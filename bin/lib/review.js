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

// Manual DoD rows still pending = MANUAL_REQUIRED cells inside the
// `## DoD Checklist` section(s) only (the table /jdi-confirm-dod flips).
function manualPending(text) {
  let n = 0;
  for (const m of text.matchAll(/^## DoD Checklist[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) {
    n += (m[1].match(/\|\s*MANUAL_REQUIRED\s*\|/g) || []).length;
  }
  return n;
}

function verdictOf(text) {
  const all = [...text.matchAll(VERDICT_RE)].map((m) => m[1]);
  if (!all.length) return { verdict: null, lines: [], manualPending: manualPending(text) };
  const worst = all.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a));
  return { verdict: worst, lines: all, manualPending: manualPending(text) };
}

// Items of every `## <heading>` / `### <heading>` section (multi-stack
// reviews nest them under `## Reviewer: x`); a section ends at the next heading.
function itemsOf(text, heading) {
  const out = [];
  const re = new RegExp(`^#{2,4} ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,4} |(?![\\s\\S]))`, 'gm');
  for (const m of text.matchAll(re)) {
    for (const l of m[1].split('\n')) {
      if (!/^\s{0,3}([-*]|\d+\.) /.test(l)) continue;
      const t = l.trim();
      if (/^([-*]|\d+\.) (\(?none\)?\.?|_\(none\)_|nenhum\.?|—|-)$/i.test(t)) continue;
      out.push(t);
    }
  }
  return out;
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
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
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

function scopeOf(root, name) {
  const st = core.readJson(path.join(root, core.JDI_DIR, 'stacks', `${name.replace(/^jdi-reviewer-/, '')}.json`), null);
  if (st && st.file_glob) return [].concat(st.file_glob);
  const f = path.join(root, core.JDI_DIR, 'agents', `${name}.md`);
  const g = fs.existsSync(f) ? core.readFrontmatter(f).scope?.file_glob : null;
  return !g || g === '**/*' ? ['**/*'] : String(g).split(/[,\s]+/).filter(Boolean);
}

function changedSince(root, sha) {
  const r = core.git(['diff', '--name-only', `${sha}..HEAD`], root);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

// Decide which reviewers run. The first reviewer owns the DoD Checklist and
// always runs; another one is CARRIED (its last segment kept, not re-spawned)
// only when: incremental verify is on, its last run is recorded at a commit
// that is an ancestor of HEAD, nothing in its scope nor in the phase's
// CONTEXT/PLAN changed since, and its segment was not BLOCKED.
function planReview(phase, reviewers, { full = false } = {}, root = process.cwd()) {
  const config = core.loadConfig(root);
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  const prevText = core.readIf(reviewFile) || '';
  const prevSegs = new Map(segments(prevText).map((x) => [x.name, x]));
  const state = core.readJson(stateFile(root, phase), null) || { reviewers: {} };
  const out = { mode: 'full', run: [], carry: [], reasons: {} };
  const incremental = !full && config.economy?.incremental_verify !== false && reviewers.length > 1;
  reviewers.forEach((r, i) => {
    let why = null;
    const last = state.reviewers[r];
    if (!incremental) why = full ? '--full' : reviewers.length > 1 ? 'economy.incremental_verify is false' : 'single reviewer';
    else if (i === 0) why = 'owns the DoD Checklist';
    else if (!last || !last.head) why = 'no previous run recorded';
    else if (core.git(['merge-base', '--is-ancestor', last.head, 'HEAD'], root).code !== 0) why = 'previous run is not an ancestor of HEAD';
    else if (!prevSegs.has(r)) why = 'previous segment missing from REVIEW.md';
    else if (verdictOf(prevSegs.get(r).text).verdict === 'BLOCKED') why = 'previous segment was BLOCKED';
    else {
      const changed = changedSince(root, last.head);
      if (changed === null) why = 'cannot diff against the previous run';
      else {
        const phaseInputs = changed.filter((f) => f === `${phase.dir}/CONTEXT.md` || f === `${phase.dir}/PLAN.md`);
        const inScope = changed.filter((f) => !f.startsWith(`${core.JDI_DIR}/`) && core.matchesAny(f, scopeOf(root, r)));
        if (phaseInputs.length) why = 'CONTEXT/PLAN changed since its last run';
        else if (inScope.length) why = `${inScope.length} file(s) changed in its scope`;
      }
    }
    if (why) {
      out.run.push(r);
      out.reasons[r] = why;
    } else {
      out.carry.push(r);
      out.reasons[r] = `unchanged since ${last.head.slice(0, 10)}`;
    }
  });
  if (out.carry.length) out.mode = 'incremental';
  // carried segments wait in the cache while the reviewers write a fresh REVIEW.md
  const carryFile = path.join(root, core.JDI_DIR, 'cache', 'review', `${phase.slug}-carried.md`);
  const carriedText = out.carry.map((r) => `${prevSegs.get(r).text.replace(/^(## Reviewer:[^\n]*)\n/, `$1\n<!-- jdi:carried from=${state.reviewers[r].head.slice(0, 12)} -->\n`)}`).join('\n\n');
  if (carriedText) core.writeFileEnsured(carryFile, carriedText + '\n', root);
  else fs.rmSync(carryFile, { force: true });
  fs.rmSync(reviewFile, { force: true });
  for (const r of out.run) state.reviewers[r] = { head };
  core.writeFileEnsured(stateFile(root, phase), JSON.stringify(state, null, 2) + '\n', root);
  return out;
}

const STAMP_RE = /^<!-- jdi:verified head=([0-9a-f]{7,40}) -->\n?/m;

// Records the commit the reviewers verified, so freshness does not depend on
// which later command committed REVIEW.md (confirm-dod, a loop override).
function stamp(reviewFile, root) {
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  if (!head) return null;
  const text = (core.readIf(reviewFile) || '').replace(STAMP_RE, '');
  fs.writeFileSync(reviewFile, text.replace(/\s*$/, '\n') + `<!-- jdi:verified head=${head} -->\n`);
  return head;
}

function mergeReview(phase, root = process.cwd()) {
  const carryFile = path.join(root, core.JDI_DIR, 'cache', 'review', `${phase.slug}-carried.md`);
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  const text = core.readIf(reviewFile);
  if (text === null) throw new core.JdiError(`${phase.dir}/REVIEW.md not found — the reviewers did not write it`, 2);
  if (!fs.existsSync(carryFile)) return { carried: 0, verified: stamp(reviewFile, root) };
  const carried = fs.readFileSync(carryFile, 'utf8');
  const names = segments(carried).map((x) => x.name);
  const present = new Set(segments(text).map((x) => x.name));
  const add = segments(carried).filter((x) => !present.has(x.name));
  fs.writeFileSync(reviewFile, text.replace(STAMP_RE, '').replace(/\s*$/, '\n\n') + add.map((x) => x.text).join('\n\n') + '\n');
  fs.rmSync(carryFile, { force: true });
  return { carried: add.length, reviewers: names, verified: stamp(reviewFile, root) };
}

// The review must describe the code being shipped: no product file may change
// after the last commit that touched REVIEW.md (the verify commit). `.jdi/`
// and `loop.non_product_globs` do not count.
function staleness(phase, root = process.cwd()) {
  const rel = `${phase.dir}/REVIEW.md`;
  const dirty = core.git(['status', '--porcelain', '--', rel], root);
  if (dirty.code !== 0) return { stale: false, reason: 'not a git repository' };
  // the stamp written by `review merge` names the verified commit; older
  // reviews fall back to the last commit that touched REVIEW.md
  const stamped = STAMP_RE.exec(core.readIf(path.join(phase.absDir, 'REVIEW.md')) || '');
  let c = stamped ? stamped[1] : null;
  if (c && core.git(['cat-file', '-e', `${c}^{commit}`], root).code !== 0) c = null;
  if (!c) {
    if (dirty.stdout) return { stale: false, reason: 'REVIEW.md not committed yet (verified at HEAD)' };
    c = core.git(['log', '-1', '--format=%H', '--', rel], root).stdout;
  }
  if (!c) return { stale: false, reason: 'REVIEW.md has no commit' };
  const changed = changedSince(root, c) || [];
  const ignore = [`${core.JDI_DIR}/**`, ...(core.loadConfig(root).loop?.non_product_globs || [])];
  const product = changed.filter((f) => !core.matchesAny(f, ignore));
  return { stale: product.length > 0, since: c, files: product };
}

function reviewText(phase) {
  const f = path.join(phase.absDir, 'REVIEW.md');
  if (!fs.existsSync(f)) throw new core.JdiError(`${phase.dir}/REVIEW.md not found — run /jdi-verify`, 2);
  return fs.readFileSync(f, 'utf8');
}

function main(argv) {
  const [sub, ...rest] = argv;
  const json = rest.includes('--json');
  const mi = rest.indexOf('--max-chars');
  const maxChars = mi === -1 ? 4000 : Number(rest[mi + 1]);
  const id = rest.find((a, i) => !a.startsWith('--') && !['--max-chars', '--reviewers'].includes(rest[i - 1]));
  if (!id) throw new core.JdiError('usage: jdi review <verdict|blockers|plan|merge|fresh> <phase> [--json]', 1);
  const phase = core.resolvePhase(id);
  if (sub === 'verdict') {
    const v = verdictOf(reviewText(phase));
    if (!v.verdict) {
      console.error('REVIEW.md has no verdict line — malformed review (never ship on silence)');
      return 2;
    }
    process.stdout.write(json ? JSON.stringify(v) + '\n' : `${v.verdict}\n`);
    return 0;
  }
  if (sub === 'plan') {
    const ri = rest.indexOf('--reviewers');
    const reviewers = ri === -1 ? [] : rest[ri + 1].split(/[\s,]+/).filter(Boolean);
    if (!reviewers.length) throw new core.JdiError('review plan needs --reviewers "<r1> <r2>" (registry order; the first owns the DoD)', 1);
    process.stdout.write(JSON.stringify(planReview(phase, reviewers, { full: rest.includes('--full') })) + '\n');
    return 0;
  }
  if (sub === 'merge') {
    process.stdout.write(JSON.stringify(mergeReview(phase)) + '\n');
    return 0;
  }
  if (sub === 'fresh') {
    const r = staleness(phase);
    process.stdout.write(JSON.stringify(r) + '\n');
    return r.stale ? 3 : 0;
  }
  if (sub === 'blockers') {
    const f = findings(reviewText(phase));
    if (json) {
      process.stdout.write(JSON.stringify(f, null, 2) + '\n');
      return 0;
    }
    const out = [];
    let used = 0;
    let cut = 0;
    for (const [title, list] of [['Blockers', f.blockers], ['Warnings', f.warnings]]) {
      if (!list.length) continue;
      out.push(`## ${title}`);
      for (const it of list) {
        if (used + it.text.length > maxChars) {
          cut++;
          continue;
        }
        out.push(it.text);
        used += it.text.length;
      }
    }
    if (cut) out.push(`(${cut} more — ${phase.dir}/REVIEW.md)`);
    process.stdout.write(out.join('\n') + (out.length ? '\n' : 'no blockers or warnings\n'));
    return 0;
  }
  throw new core.JdiError('usage: jdi review <verdict|blockers|plan|merge|fresh> <phase>', 1);
}

module.exports = { main, verdictOf, manualPending, findings, classify, segments, planReview, mergeReview, staleness, RANK };
