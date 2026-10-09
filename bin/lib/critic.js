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

function selectRows(root, phase, { preflight = false, all = false } = {}) {
  const state = readState(root, phase);
  const baitRows = bait.readResults(root, phase).rows;
  const spent = preflight ? [] : hollowSpent(phase);
  const failed = preflight ? [] : failedRows(root, phase);
  const rows = [];
  const skipped = [];
  for (const it of candidates(root, phase)) {
    const hash = dod.rowHash(it, root);
    const b = baitRows[it.id];
    const s = state.rows[it.id];
    let why = null;
    if (b && b.hash === hash && (b.status === 'CAUGHT' || b.status === 'HOLLOW')) why = `bait ${b.status}`;
    // a spent row is looked at ONCE more (the doer may have fixed the proof);
    // after that its finding is carried as a warning until the proof changes
    else if (spent.includes(it.id) && !(s && s.hollow && !s.spentChecked && s.hash === hash)) why = 'hollow-proof block already spent';
    else if (failed.includes(it.id)) why = 'Verify failed (a defect, not a hollow pass)';
    else if (!all && s && s.hash === hash && !s.hollow) why = 'sound at an unchanged proof';
    if (why) skipped.push({ id: it.id, why });
    else rows.push({ id: it.id, hash, spent: spent.includes(it.id) });
  }
  return { rows, skipped };
}

function mode(config) {
  return config.economy?.critic || 'lean';
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
  const all = opts.all || mode(config) === 'every_verify';
  const sel = selectRows(root, phase, { preflight: opts.preflight, all });
  record(sel.rows);
  if (!sel.rows.length) return { rows: [], skip: sel.skipped.length ? `nothing to examine (${sel.skipped.map((s) => `${s.id}: ${s.why}`).join('; ')})` : 'no automatic CONTEXT DoD row', skipped: sel.skipped };
  const b = brief.build(phase, { role: 'critic', rows: sel.rows.map((r) => r.id).join(','), preflight: opts.preflight, runtime: opts.runtime || 'claude' }, root);
  const out = path.join(root, core.JDI_DIR, 'cache', 'briefs', phase.slug, `critic${opts.preflight ? '-preflight' : ''}.md`);
  core.writeFileEnsured(out, b.text, root);
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  return { rows: sel.rows.map((r) => r.id), skipped: sel.skipped, brief: rel(out), findings: rel(path.join(d, 'findings.json')), tokens: b.tokens };
}

function readFindings(root, phase, planned) {
  const f = path.join(dir(root, phase), 'findings.json');
  const raw = core.readJson(f, null);
  if (!Array.isArray(raw)) return { findings: [], problem: fs.existsSync(f) ? 'findings.json is not a JSON array' : 'no findings.json (critic did not run or failed)' };
  const ok = [];
  for (const x of raw) {
    const row = Number(x?.row);
    if (!planned.includes(row)) continue; // never trust rows that were not asked
    ok.push({ row, hollow: x.hollow === true, objective: x.objective === true, evidence: String(x.evidence || '').replace(/\s+/g, ' ').slice(0, 400) });
  }
  return { findings: ok, problem: null };
}

