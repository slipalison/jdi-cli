'use strict';

// `jdi-cli review verdict <phase> [--json]`   worst-case verdict across REVIEW.md
//                                              segments (BLOCKED > PENDING_MANUAL >
//                                              WITH_WARNINGS > APPROVED); exit 2 if none
// `jdi-cli review blockers <phase> [--max-chars N] [--stack <reviewer> [--dod-owner]]`
//                                              the `## Blockers` and `## Warnings`
//                                              items only — the doer's work list in fix
//                                              mode, instead of the whole review.
//                                              `--stack`: only that reviewer's segment
//                                              (+ the DoD critic's and orchestrator's
//                                              items with `--dod-owner`), so a
//                                              multi-stack fix round sends each doer
//                                              its whole batch at once (#71)
//
// `jdi-cli review plan <phase> --reviewers "<r1> <r2>" [--full]`
//                                              incremental verify: which reviewers run,
//                                              which segments are carried (multi-stack)
// `jdi-cli review merge <phase>`               after the reviewers: puts the carried
//                                              segments back and stamps the verified
//                                              commit (`<!-- jdi:verified head=… -->`)
// `jdi-cli review fresh <phase>`               exit 3 when product files changed after
//                                              the verify commit (ship refuses)
// `jdi-cli review from-gates <phase>`          REVIEW.md BLOCKED from the gate failures
//                                              at HEAD, with no reviewer spawned (0.20)
//
// Parallel review (0.20): when several reviewers run and every one of them
// knows `segment_file=` (managed `inputs` block, delivered by `specialists
// upgrade`), `review plan` answers `parallel: true` with one segment file per
// reviewer; they are spawned at once and `review merge` writes REVIEW.md from
// the segments, in registry order. The gates run before the reviewers since
// 0.18, so nothing they run can collide. An older specialist would append to
// REVIEW.md itself: then the plan stays sequential.
//
// The orchestrator reads verdicts and work lists through here instead of
// opening REVIEW.md: in a long phase REVIEW.md grows to tens of KB and every
// byte read by the orchestrator is re-read on each of its later turns.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');

const RANK = ['APPROVED', 'APPROVED_WITH_WARNINGS', 'APPROVED_PENDING_MANUAL', 'BLOCKED'];
const VERDICT_RE = /(?:Verdict|Veredicto):\*\*\s*(APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|APPROVED|BLOCKED)\b/g;

// Bodies (as line arrays) of the sections that `isStart` opens; a section
// ends at the first line `isEnd` accepts (which may open the next one).
function sectionBodies(text, isStart, isEnd) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (cur && isEnd(line)) cur = null;
    if (!cur && isStart(line)) {
      cur = [];
      out.push(cur);
    } else if (cur) cur.push(line);
  }
  return out;
}

const isH2 = (line) => line.startsWith('## ');
const headingText = (line) => /^#{1,4} (.*)$/.exec(line)?.[1] ?? null;

// Manual DoD rows still pending = MANUAL_REQUIRED cells inside the
// `## DoD Checklist` section(s) only (the table /jdi-confirm-dod flips).
function manualPending(text) {
  const bodies = sectionBodies(text, (l) => l.startsWith('## DoD Checklist'), isH2);
  return bodies.flat().reduce((n, l) => n + (l.match(/\|\s*MANUAL_REQUIRED\s*\|/g) || []).length, 0);
}

const worse = (a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a);

function verdictOf(text) {
  const all = [...text.matchAll(VERDICT_RE)].map((m) => m[1]);
  if (!all.length) return { verdict: null, lines: [], manualPending: manualPending(text) };
  return { verdict: all.reduce((a, b) => worse(a, b), all[0]), lines: all, manualPending: manualPending(text) };
}

const NONE_ITEM = /^([-*]|\d+\.) (\(?none\)?\.?|_\(none\)_|nenhum\.?|—|-)$/i;

