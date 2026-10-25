'use strict';

// `jdi-cli gates run <phase> [--stack <name>[,<name>...]] [--only build,test,coverage,lint,audit,dod]
//                    [--changed-since <sha>] [--fresh] [--json]`
// `jdi-cli gates show <phase> [--stack <name>] [--failures] [--all]`
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
// judged from recorded evidence), timeout_min, inputs, cache_key_cmd.
//
// Reuse (#69, `economy.gate_cache`, on by default): a gate that PASSED on
// exactly the same inputs is not run again — its result comes back marked
// `reused` (when, on which commit). The key is the command, the stack config,
// the content of the inputs (every product file: tracked and untracked, outside
// .jdi/ and `loop.non_product_globs`; a stack may narrow it with `inputs`) and
// the output of `cache_key_cmd` (toolchain versions); for a DoD row, also the
// row's own hash (criterion, Verify, Bait, script). A FAIL is never reused,
// and `--fresh` runs everything (`/jdi-verify --full`). A loop round that only
// touched docs/ or .jdi/ no longer rebuilds and retests the product.
//
// 0.20 (time, measured on a real project — heavy commands were 61% of a
// phase's critical path, the model 22%):
// - `audit` gate (dependency advisories: `cargo audit`, `npm audit`, ...):
//   runs even when the build fails and is NEVER reused — the advisory
//   database changes while the code does not. An advisory used to surface only
//   in CI or in the final review, costing a round or a push.
// - `requires` (stack): env vars, commands, free disk, a `check` command —
//   verified before anything runs. A broken environment (disk full, missing
//   credential, no docker) is reported as ENV (exit 5) in a second, instead of
//   failing after 20-40 minutes of suite; the loop never counts it as a defect.
// - `--stack a,b`: several stacks in one call — in parallel when
//   `economy.parallel_gates` is true (off by default: it doubles CPU/RAM).
// - `Verify (test):` DoD rows are proven by the stack's JUnit report
//   (`test_report`) of the test/coverage gate at the same HEAD — no second run
//   of the suite per row. Every matching testcase must pass; none = FAIL.
// - `show --failures --all`: one work list from every report at HEAD.

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const core = require('./jdi-core');
const dod = require('./dod');

const ORDER = ['build', 'test', 'coverage', 'lint', 'audit'];
// Gates whose PASS is never reused: their result depends on the outside world.
const NEVER_REUSED = new Set(['audit']);

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
  if (prepend.length) {
    // the existing key (`Path` on Windows): a second `PATH` key would hide it
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = [...new Set(prepend)].join(path.delimiter) + path.delimiter + (env[key] || '');
  }
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

// --------------------------------------------------------------------------
// Reuse
// --------------------------------------------------------------------------

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function gitList(root, args) {
  const r = core.git([...args, '-z'], root);
  return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : null;
}

// Content fingerprint of every file in the working tree (tracked, and
// untracked but not ignored): its git blob id — the index's for an unmodified
// file, `git hash-object` (same clean filters, so CRLF/autocrlf and a later
// commit give the same id) for a modified or new one. Gitignored files (.env,
// generated config) are not in it: put what they change in `cache_key_cmd`.
function treeFingerprint(root) {
  const staged = gitList(root, ['ls-files', '-s']);
  if (staged === null) return null;
  const files = new Map();
  for (const e of staged) {
    const tab = e.indexOf('\t');
    files.set(e.slice(tab + 1), e.slice(0, tab).split(' ')[1]);
  }
  const dirty = [...(gitList(root, ['ls-files', '-m']) || []), ...(gitList(root, ['ls-files', '-o', '--exclude-standard']) || [])];
  const present = [...new Set(dirty)].filter((f) => {
    const abs = path.join(root, f);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return true;
    files.set(f, 'deleted');
    return false;
  });
  if (present.length) {
    const r = spawnSync(core.program('git'), ['hash-object', '--stdin-paths'], { cwd: root, input: present.join('\n') + '\n', encoding: 'utf8' });
    const ids = (r.stdout || '').split('\n').filter(Boolean);
    if (r.status !== 0 || ids.length !== present.length) return null; // no fingerprint: no reuse
    present.forEach((f, i) => files.set(f, ids[i]));
  }
  return files;
}

