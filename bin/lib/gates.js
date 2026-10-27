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
// judged from recorded evidence), timeout_min, idle_timeout_s (0.21: no
// output for this long = stalled, the tree is killed and the gate fails with
// that reason; absent or 0 = off), inputs, cache_key_cmd.
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

// What `npx` / `npm exec` adds to the environment of jdi-cli itself: npm's
// config (`npm_config_*`, from ~/.npmrc too), the lifecycle and package
// variables, and its own `.bin` dirs on PATH. A gate run through
// `npx jdi-cli` must see what the same command sees run directly (#82: an
// `allow-scripts` in ~/.npmrc became `npm_config_allow_scripts`, and
// `npm audit` in the gate refused it). A stack that wants one declares it in
// `env`.
const NPM_EXEC_VARS = /^(npm_config_|npm_lifecycle_|npm_package_)|^(npm_execpath|npm_node_execpath|npm_command|npm_exec)$/i;
const NPM_EXEC_PATH = /(?:[\\/]_npx[\\/])|(?:[\\/]node-gyp-bin$)/;

function withoutNpmExec(env) {
  if (!env.npm_command && !env.npm_execpath) return env; // not run by npm
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!NPM_EXEC_VARS.test(k)) out[k] = v;
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH');
  if (key) out[key] = out[key].split(path.delimiter).filter((p) => !NPM_EXEC_PATH.test(p)).join(path.delimiter);
  return out;
}

function envFor(stacks) {
  const env = withoutNpmExec({ ...process.env });
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

const WATCHDOG = path.join(__dirname, 'watchdog.js');

// One command, under the watchdog (0.21): on the deadline or after
// `idleS` seconds without output, the whole process tree is killed — not
// just the shell, which left suites running and holding locks. A timeout or
// a stall is a FAIL with its reason first in the excerpt: a deadlock in the
// code is a defect a doer can fix.
function run(cmd, { root, cwd = root, env, shell, timeoutMin, log, idleS }) {
  const t0 = Date.now();
  const spec = { cmd: shell.cmd, args: shell.args(cmd), timeoutMs: Math.round((timeoutMin || 30) * 60 * 1000), idleMs: idleS ? Math.round(idleS * 1000) : 0 };
  const r = spawnSync(process.execPath, [WATCHDOG], { cwd, env, input: JSON.stringify(spec), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const out = `$ ${cmd}\n${output}`;
  core.writeFileEnsured(log, out, root);
  const duration = Math.round((Date.now() - t0) / 100) / 10;
  const killed = /^jdi-watchdog: (.*)$/m.exec(r.stderr || '');
  if (r.status === 127 && killed) return { exit: 127, duration, out, output, error: `shell '${shell.cmd}' not found` };
  if (killed) return { exit: r.status ?? 124, duration, out, output, error: killed[1] };
  return { exit: r.status ?? 1, duration, out, output };
}

// A failure no code change can fix: reported as ENV (a setup problem the
// human solves), never as a `[defect]` for a doer — a fix round on it only
// burns a round. Only unambiguous signals, read from the command's OUTPUT
// (never its own text: a DoD row that greps for "ENOSPC" is not a full disk):
// the shell could not find the command, or the OS said the disk is full.
const DISK_FULL = 'no space left on device';

function envCause(r) {
  if (r.exit === 127) return r.error || 'command not found (exit 127) — a tool the gate needs is not installed or not on PATH';
  if (tail(r.output || '', 40).toLowerCase().includes(DISK_FULL)) return 'disk full: No space left on device';
  return null;
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
  const r = run(cmd, { root: ctx.root, env: ctx.env, shell: ctx.shell, timeoutMin: ctx.timeoutMin, log, idleS: ctx.idleS });
  const status = r.exit === 0 ? 'PASS' : 'FAIL';
  const res = { gate: name, status, exit: r.exit, duration_s: r.duration, log: path.relative(ctx.root, log).split(path.sep).join('/') };
  if (status === 'FAIL') res.excerpt = (r.error ? r.error + '\n' : '') + tail(r.out);
  const env = status === 'FAIL' ? envCause(r) : null;
  if (env) Object.assign(res, { status: 'ENV', reason: env });
  if (name === 'test' || name === 'coverage') {
    const report = snapshotTestReport(ctx, started);
    if (report?.stale) res.test_report_missing = true; // ran, wrote no fresh JUnit
    else if (report) res.test_report = report.file;
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
  if (!files.length) return { stale: true, file: null };
  const xml = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const rel = `${core.JDI_DIR}/cache/gates/_reports/${sha(xml).slice(0, 16)}.xml`;
  core.writeFileEnsured(path.join(ctx.root, rel), xml, ctx.root);
  return { stale: false, file: rel };
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
    const prefix = g.slice(0, g.indexOf('*'));
    const base = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    for (const f of walk(path.join(root, base))) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (core.matchesAny(rel, [g])) out.add(f);
    }
  }
  return [...out];
}

const WALK_SKIP = new Set(['.git', 'node_modules', '.jdi']);

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    if (!e.isDirectory()) return [path.join(dir, e.name)];
    return WALK_SKIP.has(e.name) ? [] : walk(path.join(dir, e.name));
  });
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
    let cut = false;
    if (!tag.endsWith('/>')) {
      const close = xml.indexOf('</testcase>', end);
      cut = close === -1; // the run was killed mid-test: never a pass
      body = cut ? '' : xml.slice(end + 1, close);
    }
    let status = 'passed';
    if (cut || body.includes('<failure') || body.includes('<error')) status = 'failed';
    else if (body.includes('<skipped')) status = 'skipped';
    cases.push({ name: xmlAttr(tag, 'name'), classname: xmlAttr(tag, 'classname'), status, ...(cut && { cut }) });
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
// A stack report valid for HEAD: measured at HEAD, or at an older commit
// with nothing changed in the stack's scope since (a carried reviewer's stack
// is not gated again, and its proof still holds).
function validReport(ctx, s) {
  const rep = core.readJson(path.join(ctx.gateDir, `${s.id}.json`), null);
  if (!rep?.head) return null;
  if (rep.head === ctx.head) return rep;
  const changed = changedInScope(ctx.root, rep.head, [s.file_glob || []].flat());
  return changed?.length === 0 ? rep : null;
}

