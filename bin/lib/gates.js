'use strict';

// `jdi-cli gates run <phase> [--stack <name>] [--only build,test,coverage,lint,dod]
//                    [--changed-since <sha>] [--json]`
// `jdi-cli gates show <phase> [--stack <name>] [--failures]`
//
// Runs the deterministic quality gates (build, tests, coverage, lint) and the
// automatic Definition of Done checks OUTSIDE any agent's context, and writes
// .jdi/cache/gates/<slug>/<stack>.json (status, duration, short failure
// excerpt, path to the full log). Reviewers read the JSON instead of running
// long commands themselves.
//
// Why: measured on a real project, sub-agents cache their prompt for 5
// minutes; a 10-minute test suite run inside a 500k-token reviewer made the
// next call re-write the whole context — 11% of all tokens went to that alone.
// And each multi-stack reviewer ran the whole DoD again.
//
// Stack config: .jdi/stacks/<name>.json (`jdi-cli template stack`): gate
// commands, env, path_prepend, coverage_runs_tests (run the suite once),
// evidence_only (commands never executed here — e.g. E2E with a real login;
// judged from recorded evidence), timeout_min.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('./jdi-core');
const dod = require('./dod');

const ORDER = ['build', 'test', 'coverage', 'lint'];

function stacksDir(root) {
  return path.join(root, core.JDI_DIR, 'stacks');
}

function loadStacks(root) {
  const d = stacksDir(root);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, ...core.readJson(path.join(d, f), {}), id: f.slice(0, -5) }));
}