// `./a/b/` -> `a/b` (no regex: plain loops cannot backtrack)
function trimSlashes(t) {
  const s = t.startsWith('./') ? t.slice(2) : t;
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

// Files a command names: an exact path, a directory (everything under it) or
// a glob. A DoD row that greps docs/api.md must see docs/api.md change, even
// though docs/ is outside the product.
function namedFiles(tree, cmd) {
  const tokens = cmd
    .split(/[\s'"`|;&()<>=]+/)
    .map((t) => trimSlashes(t.replaceAll('\\', '/')))
    .filter((t) => t.length > 1);
  const out = new Set();
  for (const t of tokens) {
    const glob = t.includes('*');
    for (const f of tree.keys()) {
      if (f === t || f.startsWith(t + '/') || (glob && core.matchesAny(f, [t]))) out.add(f);
    }
  }
  return out;
}

function inputHash(ctx, globs, cmd = null) {
  if (!ctx.tree) return null;
  const ignore = ['.jdi/**', ...(ctx.nonProduct || [])];
  const named = cmd ? namedFiles(ctx.tree, cmd) : new Set();
  // explicit globs are the whole input set (they may point at docs/ or
  // .jdi/ on purpose); the ignore list only shapes the default.
  const inScope = (f) => (globs?.length ? core.matchesAny(f, globs) : !core.matchesAny(f, ignore));
  const lines = [...ctx.tree]
    .filter(([f]) => named.has(f) || inScope(f))
    .map(([f, id]) => `${id} ${f}`)
    .sort(core.compareStr);
  return sha(lines.join('\n'));
}

// Input hash outside a gates run (evidence records, #70): the product files,
// or `globs` when given, plus every file `cmd` names.
function productHash(root, { globs = null, cmd = null } = {}) {
  const config = core.loadConfig(root);
  return inputHash({ tree: treeFingerprint(root), nonProduct: config.loop?.non_product_globs || [] }, globs, cmd);
}

function stackInputs(stack, gate) {
  const inp = stack?.inputs;
  if (Array.isArray(inp)) return inp;
  return (inp && (inp[gate] || inp['*'])) || null;
}

// The reuse key of one command, or null when reuse is off or impossible.
function reuseKey(ctx, cmd, gate, extra = '') {
  if (!ctx.reuse) return null;
  const inputs = inputHash(ctx, stackInputs(ctx.stack, gate), gate === 'dod' ? cmd : null);
  if (!inputs) return null;
  return sha(JSON.stringify({ cmd, gate, stack: ctx.stackHash, inputs, toolchain: ctx.toolchain, extra })).slice(0, 24);
}

const reusePath = (ctx, key) => path.join(ctx.root, core.JDI_DIR, 'cache', 'gates', '_reuse', `${key}.json`);

function reused(ctx, key) {
  if (!key || ctx.fresh) return null;
  const hit = core.readJson(reusePath(ctx, key), null);
  if (hit?.result?.status !== 'PASS') return null;
  return { ...hit.result, duration_s: 0, reused: { key: key.slice(0, 12), from_head: hit.head, at: hit.at } };
}

function remember(ctx, key, result) {
  if (!key || result.status !== 'PASS') return;
  core.writeFileEnsured(reusePath(ctx, key), JSON.stringify({ head: ctx.head, at: new Date().toISOString(), result }) + '\n', ctx.root);
}

// The toolchain part of the key: what `cache_key_cmd` prints (e.g.
// `rustc -V; node -v`). It runs once per `gates run`.
function toolchainOf(ctx, stack) {
  if (!stack?.cache_key_cmd) return '';
  const log = path.join(ctx.gateDir, ctx.label, 'cache-key.log');
  return sha(run(stack.cache_key_cmd, { root: ctx.root, env: ctx.env, shell: ctx.shell, timeoutMin: 2, log }).out);
}

function execGate(ctx, name, cmd) {
  const key = NEVER_REUSED.has(name) ? null : reuseKey(ctx, cmd, name);
  const hit = reused(ctx, key);
  if (hit) return hit;
  const log = path.join(ctx.gateDir, ctx.label, `${name}.log`);
  const started = Date.now();
  const r = run(cmd, { root: ctx.root, env: ctx.env, shell: ctx.shell, timeoutMin: ctx.timeoutMin, log });
  const status = r.exit === 0 ? 'PASS' : 'FAIL';
  const res = { gate: name, status, exit: r.exit, duration_s: r.duration, log: path.relative(ctx.root, log).split(path.sep).join('/') };
  if (status === 'FAIL') res.excerpt = (r.error ? r.error + '\n' : '') + tail(r.out);
  if (name === 'test' || name === 'coverage') {
    const report = snapshotTestReport(ctx, started);
    if (report) res.test_report = report;
  }
  remember(ctx, key, res);
  return res;
}

// --------------------------------------------------------------------------
// Test reports (JUnit) — the proof of `Verify (test):` DoD rows
// --------------------------------------------------------------------------

// The stack's JUnit files written by THIS run (mtime after it started),
// copied under .jdi/cache/gates/_reports/ by content hash: a later partial run
// (a doer's targeted test) cannot overwrite the proof, and a reused gate
// result keeps pointing at the report of the run it reuses.
function snapshotTestReport(ctx, startedMs) {
  const globs = [ctx.stack?.test_report || []].flat();
  if (!globs.length) return null;
  const files = reportFiles(ctx.root, globs).filter((f) => fs.statSync(f).mtimeMs >= startedMs - 1000);
  if (!files.length) return null;
  const xml = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const rel = `${core.JDI_DIR}/cache/gates/_reports/${sha(xml).slice(0, 16)}.xml`;
  core.writeFileEnsured(path.join(ctx.root, rel), xml, ctx.root);
  return rel;
}

// Report files: plain paths, or globs over the files under their fixed prefix
// (they are usually gitignored build output, so not in the git tree).
function reportFiles(root, globs) {
  const out = new Set();
  for (const g of globs) {
    if (!g.includes('*')) {
      if (fs.existsSync(path.join(root, g))) out.add(path.join(root, g));
      continue;
    }
    const base = g.slice(0, g.indexOf('*')).replace(/[^/]*$/, '');
    for (const f of walk(path.join(root, base), 4)) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (core.matchesAny(rel, [g])) out.add(f);
    }
  }
  return [...out];
}

function walk(dir, depth) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), depth - 1) : [path.join(dir, e.name)]));
}

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unescapeXml = (v) => v.replaceAll(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);