function apply(phase, opts = {}, root = process.cwd()) {
  const d = dir(root, phase);
  const planFile = core.readJson(path.join(d, 'plan.json'), null);
  const planned = planFile ? planFile.rows.map((r) => r.id) : [];
  const { findings, problem } = planned.length ? readFindings(root, phase, planned) : { findings: [], problem: null };

  // record the examined rows (only when the critic answered for them)
  const state = readState(root, phase);
  for (const f of findings) {
    const pr = planFile.rows.find((r) => r.id === f.row);
    if (pr?.spent) f.spent = true;
    state.rows[f.row] = { hash: pr?.hash, hollow: f.hollow, objective: f.objective, evidence: f.evidence, at: new Date().toISOString(), preflight: Boolean(opts.preflight), spentChecked: Boolean(pr?.spent) };
  }
  core.writeFileEnsured(path.join(d, 'state.json'), JSON.stringify(state, null, 2) + '\n', root);

  // mechanical results: a bait that survived is an objective hollow proof
  const items = candidates(root, phase);
  const baitRows = bait.readResults(root, phase).rows;
  const baitHollow = items.filter((it) => baitRows[it.id]?.status === 'HOLLOW' && baitRows[it.id].hash === dod.rowHash(it, root)).map((it) => ({ row: it.id, hollow: true, objective: true, evidence: `Bait \`${baitRows[it.id].bait}\` survived: the Verify still exits 0 with the criterion broken` }));

  const hollow = [...baitHollow, ...findings.filter((f) => f.hollow && !baitHollow.some((b) => b.row === f.row))];
  // a row whose block the loop already spent never blocks again
  const objective = hollow.filter((f) => f.objective && !f.spent);
  const subjective = hollow.filter((f) => !f.objective || f.spent);

  if (opts.preflight) {
    const fixFile = path.join(d, 'preflight-fixes.md');
    if (!objective.length && !subjective.length) {
      fs.rmSync(fixFile, { force: true });
      return { status: 'clean', examined: findings.length, problem };
    }
    const lines = ['# DoD critic — preflight (before any code)', '', 'Rows whose Verify would pass without proving the criterion. Rewrite the Verify (or add a Bait) so it fails when the criterion is broken:', ''];
    for (const f of objective) lines.push(`- DoD ${f.row} [objective]: ${f.evidence}`);
    for (const f of subjective) lines.push(`- DoD ${f.row} [suspicion]: ${f.evidence}`);
    core.writeFileEnsured(fixFile, lines.join('\n') + '\n', root);
    return { status: objective.length ? 'fix' : 'warn', objective: objective.map((f) => f.row), subjective: subjective.map((f) => f.row), fixes: path.relative(root, fixFile).split(path.sep).join('/'), problem };
  }

  // carried: rows found hollow before whose block is spent — they stay
  // visible as warnings until the proof changes
  const spent = hollowSpent(phase);
  const carried = Object.entries(state.rows)
    .filter(([id, s]) => s.hollow && spent.includes(Number(id)) && !hollow.some((h) => h.row === Number(id)))
    .map(([id, s]) => ({ row: Number(id), evidence: s.evidence }));

  if (!findings.length && !hollow.length && !carried.length) {
    if (!planned.length) return { status: 'skipped', reason: 'nothing examined', problem };
  }
  const verdict = objective.length ? 'BLOCKED' : subjective.length || carried.length ? 'APPROVED_WITH_WARNINGS' : 'APPROVED';
  const seg = ['', '## DoD Critic', '', `Examined: ${findings.length ? findings.map((f) => f.row).join(', ') : 'none'}${baitHollow.length ? ` · bait survived: ${baitHollow.map((b) => b.row).join(', ')}` : ''}${problem ? ` · critic: ${problem}` : ''}`, ''];
  if (objective.length) seg.push('### Blockers', ...objective.map((f) => `- [hollow DoD ${f.row}] ${f.evidence}`), '');
  if (subjective.length || carried.length) seg.push('### Warnings', ...subjective.map((f) => `- [hollow DoD ${f.row}] (${f.spent ? 'block spent' : 'suspicion'}) ${f.evidence}`), ...carried.map((c) => `- [hollow DoD ${c.row}] (block spent, carried) ${c.evidence}`), '');
  seg.push(`**Verdict:** ${verdict}`, '');
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  if (!fs.existsSync(reviewFile)) throw new core.JdiError(`${phase.dir}/REVIEW.md not found — the critic segment goes after the reviewers'`, 2);
  const text = fs.readFileSync(reviewFile, 'utf8').replace(/\n## DoD Critic\n[\s\S]*?(?=\n## (?!#)|(?![\s\S]))/g, '');
  fs.writeFileSync(reviewFile, text.replace(/\s*$/, '\n') + seg.join('\n'));
  return { status: 'applied', verdict, examined: findings.length, objective: objective.map((f) => f.row), subjective: subjective.map((f) => f.row), carried: carried.map((c) => c.row), problem };
}

function main(argv) {
  const [sub, ...rest] = argv;
  const opts = {};
  let id = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--preflight') opts.preflight = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--runtime') opts.runtime = rest[++i];
    else if (a.startsWith('--')) throw new core.JdiError(`unknown flag: ${a}`, 1);
    else id = a;
  }
  if (!id || !['plan', 'apply'].includes(sub)) throw new core.JdiError('usage: jdi critic <plan|apply> <phase> [--preflight] [--all]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  const out = sub === 'plan' ? plan(phase, opts, root) : apply(phase, opts, root);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (sub === 'apply' && opts.preflight && out.status === 'fix') return 3;
  return 0;
}

module.exports = { main, plan, apply, selectRows };