// Items of every `## <heading>` / `### <heading>` section (multi-stack
// reviews nest them under `## Reviewer: x`); a section ends at the next heading.
function itemsOf(text, heading) {
  const isStart = (l) => /^#{2,4} /.test(l) && headingText(l).startsWith(heading);
  const bodies = sectionBodies(text, isStart, (l) => headingText(l) !== null);
  return bodies
    .flat()
    .filter((l) => /^\s{0,3}([-*]|\d+\.) /.test(l))
    .map((l) => l.trim())
    .filter((t) => !NONE_ITEM.test(t));
}

// [defect] / [hollow DoD N] tags written by the reviewer (and the critic).
function classify(line) {
  const h = /\[hollow(?:-proof)?(?:\s+DoD\s*(\d+))?\]/i.exec(line);
  if (h) return { kind: 'hollow', row: h[1] ? Number(h[1]) : null };
  return { kind: 'defect', row: null };
}

function findings(text) {
  return {
    blockers: itemsOf(text, 'Blockers').map((l) => ({ text: l, ...classify(l) })),
    warnings: itemsOf(text, 'Warnings').map((l) => ({ text: l, ...classify(l) })),
  };
}

// --------------------------------------------------------------------------
// Incremental verify (multi-stack): `review plan` before the reviewers,
// `review merge` after them.
// --------------------------------------------------------------------------

const ORCH_SEGMENTS = /^## (DoD Critic|Loop override|Read-only check)\b/;

// Split REVIEW.md into `## Reviewer: <name>` segments (each runs until the
// next reviewer segment or an orchestrator segment).
function segments(text) {
  const out = [];
  let cur = null;
  for (const l of text.split('\n')) {
    const m = /^## Reviewer:\s*(\S+)/.exec(l);
    if (m) {
      cur = { name: m[1], lines: [l] };
      out.push(cur);
    } else if (ORCH_SEGMENTS.test(l)) cur = null;
    else if (cur) cur.lines.push(l);
  }
  return out.map((x) => ({ name: x.name, text: x.lines.join('\n').trimEnd() }));
}

// The part of REVIEW.md that belongs to one stack's doer: its reviewer
// segment, plus — for the DoD owner — everything outside reviewer segments
// (the DoD Critic, a Loop override, a single-reviewer review).
function scopedText(text, stack, dodOwner) {
  if (!segments(text).length) return text;
  const own = [];
  const outside = [];
  let inSeg = null;
  for (const l of text.split('\n')) {
    const m = /^## Reviewer:\s*(\S+)/.exec(l);
    if (m) inSeg = m[1];
    else if (ORCH_SEGMENTS.test(l)) inSeg = null;
    if (inSeg === stack) own.push(l);
    else if (inSeg === null) outside.push(l);
  }
  return [...own, ...(dodOwner ? ['', ...outside] : [])].join('\n');
}

function segDir(root, phase) {
  return path.join(root, core.JDI_DIR, 'cache', 'review', phase.slug, 'segments');
}

// The specialist knows `segment_file=` (its managed inputs block is 0.20+).
function writesSegments(root, name) {
  const text = core.readIf(path.join(root, core.JDI_DIR, 'agents', `${name}.md`));
  return Boolean(text?.includes('segment_file='));
}

function stateFile(root, phase) {
  return path.join(root, core.JDI_DIR, 'cache', 'review', `${phase.slug}.json`);
}

function carryFileOf(root, phase) {
  return path.join(root, core.JDI_DIR, 'cache', 'review', `${phase.slug}-carried.md`);
}

function scopeOf(root, name) {
  const st = core.readJson(path.join(root, core.JDI_DIR, 'stacks', `${name.replace(/^jdi-reviewer-/, '')}.json`), null);
  if (st?.file_glob) return [st.file_glob].flat();
  const f = path.join(root, core.JDI_DIR, 'agents', `${name}.md`);
  const g = fs.existsSync(f) ? core.readFrontmatter(f).scope?.file_glob : null;
  if (!g || g === '**/*') return ['**/*'];
  return String(g).split(/[,\s]+/).filter(Boolean);
}