// name="..." / classname='...' of one tag (no regex over the whole file).
function xmlAttr(tag, attr) {
  for (const q of ['"', "'"]) {
    const at = tag.indexOf(` ${attr}=${q}`);
    if (at !== -1) {
      const start = at + attr.length + 3;
      return unescapeXml(tag.slice(start, tag.indexOf(q, start)));
    }
  }
  return '';
}

// Every <testcase> of a JUnit document: { name, classname, status }.
function parseJunit(xml) {
  const cases = [];
  for (let i = xml.indexOf('<testcase'); i !== -1; i = xml.indexOf('<testcase', i + 9)) {
    const end = xml.indexOf('>', i);
    if (end === -1) break;
    const tag = xml.slice(i, end + 1);
    let body = '';
    if (!tag.endsWith('/>')) {
      const close = xml.indexOf('</testcase>', end);
      body = close === -1 ? '' : xml.slice(end + 1, close);
    }
    let status = 'passed';
    if (body.includes('<failure') || body.includes('<error')) status = 'failed';
    else if (body.includes('<skipped')) status = 'skipped';
    cases.push({ name: xmlAttr(tag, 'name'), classname: xmlAttr(tag, 'classname'), status });
  }
  return cases;
}

// A test id matches a testcase by its name or by `classname<sep>name`.
function matchesTest(c, id) {
  if (c.name === id) return true;
  return [c.classname + '::' + c.name, c.classname + '.' + c.name, c.classname + ' ' + c.name, c.classname + '/' + c.name].includes(id);
}

