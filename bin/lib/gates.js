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
  const sh = (stack && stack.shell) || 'bash';
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
  if (r.error && r.error.code === 'ENOENT') return { exit: 127, duration, out, error: `shell '${shell.cmd}' not found` };
  if (r.signal) return { exit: 124, duration, out, error: `killed by ${r.signal} (timeout ${timeoutMin} min?)` };
  return { exit: r.status ?? 1, duration, out };
}

function changedInScope(root, sha, globs) {
  const r = core.git(['diff', '--name-only', `${sha}..HEAD`], root);
  if (r.code !== 0) return null;
  const files = r.stdout.split('\n').filter(Boolean);
  return globs && globs.length ? files.filter((f) => core.matchesAny(f, globs)) : files;
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

function runGates(phase, opts, root = process.cwd()) {
  const stacks = loadStacks(root);
  const only = opts.only ? new Set(opts.only) : null;
  const wantDod = only ? only.has('dod') : false;
  const stack = opts.stack ? findStack(stacks, opts.stack) : null;
  if (opts.stack && !stack) throw new core.JdiError(`no stack '${opts.stack}' in .jdi/stacks/ (create it with \`jdi-cli template stack\`)`, 3);
  if (!opts.stack && !wantDod) throw new core.JdiError('--stack <name> is required (or --only dod for the Definition of Done)', 1);
  const gateDir = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug);
  const label = stack ? stack.id : 'dod';
  const env = envFor(stack ? [stack] : stacks);
  const shell = shellFor(stack || stacks[0]);
  const timeoutMin = (stack || stacks[0] || {}).timeout_min || 30;
  const head = core.git(['rev-parse', 'HEAD'], root).stdout || null;
  const report = { phase: phase.slug, stack: label, head, started: new Date().toISOString(), base: opts.changedSince || null, results: [], dod: [] };

  if (stack && opts.changedSince) {
    const changed = changedInScope(root, opts.changedSince, stack.file_glob);
    if (changed && changed.length === 0) {
      for (const g of ORDER) {
        if (stack.gates?.[g] && (!only || only.has(g))) report.results.push({ gate: g, status: 'SKIPPED', reason: `nothing changed in ${[].concat(stack.file_glob || []).join(', ')} since ${opts.changedSince}` });
      }
    }
  }
  if (stack && report.results.length === 0) {
    const g = stack.gates || {};
    const want = (k) => g[k] && (!only || only.has(k));
    const exec = (name, cmd) => {
      const log = path.join(gateDir, label, `${name}.log`);
      const r = run(cmd, { root, env, shell, timeoutMin, log });
      const status = r.exit === 0 ? 'PASS' : 'FAIL';
      const res = { gate: name, status, exit: r.exit, duration_s: r.duration, log: path.relative(root, log).split(path.sep).join('/') };
      if (status === 'FAIL') res.excerpt = (r.error ? r.error + '\n' : '') + tail(r.out);
      return res;
    };
    if (want('build')) report.results.push(exec('build', g.build));
    const buildFailed = report.results.some((x) => x.gate === 'build' && x.status === 'FAIL');
    if (!buildFailed) {
      if (stack.coverage_runs_tests && want('coverage') && g.test) {
        const cov = exec('coverage', g.coverage);
        report.results.push(cov);
        if (cov.status === 'PASS') report.results.push({ gate: 'test', status: 'PASS', reason: 'ran inside the coverage gate (coverage_runs_tests)' });
        else if (want('test')) report.results.push(exec('test', g.test)); // tell test failure from threshold failure
      } else {
        if (want('test')) report.results.push(exec('test', g.test));
        if (want('coverage')) report.results.push(exec('coverage', g.coverage));
      }
      if (want('lint')) {
        const lint = exec('lint', g.lint);
        if (lint.status === 'FAIL' && !stack.lint_blocks) lint.status = 'WARN';
        report.results.push(lint);
      }
    } else {
      for (const k of ['test', 'coverage', 'lint']) if (want(k)) report.results.push({ gate: k, status: 'SKIPPED', reason: 'build failed (fail-fast)' });
    }
  }

  if (wantDod) {
    const evidence = [...new Set(stacks.flatMap((s) => s.evidence_only || []))];
    for (const it of dodItems(root, phase)) {
      const base = { id: it.id, source: it.source, type: it.type, criterion: it.criterion.slice(0, 160) };
      if (it.type === 'manual') {
        report.dod.push({ ...base, status: 'MANUAL_REQUIRED' });
        continue;
      }
      if (it.type === 'deferred') {
        report.dod.push({ ...base, status: 'DEFERRED' });
        continue;
      }
      if (!it.verify) {
        report.dod.push({ ...base, status: 'INCONCLUSIVE', reason: 'no Verify' });
        continue;
      }
      if (it.evidence || isEvidenceOnly(it.verify.command, evidence)) {
        report.dod.push({ ...base, status: 'EVIDENCE', reason: 'not executed here (external effect) — judge by the recorded evidence' });
        continue;
      }
      const log = path.join(gateDir, 'dod', `${it.source.toLowerCase()}-${it.id}.log`);
      const r = run(it.verify.command, { root, env, shell, timeoutMin, log });
      const res = { ...base, status: r.exit === 0 ? 'PASS' : 'FAIL', exit: r.exit, duration_s: r.duration, log: path.relative(root, log).split(path.sep).join('/') };
      if (res.status === 'FAIL') res.excerpt = (r.error ? r.error + '\n' : '') + tail(r.out, 12);
      report.dod.push(res);
    }
  }

  const failed = report.results.some((x) => x.status === 'FAIL') || report.dod.some((x) => x.status === 'FAIL');
  report.finished = new Date().toISOString();
  report.status = failed ? 'FAIL' : 'PASS';
  const out = path.join(gateDir, `${label}.json`);
  core.writeFileEnsured(out, JSON.stringify(report, null, 2) + '\n', root);
  report.file = path.relative(root, out).split(path.sep).join('/');
  return report;
}