function findStack(stacks, name) {
  return stacks.find((s) => s.id === name || s.name === name || s.agent === name) || null;
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function envFor(stacks) {
  const env = { ...process.env };
  const prepend = [];
  for (const s of stacks) {
    Object.assign(env, s.env || {});
    for (const p of s.path_prepend || []) prepend.push(expandHome(p));
  }
  if (prepend.length) env.PATH = [...new Set(prepend)].join(path.delimiter) + path.delimiter + (env.PATH || '');
  return env;
}

function shellFor(stack) {
  const sh = stack?.shell || 'bash';
  if (sh === 'pwsh' || sh === 'powershell') return { cmd: sh === 'pwsh' ? 'pwsh' : 'powershell', args: (c) => ['-NoProfile', '-Command', c] };
  return { cmd: 'bash', args: (c) => ['-c', c] };
}

function tail(text, n = 20) {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n').trim();
}

function run(cmd, { root, cwd = root, env, shell, timeoutMin, log }) {
  const t0 = Date.now();
  const r = spawnSync(shell.cmd, shell.args(cmd), {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: Math.round((timeoutMin || 30) * 60 * 1000),
  });
  const out = `$ ${cmd}\n${r.stdout || ''}${r.stderr || ''}`;
  core.writeFileEnsured(log, out, root);
  const duration = Math.round((Date.now() - t0) / 100) / 10;
  if (r.error?.code === 'ENOENT') return { exit: 127, duration, out, error: `shell '${shell.cmd}' not found` };
  if (r.signal) return { exit: 124, duration, out, error: `killed by ${r.signal} (timeout ${timeoutMin} min?)` };
  return { exit: r.status ?? 1, duration, out };
}

function changedInScope(root, sha, globs) {
  const r = core.git(['diff', '--name-only', `${sha}..HEAD`], root);
  if (r.code !== 0) return null;
  const files = r.stdout.split('\n').filter(Boolean);
  return globs?.length ? files.filter((f) => core.matchesAny(f, globs)) : files;
}

function isEvidenceOnly(cmd, patterns) {
  return (patterns || []).some((p) => cmd.includes(p));
}

function dodItems(root, phase) {
  const items = [];
  const project = path.join(root, core.JDI_DIR, 'PROJECT.md');
  for (const [src, file] of [['PROJECT', project], ['CONTEXT', path.join(phase.absDir, 'CONTEXT.md')]]) {
    if (!fs.existsSync(file)) continue;
    for (const it of dod.parse(fs.readFileSync(file, 'utf8'), file).items) items.push({ ...it, source: src });
  }
  return items;
}

// --changed-since: a stack with nothing changed in its scope is SKIPPED.
function skippedResults(root, stack, opts, only) {
  if (!opts.changedSince) return null;
  const changed = changedInScope(root, opts.changedSince, stack.file_glob);
  if (changed?.length !== 0) return null;
  const scope = [stack.file_glob || []].flat().join(', ');
  return ORDER.filter((g) => stack.gates?.[g] && (!only || only.has(g))).map((g) => ({ gate: g, status: 'SKIPPED', reason: `nothing changed in ${scope} since ${opts.changedSince}` }));
}

function execGate(ctx, name, cmd) {
  const log = path.join(ctx.gateDir, ctx.label, `${name}.log`);
  const r = run(cmd, { root: ctx.root, env: ctx.env, shell: ctx.shell, timeoutMin: ctx.timeoutMin, log });
  const status = r.exit === 0 ? 'PASS' : 'FAIL';
  const res = { gate: name, status, exit: r.exit, duration_s: r.duration, log: path.relative(ctx.root, log).split(path.sep).join('/') };
  if (status === 'FAIL') res.excerpt = (r.error ? r.error + '\n' : '') + tail(r.out);
  return res;
}

// Tests run once: inside coverage when the stack says so (and only on a
// coverage failure again alone, to tell a test failure from the threshold).
function testAndCoverage(ctx, stack, want) {
  const g = stack.gates || {};
  if (!(stack.coverage_runs_tests && want('coverage') && g.test)) {
    return [want('test') && execGate(ctx, 'test', g.test), want('coverage') && execGate(ctx, 'coverage', g.coverage)].filter(Boolean);
  }
  const cov = execGate(ctx, 'coverage', g.coverage);
  if (cov.status === 'PASS') return [cov, { gate: 'test', status: 'PASS', reason: 'ran inside the coverage gate (coverage_runs_tests)' }];
  return [cov, want('test') && execGate(ctx, 'test', g.test)].filter(Boolean);
}

function stackResults(ctx, stack, only) {
  const g = stack.gates || {};
  const want = (k) => g[k] && (!only || only.has(k));
  const results = want('build') ? [execGate(ctx, 'build', g.build)] : [];
  if (results.some((x) => x.status === 'FAIL')) {
    return [...results, ...['test', 'coverage', 'lint'].filter(want).map((k) => ({ gate: k, status: 'SKIPPED', reason: 'build failed (fail-fast)' }))];
  }
  results.push(...testAndCoverage(ctx, stack, want));
  if (want('lint')) {
    const lint = execGate(ctx, 'lint', g.lint);
    if (lint.status === 'FAIL' && !stack.lint_blocks) lint.status = 'WARN';
    results.push(lint);
  }
  return results;
}

const DOD_STATIC = { manual: 'MANUAL_REQUIRED', deferred: 'DEFERRED' };

function dodResult(ctx, it, evidence) {
  const base = { id: it.id, source: it.source, type: it.type, criterion: it.criterion.slice(0, 160) };
  if (DOD_STATIC[it.type]) return { ...base, status: DOD_STATIC[it.type] };
  if (!it.verify) return { ...base, status: 'INCONCLUSIVE', reason: 'no Verify' };
  if (it.evidence || isEvidenceOnly(it.verify.command, evidence)) return { ...base, status: 'EVIDENCE', reason: 'not executed here (external effect) — judge by the recorded evidence' };
  const log = path.join(ctx.gateDir, 'dod', `${it.source.toLowerCase()}-${it.id}.log`);
  const r = run(it.verify.command, { root: ctx.root, env: ctx.env, shell: ctx.shell, timeoutMin: ctx.timeoutMin, log });
  const res = { ...base, status: r.exit === 0 ? 'PASS' : 'FAIL', exit: r.exit, duration_s: r.duration, log: path.relative(ctx.root, log).split(path.sep).join('/') };
  if (res.status === 'FAIL') res.excerpt = (r.error ? r.error + '\n' : '') + tail(r.out, 12);
  return res;
}

function runGates(phase, opts, root = process.cwd()) {
  const stacks = loadStacks(root);
  const only = opts.only ? new Set(opts.only) : null;
  const wantDod = only ? only.has('dod') : false;
  const stack = opts.stack ? findStack(stacks, opts.stack) : null;
  if (opts.stack && !stack) throw new core.JdiError(`no stack '${opts.stack}' in .jdi/stacks/ (create it with \`jdi-cli template stack\`)`, 3);
  if (!opts.stack && !wantDod) throw new core.JdiError('--stack <name> is required (or --only dod for the Definition of Done)', 1);
  const gateDir = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug);
  const label = stack ? stack.id : 'dod';
  const ctx = { root, gateDir, label, env: envFor(stack ? [stack] : stacks), shell: shellFor(stack || stacks[0]), timeoutMin: (stack || stacks[0])?.timeout_min || 30 };
  const head = core.git(['rev-parse', 'HEAD'], root).stdout || null;
  const report = { phase: phase.slug, stack: label, head, started: new Date().toISOString(), base: opts.changedSince || null, results: [], dod: [] };
  if (stack) report.results = skippedResults(root, stack, opts, only) || stackResults(ctx, stack, only);
  if (wantDod) {
    const evidence = [...new Set(stacks.flatMap((s) => s.evidence_only || []))];
    report.dod = dodItems(root, phase).map((it) => dodResult(ctx, it, evidence));
  }
  const failed = report.results.some((x) => x.status === 'FAIL') || report.dod.some((x) => x.status === 'FAIL');
  report.finished = new Date().toISOString();
  report.status = failed ? 'FAIL' : 'PASS';
  const out = path.join(gateDir, `${label}.json`);
  core.writeFileEnsured(out, JSON.stringify(report, null, 2) + '\n', root);
  report.file = path.relative(root, out).split(path.sep).join('/');
  return report;
}