// The reports a `Verify (test):` row may be proven by: the stacks' gate
// results AT HEAD (its `Stack:` only, when it names one).
function headReports(ctx, it, stacks) {
  const wanted = it.stack ? stacks.filter((s) => [s.id, s.name, s.agent].includes(it.stack)) : stacks;
  const out = [];
  for (const s of wanted.filter((x) => x.test_report)) {
    const rep = core.readJson(path.join(ctx.gateDir, `${s.id}.json`), null);
    const r = rep?.head === ctx.head ? (rep.results || []).find((x) => x.test_report) : null;
    out.push({ stack: s.id, file: r ? path.join(ctx.root, r.test_report) : null });
  }
  return out;
}

function testRowResult(ctx, it, stacks, base) {
  const id = it.verify.command.trim();
  const reports = headReports(ctx, it, stacks);
  if (!reports.length) return { ...base, status: 'FAIL', reason: 'Verify (test): no stack declares `test_report` (JUnit) — nothing can prove it' };
  const missing = reports.filter((r) => !r.file || !fs.existsSync(r.file));
  if (missing.length === reports.length) {
    return { ...base, status: 'FAIL', reason: `Verify (test): no test report at HEAD — run \`gates run --stack ${missing.map((r) => r.stack).join(',')}\` first` };
  }
  const cases = reports.filter((r) => r.file && fs.existsSync(r.file)).flatMap((r) => parseJunit(fs.readFileSync(r.file, 'utf8')));
  const hits = cases.filter((c) => matchesTest(c, id));
  if (!hits.length) return { ...base, status: 'FAIL', reason: `Verify (test): no testcase named \`${id}\` in the report — the proof does not exist` };
  const bad = hits.filter((c) => c.status !== 'passed');
  if (bad.length) return { ...base, status: 'FAIL', reason: `Verify (test): \`${id}\` ${bad[0].status} (${bad.length}/${hits.length})` };
  return { ...base, status: 'PASS', proof: `${hits.length} testcase(s) \`${id}\` passed in the test report at HEAD` };
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
  // the audit reads the lockfiles, not the build: it runs either way
  const audit = want('audit') ? [execGate(ctx, 'audit', g.audit)] : [];
  const results = want('build') ? [execGate(ctx, 'build', g.build)] : [];
  if (results.some((x) => x.status === 'FAIL')) {
    return [...results, ...['test', 'coverage', 'lint'].filter(want).map((k) => ({ gate: k, status: 'SKIPPED', reason: 'build failed (fail-fast)' })), ...audit];
  }
  results.push(...testAndCoverage(ctx, stack, want));
  if (want('lint')) {
    const lint = execGate(ctx, 'lint', g.lint);
    if (lint.status === 'FAIL' && !stack.lint_blocks) lint.status = 'WARN';
    results.push(lint);
  }
  return [...results, ...audit];
}

// --------------------------------------------------------------------------
// Preflight — the environment, before minutes of suite
// --------------------------------------------------------------------------

// PATH of an env object: on Windows the key is `Path`, and a copy of
// process.env is no longer case-insensitive.
function pathOf(env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] : '';
}

function onPath(name, envPath) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return String(envPath || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((d) => exts.some((e) => fs.existsSync(path.join(d, name + e))));
}

