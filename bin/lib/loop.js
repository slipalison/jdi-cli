'use strict';

// `jdi-cli loop <init|record|reset|status> <phase>` — the ralph loop's
// bookkeeping as code (it used to be prose the orchestrator executed turn by
// turn, and in practice became a hand-written narrative table that the
// oscillation check could no longer parse).
//
//   loop init   <phase> [--max-iter 5] [--max-resets 3]
//   loop record <phase> [--autonomous]   after each verify: appends the
//                                        iteration and prints the decision as JSON
//   loop reset  <phase> --reason <text> [--autonomous]
//   loop status <phase> [--json]
//
// Decision rules (issue #62, items 1 and 6):
// - APPROVED / APPROVED_WITH_WARNINGS -> converged. PENDING_MANUAL -> pending-manual.
// - A blocker tagged `[defect]` (or untagged) always blocks.
// - A blocker tagged `[hollow DoD N]` (the Verify passes without proving the
//   criterion, but the code is right) blocks ONCE per DoD row: the row goes to
//   `hollow_spent`, and later hollow findings on it become PR warnings.
// - No open defect and nothing new to block -> converged-with-warnings.
// - No open defect and no product change since the last verified commit
//   (files outside .jdi/ and `loop.non_product_globs`) -> converged-with-warnings.
// - Same finding hash already seen this round -> gate (oscillation).
// - iter >= max_iter -> gate. Resets beyond max_resets (autonomous:
//   orchestration.max_resets_autonomous, default = max_resets) -> killed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./jdi-core');
const review = require('./review');

function loopFile(phase) {
  return path.join(phase.absDir, 'LOOP.md');
}

function readLoop(phase) {
  const f = loopFile(phase);
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  const { fm, body } = core.splitFrontmatter(text);
  const y = core.parseYaml(fm);
  const history = [];
  for (const l of body.split('\n')) {
    const m = /^- iter (\d+): (\w+), hash=([a-f0-9]+)(?:, commit=(\w+))?(?:, ts=(\S+?))?(?:, product=(\w+))?(?:, defects=(\d+))?(?:, hollow=(\d+))?\s*$/.exec(l);
    if (m) history.push({ iter: Number(m[1]), verdict: m[2], hash: m[3], commit: m[4], product: m[6] });
    else if (/^--- (AUTO-)?RESET|^--- RESUMED/.test(l)) history.push({ marker: l });
  }
  const list = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => !Number.isNaN(n)) : []);
  return {
    file: f,
    text,
    body,
    iter: Number(y.iter || 0),
    totalResets: Number(y.total_resets || 0),
    status: String(y.status || 'running'),
    maxIter: Number(y.max_iter_per_round || 5),
    maxResets: Number(y.max_resets || 3),
    createdAt: y.created_at || '',
    hollowSpent: list(y.hollow_spent),
    lastVerifiedCommit: typeof y.last_verified_commit === 'string' ? y.last_verified_commit : '',
    history,
  };
}

function writeLoop(phase, st, appendLines = []) {
  const fm = [
    '---',
    `phase_slug: ${phase.slug}`,
    `iter: ${st.iter}`,
    `total_resets: ${st.totalResets}`,
    `status: ${st.status}`,
    `max_iter_per_round: ${st.maxIter}`,
    `max_resets: ${st.maxResets}`,
    `created_at: ${st.createdAt}`,
    `hollow_spent: [${st.hollowSpent.join(', ')}]`,
    `last_verified_commit: ${JSON.stringify(st.lastVerifiedCommit || '')}`,
    '---',
  ].join('\n');
  let body = st.body !== undefined ? st.body : '\n## History\n\n';
  if (!/## History/.test(body)) body = `\n## History\n\n${body}`;
  if (appendLines.length) body = body.trimEnd() + '\n' + appendLines.join('\n') + '\n';
  fs.writeFileSync(loopFile(phase), fm + '\n' + body.replace(/^\n*/, '\n'));
}

function init(phase, { maxIter = 5, maxResets = 3 } = {}) {
  const cur = readLoop(phase);
  if (cur) return cur;
  writeLoop(phase, { iter: 0, totalResets: 0, status: 'running', maxIter, maxResets, createdAt: new Date().toISOString(), hollowSpent: [], lastVerifiedCommit: '', body: '\n## History\n\n' });
  return readLoop(phase);
}

function findingHash(f) {
  const norm = [...f.blockers, ...f.warnings]
    .map((x) => x.text.replace(/\d{4}-\d{2}-\d{2}T\S*/g, '').toLowerCase().trim())
    .filter(Boolean)
    .sort(core.compareStr);
  return crypto.createHash('sha256').update([...new Set(norm)].join('\n')).digest('hex').slice(0, 12);
}

function productChanged(root, since, nonProduct) {
  if (!since) return true;
  const r = core.git(['diff', '--name-only', `${since}..HEAD`], root);
  if (r.code !== 0) return true;
  const files = r.stdout.split('\n').filter(Boolean);
  const ignore = ['.jdi/**', ...(nonProduct || [])];
  return files.some((f) => !core.matchesAny(f, ignore));
}

// Gates that failed on the current HEAD (reports of `jdi-cli gates run`).
function gateFailures(root, phase) {
  const d = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug);
  if (!fs.existsSync(d)) return [];
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  const out = [];
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
    const r = core.readJson(path.join(d, f), null);
    if (!r || !head || r.head !== head) continue;
    for (const x of r.results || []) if (x.status === 'FAIL') out.push(`${r.stack}/${x.gate}`);
    for (const x of r.dod || []) if (x.status === 'FAIL') out.push(`dod ${x.source} ${x.id}`);
  }
  return out;
}