function headReports(ctx, it, stacks) {
  const wanted = it.stack ? stacks.filter((s) => [s.id, s.name, s.agent].includes(it.stack)) : stacks;
  return wanted
    .filter((x) => x.test_report)
    .map((s) => {
      const rep = validReport(ctx, s);
      const suite = (rep?.results || []).filter((x) => x.gate === 'test' || x.gate === 'coverage');
      const r = suite.find((x) => x.test_report);
      const file = r ? path.join(ctx.root, r.test_report) : null;
      return { stack: s.id, measured: Boolean(rep), file: file && fs.existsSync(file) ? file : null, suiteFailed: suite.some((x) => x.status === 'FAIL' || x.status === 'SKIPPED'), noReport: suite.some((x) => x.test_report_missing) };
    });
}

// Why no report can prove the row: the suite failed (the stack gate already
// says so: SKIPPED here), or the setup is wrong (ENV: no doer can fix it).
function noProofResult(reports, base, head) {
  if (reports.some((r) => r.suiteFailed)) return { ...base, status: 'SKIPPED', reason: 'Verify (test): the suite failed or did not run — see the stack gates' };
  const unmeasured = reports.filter((r) => !r.measured).map((r) => r.stack);
  if (unmeasured.length) return { ...base, status: 'ENV', reason: `Verify (test): no report at HEAD ${String(head || '').slice(0, 10)} for ${unmeasured.join(',')} — run \`gates run --stack ${unmeasured.join(',')}\` before the DoD` };
  const why = reports.some((r) => r.noReport) ? 'the test gate ran but wrote no fresh JUnit at `test_report` (an incremental runner that skipped the run?)' : 'the stack results carry no test report';
  return { ...base, status: 'ENV', reason: `Verify (test): ${why} — fix the gate command or \`test_report\`` };
}