function summary(report) {
  const lines = [`gates ${report.phase}/${report.stack}: ${report.status} — ${report.file}`];
  for (const r of report.results) lines.push(`  ${r.gate.padEnd(9)} ${r.status}${r.duration_s !== undefined ? ` ${r.duration_s}s` : ''}${r.reason ? ` (${r.reason})` : ''}`);
  if (report.dod.length) {
    const c = (s) => report.dod.filter((d) => d.status === s).length;
    lines.push(`  dod       PASS ${c('PASS')} · FAIL ${c('FAIL')} · EVIDENCE ${c('EVIDENCE')} · MANUAL ${c('MANUAL_REQUIRED')} · INCONCLUSIVE ${c('INCONCLUSIVE')}`);
    for (const d of report.dod.filter((x) => x.status === 'FAIL')) lines.push(`    FAIL ${d.source} ${d.id}: ${d.log}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const [sub, ...rest] = argv;
  const opts = {};
  let id = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--stack') opts.stack = rest[++i];
    else if (a === '--only') opts.only = rest[++i].split(',').map((s) => s.trim());
    else if (a === '--changed-since') opts.changedSince = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--failures') opts.failures = true;
    else if (a.startsWith('--')) throw new core.JdiError(`unknown flag: ${a}`, 1);
    else id = a;
  }
  if (!id) throw new core.JdiError('usage: jdi gates <run|show> <phase> [--stack <name>] [--only ...] [--changed-since <sha>]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  if (sub === 'run') {
    const report = runGates(phase, opts, root);
    process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : summary(report)) + '\n');
    return report.status === 'PASS' ? 0 : 1;
  }
  if (sub === 'show') {
    const f = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, `${opts.stack || 'dod'}.json`);
    const report = core.readJson(f, null);
    if (!report) throw new core.JdiError(`no gate results at ${path.relative(root, f)}`, 2);
    report.file = path.relative(root, f);
    if (opts.failures) {
      // the work list of a fix round: only what failed, with its excerpt
      const fails = [...(report.results || []).filter((x) => x.status === 'FAIL').map((x) => ({ what: `${report.stack}/${x.gate}`, ...x })), ...(report.dod || []).filter((x) => x.status === 'FAIL').map((x) => ({ what: `DoD ${x.source} ${x.id}: ${x.criterion}`, ...x }))];
      if (!fails.length) {
        console.log(`${report.stack}: no failures (head ${String(report.head).slice(0, 10)})`);
        return 0;
      }
      for (const x of fails) console.log(`- FAIL ${x.what}${x.log ? ` (log: ${x.log})` : ''}\n${(x.excerpt || '').split('\n').map((l) => `    ${l}`).join('\n')}`);
      return 1;
    }
    process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : summary(report)) + '\n');
    return 0;
  }
  throw new core.JdiError('usage: jdi gates <run|show> <phase> ...', 1);
}

module.exports = { main, runGates, loadStacks, findStack, summary, run, envFor, shellFor, tail, dodItems, changedInScope };