// The loop converged on findings that no longer block (hollow proofs on rows
// that spent their block, or no product change): record it where /jdi-ship
// reads the verdict, with the reason, instead of leaving a BLOCKED line that
// ship refuses.
function overrideVerdict(phase, iter, reason, warnings) {
  const file = path.join(phase.absDir, 'REVIEW.md');
  const text = fs.readFileSync(file, 'utf8');
  const out = text.replace(/^(\*\*(?:Verdict|Veredicto):\*\*\s*)BLOCKED\b/gm, '$1APPROVED_WITH_WARNINGS');
  const note = ['', '## Loop override', '', `Loop iteration ${iter} (LOOP.md): ${reason}.`, 'BLOCKED became APPROVED_WITH_WARNINGS; these findings ship as PR warnings:', ...warnings.map((w) => `- ${w.replace(/^([-*]|\d+\.)\s+/, '')}`), ''].join('\n');
  fs.writeFileSync(file, out.trimEnd() + '\n' + note);
}

// A defect: tagged/untagged defect, a hollow tag without a DoD row (no
// per-row budget to account it to), a gate that failed on this commit, or a
// BLOCKED verdict whose reasons could not be read at all.
function defectsOf(f, verdict, root, phase) {
  const defects = f.blockers.filter((b) => b.kind === 'defect' || b.row === null);
  for (const g of gateFailures(root, phase)) defects.push({ text: `gate ${g} failed`, kind: 'defect', row: null });
  if (verdict === 'BLOCKED' && f.blockers.length === 0 && defects.length === 0) defects.push({ text: 'BLOCKED without a readable Blockers list', kind: 'defect', row: null });
  return defects;
}

// Finding hashes since the last RESET/RESUMED marker.
function roundHashes(history) {
  const out = [];
  for (const h of history) {
    if (h.marker) out.length = 0;
    else out.push(h.hash);
  }
  return out;
}

function decide(s) {
  const prWarnings = s.f.blockers.map((b) => b.text);
  if (s.verdict === 'APPROVED' || s.verdict === 'APPROVED_WITH_WARNINGS') return { status: 'converged', reason: s.verdict };
  if (s.verdict === 'APPROVED_PENDING_MANUAL') return { status: 'pending-manual', reason: 'manual DoD items pending — /jdi-confirm-dod' };
  if (s.defects.length === 0 && s.newHollow.length === 0) return { status: 'converged-with-warnings', reason: `only hollow-proof findings on rows that already spent their block (${s.spentHollow.join(', ') || 'none tagged'}) — list them in the PR`, prWarnings };
  if (s.defects.length === 0 && !s.changed) return { status: 'converged-with-warnings', reason: 'no open defect and no product change since the last verified commit — remaining hollow-proof findings go to the PR', prWarnings };
  if (roundHashes(s.st.history).includes(s.hash)) return { status: 'gate', reason: `oscillation: finding hash ${s.hash} already seen this round` };
  if (s.iter >= s.st.maxIter) return { status: 'gate', reason: `${s.iter} iterations without approval (max_iter_per_round=${s.st.maxIter})` };
  return { status: 'continue', reason: `${s.defects.length} defect(s), ${s.newHollow.length} new hollow-proof row(s)` };
}