const caseName = (c) => (c.classname ? `${c.classname}::${c.name}` : c.name);

function badCasesReason(id, hits, bad) {
  const names = bad.slice(0, 3).map(caseName).join(', ') + (bad.length > 3 ? ', ...' : '');
  const cut = bad.filter((c) => c.cut);
  if (cut.length) return `Verify (test): \`${id}\` — report cut off (the run was interrupted) at ${cut.map(caseName).slice(0, 3).join(', ')}`;
  return `Verify (test): \`${id}\` — ${hits.length} case(s), ${bad.length} not passed (${bad[0].status}): ${names}`;
}

function testRowResult(ctx, it, stacks, base) {
  const id = it.verify.command.trim();
  const reports = headReports(ctx, it, stacks);
  if (!reports.length) return { ...base, status: 'ENV', reason: 'Verify (test): no stack declares `test_report` (JUnit) — nothing can prove it' };
  if (!reports.some((r) => r.file)) return noProofResult(reports, base, ctx.head);
  const cases = reports.filter((r) => r.file).flatMap((r) => parseJunit(fs.readFileSync(r.file, 'utf8')));
  const hits = cases.filter((c) => matchesTest(c, id));
  if (!hits.length) return { ...base, status: 'FAIL', reason: `Verify (test): no testcase matches \`${id}\` in the report — the proof does not exist` };
  const bad = hits.filter((c) => c.status !== 'passed');
  if (bad.length) return { ...base, status: 'FAIL', reason: badCasesReason(id, hits, bad) };
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
  if (cov.status === 'ENV') return [cov, want('test') && { gate: 'test', status: 'SKIPPED', reason: 'the coverage run hit the environment (ENV)' }].filter(Boolean);
  return [cov, want('test') && execGate(ctx, 'test', g.test)].filter(Boolean);
}

// A gate that does not block: its failure — or its environment — is a warning.
function toWarning(res) {
  if (res?.status === 'FAIL' || res?.status === 'ENV') res.status = 'WARN';
}