function freeMb(root) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const s = fs.statfsSync(root);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

// What `requires` declares and is missing: [] when the stack can run.
function preflightProblems(ctx, stacks) {
  const problems = [];
  for (const s of stacks.filter((x) => x.requires)) {
    const req = s.requires;
    for (const v of req.env || []) if (!ctx.env[v]) problems.push(`${s.id}: env ${v} is not set`);
    for (const c of req.commands || []) if (!onPath(c, pathOf(ctx.env))) problems.push(`${s.id}: command \`${c}\` not found`);
    const free = req.disk_free_mb ? freeMb(ctx.root) : null;
    if (free !== null && free < req.disk_free_mb) problems.push(`${s.id}: ${free} MB free on disk < ${req.disk_free_mb} MB`);
    if (req.check) {
      const r = run(req.check, { root: ctx.root, env: ctx.env, shell: shellFor(s), timeoutMin: 2, log: path.join(ctx.gateDir, s.id, 'preflight.log') });
      if (r.exit !== 0) problems.push(`${s.id}: \`${req.check}\` exits ${r.exit}: ${tail(r.out, 3).replaceAll('\n', ' | ')}`);
    }
  }
  return problems;
}

const DOD_STATIC = { manual: 'MANUAL_REQUIRED', deferred: 'DEFERRED' };

// The command plus the script it calls (`dod extract`): the files the
// script reads are inputs too.
function verifyText(root, it) {
  const script = it.script ? core.readIf(path.join(root, it.script)) || '' : '';
  return `${it.verify.command}\n${script}`;
}

function dodResult(ctx, it, evidence, stacks) {
  const base = { id: it.id, source: it.source, type: it.type, criterion: it.criterion.slice(0, 160) };
  if (DOD_STATIC[it.type]) return { ...base, status: DOD_STATIC[it.type] };
  if (!it.verify) return { ...base, status: 'INCONCLUSIVE', reason: 'no Verify' };
  if (it.testRef) return testRowResult(ctx, it, stacks, base);
  if (it.evidence || isEvidenceOnly(it.verify.command, evidence)) return { ...base, status: 'EVIDENCE', reason: 'not executed here (external effect) — judge by the recorded evidence' };
  const key = reuseKey(ctx, verifyText(ctx.root, it), 'dod', dod.rowHash(it, ctx.root));
  const hit = reused(ctx, key);
  if (hit) return { ...hit, ...base };
  const log = path.join(ctx.gateDir, 'dod', `${it.source.toLowerCase()}-${it.id}.log`);
  const r = run(it.verify.command, { root: ctx.root, env: ctx.env, shell: ctx.shell, timeoutMin: ctx.timeoutMin, log });
  const res = { ...base, status: r.exit === 0 ? 'PASS' : 'FAIL', exit: r.exit, duration_s: r.duration, log: path.relative(ctx.root, log).split(path.sep).join('/') };
  if (res.status === 'FAIL') res.excerpt = (r.error ? r.error + '\n' : '') + tail(r.out, 12);
  remember(ctx, key, res);
  return res;
}