function resultLine(r) {
  const took = r.duration_s === undefined ? '' : ` ${r.duration_s}s`;
  const why = r.reason ? ` (${r.reason})` : '';
  return `  ${r.gate.padEnd(9)} ${r.status}${took}${why}`;
}

function dodLines(dodRows) {
  if (!dodRows.length) return [];
  const c = (s) => dodRows.filter((d) => d.status === s).length;
  return [
    `  dod       PASS ${c('PASS')} · FAIL ${c('FAIL')} · EVIDENCE ${c('EVIDENCE')} · MANUAL ${c('MANUAL_REQUIRED')} · INCONCLUSIVE ${c('INCONCLUSIVE')}`,
    ...dodRows.filter((x) => x.status === 'FAIL').map((d) => `    FAIL ${d.source} ${d.id}: ${d.log}`),
  ];
}

function summary(report) {
  return [`gates ${report.phase}/${report.stack}: ${report.status} — ${report.file}`, ...report.results.map(resultLine), ...dodLines(report.dod)].join('\n');
}

function parseArgs(rest) {
  const opts = {};
  let id = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--stack') opts.stack = rest[++i];
    else if (a === '--only') opts.only = rest[++i].split(',').map((x) => x.trim());
    else if (a === '--changed-since') opts.changedSince = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--failures') opts.failures = true;
    else if (a.startsWith('--')) throw new core.JdiError(`unknown flag: ${a}`, 1);
    else id = a;
  }
  return { id, opts };
}

function showCmd(root, phase, opts) {
  const f = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, `${opts.stack || 'dod'}.json`);
  const report = core.readJson(f, null);
  if (!report) throw new core.JdiError(`no gate results at ${path.relative(root, f)}`, 2);
  report.file = path.relative(root, f);
  if (opts.failures) return failuresCmd(report);
  process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : summary(report)) + '\n');
  return 0;
}

// The work list of a fix round: only what failed, with its excerpt.
function failuresCmd(report) {
  const gateFails = (report.results || []).filter((x) => x.status === 'FAIL').map((x) => ({ ...x, what: `${report.stack}/${x.gate}` }));
  const dodFails = (report.dod || []).filter((x) => x.status === 'FAIL').map((x) => ({ ...x, what: `DoD ${x.source} ${x.id}: ${x.criterion}` }));
  const fails = [...gateFails, ...dodFails];
  if (!fails.length) {
    console.log(`${report.stack}: no failures (head ${String(report.head).slice(0, 10)})`);
    return 0;
  }
  for (const x of fails) {
    const log = x.log ? ' (log: ' + x.log + ')' : '';
    const excerpt = (x.excerpt || '').split('\n').map((l) => '    ' + l).join('\n');
    console.log(`- FAIL ${x.what}${log}\n${excerpt}`);
  }
  return 1;
}

function main(argv) {
  const [sub, ...rest] = argv;
  const { id, opts } = parseArgs(rest);
  if (!id) throw new core.JdiError('usage: jdi gates <run|show> <phase> [--stack <name>] [--only ...] [--changed-since <sha>]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  if (sub === 'show') return showCmd(root, phase, opts);
  if (sub !== 'run') throw new core.JdiError('usage: jdi gates <run|show> <phase> ...', 1);
  const report = runGates(phase, opts, root);
  process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : summary(report)) + '\n');
  return report.status === 'PASS' ? 0 : 1;
}

module.exports = { main, runGates, loadStacks, findStack, summary, run, envFor, shellFor, tail, dodItems, changedInScope };