function stackResults(ctx, stack, only) {
  const g = stack.gates || {};
  const want = (k) => g[k] && (!only || only.has(k));
  // the audit reads the lockfiles, not the build: it runs either way
  const audit = want('audit') ? [execGate(ctx, 'audit', g.audit)] : [];
  // `audit_blocks: false`: an advisory (or an offline registry) is a warning
  if (stack.audit_blocks === false) toWarning(audit[0]);
  const results = want('build') ? [execGate(ctx, 'build', g.build)] : [];
  if (results.some((x) => x.status === 'FAIL' || x.status === 'ENV')) {
    return [...results, ...['test', 'coverage', 'lint'].filter(want).map((k) => ({ gate: k, status: 'SKIPPED', reason: 'build failed (fail-fast)' })), ...audit];
  }
  results.push(...testAndCoverage(ctx, stack, want));
  if (want('lint')) {
    const lint = execGate(ctx, 'lint', g.lint);
    if (!stack.lint_blocks) toWarning(lint);
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
function diskProblem(ctx, req) {
  const free = req.disk_free_mb ? freeMb(ctx.root) : null;
  return free !== null && free < req.disk_free_mb ? [`${free} MB free on disk < ${req.disk_free_mb} MB`] : [];
}

function checkProblem(ctx, s, check) {
  if (!check) return [];
  const r = run(check, { root: ctx.root, env: ctx.env, shell: shellFor(s), timeoutMin: 2, log: path.join(ctx.gateDir, s.id, 'preflight.log') });
  return r.exit === 0 ? [] : [`\`${check}\` exits ${r.exit}: ${tail(r.out, 3).replaceAll('\n', ' | ')}`];
}

// What one stack's `requires` declares and is missing.
function stackProblems(ctx, s) {
  const req = s.requires;
  return [
    ...(req.env || []).filter((v) => !ctx.env[v]).map((v) => `env ${v} is not set`),
    ...(req.commands || []).filter((c) => !onPath(c, pathOf(ctx.env))).map((c) => `command \`${c}\` not found`),
    ...diskProblem(ctx, req),
    ...checkProblem(ctx, s, req.check),
  ].map((p) => `${s.id}: ${p}`);
}

function preflightProblems(ctx, stacks) {
  return stacks.filter((x) => x.requires).flatMap((s) => stackProblems(ctx, s));
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
  const r = run(it.verify.command, { root: ctx.root, env: ctx.env, shell: ctx.shell, timeoutMin: ctx.timeoutMin, log, idleS: ctx.idleS });
  const res = { ...base, status: r.exit === 0 ? 'PASS' : 'FAIL', exit: r.exit, duration_s: r.duration, log: path.relative(ctx.root, log).split(path.sep).join('/') };
  if (res.status === 'FAIL') res.excerpt = (r.error ? r.error + '\n' : '') + tail(r.out, 12);
  const env = res.status === 'FAIL' ? envCause(r) : null;
  if (env) Object.assign(res, { status: 'ENV', reason: env });
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
  const ctx = gateContext(root, phase, stack, stacks, opts);
  const report = { phase: phase.slug, stack: ctx.label, head: ctx.head, started: new Date().toISOString(), base: opts.changedSince || null, results: [], dod: [] };
  const skipped = stack ? skippedResults(root, stack, opts, only) : null;
  const preStacks = stack ? [stack] : dodStacks(root, phase, stacks);
  const problems = skipped ? [] : preflightProblems(ctx, preStacks);
  if (problems.length) {
    report.preflight = problems;
    return finishReport(ctx, report);
  }
  if (stack) report.results = skipped || stackResults(ctx, stack, only);
  if (wantDod) {
    const evidence = [...new Set(stacks.flatMap((s) => s.evidence_only || []))];
    report.dod = dodItems(root, phase).map((it) => dodResult(ctx, it, evidence, stacks));
    attachEvidence(root, phase, report.dod);
  }
  return finishReport(ctx, report);
}

function gateContext(root, phase, stack, stacks, opts) {
  const config = core.loadConfig(root);
  const head = core.git(['rev-parse', 'HEAD'], root).stdout || null;
  const ctx = {
    root,
    gateDir: path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug),
    label: stack ? stack.id : 'dod',
    head,
    stack,
    env: envFor(stack ? [stack] : stacks),
    shell: shellFor(stack || stacks[0]),
    timeoutMin: (stack || stacks[0])?.timeout_min || 30,
    idleS: (stack || stacks[0])?.idle_timeout_s || 0,
    reuse: config.economy?.gate_cache !== false && Boolean(head),
    fresh: Boolean(opts.fresh),
  };
  if (ctx.reuse) {
    ctx.tree = treeFingerprint(root);
    ctx.nonProduct = config.loop?.non_product_globs || [];
    ctx.stackHash = sha(JSON.stringify(stack || stacks));
    ctx.toolchain = toolchainOf(ctx, stack);
  }
  return ctx;
}

// Status of the whole report: ENV first (fixing code cannot make an
// environment or an unreadable proof pass), then FAIL, then PASS.
function finishReport(ctx, report) {
  report.finished = new Date().toISOString();
  const all = [...report.results, ...report.dod];
  if (report.preflight?.length || all.some((x) => x.status === 'ENV')) report.status = 'ENV';
  else if (all.some((x) => x.status === 'FAIL')) report.status = 'FAIL';
  else report.status = 'PASS';
  return writeReport(ctx.root, ctx.gateDir, ctx.label, report);
}

// The stacks whose `requires` the DoD needs: the ones its rows name with
// `Stack:` — not every stack of the repo (one may not run on this machine).
function dodStacks(root, phase, stacks) {
  const named = new Set(dodItems(root, phase).filter((it) => it.type === 'auto' && it.stack).map((it) => it.stack));
  return stacks.filter((s) => named.has(s.id) || named.has(s.name) || named.has(s.agent));
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
    `  dod       PASS ${c('PASS')} (reused ${dodRows.filter((d) => d.reused).length}) · FAIL ${c('FAIL')} · EVIDENCE ${c('EVIDENCE')} · MANUAL ${c('MANUAL_REQUIRED')} · INCONCLUSIVE ${c('INCONCLUSIVE')}` + (c('ENV') ? ` · ENV ${c('ENV')}` : '') + (c('SKIPPED') ? ` · SKIPPED ${c('SKIPPED')}` : ''),
    ...dodRows.filter((x) => x.status === 'ENV').map((d) => `    ENV ${d.source} ${d.id}: ${d.reason}`),
    // a `Verify (test):` row has a reason, a run row a log
    ...dodRows.filter((x) => x.status === 'FAIL').map((d) => `    FAIL ${d.source} ${d.id}: ${d.reason || d.log || d.excerpt || 'failed'}`),
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
    else if (a === '--detach') opts.detach = true;
    else if (a === '--job') opts.job = rest[++i];
    else if (a === '--timeout') opts.timeout = Number(rest[++i]);
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
  return Math.max(...reports.map(failuresCmd));
}

function showCmd(root, phase, opts) {
  if (opts.failures && opts.all) return allFailuresCmd(root, phase);
  // a reviewer name resolves to its stack file, as in `run`
  const label = opts.stack ? findStack(loadStacks(root), opts.stack)?.id || opts.stack : 'dod';
  const f = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, `${label}.json`);
  const report = core.readJson(f, null);
  if (!report) throw new core.JdiError(`no gate results at ${path.relative(root, f)}`, 2);
  report.file = path.relative(root, f);
  if (opts.failures) return failuresCmd(report);
  process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : summary(report)) + '\n');
  return 0;
}

