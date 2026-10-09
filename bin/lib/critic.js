'use strict';

// `jdi-cli critic plan  <phase> [--preflight] [--all] [--runtime claude|other]`
// `jdi-cli critic apply <phase> [--preflight]`
//
// The DoD critic asks one question per automatic DoD row: does its `Verify:`
// PROVE the criterion, or merely exit 0? Measured on a real project, the
// critic re-judged every row on every verify round, through the project
// reviewer (whose prompt is large) — and /jdi-issue forced it each round.
//
// Lean cadence (config `economy.critic`: "lean" default, "every_verify", "off"):
//   - preflight: once, after /jdi-discuss, before any code — a hollow proof
//     caught here costs an asker fix, not loop iterations;
//   - verify: only rows never examined, rows whose proof changed (hash of
//     criterion + Verify + Bait + script), and rows found hollow last time
//     (the doer may have strengthened the test behind them). Rows sound at an
//     unchanged hash, rows with a bait result (mechanical), rows whose Verify
//     FAILED (that is a defect, not a hollow pass) are not re-examined; a row
//     that already spent its hollow-proof block in the ralph loop is looked
//     at ONCE more (the doer may have fixed it), can no longer block, and is
//     then carried as a warning until its proof changes.
// Only CONTEXT.md rows: PROJECT § DoD rows are the same in every phase.
//
// `plan` prints JSON {rows, brief, tokens} — or {rows: [], skip} when there is
// nothing to examine (do not spawn). The jdi-dod-critic agent writes
// .jdi/cache/critic/<slug>/findings.json: [{row, hollow, objective, evidence}].
// `apply` validates it, merges the bait results, records the examined hashes
// and (verify) appends ONE `## DoD Critic` segment to REVIEW.md that can only
// tighten the verdict, or (preflight) writes the fix list for the asker.
// Fail-open: missing or malformed findings change nothing.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const dod = require('./dod');
const brief = require('./brief');
const bait = require('./bait');

function dir(root, phase) {
  return path.join(root, core.JDI_DIR, 'cache', 'critic', phase.slug);
}

function readState(root, phase) {
  return core.readJson(path.join(dir(root, phase), 'state.json'), null) || { rows: {} };
}

function hollowSpent(phase) {
  const f = path.join(phase.absDir, 'LOOP.md');
  if (!fs.existsSync(f)) return [];
  const m = /^hollow_spent:\s*\[([^\]]*)\]/m.exec(fs.readFileSync(f, 'utf8'));
  return m ? m[1].split(',').map((x) => Number(x.trim())).filter(Boolean) : [];
}

function failedRows(root, phase) {
  const r = core.readJson(path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, 'dod.json'), null);
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  if (!r || r.head !== head) return [];
  return (r.dod || []).filter((x) => x.source === 'CONTEXT' && x.status === 'FAIL').map((x) => x.id);
}

function candidates(root, phase) {
  const file = path.join(phase.absDir, 'CONTEXT.md');
  if (!fs.existsSync(file)) throw new core.JdiError(`${phase.dir}/CONTEXT.md not found`, 2);
  return dod.parse(fs.readFileSync(file, 'utf8'), file).items.filter((it) => it.type === 'auto' && it.verify && !it.evidence);
}

// Why a candidate row is NOT examined this round (null: examine it).
function skipReason(it, hash, ctx) {
  const b = ctx.baitRows[it.id];
  const s = ctx.state.rows[it.id];
  if (b?.hash === hash && (b.status === 'CAUGHT' || b.status === 'HOLLOW')) return `bait ${b.status}`;
  // a spent row is looked at ONCE more (the doer may have fixed the proof);
  // after that its finding is carried as a warning until the proof changes
  const recheckSpent = s?.hollow && !s.spentChecked && s.hash === hash;
  if (ctx.spent.includes(it.id) && !recheckSpent) return 'hollow-proof block already spent';
  if (ctx.failed.includes(it.id)) return 'Verify failed (a defect, not a hollow pass)';
  if (!ctx.all && s?.hash === hash && !s.hollow) return 'sound at an unchanged proof';
  return null;
}

function selectRows(root, phase, { preflight = false, all = false } = {}) {
  const ctx = {
    all,
    state: readState(root, phase),
    baitRows: bait.readResults(root, phase).rows,
    spent: preflight ? [] : hollowSpent(phase),
    failed: preflight ? [] : failedRows(root, phase),
  };
  const rows = [];
  const skipped = [];
  for (const it of candidates(root, phase)) {
    const hash = dod.rowHash(it, root);
    const why = skipReason(it, hash, ctx);
    if (why) skipped.push({ id: it.id, why });
    else rows.push({ id: it.id, hash, spent: ctx.spent.includes(it.id) });
  }
  return { rows, skipped };
}