// EVIDENCE rows get the freshness of their recorded runs (#70): the reviewer
// sees "fresh" or what changed, instead of asking for the whole suite again.
function attachEvidence(root, phase, rows) {
  if (!rows.some((r) => r.status === 'EVIDENCE')) return;
  const ev = require('./evidence').status(root, phase);
  for (const r of rows.filter((x) => x.status === 'EVIDENCE')) {
    const e = ev.find((x) => x.source === r.source && x.row === (r.source === 'PROJECT' ? `project-${r.id}` : String(r.id)));
    if (e) r.evidence = { iteration: e.iteration.status, ship: e.ship.status, ...(e.ship.reason ? { reason: e.ship.reason } : {}) };
  }
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
  const config = core.loadConfig(root);
  const head = core.git(['rev-parse', 'HEAD'], root).stdout || null;
  const ctx = { root, gateDir, label, head, stack, env: envFor(stack ? [stack] : stacks), shell: shellFor(stack || stacks[0]), timeoutMin: (stack || stacks[0])?.timeout_min || 30 };
  ctx.reuse = config.economy?.gate_cache !== false && Boolean(head);
  ctx.fresh = Boolean(opts.fresh);
  if (ctx.reuse) {
    ctx.tree = treeFingerprint(root);
    ctx.nonProduct = config.loop?.non_product_globs || [];
    ctx.stackHash = sha(JSON.stringify(stack || stacks));
    ctx.toolchain = toolchainOf(ctx, stack);
  }
  const report = { phase: phase.slug, stack: label, head, started: new Date().toISOString(), base: opts.changedSince || null, results: [], dod: [] };
  const skipped = stack ? skippedResults(root, stack, opts, only) : null;
  const problems = skipped ? [] : preflightProblems(ctx, stack ? [stack] : stacks);
  if (problems.length) {
    report.preflight = problems;
    report.finished = new Date().toISOString();
    report.status = 'ENV';
    return writeReport(root, gateDir, label, report);
  }
  if (stack) report.results = skipped || stackResults(ctx, stack, only);
  if (wantDod) {
    const evidence = [...new Set(stacks.flatMap((s) => s.evidence_only || []))];
    report.dod = dodItems(root, phase).map((it) => dodResult(ctx, it, evidence, stacks));
    attachEvidence(root, phase, report.dod);
  }
  const failed = report.results.some((x) => x.status === 'FAIL') || report.dod.some((x) => x.status === 'FAIL');
  report.finished = new Date().toISOString();
  report.status = failed ? 'FAIL' : 'PASS';
  return writeReport(root, gateDir, label, report);
}

function writeReport(root, gateDir, label, report) {
  const out = path.join(gateDir, `${label}.json`);
  core.writeFileEnsured(out, JSON.stringify(report, null, 2) + '\n', root);
  report.file = path.relative(root, out).split(path.sep).join('/');
  return report;
}

// `reused <key> from <head>, <when>` — never to be read as re-measured.
function reusedNote(r) {
  return r.reused ? ` (reused ${r.reused.key}: passed on ${String(r.reused.from_head).slice(0, 10)} at ${r.reused.at}, same inputs)` : '';
}

function resultLine(r) {
  const took = r.duration_s === undefined || r.reused ? '' : ` ${r.duration_s}s`;
  const why = r.reason ? ` (${r.reason})` : '';
  return `  ${r.gate.padEnd(9)} ${r.status}${took}${why}${reusedNote(r)}`;
}

function dodLines(dodRows) {
  if (!dodRows.length) return [];
  const c = (s) => dodRows.filter((d) => d.status === s).length;
  return [
    `  dod       PASS ${c('PASS')} (reused ${dodRows.filter((d) => d.reused).length}) · FAIL ${c('FAIL')} · EVIDENCE ${c('EVIDENCE')} · MANUAL ${c('MANUAL_REQUIRED')} · INCONCLUSIVE ${c('INCONCLUSIVE')}`,
    ...dodRows.filter((x) => x.status === 'FAIL').map((d) => `    FAIL ${d.source} ${d.id}: ${d.log}`),
    ...dodRows.filter((x) => x.evidence).map((d) => `    EVIDENCE ${d.source} ${d.id}: iteration ${d.evidence.iteration} · ship ${d.evidence.ship}` + (d.evidence.reason ? ' (' + d.evidence.reason + ')' : '')),
  ];
}

function summary(report) {
  const env = (report.preflight || []).map((p) => `  ENV       ${p}`);
  return [`gates ${report.phase}/${report.stack}: ${report.status} — ${report.file}`, ...env, ...report.results.map(resultLine), ...dodLines(report.dod)].join('\n');
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
    else if (a === '--fresh') opts.fresh = true;
    else if (a === '--failures') opts.failures = true;
    else if (a === '--all') opts.all = true;
    else if (a.startsWith('--')) throw new core.JdiError(`unknown flag: ${a}`, 1);
    else id = a;
  }
  return { id, opts };
}