// The work list of a fix round: only what failed, with its excerpt.
// The environment problems of a report (preflight, ENV DoD rows).
function envLines(report) {
  return [
    ...(report.preflight || []),
    ...(report.results || []).filter((x) => x.status === 'ENV').map((x) => `${x.gate}: ${x.reason} (log: ${x.log})`),
    ...(report.dod || []).filter((x) => x.status === 'ENV').map((x) => `DoD ${x.source} ${x.id}: ${x.reason}`),
  ];
}

function failuresCmd(report) {
  if (report.status === 'ENV') {
    for (const l of envLines(report)) console.log(`- ENV ${report.stack}: ${l}`);
    return 5;
  }
  const gateFails = (report.results || []).filter((x) => x.status === 'FAIL').map((x) => ({ ...x, what: `${report.stack}/${x.gate}` }));
  const dodFails = (report.dod || []).filter((x) => x.status === 'FAIL').map((x) => ({ ...x, what: `DoD ${x.source} ${x.id}: ${x.criterion}` }));
  const fails = [...gateFails, ...dodFails];
  if (!fails.length) {
    console.log(`${report.stack}: no failures (head ${String(report.head).slice(0, 10)})`);
    return 0;
  }
  for (const x of fails) {
    const log = x.log ? ' (log: ' + x.log + ')' : '';
    const excerpt = (x.excerpt || x.reason || '').split('\n').map((l) => '    ' + l).join('\n');
    console.log(`- FAIL ${x.what}${log}\n${excerpt}`);
  }
  return 1;
}

const exitOf = (report) => ({ PASS: 0, ENV: 5 })[report.status] ?? 1;