function mode(config) {
  return config.economy?.critic || 'lean';
}

const relPath = (root, p) => path.relative(root, p).split(path.sep).join('/');

function skipText(skipped) {
  if (!skipped.length) return 'no automatic CONTEXT DoD row';
  return `nothing to examine (${skipped.map((x) => x.id + ': ' + x.why).join('; ')})`;
}

function plan(phase, opts = {}, root = process.cwd()) {
  const config = core.loadConfig(root);
  const d = dir(root, phase);
  // every plan starts a new round: no stale findings can be applied later
  fs.rmSync(path.join(d, 'findings.json'), { force: true });
  const record = (rows) => core.writeFileEnsured(path.join(d, 'plan.json'), JSON.stringify({ preflight: Boolean(opts.preflight), rows }, null, 2) + '\n', root);
  if (mode(config) === 'off') {
    record([]);
    return { rows: [], skip: 'economy.critic is "off"' };
  }
  const sel = selectRows(root, phase, { preflight: opts.preflight, all: opts.all || mode(config) === 'every_verify' });
  record(sel.rows);
  if (!sel.rows.length) return { rows: [], skip: skipText(sel.skipped), skipped: sel.skipped };
  const b = brief.build(phase, { role: 'critic', rows: sel.rows.map((r) => r.id).join(','), preflight: opts.preflight, runtime: opts.runtime || 'claude' }, root);
  const out = path.join(root, core.JDI_DIR, 'cache', 'briefs', phase.slug, opts.preflight ? 'critic-preflight.md' : 'critic.md');
  core.writeFileEnsured(out, b.text, root);
  return { rows: sel.rows.map((r) => r.id), skipped: sel.skipped, brief: relPath(root, out), findings: relPath(root, path.join(d, 'findings.json')), tokens: b.tokens };
}

function readFindings(root, phase, planned) {
  const f = path.join(dir(root, phase), 'findings.json');
  const raw = core.readJson(f, null);
  if (!Array.isArray(raw)) return { findings: [], problem: fs.existsSync(f) ? 'findings.json is not a JSON array' : 'no findings.json (critic did not run or failed)' };
  const findings = raw
    .map((x) => ({ row: Number(x?.row), hollow: x?.hollow === true, objective: x?.objective === true, evidence: String(x?.evidence || '').replaceAll(/\s+/g, ' ').slice(0, 400) }))
    .filter((x) => planned.includes(x.row)); // never trust rows that were not asked
  return { findings, problem: null };
}

// Record the examined rows (only those the critic answered for).
function recordExamined(root, phase, planFile, findings, preflight) {
  const state = readState(root, phase);
  for (const f of findings) {
    const pr = planFile.rows.find((r) => r.id === f.row);
    if (pr?.spent) f.spent = true;
    state.rows[f.row] = { hash: pr?.hash, hollow: f.hollow, objective: f.objective, evidence: f.evidence, at: new Date().toISOString(), preflight: Boolean(preflight), spentChecked: Boolean(pr?.spent) };
  }
  core.writeFileEnsured(path.join(dir(root, phase), 'state.json'), JSON.stringify(state, null, 2) + '\n', root);
  return state;
}

// Mechanical results: a bait that survived is an objective hollow proof.
function baitHollows(root, phase) {
  const baitRows = bait.readResults(root, phase).rows;
  return candidates(root, phase)
    .filter((it) => baitRows[it.id]?.status === 'HOLLOW' && baitRows[it.id].hash === dod.rowHash(it, root))
    .map((it) => ({ row: it.id, hollow: true, objective: true, evidence: 'Bait `' + baitRows[it.id].bait + '` survived: the Verify still exits 0 with the criterion broken' }));
}

function preflightResult(root, phase, objective, subjective, examined, problem) {
  const fixFile = path.join(dir(root, phase), 'preflight-fixes.md');
  if (!objective.length && !subjective.length) {
    fs.rmSync(fixFile, { force: true });
    return { status: 'clean', examined, problem };
  }
  const lines = [
    '# DoD critic — preflight (before any code)',
    '',
    'Rows whose Verify would pass without proving the criterion. Rewrite the Verify (or add a Bait) so it fails when the criterion is broken:',
    '',
    ...objective.map((f) => `- DoD ${f.row} [objective]: ${f.evidence}`),
    ...subjective.map((f) => `- DoD ${f.row} [suspicion]: ${f.evidence}`),
  ];
  core.writeFileEnsured(fixFile, lines.join('\n') + '\n', root);
  return { status: objective.length ? 'fix' : 'warn', objective: objective.map((f) => f.row), subjective: subjective.map((f) => f.row), fixes: relPath(root, fixFile), problem };
}