function changedSince(root, sha) {
  const r = core.git(['diff', '--name-only', `${sha}..HEAD`], root);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

// Why reviewer `r` must run, from what changed since its last run (null:
// nothing in its scope nor in the phase's CONTEXT/PLAN changed).
function changeReason(root, phase, r, since) {
  const changed = changedSince(root, since);
  if (changed === null) return 'cannot diff against the previous run';
  if (changed.some((f) => f === `${phase.dir}/CONTEXT.md` || f === `${phase.dir}/PLAN.md`)) return 'CONTEXT/PLAN changed since its last run';
  const inScope = changed.filter((f) => !f.startsWith(`${core.JDI_DIR}/`) && core.matchesAny(f, scopeOf(root, r)));
  return inScope.length ? `${inScope.length} file(s) changed in its scope` : null;
}

// Why reviewer `r` (position i) runs; null when its last segment can be carried.
function runReason(ctx, r, i) {
  const last = ctx.state.reviewers[r];
  if (i === 0) return 'owns the DoD Checklist';
  if (!last?.head) return 'no previous run recorded';
  if (core.git(['merge-base', '--is-ancestor', last.head, 'HEAD'], ctx.root).code !== 0) return 'previous run is not an ancestor of HEAD';
  if (!ctx.prevSegs.has(r)) return 'previous segment missing from REVIEW.md';
  if (verdictOf(ctx.prevSegs.get(r).text).verdict === 'BLOCKED') return 'previous segment was BLOCKED';
  return changeReason(ctx.root, ctx.phase, r, last.head);
}

function fullReason(full, count) {
  if (full) return '--full';
  return count > 1 ? 'economy.incremental_verify is false' : 'single reviewer';
}

function carriedSegment(text, head) {
  return text.replace(/^(## Reviewer:[^\n]*)\n/, (m, title) => `${title}\n<!-- jdi:carried from=${head.slice(0, 12)} -->\n`);
}

// `loop.record_commits: "at_ship"` (#71): the verify does not commit
// REVIEW.md each round, so the review being replaced would exist nowhere —
// keep it as `reviews/round-N.md` in the phase folder (committed at ship).
function snapshotRound(root, phase, reviewFile) {
  if (core.loadConfig(root).loop?.record_commits !== 'at_ship' || !fs.existsSync(reviewFile)) return;
  const dir = path.join(phase.absDir, 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const n = fs.readdirSync(dir).filter((f) => /^round-\d+\.md$/.test(f)).length + 1;
  fs.copyFileSync(reviewFile, path.join(dir, `round-${n}.md`));
}

// Decide which reviewers run. The first reviewer owns the DoD Checklist and
// always runs; another one is CARRIED (its last segment kept, not re-spawned)
// only when: incremental verify is on, its last run is recorded at a commit
// that is an ancestor of HEAD, nothing in its scope nor in the phase's
// CONTEXT/PLAN changed since, and its segment was not BLOCKED.
function planReview(phase, reviewers, { full = false } = {}, root = process.cwd()) {
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  const ctx = {
    root,
    phase,
    state: core.readJson(stateFile(root, phase), null) || { reviewers: {} },
    prevSegs: new Map(segments(core.readIf(reviewFile) || '').map((x) => [x.name, x])),
  };
  const incremental = !full && core.loadConfig(root).economy?.incremental_verify !== false && reviewers.length > 1;
  const out = { mode: 'full', run: [], carry: [], reasons: {} };
  reviewers.forEach((r, i) => {
    const why = incremental ? runReason(ctx, r, i) : fullReason(full, reviewers.length);
    out[why ? 'run' : 'carry'].push(r);
    out.reasons[r] = why || `unchanged since ${ctx.state.reviewers[r].head.slice(0, 10)}`;
  });
  if (out.carry.length) out.mode = 'incremental';
  // carried segments wait in the cache while the reviewers write a fresh REVIEW.md
  const carriedText = out.carry.map((r) => carriedSegment(ctx.prevSegs.get(r).text, ctx.state.reviewers[r].head)).join('\n\n');
  if (carriedText) core.writeFileEnsured(carryFileOf(root, phase), carriedText + '\n', root);
  else fs.rmSync(carryFileOf(root, phase), { force: true });
  snapshotRound(root, phase, reviewFile);
  fs.rmSync(reviewFile, { force: true });
  fs.rmSync(segDir(root, phase), { recursive: true, force: true });
  const parallelOn = core.loadConfig(root).economy?.parallel_review !== false;
  // only when the gates run outside the reviewers (a stack file per reviewer):
  // a reviewer without one runs its own build/test, and two of those in one
  // tree collide on ports, locks and output dirs
  const gates = require('./gates');
  const stacks = gates.loadStacks(root);
  const gated = (r) => Boolean(gates.findStack(stacks, r));
  out.parallel = parallelOn && out.run.length > 1 && out.run.every((r) => writesSegments(root, r) && gated(r));
  if (out.parallel) {
    fs.mkdirSync(segDir(root, phase), { recursive: true });
    out.segments = Object.fromEntries(out.run.map((r) => [r, path.relative(root, path.join(segDir(root, phase), `${r}.md`)).split(path.sep).join('/')]));
  }
  for (const r of out.run) ctx.state.reviewers[r] = { head };
  ctx.state.order = reviewers;
  ctx.state.parallel_run = out.parallel ? out.run : [];
  core.writeFileEnsured(stateFile(root, phase), JSON.stringify(ctx.state, null, 2) + '\n', root);
  return out;
}

// Segments written by parallel reviewers, in registry order.
function collectSegments(root, phase, order) {
  const d = segDir(root, phase);
  let files = [];
  try {
    files = fs.readdirSync(d).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const rank = (f) => {
    const i = (order || []).indexOf(f.slice(0, -3));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return files.sort((a, b) => rank(a) - rank(b) || core.compareStr(a, b)).map((f) => fs.readFileSync(path.join(d, f), 'utf8').trim());
}

const STAMP_RE = /^<!-- jdi:verified head=([\da-f]{7,40}) -->\n?/m;

// Records the commit the reviewers verified, so freshness does not depend on
// which later command committed REVIEW.md (confirm-dod, a loop override).
function stamp(reviewFile, root) {
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  if (!head) return null;
  const text = (core.readIf(reviewFile) || '').replace(STAMP_RE, '');
  fs.writeFileSync(reviewFile, text.trimEnd() + '\n' + `<!-- jdi:verified head=${head} -->\n`);
  return head;
}

function mergeReview(phase, root = process.cwd()) {
  const carryFile = carryFileOf(root, phase);
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  const st = core.readJson(stateFile(root, phase), null) || {};
  const segs = collectSegments(root, phase, st.order);
  // a parallel reviewer that wrote nothing would drop out of the worst-case
  // verdict: refuse, so the orchestrator spawns it again
  const silent = (st.parallel_run || []).filter((r) => !fs.existsSync(path.join(segDir(root, phase), `${r}.md`)));
  if (segs.length && silent.length) throw new core.JdiError(`no segment from ${silent.join(', ')} — spawn it again (never merge a review with a silent reviewer)`, 2);
  if (segs.length) {
    const base = core.readIf(reviewFile);
    const present = new Set(segments(base || '').map((x) => x.name));
    const fresh = segs.filter((t) => !segments(t).some((x) => present.has(x.name)));
    const head = base === null ? `# Review (slug: ${phase.slug})\n\n` : base.trimEnd() + '\n\n';
    fs.writeFileSync(reviewFile, head + fresh.join('\n\n') + '\n');
    fs.rmSync(segDir(root, phase), { recursive: true, force: true });
  }
  if (!fs.existsSync(reviewFile)) throw new core.JdiError(`${phase.dir}/REVIEW.md not found — the reviewers did not write it`, 2);
  const readOnly = readOnlyCheck(root, phase, reviewFile, st);
  const text = core.readIf(reviewFile);
  if (!fs.existsSync(carryFile)) return { carried: 0, readOnly, verified: stamp(reviewFile, root) };
  const carried = segments(fs.readFileSync(carryFile, 'utf8'));
  const present = new Set(segments(text).map((x) => x.name));
  const add = carried.filter((x) => !present.has(x.name));
  fs.writeFileSync(reviewFile, text.replace(STAMP_RE, '').trimEnd() + '\n\n' + add.map((x) => x.text).join('\n\n') + '\n');
  fs.rmSync(carryFile, { force: true });
  return { carried: add.length, reviewers: carried.map((x) => x.name), readOnly, verified: stamp(reviewFile, root) };
}

// --------------------------------------------------------------------------
// Read-only check (0.21): reviewers and the critic only read. `review
// baseline`, right before they are spawned, records HEAD and the working tree
// outside .jdi/; `review merge` compares. A commit during the review blocks
// (unreviewed code entered the branch); changed files are a warning (a
// reviewer may have edited code — with reviewers in parallel, silently).
// --------------------------------------------------------------------------

// Every file that differs from HEAD (staged, unstaged, untracked) outside
// .jdi/, with the hash of its content ('-' = deleted).
function treeSnapshot(root) {
  const tracked = core.git(['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD'], root);
  const untracked = core.git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], root);
  if (tracked.code !== 0 || untracked.code !== 0) return null;
  const crypto = require('node:crypto');
  const out = {};
  for (const file of `${tracked.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean)) {
    if (file.startsWith(`${core.JDI_DIR}/`)) continue;
    const bytes = core.readIf(path.join(root, file));
    out[file] = bytes === null ? '-' : crypto.createHash('sha256').update(bytes).digest('hex');
  }
  return out;
}

function baseline(phase, root = process.cwd()) {
  const st = core.readJson(stateFile(root, phase), null) || { reviewers: {} };
  st.readonly = { head: core.git(['rev-parse', 'HEAD'], root).stdout, tree: treeSnapshot(root), at: new Date().toISOString() };
  core.writeFileEnsured(stateFile(root, phase), JSON.stringify(st, null, 2) + '\n', root);
  return { baseline: st.readonly.head, dirty: Object.keys(st.readonly.tree || {}).length };
}

// Product files committed between the baseline and HEAD (.jdi/ does not
// count: a harness may checkpoint the review artifacts as they are written).
function committedSince(root, base) {
  const r = core.git(['-c', 'core.quotePath=false', 'diff', '--name-only', `${base}..HEAD`], root);
  if (r.code !== 0) return ['(history rewritten since the baseline)'];
  return r.stdout.split('\n').filter((f) => f && !f.startsWith(`${core.JDI_DIR}/`));
}

function readOnlyCheck(root, phase, reviewFile, st) {
  const b = st.readonly;
  if (!b?.head || !b.tree) return null; // no baseline: an older orchestrator
  // one baseline, one check: a later merge needs a fresh `review baseline`
  st.readonly = null;
  core.writeFileEnsured(stateFile(root, phase), JSON.stringify(st, null, 2) + '\n', root);
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  const committed = head === b.head ? [] : committedSince(root, b.head);
  const now = treeSnapshot(root) || {};
  const changed = [...new Set([...Object.keys(now), ...Object.keys(b.tree)])].filter((f) => now[f] !== b.tree[f]).sort(core.compareStr);
  if (committed.length) return flagReadOnly(reviewFile, ['**Verdict:** BLOCKED', '', '### Blockers', `- [defect] a commit entered the branch during the review (${b.head.slice(0, 10)} -> ${head.slice(0, 10)}: ${listOf(committed)}): a read-only role committed — review or revert it, then verify again`], { headChanged: true, changed: committed });
  // no product file committed: HEAD has the same product files as the
  // baseline, so the two snapshots compare as they are
  if (!changed.length) return { clean: true };
  return flagReadOnly(reviewFile, ['**Verdict:** APPROVED_WITH_WARNINGS', '', '### Warnings', `- files changed while the reviewers ran (they only read — check who wrote them): ${listOf(changed)}`], { headChanged: false, changed });
}

const listOf = (files) => files.slice(0, 10).join(', ') + (files.length > 10 ? ', ...' : '');

function flagReadOnly(reviewFile, body, result) {
  const lines = ['', '## Read-only check', '', ...body];
  fs.writeFileSync(reviewFile, (core.readIf(reviewFile) || '').replace(STAMP_RE, '').trimEnd() + '\n' + lines.join('\n') + '\n');
  return { clean: false, ...result };
}

// The commit the review describes: the stamp written by `review merge`;
// older reviews fall back to the last commit that touched REVIEW.md.
function verifiedCommit(phase, root, dirty) {
  const stamped = STAMP_RE.exec(core.readIf(path.join(phase.absDir, 'REVIEW.md')) || '');
  if (stamped && core.git(['cat-file', '-e', `${stamped[1]}^{commit}`], root).code === 0) return { commit: stamped[1] };
  if (dirty) return { reason: 'REVIEW.md not committed yet (verified at HEAD)' };
  const c = core.git(['log', '-1', '--format=%H', '--', `${phase.dir}/REVIEW.md`], root).stdout;
  return c ? { commit: c } : { reason: 'REVIEW.md has no commit' };
}

// The review must describe the code being shipped: no product file may change
// after the verified commit. `.jdi/` and `loop.non_product_globs` do not count.
function staleness(phase, root = process.cwd()) {
  const dirty = core.git(['status', '--porcelain', '--', `${phase.dir}/REVIEW.md`], root);
  if (dirty.code !== 0) return { stale: false, reason: 'not a git repository' };
  const v = verifiedCommit(phase, root, Boolean(dirty.stdout));
  if (!v.commit) return { stale: false, reason: v.reason };
  const ignore = [`${core.JDI_DIR}/**`, ...(core.loadConfig(root).loop?.non_product_globs || [])];
  const product = (changedSince(root, v.commit) || []).filter((f) => !core.matchesAny(f, ignore));
  return { stale: product.length > 0, since: v.commit, files: product };
}

function reviewText(phase) {
  const f = path.join(phase.absDir, 'REVIEW.md');
  if (!fs.existsSync(f)) throw new core.JdiError(`${phase.dir}/REVIEW.md not found — run /jdi-verify`, 2);
  return fs.readFileSync(f, 'utf8');
}

function verdictCmd(phase, json) {
  const v = verdictOf(reviewText(phase));
  if (!v.verdict) {
    console.error('REVIEW.md has no verdict line — malformed review (never ship on silence)');
    return 2;
  }
  process.stdout.write(json ? JSON.stringify(v) + '\n' : `${v.verdict}\n`);
  return 0;
}

// The fix round's work list: blockers then warnings, under a character cap.
function blockersCmd(phase, json, maxChars, scope = {}) {
  const text = reviewText(phase);
  const f = findings(scope.stack ? scopedText(text, scope.stack, scope.dodOwner) : text);
  if (json) {
    process.stdout.write(JSON.stringify(f, null, 2) + '\n');
    return 0;
  }
  const out = [];
  let used = 0;
  let cut = 0;
  for (const [title, list] of Object.entries({ Blockers: f.blockers, Warnings: f.warnings })) {
    if (list.length) out.push(`## ${title}`);
    for (const it of list) {
      if (used + it.text.length > maxChars) cut++;
      else {
        out.push(it.text);
        used += it.text.length;
      }
    }
  }
  if (cut) out.push(`(${cut} more — ${phase.dir}/REVIEW.md)`);
  process.stdout.write(out.length ? out.join('\n') + '\n' : 'no blockers or warnings\n');
  return 0;
}

function printJson(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  return code;
}

function planCmd(phase, rest) {
  const ri = rest.indexOf('--reviewers');
  const reviewers = ri === -1 ? [] : rest[ri + 1].split(/[\s,]+/).filter(Boolean);
  if (!reviewers.length) throw new core.JdiError('review plan needs --reviewers "<r1> <r2>" (registry order; the first owns the DoD)', 1);
  return printJson(planReview(phase, reviewers, { full: rest.includes('--full') }), 0);
}

// Gates still red after the pre-review fix pass: the review is BLOCKED by
// measurement — no reviewer is spawned to say what the reports already say.
// Each failure is a `[defect]` blocker, so the loop routes it as one.
function fromGates(phase, root = process.cwd()) {
  const gates = require('./gates');
  const reports = gates.headReportsOf(root, phase);
  const stacks = gates.loadStacks(root);
  // one `## Reviewer: <agent>` segment per stack, so `review blockers --stack`
  // gives each stack's doer only its failures; DoD failures stay outside the
  // segments (they go to the DoD owner, `--dod-owner`)
  const segs = [];
  const dodBlockers = [];
  for (const r of reports) {
    const fails = (r.results || []).filter((y) => y.status === 'FAIL').map((x) => `- [defect] gate ${r.stack}/${x.gate} failed — log: ${x.log || '-'}`);
    if (fails.length) {
      const st = gates.findStack(stacks, r.stack);
      segs.push([`## Reviewer: ${st?.agent || r.stack}`, '', '**Verdict:** BLOCKED', '', '### Blockers', ...fails, ''].join('\n'));
    }
    for (const x of (r.dod || []).filter((y) => y.status === 'FAIL')) dodBlockers.push(`- [defect] DoD ${x.source} ${x.id} FAIL: ${x.criterion}${x.reason ? ' — ' + x.reason : ''}${x.log ? ' — log: ' + x.log : ''}`);
  }
  if (!segs.length && !dodBlockers.length) throw new core.JdiError(`no failed gate at HEAD for ${phase.slug} — nothing to block on (spawn the reviewers)`, 2);
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  const head = [`# Review (slug: ${phase.slug})`, '', '**Verdict:** BLOCKED', '', 'The gates are red at HEAD after the fix pass; no reviewer was spawned (judgment waits for green gates).', ''];
  const dodPart = dodBlockers.length ? ['### Blockers', ...dodBlockers, ''] : [];
  fs.writeFileSync(reviewFile, [...head, ...dodPart, ...segs].join('\n'));
  const count = dodBlockers.length + segs.reduce((n, t) => n + t.split('\n').filter((l) => l.startsWith('- [defect]')).length, 0);
  return { verdict: 'BLOCKED', blockers: count, verified: stamp(reviewFile, root) };
}

function main(argv) {
  const [sub, ...rest] = argv;
  const json = rest.includes('--json');
  const mi = rest.indexOf('--max-chars');
  const maxChars = mi === -1 ? 4000 : Number(rest[mi + 1]);
  const id = rest.find((a, i) => !a.startsWith('--') && !['--max-chars', '--reviewers', '--stack'].includes(rest[i - 1]));
  const si = rest.indexOf('--stack');
  const scope = { stack: si === -1 ? null : rest[si + 1], dodOwner: rest.includes('--dod-owner') };
  if (!id) throw new core.JdiError('usage: jdi review <verdict|blockers|plan|merge|fresh|from-gates|baseline> <phase> [--json]', 1);
  const phase = core.resolvePhase(id);
  if (sub === 'verdict') return verdictCmd(phase, json);
  if (sub === 'blockers') return blockersCmd(phase, json, maxChars, scope);
  if (sub === 'plan') return planCmd(phase, rest);
  if (sub === 'merge') return printJson(mergeReview(phase), 0);
  if (sub === 'from-gates') return printJson(fromGates(phase), 0);
  if (sub === 'baseline') return printJson(baseline(phase), 0);
  if (sub === 'fresh') {
    const r = staleness(phase);
    return printJson(r, r.stale ? 3 : 0);
  }
  throw new core.JdiError('usage: jdi review <verdict|blockers|plan|merge|fresh|from-gates|baseline> <phase>', 1);
}

module.exports = { main, verdictOf, manualPending, findings, classify, segments, scopedText, planReview, mergeReview, fromGates, baseline, staleness, RANK };