// One child `gates run` per stack, all at once; resolves to their reports.
function runChildren(phase, stackIds, rest) {
  const cli = path.join(__dirname, '..', 'jdi.js');
  // the children get the same flags minus the stack list, the output format
  // and the detached job id (only the parent finishes the job)
  const drop = new Set(['--stack', '--job']);
  const base = rest.filter((a, i) => !drop.has(a) && !drop.has(rest[i - 1]) && a !== '--json');
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
              // a child that died still leaves a report: `show --failures --all` must see it
              const root = process.cwd();
              const head = core.git(['rev-parse', 'HEAD'], root).stdout || null;
              const report = { phase: phase.slug, stack: s, head, status: 'FAIL', results: [{ gate: 'run', status: 'FAIL', exit: code, excerpt: tail(err || out) }], dod: [] };
              resolve(writeReport(root, path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug), s, report));
            }
          });
        }),
    ),
  );
}

function printReports(reports, json) {
  const payload = reports.length === 1 ? reports[0] : reports;
  process.stdout.write((json ? JSON.stringify(payload, null, 2) : reports.map(summary).join('\n')) + '\n');
  return Math.max(...reports.map(exitOf));
}

// Always a promise (several stacks in parallel resolve later); errors keep
// their exit code (bin/jdi.js awaits it).
// --------------------------------------------------------------------------
// Detached runs (0.21): `run --detach` returns at once; `wait` blocks up to
// --timeout seconds (default and max 540: under a 10-minute tool-call limit)
// and prints the run's output when it is done. For runtimes that cannot run a
// command in the background and be told when it ends; a 20-minute suite in
// the foreground used to hit the tool limit and lose its result.
// --------------------------------------------------------------------------

const WAIT_MAX_S = 540;
const JOB_DIED = 2;
const jobsDir = (root, phase) => path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, 'jobs');

function detach(root, phase, rest) {
  const dir = jobsDir(root, phase);
  fs.mkdirSync(dir, { recursive: true });
  const job = Date.now().toString(36);
  const outFd = fs.openSync(path.join(dir, `${job}.out`), 'w');
  const args = rest.filter((a) => a !== '--detach');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'jdi.js'), 'gates', 'run', ...args, '--job', job], {
    cwd: root,
    env: process.env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, outFd],
  });
  child.unref();
  fs.closeSync(outFd);
  fs.writeFileSync(path.join(dir, `${job}.json`), JSON.stringify({ job, pid: child.pid, args, started: new Date().toISOString(), done: false }) + '\n');
  process.stdout.write(`gates job ${job} started — \`jdi-cli gates wait ${phase.slug}\` (blocks up to ${WAIT_MAX_S}s per call)\n`);
  return 0;
}