// Every report of the phase measured at HEAD (stacks and dod).
function headReportsOf(root, phase) {
  const d = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug);
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  let files = [];
  try {
    files = fs.readdirSync(d).filter((f) => f.endsWith('.json') && f !== 'bait.json');
  } catch {
    return [];
  }
  return files
    .sort(core.compareStr)
    .map((f) => ({ ...core.readJson(path.join(d, f), {}), file: path.relative(root, path.join(d, f)) }))
    .filter((r) => r.head && r.head === head);
}

// One work list for a fix round from every report at HEAD (#1 of 0.20: the
// gates go green before any reviewer is spawned).
function allFailuresCmd(root, phase) {
  const reports = headReportsOf(root, phase);
  if (!reports.length) throw new core.JdiError(`no gate results at HEAD for ${phase.slug} — run \`gates run\` first`, 2);
  let code = 0;
  for (const r of reports) {
    if (r.status === 'ENV') {
      console.log(`- ENV ${r.stack}: ${(r.preflight || []).join('; ')}`);
      code = Math.max(code, 5);
    } else if (failuresCmd(r) !== 0) code = Math.max(code, 1);
  }
  return code;
}

function showCmd(root, phase, opts) {
  if (opts.failures && opts.all) return allFailuresCmd(root, phase);
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

const exitOf = (report) => ({ PASS: 0, ENV: 5 })[report.status] ?? 1;

// One child `gates run` per stack, all at once; resolves to their reports.
function runChildren(phase, stackIds, rest) {
  const cli = path.join(__dirname, '..', 'jdi.js');
  const base = rest.filter((a, i) => a !== '--stack' && rest[i - 1] !== '--stack' && a !== '--json');
  return Promise.all(
    stackIds.map(
      (s) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [cli, 'gates', 'run', ...base, '--stack', s, '--json'], { cwd: process.cwd(), env: process.env });
          let out = '';
          let err = '';
          child.stdout.on('data', (b) => (out += b));
          child.stderr.on('data', (b) => (err += b));
          child.on('close', (code) => {
            try {
              resolve(JSON.parse(out));
            } catch {
              resolve({ phase: phase.slug, stack: s, status: 'FAIL', results: [{ gate: 'run', status: 'FAIL', excerpt: tail(err || out) }], dod: [], file: '-', exit: code });
            }
          });
        }),
    ),
  );
}

function printReports(reports, json) {
  process.stdout.write((json ? JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) : reports.map(summary).join('\n')) + '\n');
  return Math.max(...reports.map(exitOf));
}

function main(argv) {
  const [sub, ...rest] = argv;
  const { id, opts } = parseArgs(rest);
  if (!id) throw new core.JdiError('usage: jdi gates <run|show> <phase> [--stack <name>[,<name>]] [--only ...] [--changed-since <sha>]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  if (sub === 'show') return showCmd(root, phase, opts);
  if (sub !== 'run') throw new core.JdiError('usage: jdi gates <run|show> <phase> ...', 1);
  const stackIds = String(opts.stack || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (stackIds.length <= 1) return printReports([runGates(phase, opts, root)], opts.json);
  if (core.loadConfig(root).economy?.parallel_gates === true) {
    return runChildren(phase, stackIds, rest).then((reports) => printReports(reports, opts.json));
  }
  return printReports(stackIds.map((s) => runGates(phase, { ...opts, stack: s }, root)), opts.json);
}

module.exports = { main, runGates, loadStacks, findStack, summary, run, envFor, shellFor, tail, dodItems, changedInScope, treeFingerprint, productHash, namedFiles, verifyText, parseJunit, headReportsOf };