function verdictOf(objective, warnings) {
  if (objective.length) return 'BLOCKED';
  return warnings ? 'APPROVED_WITH_WARNINGS' : 'APPROVED';
}

function segmentLines(r) {
  const examined = r.findings.length ? r.findings.map((f) => f.row).join(', ') : 'none';
  const baitNote = r.baitHollow.length ? ' · bait survived: ' + r.baitHollow.map((b) => b.row).join(', ') : '';
  const problemNote = r.problem ? ' · critic: ' + r.problem : '';
  const lines = ['', '## DoD Critic', '', `Examined: ${examined}${baitNote}${problemNote}`, ''];
  if (r.objective.length) lines.push('### Blockers', ...r.objective.map((f) => `- [hollow DoD ${f.row}] ${f.evidence}`), '');
  if (r.subjective.length || r.carried.length) {
    lines.push(
      '### Warnings',
      ...r.subjective.map((f) => `- [hollow DoD ${f.row}] (${f.spent ? 'block spent' : 'suspicion'}) ${f.evidence}`),
      ...r.carried.map((c) => `- [hollow DoD ${c.row}] (block spent, carried) ${c.evidence}`),
      '',
    );
  }
  lines.push(`**Verdict:** ${r.verdict}`, '');
  return lines;
}

// REVIEW.md without a previous `## DoD Critic` segment (it ends at the next
// `## ` heading), so re-applying replaces it instead of stacking it.
function withoutCriticSegment(text) {
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (line === '## DoD Critic') skipping = true;
    else if (skipping && line.startsWith('## ')) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function writeSegment(phase, lines) {
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  if (!fs.existsSync(reviewFile)) throw new core.JdiError(`${phase.dir}/REVIEW.md not found — the critic segment goes after the reviewers'`, 2);
  const text = withoutCriticSegment(fs.readFileSync(reviewFile, 'utf8'));
  fs.writeFileSync(reviewFile, text.trimEnd() + '\n' + lines.join('\n'));
}

function apply(phase, opts = {}, root = process.cwd()) {
  const planFile = core.readJson(path.join(dir(root, phase), 'plan.json'), null);
  const planned = planFile ? planFile.rows.map((r) => r.id) : [];
  const { findings, problem } = planned.length ? readFindings(root, phase, planned) : { findings: [], problem: null };
  const state = recordExamined(root, phase, planFile || { rows: [] }, findings, opts.preflight);
  const baitHollow = baitHollows(root, phase);
  const hollow = [...baitHollow, ...findings.filter((f) => f.hollow && !baitHollow.some((b) => b.row === f.row))];
  // a row whose block the loop already spent never blocks again
  const objective = hollow.filter((f) => f.objective && !f.spent);
  const subjective = hollow.filter((f) => !f.objective || f.spent);
  if (opts.preflight) return preflightResult(root, phase, objective, subjective, findings.length, problem);

  // carried: rows found hollow before whose block is spent — they stay
  // visible as warnings until the proof changes
  const spent = hollowSpent(phase);
  const carried = Object.entries(state.rows)
    .filter(([id, s]) => s.hollow && spent.includes(Number(id)) && !hollow.some((h) => h.row === Number(id)))
    .map(([id, s]) => ({ row: Number(id), evidence: s.evidence }));
  if (!planned.length && !hollow.length && !carried.length) return { status: 'skipped', reason: 'nothing examined', problem };
  const verdict = verdictOf(objective, subjective.length || carried.length);
  writeSegment(phase, segmentLines({ findings, baitHollow, problem, objective, subjective, carried, verdict }));
  return { status: 'applied', verdict, examined: findings.length, objective: objective.map((f) => f.row), subjective: subjective.map((f) => f.row), carried: carried.map((c) => c.row), problem };
}

function parseArgs(rest) {
  const opts = {};
  let id = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--preflight' || a === '--all') opts[a.slice(2)] = true;
    else if (a === '--runtime') opts.runtime = rest[++i];
    else if (a.startsWith('--')) throw new core.JdiError(`unknown flag: ${a}`, 1);
    else id = a;
  }
  return { id, opts };
}

function main(argv) {
  const [sub, ...rest] = argv;
  const { id, opts } = parseArgs(rest);
  if (!id || !['plan', 'apply'].includes(sub)) throw new core.JdiError('usage: jdi critic <plan|apply> <phase> [--preflight] [--all]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  const out = sub === 'plan' ? plan(phase, opts, root) : apply(phase, opts, root);
  process.stdout.write(JSON.stringify(out) + '\n');
  return sub === 'apply' && opts.preflight && out.status === 'fix' ? 3 : 0;
}

module.exports = { main, plan, apply, selectRows };