function finishJob(root, phase, job, code) {
  const f = path.join(jobsDir(root, phase), `${job}.json`);
  const j = core.readJson(f, {}) || {};
  fs.writeFileSync(f, JSON.stringify({ ...j, done: true, code, finished: new Date().toISOString() }) + '\n');
  return code;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function latestJob(root, phase) {
  const files = fs.existsSync(jobsDir(root, phase)) ? fs.readdirSync(jobsDir(root, phase)).filter((f) => f.endsWith('.json')) : [];
  return files.sort(core.compareStr).at(-1)?.slice(0, -5) || null;
}

// One look at the job: its exit code when it ended (or died, or ran out of
// time to wait), null while it is still running.
function jobStep(root, phase, job, deadline) {
  const f = path.join(jobsDir(root, phase), `${job}.json`);
  const j = core.readJson(f, null);
  if (!j) throw new core.JdiError(`no gates job ${job}`, 2);
  const out = () => core.readIf(path.join(jobsDir(root, phase), `${job}.out`)) || '';
  if (j.done) {
    process.stdout.write(out());
    return j.code;
  }
  if (!alive(j.pid)) {
    // not 1: 1 means "gates ran and failed" — this run measured nothing
    process.stdout.write(out() + `\ngates job ${job}: the run died before it finished — nothing was measured, run it again\n`);
    return JOB_DIED;
  }
  if (Date.now() > deadline) {
    process.stdout.write(`gates job ${job}: still running (${Math.round((Date.now() - Date.parse(j.started)) / 60000)} min) — call \`jdi-cli gates wait ${phase.slug} --job ${job}\` again\n`);
    return 75;
  }
  return null;
}

function waitJob(root, phase, opts) {
  const job = opts.job || latestJob(root, phase);
  if (!job) throw new core.JdiError(`no detached gates run for ${phase.slug} — start one with \`gates run ... --detach\``, 2);
  const deadline = Date.now() + Math.min(opts.timeout || WAIT_MAX_S, WAIT_MAX_S) * 1000;
  const poll = (resolve, reject) => {
    try {
      const code = jobStep(root, phase, job, deadline);
      if (code === null) setTimeout(() => poll(resolve, reject), 2000);
      else resolve(code);
    } catch (err) {
      reject(err);
    }
  };
  return new Promise(poll);
}

async function main(argv) {
  const [sub, ...rest] = argv;
  const { id, opts } = parseArgs(rest);
  if (!id) throw new core.JdiError('usage: jdi gates <run|show|wait> <phase> [--stack <name>[,<name>]] [--only ...] [--changed-since <sha>] [--detach]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  if (sub === 'show') return showCmd(root, phase, opts);
  if (sub === 'wait') return waitJob(root, phase, opts);
  if (sub !== 'run') throw new core.JdiError('usage: jdi gates <run|show|wait> <phase> ...', 1);
  if (opts.detach) return detach(root, phase, rest);
  if (!opts.job) return runCmd(root, phase, opts, rest);
  // a detached run: its end (and its error's exit code) goes to the job file
  try {
    return finishJob(root, phase, opts.job, await runCmd(root, phase, opts, rest));
  } catch (err) {
    finishJob(root, phase, opts.job, err instanceof core.JdiError ? err.code : 1);
    throw err; // the CLI prints it — into the job's output file
  }
}

async function runCmd(root, phase, opts, rest) {
  const names = String(opts.stack || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length <= 1) return printReports([runGates(phase, opts, root)], opts.json);
  // every name resolved before anything runs; a reviewer without a stack
  // file runs its own gates (as before .jdi/stacks/ existed for it)
  const stacks = loadStacks(root);
  const known = names.map((n) => findStack(stacks, n)).filter(Boolean);
  for (const n of names.filter((x) => !findStack(stacks, x))) console.error(`note: no stack file for '${n}' — skipped (its reviewer runs its own gates)`);
  if (!known.length) throw new core.JdiError(`no stack file for ${names.join(', ')} in .jdi/stacks/`, 3);
  const ids = known.map((s) => s.id);
  if (core.loadConfig(root).economy?.parallel_gates === true && ids.length > 1) {
    if (!sharedReports(known)) return runChildren(phase, ids, rest).then((reports) => printReports(reports, opts.json));
    console.error('note: stacks share a test_report path — run one after the other, so each proof is its own run');
  }
  return printReports(ids.map((s) => runGates(phase, { ...opts, stack: s }, root)), opts.json);
}

// Two stacks whose test_report paths can name the same file.
function sharedReports(stacks) {
  const prefixes = stacks.flatMap((s) => [s.test_report || []].flat().map((g) => (g.includes('*') ? g.slice(0, g.indexOf('*')) : g)));
  return prefixes.some((a, i) => prefixes.some((b, j) => i !== j && (a.startsWith(b) || b.startsWith(a))));
}

module.exports = { main, runGates, loadStacks, findStack, summary, run, envFor, shellFor, tail, dodItems, changedInScope, treeFingerprint, productHash, namedFiles, verifyText, parseJunit, headReportsOf };