function record(phase, { root = process.cwd(), autonomous = false } = {}) {
  const config = core.loadConfig(root);
  const st = init(phase);
  if (['converged', 'killed'].includes(st.status)) return { status: st.status, reason: `LOOP.md already ${st.status}` };
  const text = fs.readFileSync(path.join(phase.absDir, 'REVIEW.md'), 'utf8');
  const v = review.verdictOf(text);
  if (!v.verdict) throw new core.JdiError('REVIEW.md has no verdict — malformed review', 2);
  const f = review.findings(text);
  const hash = findingHash(f);
  const head = core.git(['rev-parse', '--short', 'HEAD'], root).stdout || 'unknown';
  const changed = productChanged(root, st.lastVerifiedCommit, config.loop?.non_product_globs);
  const defects = defectsOf(f, v.verdict, root, phase);
  const hollowRows = [...new Set(f.blockers.filter((b) => b.kind === 'hollow' && b.row !== null).map((b) => b.row))];
  const newHollow = hollowRows.filter((r) => !st.hollowSpent.includes(r));
  const spentHollow = hollowRows.filter((r) => st.hollowSpent.includes(r));
  const iter = st.iter + 1;
  const decision = decide({ st, f, verdict: v.verdict, defects, newHollow, spentHollow, changed, hash, iter });

  const next = { ...st, iter, hollowSpent: [...new Set([...st.hollowSpent, ...newHollow])].sort((a, b) => a - b), lastVerifiedCommit: head };
  if (decision.status.startsWith('converged') || decision.status === 'pending-manual') next.status = 'converged';
  const line = `- iter ${iter}: ${v.verdict}, hash=${hash}, commit=${head}, ts=${new Date().toISOString()}, product=${changed ? 'changed' : 'unchanged'}, defects=${defects.length}, hollow=${hollowRows.length}`;
  writeLoop(phase, next, [line]);
  if (decision.status === 'converged-with-warnings' && v.verdict === 'BLOCKED') {
    overrideVerdict(phase, iter, decision.reason, decision.prWarnings || []);
    decision.reviewOverridden = true;
  }
  if (decision.status === 'gate' && autonomous) decision.autonomous = 'take the Continue branch: run `jdi-cli loop reset <phase> --autonomous --reason "<why>"`';
  return { ...decision, iter, verdict: v.verdict, hash, defects: defects.length, hollowNew: newHollow, hollowSpent: next.hollowSpent };
}

function reset(phase, { root = process.cwd(), reason = 'reset', autonomous = false } = {}) {
  const config = core.loadConfig(root);
  const st = readLoop(phase) || init(phase);
  const max = autonomous ? Number(config.orchestration?.max_resets_autonomous || st.maxResets) : st.maxResets;
  const totalResets = st.totalResets + 1;
  if (totalResets >= max) {
    writeLoop(phase, { ...st, totalResets, status: 'killed' }, [`--- KILLED at ${new Date().toISOString()} (${totalResets}/${max} resets): ${reason} ---`]);
    return { status: 'killed', reason: `${totalResets}/${max} resets — killed work is never shipped` };
  }
  writeLoop(phase, { ...st, totalResets, iter: 0, status: 'running' }, [`--- ${autonomous ? 'AUTO-' : ''}RESET ${totalResets} at ${new Date().toISOString()} (${reason}) ---`]);
  return { status: 'continue', reason: `reset ${totalResets}/${max}` };
}

function main(argv) {
  const [sub, ...rest] = argv;
  const opt = (n) => {
    const i = rest.indexOf(n);
    return i === -1 ? undefined : rest[i + 1];
  };
  const valued = new Set(['--max-iter', '--max-resets', '--reason']);
  const id = rest.find((a, i) => !a.startsWith('--') && !valued.has(rest[i - 1]));
  if (!id) throw new core.JdiError('usage: jdi loop <init|record|reset|status> <phase> ...', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  const autonomous = rest.includes('--autonomous');
  let out;
  if (sub === 'init') out = init(phase, { maxIter: Number(opt('--max-iter') || 5), maxResets: Number(opt('--max-resets') || 3) });
  else if (sub === 'record') out = record(phase, { root, autonomous });
  else if (sub === 'reset') out = reset(phase, { root, reason: opt('--reason') || 'reset', autonomous });
  else if (sub === 'status') {
    const st = readLoop(phase);
    out = st ? { status: st.status, iter: st.iter, total_resets: st.totalResets, max_iter: st.maxIter, max_resets: st.maxResets, hollow_spent: st.hollowSpent, last_verified_commit: st.lastVerifiedCommit } : { status: 'absent' };
  } else throw new core.JdiError('usage: jdi loop <init|record|reset|status> <phase>', 1);
  if (out?.text) delete out.text;
  if (out?.body) delete out.body;
  process.stdout.write(JSON.stringify(out) + '\n');
  return out.status === 'killed' ? 1 : 0;
}

module.exports = { main, init, record, reset, readLoop, findingHash };
