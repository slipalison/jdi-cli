'use strict';

// `jdi-cli review verdict <phase> [--json]`   worst-case verdict across REVIEW.md
//                                              segments (BLOCKED > PENDING_MANUAL >
//                                              WITH_WARNINGS > APPROVED); exit 2 if none
// `jdi-cli review blockers <phase> [--max-chars N]`
//                                              the `## Blockers` and `## Warnings`
//                                              items only — the doer's work list in fix
//                                              mode, instead of the whole review
//
// `jdi-cli review plan <phase> --reviewers "<r1> <r2>" [--full]`
//                                              incremental verify: which reviewers run,
//                                              which segments are carried (multi-stack)
// `jdi-cli review merge <phase>`               after the reviewers: puts the carried
//                                              segments back and stamps the verified
//                                              commit (`<!-- jdi:verified head=… -->`)
// `jdi-cli review fresh <phase>`               exit 3 when product files changed after
//                                              the verify commit (ship refuses)
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

const ORCH_SEGMENTS = /^## (DoD Critic|Loop override)\b/;

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
  fs.rmSync(reviewFile, { force: true });
  for (const r of out.run) ctx.state.reviewers[r] = { head };
  core.writeFileEnsured(stateFile(root, phase), JSON.stringify(ctx.state, null, 2) + '\n', root);
  return out;
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
  const text = core.readIf(reviewFile);
  if (text === null) throw new core.JdiError(`${phase.dir}/REVIEW.md not found — the reviewers did not write it`, 2);
  if (!fs.existsSync(carryFile)) return { carried: 0, verified: stamp(reviewFile, root) };
  const carried = segments(fs.readFileSync(carryFile, 'utf8'));
  const present = new Set(segments(text).map((x) => x.name));
  const add = carried.filter((x) => !present.has(x.name));
  fs.writeFileSync(reviewFile, text.replace(STAMP_RE, '').trimEnd() + '\n\n' + add.map((x) => x.text).join('\n\n') + '\n');
  fs.rmSync(carryFile, { force: true });
  return { carried: add.length, reviewers: carried.map((x) => x.name), verified: stamp(reviewFile, root) };
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
function blockersCmd(phase, json, maxChars) {
  const f = findings(reviewText(phase));
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

function main(argv) {
  const [sub, ...rest] = argv;
  const json = rest.includes('--json');
  const mi = rest.indexOf('--max-chars');
  const maxChars = mi === -1 ? 4000 : Number(rest[mi + 1]);
  const id = rest.find((a, i) => !a.startsWith('--') && !['--max-chars', '--reviewers'].includes(rest[i - 1]));
  if (!id) throw new core.JdiError('usage: jdi review <verdict|blockers|plan|merge|fresh> <phase> [--json]', 1);
  const phase = core.resolvePhase(id);
  if (sub === 'verdict') return verdictCmd(phase, json);
  if (sub === 'blockers') return blockersCmd(phase, json, maxChars);
  if (sub === 'plan') return planCmd(phase, rest);
  if (sub === 'merge') return printJson(mergeReview(phase), 0);
  if (sub === 'fresh') {
    const r = staleness(phase);
    return printJson(r, r.stale ? 3 : 0);
  }
  throw new core.JdiError('usage: jdi review <verdict|blockers|plan|merge|fresh> <phase>', 1);
}

module.exports = { main, verdictOf, manualPending, findings, classify, segments, planReview, mergeReview, staleness, RANK };
