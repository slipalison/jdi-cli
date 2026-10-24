'use strict';

// `jdi-cli evidence record <phase> --row N --scope iteration|ship [--artifact f] [--note t]`
// `jdi-cli evidence status <phase> [--json]`
//
// A `Verify (evidence):` row (E2E with a real login, a deploy) is never run
// by JDI: someone runs it and the reviewer judges what was recorded. Until
// now nothing said when a recorded run stopped being valid, so a project
// re-ran its 20-minute E2E on every loop round — once just for a change in
// docs/api.md (#70). A record is valid while the row's inputs do not change:
//
//   inputs     the row's `**Inputs:**` globs, or every product file (outside
//              .jdi/ and loop.non_product_globs), plus the files its command
//              names; the row's own hash (criterion, Verify, Inputs,
//              Iteration) too — a changed proof needs a new run
//   scope      `iteration` = the focused run of `**Iteration:**` (enough
//              inside a loop round); `ship` = the full `Verify (evidence):`
//              run. A ship record also covers the iteration.
//
// Records live in the phase folder (`evidence/dod-N.<scope>.json`, tracked):
// part of the audit trail, the same on every clone. `ship` refuses a phase
// created with 0.19+ whose evidence rows lack a fresh ship-scope record
// (`--allow-stale-evidence "<reason>"` records why in SHIPPED.md).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./jdi-core');
const dod = require('./dod');
const gates = require('./gates');

const SCOPES = ['iteration', 'ship'];

// The evidence rows of the phase (CONTEXT) and of the project (PROJECT).
function evidenceRows(root, phase) {
  const evidenceOnly = [...new Set(gates.loadStacks(root).flatMap((s) => s.evidence_only || []))];
  return gates
    .dodItems(root, phase)
    .filter((it) => it.type === 'auto' && it.verify && (it.evidence || evidenceOnly.some((p) => it.verify.command.includes(p))));
}

const rowKey = (it) => (it.source === 'PROJECT' ? `project-${it.id}` : String(it.id));
const recordPath = (phase, it, scope) => path.join(phase.absDir, 'evidence', `dod-${rowKey(it)}.${scope}.json`);

function fingerprint(root, it) {
  return gates.productHash(root, { globs: it.inputs, cmd: `${gates.verifyText(root, it)}\n${it.iteration || ''}` });
}

function findRow(root, phase, row) {
  const rows = evidenceRows(root, phase);
  const it = rows.find((r) => rowKey(r) === String(row) || (r.source === 'CONTEXT' && r.id === Number(row)));
  if (!it) throw new core.JdiError(`no evidence row ${row} in ${phase.slug} (evidence rows: ${rows.map(rowKey).join(', ') || 'none'})`, 2);
  return it;
}

function record(root, phase, { row, scope, artifact = null, note = null }) {
  if (!SCOPES.includes(scope)) throw new core.JdiError('--scope must be iteration or ship', 1);
  const it = findRow(root, phase, row);
  let artifactSha = null;
  if (artifact) {
    const abs = path.resolve(root, artifact);
    if (!fs.existsSync(abs)) throw new core.JdiError(`artifact not found: ${artifact}`, 1);
    artifactSha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  }
  const rec = {
    row: rowKey(it),
    scope,
    head: core.git(['rev-parse', 'HEAD'], root).stdout || null,
    input_hash: fingerprint(root, it),
    row_hash: dod.rowHash(it, root),
    inputs: it.inputs || ['<product>'],
    command: scope === 'iteration' && it.iteration ? it.iteration : it.verify.command,
    artifact: artifact ? artifact.split(path.sep).join('/') : null,
    artifact_sha: artifactSha,
    note: note ? String(note).replaceAll(/\s+/g, ' ').slice(0, 300) : null,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    by: core.git(['config', 'user.name'], root).stdout || 'unknown',
  };
  const f = recordPath(phase, it, scope);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(rec, null, 2) + '\n');
  return { status: 'recorded', ...rec, file: path.relative(root, f).split(path.sep).join('/') };
}

// fresh | stale (with the changed files, when git can name them) | missing
function scopeStatus(root, phase, it, scope, now) {
  const rec = core.readJson(recordPath(phase, it, scope), null);
  if (!rec) return { status: 'missing' };
  if (rec.row_hash !== now.rowHash) return { status: 'stale', reason: 'the row changed after the run', at: rec.at };
  if (rec.input_hash === now.inputHash) return { status: 'fresh', at: rec.at, head: rec.head };
  const diff = rec.head ? core.git(['diff', '--name-only', rec.head], root) : { code: 1 };
  const changed = diff.code === 0 ? diff.stdout.split('\n').filter(Boolean).filter((f) => !f.startsWith('.jdi/')) : [];
  return { status: 'stale', reason: changed.length ? `changed: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}` : 'inputs changed', at: rec.at };
}

function status(root, phase) {
  return evidenceRows(root, phase).map((it) => {
    const now = { rowHash: dod.rowHash(it, root), inputHash: fingerprint(root, it) };
    const ship = scopeStatus(root, phase, it, 'ship', now);
    const iter = scopeStatus(root, phase, it, 'iteration', now);
    // a fresh full run covers the round too
    const iteration = ship.status === 'fresh' ? { ...ship, via: 'ship' } : iter;
    return { row: rowKey(it), source: it.source, criterion: it.criterion.slice(0, 120), iteration_command: it.iteration || null, iteration, ship };
  });
}

function enforced(root, phase) {
  const budgets = require('./budgets');
  const created = budgets.createdWith(root, phase.slug);
  return Boolean(created && budgets.semverGte(created, '0.19.0'));
}

// What ship refuses: evidence rows without a fresh ship-scope record.
function shipProblems(root, phase) {
  return status(root, phase)
    .filter((r) => r.ship.status !== 'fresh')
    .map((r) => `DoD ${r.row}: ship evidence ${r.ship.status}${r.ship.reason ? ` (${r.ship.reason})` : ''}`);
}

function lines(rows) {
  if (!rows.length) return ['no evidence rows'];
  const show = (s) => s.status + (s.reason ? ` (${s.reason})` : '') + (s.via ? ' via ship' : '');
  return rows.map((r) => `DoD ${r.row}: iteration ${show(r.iteration)} · ship ${show(r.ship)} — ${r.criterion}`);
}

function main(argv) {
  const [sub, ...rest] = argv;
  const opt = (n) => {
    const i = rest.indexOf(n);
    return i === -1 ? undefined : rest[i + 1];
  };
  const valued = new Set(['--row', '--scope', '--artifact', '--note']);
  const id = rest.find((a, i) => !a.startsWith('--') && !valued.has(rest[i - 1]));
  if (!id || !['record', 'status'].includes(sub)) throw new core.JdiError('usage: jdi evidence <record|status> <phase> [--row N --scope iteration|ship] [--artifact f] [--note t] [--json]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  if (sub === 'record') {
    if (!opt('--row')) throw new core.JdiError('evidence record needs --row N', 1);
    process.stdout.write(JSON.stringify(record(root, phase, { row: opt('--row'), scope: opt('--scope') || 'ship', artifact: opt('--artifact'), note: opt('--note') })) + '\n');
    return 0;
  }
  const rows = status(root, phase);
  process.stdout.write((rest.includes('--json') ? JSON.stringify(rows, null, 2) : lines(rows).join('\n')) + '\n');
  // exit 2 only where ship enforces it (phases created with 0.19+)
  return enforced(root, phase) && rows.some((r) => r.ship.status !== 'fresh') ? 2 : 0;
}

module.exports = { main, record, status, shipProblems, evidenceRows, enforced };
