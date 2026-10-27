#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
// --no-color has to be in the environment before ui.js loads: it picks the
// palette and the banner animation once, at require time (#47). The child
// .sh scripts read the same variable.
if (process.argv.includes('--no-color')) process.env.NO_COLOR = '1';
// The shell helpers that call back into Node (validate-phase -> resolve-phase)
// use this binary, not whatever `node` the PATH has.
process.env.JDI_NODE = process.execPath;
const ui = require('./lib/ui');
const i18n = require('./lib/i18n');
const { c, sym } = ui;

const VERSION = require('../package.json').version;
const PKG_ROOT = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

const VALID_RUNTIMES = ['claude', 'copilot', 'antigravity', 'opencode', 'junie', 'all'];
const VALID_SCOPES = ['user', 'project'];
// uninstall also takes `both`, its default.
const UNINSTALL_SCOPES = [...VALID_SCOPES, 'both'];
const RUNTIME_NAMES = VALID_RUNTIMES.filter((r) => r !== 'all');

// Idioma resolvido uma vez em main() e usado por todo o dispatcher.
let cliLang = i18n.DEFAULT_LANG;

function tr(key, ...args) {
  return i18n.t(cliLang, key, ...args);
}

// =================================================================
// Argument parsing — minimal, no deps
// =================================================================

// Canonical flag key per alias; any other --long keeps its own name.
const FLAG_ALIAS = {
  '-s': 'scope', '--scope': 'scope',
  '-v': 'verbose', '--verbose': 'verbose',
  '-V': 'version', '--version': 'version',
  '-h': 'help', '--help': 'help',
  '-y': 'yes',
  '--no-color': 'noColor',
};

// Flags every command accepts. `value` takes the next token (or `=value`);
// `bool` takes no value, or an explicit `=true|false`.
const GLOBAL_FLAGS = { noColor: 'bool', lang: 'value', help: 'bool', version: 'bool' };

// The flags each install-side command accepts on top of the global ones.
// Anything else is a usage error, before any script runs: a typo such as
// `--dryrun` used to be dropped and the purge it guarded ran for real (#36),
// and one global set of value flags made `uninstall --runtime claude` fall
// back to `all` (#35). The plumbing helpers are not listed: they get the raw
// argv and parse it themselves.
const COMMAND_FLAGS = {
  install: { scope: 'value', runtime: 'value', githooks: 'bool', force: 'bool' },
  update: { 'force-specialists': 'bool', 'skip-specialists': 'bool', 'dry-run': 'bool', yes: 'bool', force: 'bool' },
  uninstall: { runtime: 'value', scope: 'value', purge: 'bool', yes: 'bool', 'dry-run': 'bool' },
  build: {},
  'install-playwright': { 'skip-browser': 'bool', 'skip-mcp': 'bool', runtime: 'value', 'antigravity-scope': 'value' },
  'install-caveman': { repo: 'value', scope: 'value', force: 'bool' },
  doctor: { verbose: 'bool' },
  help: {},
};
const COMMAND_ALIAS = {
  upgrade: 'update', remove: 'uninstall', playwright: 'install-playwright', caveman: 'install-caveman',
};

const BOOL_VALUES = { true: true, 1: true, yes: true, false: false, 0: false, no: false };

// Leading global flags (`jdi --no-color install claude`) are skipped to find
// the command; `-h`, `-V`/`-v` and their long forms ARE the command there.
function findCommand(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--no-color' || a.startsWith('--lang=')) { i++; continue; }
    if (a === '--lang') { i += 2; continue; }
    break;
  }
  return i;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmdIndex = findCommand(args);
  if (cmdIndex >= args.length) return { cmd: 'help', positional: [], flags: parseFlags(args, null).flags, errors: [], cmdIndex };

  const raw = args[cmdIndex];
  const cmd = COMMAND_ALIAS[raw] || raw;
  const spec = Object.hasOwn(COMMAND_FLAGS, cmd) ? COMMAND_FLAGS[cmd] : null;
  const rest = [...args.slice(0, cmdIndex), ...args.slice(cmdIndex + 1)];
  return { cmd, ...parseFlags(rest, spec), cmdIndex };
}

// One `-x` / `--x[=v]` token -> { key, kind, name, value }; value is
// undefined without `=`.
function flagToken(a, spec) {
  const eq = a.indexOf('=');
  const name = eq === -1 ? a : a.slice(0, eq);
  const key = FLAG_ALIAS[name] || name.replace(/^--?/, '');
  return { key, name, kind: GLOBAL_FLAGS[key] || spec?.[key], value: eq === -1 ? undefined : a.slice(eq + 1) };
}

// A boolean flag: bare, or `=true|false` (`--purge=false` used to purge).
function boolFlag(t, flags, errors) {
  if (t.value === undefined) {
    flags[t.key] = true;
    return;
  }
  const v = BOOL_VALUES[t.value.toLowerCase()];
  if (v === undefined) errors.push(`${t.name} takes no value (or =true|false)`);
  else flags[t.key] = v;
}

// spec null = a plumbing helper: only the global flags matter here, and
// unknown ones are left to the helper.
function parseFlags(tokens, spec) {
  const flags = {};
  const positional = [];
  const errors = [];

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (!a.startsWith('-') || a === '-') { positional.push(a); continue; }
    const t = flagToken(a, spec);
    if (!t.kind) {
      if (spec) errors.push(`unknown flag: ${t.name}`);
    } else if (t.kind === 'bool') {
      boolFlag(t, flags, errors);
    } else if (t.value !== undefined) {
      flags[t.key] = t.value;
    } else if (tokens[i + 1] === undefined || tokens[i + 1].startsWith('-')) {
      errors.push(`${t.name} needs a value`);
    } else {
      flags[t.key] = tokens[++i];
    }
  }

  return { positional, flags, errors };
}

// =================================================================
// Spawn helpers — delegate to .sh / .ps1
// =================================================================

function getScriptPath(name) {
  const ext = isWindows ? '.ps1' : '.sh';
  return path.join(PKG_ROOT, 'bin', `${name}${ext}`);
}

// Prefer PowerShell 7 (pwsh) when available: it decodes BOM-less UTF-8 .ps1
// correctly and is the actively developed PowerShell. Windows PowerShell 5.1
// reads BOM-less scripts as ANSI (cp1252), which turns any non-ASCII byte
// into parser garbage (issue #24). The scripts are additionally kept
// ASCII-only (enforced by a publish guard) so the 5.1 fallback stays safe.
//
// Resolution uses fixed install locations instead of probing the PATH
// (S4036 — a writable dir earlier in PATH could shadow `pwsh`). pwsh has
// FOUR canonical installs, checked in order:
//   1. %ProgramFiles%\PowerShell\<major>\pwsh.exe        (MSI / winget machine)
//   2. %LOCALAPPDATA%\Programs\PowerShell\<major>\...    (winget user scope)
//   3. %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe     (Microsoft Store alias)
//   4. %USERPROFILE%\.dotnet\tools\pwsh.exe              (dotnet global tool)
// Fallback: System32 WindowsPowerShell 5.1 (always present on Windows).
let cachedPowerShell = null;

function newestPwshUnder(root) {
  let best = null;
  try {
    for (const entry of fs.readdirSync(root)) {
      if (!/^\d+$/.test(entry)) continue;
      const candidate = path.join(root, entry, 'pwsh.exe');
      if (fs.existsSync(candidate) && (!best || Number(entry) > best.ver)) {
        best = { ver: Number(entry), path: candidate };
      }
    }
  } catch {
    // dir absent — this install flavor is not present
  }
  return best ? best.path : null;
}

function resolvePowerShell() {
  if (cachedPowerShell) return cachedPowerShell;

  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    newestPwshUnder(path.join(process.env.ProgramFiles || String.raw`C:\Program Files`, 'PowerShell')),
    localAppData && newestPwshUnder(path.join(localAppData, 'Programs', 'PowerShell')),
    localAppData && path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.dotnet', 'tools', 'pwsh.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedPowerShell = c;
      return cachedPowerShell;
    }
  }

  const ps51 = path.join(
    process.env.SystemRoot || String.raw`C:\Windows`,
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  cachedPowerShell = fs.existsSync(ps51) ? ps51 : 'powershell.exe';
  return cachedPowerShell;
}

function runShellScript(scriptName, scriptArgs = []) {
  const scriptPath = getScriptPath(scriptName);

  if (!fs.existsSync(scriptPath)) {
    ui.fail(tr('error.script_not_found', scriptPath));
    return { code: 1 };
  }

  let cmd, args;
  if (isWindows) {
    cmd = resolvePowerShell();
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...scriptArgs];
  } else {
    cmd = 'bash';
    args = [scriptPath, ...scriptArgs];
  }

  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  return { code: exitCodeOf(result, cmd) };
}

// Only status 0 is success. A shell that could not start (ENOENT: no bash, a
// broken Git Bash) has status null and used to print the success box with
// exit 0 (#38); a child killed by a signal has status null too.
function exitCodeOf(result, cmd) {
  if (result.error) {
    ui.fail(`${cmd}: ${result.error.message}`);
    return 127;
  }
  return result.status ?? 1;
}

// =================================================================
// Lib helper plumbing — exposes bin/lib scripts as CLI subcommands
// so slash commands inside a consumer project can call them via
// `jdi <helper>` / `npx jdi-cli <helper>` without any JDI code being
// copied into the project (no-code-in-consumer-repo invariant).
// =================================================================

function runLibScript(baseName, scriptArgs = [], opts = {}) {
  const ext = isWindows ? '.ps1' : '.sh';
  const scriptPath = path.join(PKG_ROOT, 'bin', 'lib', `${baseName}${ext}`);

  if (!fs.existsSync(scriptPath)) {
    console.error(`ERROR: helper not found: ${scriptPath}`);
    return { code: 1, stdout: '' };
  }

  let cmd, args;
  if (isWindows) {
    cmd = resolvePowerShell();
    // The bash helpers parse GNU --flags themselves; the PowerShell ports
    // declare idiomatic [switch]/PascalCase parameters. Translate at this
    // single boundary so `--check-unique` binds to `-CheckUnique` etc.
    // (issue #24 bug 2 — every lib helper invoked with a flag failed on
    // Windows because the binder saw the literal `--flag`).
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...toPsArgs(scriptArgs)];
  } else {
    cmd = 'bash';
    args = [scriptPath, ...scriptArgs];
  }

  const result = spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });

  return { code: exitCodeOf(result, cmd), stdout: opts.capture ? (result.stdout || '') : '' };
}

// resolve-phase runs in Node since 0.17.0 (one implementation: the .sh/.ps1
// twins disagreed on CRLF roadmaps and absolute vs relative dirs, #48). Same
// output (KEY='value' lines, or --json) and the same exit codes.
// 1 = legacy NN-slug folder, 3 = per-entry roadmap (layout v3), 2 otherwise.
function phaseSchema(r) {
  if (/\/\d+-[^/]+$/.test(r.dir)) return 1;
  return fs.existsSync(path.join(process.cwd(), '.jdi', 'roadmap')) ? 3 : 2;
}

function cmdResolvePhase(rawArgs) {
  const json = rawArgs.includes('--json');
  const rest = rawArgs.filter((a) => a !== '--json');
  if (rest.length === 0) {
    console.error('usage: jdi resolve-phase <slug|position> [--json]');
    process.exit(1);
  }
  const core = require(path.join(PKG_ROOT, 'bin', 'lib', 'jdi-core.js'));
  let r;
  try {
    r = core.resolvePhase(rest[0], process.cwd());
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(Number.isInteger(err.code) ? err.code : 1);
  }
  const schema = phaseSchema(r);
  if (json) {
    console.log(JSON.stringify({ slug: r.slug, dir: r.dir, position: r.position, schema_version: schema, folder_exists: r.exists }));
    return;
  }
  console.log(`JDI_PHASE_SLUG='${r.slug}'`);
  console.log(`JDI_PHASE_DIR='${r.dir}'`);
  console.log(`JDI_PHASE_POSITION='${r.position}'`);
  console.log(`JDI_PHASE_SCHEMA='${schema}'`);
  console.log(`JDI_PHASE_FOLDER_EXISTS='${r.exists}'`);
}

function cmdLibPassthrough(baseName, usage, rawArgs) {
  if (rawArgs.length === 0) {
    console.error(`usage: jdi ${usage}`);
    process.exit(1);
  }
  const { code } = runLibScript(baseName, rawArgs);
  process.exit(code);
}

// GNU-style --kebab-flags -> PowerShell -PascalCase parameters, applied only
// when dispatching to .ps1 (bash helpers parse --flags themselves). Values
// keep following as separate args, which matches PS named-parameter binding.
function toPsArgs(rawArgs) {
  return rawArgs.map((a) =>
    /^--[a-z][a-z-]*$/.test(a)
      ? '-' + a.slice(2).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
      : a
  );
}

// Like cmdLibPassthrough but zero-arg friendly (render / migrate-layout).
// Flag mapping for the PowerShell side happens inside runLibScript.
function cmdLibZeroArg(baseName, rawArgs) {
  const { code } = runLibScript(baseName, rawArgs);
  process.exit(code);
}

// Raw argv for a plumbing helper: everything after the subcommand MINUS the
// global flags jdi.js consumes itself (--no-color, --lang <x>). The helpers
// never declare those, so forwarding them broke every helper on Windows
// (`validate-slug --no-color` -> binder error on `-NoColor`, #33).
let libArgStart = 3;

function libArgs() {
  const raw = process.argv.slice(libArgStart);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--no-color') continue;
    if (a === '--lang') { i++; continue; }
    if (a.startsWith('--lang=')) continue;
    out.push(a);
  }
  return out;
}

// Node helpers live in bin/lib/<name>.js and export main(argv) -> exit code.
// Errors carrying a numeric `code` (JdiError) keep it as the exit code.
function runNodeHelper(name, rawArgs) {
  const mod = typeof name === 'string' ? require(path.join(PKG_ROOT, 'bin', 'lib', `${name}.js`)) : name;
  let code;
  try {
    code = mod.main(rawArgs);
  } catch (err) {
    console.error(`ERROR: ${err?.message || err}`);
    code = Number.isInteger(err?.code) ? err.code : 1;
  }
  // exitCode, not exit(): exit() would cut a large stdout written to a pipe.
  // A helper may answer with a promise (gates running stacks in parallel).
  if (code && typeof code.then === 'function') {
    code.then(
      (c) => { process.exitCode = c ?? 0; },
      (err) => {
        console.error(`ERROR: ${err?.message || err}`);
        process.exitCode = Number.isInteger(err?.code) ? err.code : 1;
      },
    );
    return;
  }
  process.exitCode = code ?? 0;
}

// Build CLI args from a flag spec, picking the platform-correct flag name.
// spec: [{ key, win, nix, value? }]. value:true forwards the flag's value.
function buildFlagArgs(flags, spec) {
  const args = [];
  for (const s of spec) {
    const present = flags[s.key];
    if (!present) continue;
    const name = isWindows ? s.win : s.nix;
    if (s.value) args.push(name, present);
    else args.push(name);
  }
  return args;
}

// =================================================================
// Validation helpers
// =================================================================

function ensureRuntime(runtime) {
  if (!runtime) {
    ui.fail(tr('error.runtime_required'));
    console.error('');
    console.error(`  ${tr('help.usage_label')} ${c.cyan}jdi install <runtime> [--scope user|project]${c.reset}`);
    console.error(`  ${tr('error.runtimes_label')}: ${VALID_RUNTIMES.join(', ')}`);
    console.error('');
    process.exit(1);
  }
  if (!VALID_RUNTIMES.includes(runtime)) {
    ui.fail(tr('error.runtime_invalid', runtime));
    console.error(`  ${tr('error.valid_options')}: ${VALID_RUNTIMES.join(', ')}`);
    process.exit(1);
  }
}

function ensureScope(scope, valid = VALID_SCOPES) {
  if (scope && !valid.includes(scope)) {
    ui.fail(tr('error.scope_invalid', scope));
    console.error(`  ${tr('error.valid_options')}: ${valid.join(', ')}`);
    process.exit(1);
  }
}

// The runtime is the one positional; `--runtime <name>` is the same thing
// (the shell scripts document it). Both, and disagreeing, is an error.
function runtimeArg({ positional, flags }) {
  if (positional.length > 1 || (positional[0] && flags.runtime && positional[0] !== flags.runtime)) {
    ui.fail(tr('error.one_runtime'));
    process.exit(1);
  }
  return positional[0] || flags.runtime;
}

// =================================================================
// Commands
// =================================================================

async function cmdInstall(parsed) {
  const { flags } = parsed;
  const runtime = runtimeArg(parsed);
  const scope = flags.scope || 'project';

  ensureRuntime(runtime);
  ensureScope(scope);

  await ui.bannerAnimated();

  ui.header(tr('install.header', `${c.bold}${runtime}${c.reset}`));
  ui.info(`${tr('label.directory')}: ${c.dim}${process.cwd()}${c.reset}`);
  ui.info(`${tr('label.scope')}: ${c.dim}${scope}${c.reset}`);
  ui.info(`${tr('label.platform')}: ${c.dim}${process.platform} (${isWindows ? 'PowerShell' : 'bash'})${c.reset}`);
  console.log('');

  const args = isWindows
    ? ['-Runtime', runtime, '-Scope', scope]
    : [runtime, '--scope', scope];
  if (flags.githooks) args.push(isWindows ? '-Githooks' : '--githooks');
  // replace JDI files the project edited (default: kept, new version beside)
  if (flags.force) process.env.JDI_FORCE_FILES = '1';

  const { code } = runShellScript('jdi-install', args);

  if (code === 0) {
    ui.successSummary(tr('install.success_title'), [
      `${sym.success} ${tr('label.runtime')}: ${c.bold}${runtime}${c.reset}`,
      `${sym.success} ${tr('label.scope')}: ${c.bold}${scope}${c.reset}`,
      `${sym.success} ${tr('label.directory')}: ${c.dim}${process.cwd()}${c.reset}`,
    ]);

    const nextStepList = [
      tr('install.next1', runtime),
      tr('install.next2', `${c.cyan}${tr('install.next2_cmd')}${c.reset}`),
      tr('install.next3', `${c.cyan}/jdi-bootstrap${c.reset}`),
      tr('install.next4', `${c.cyan}npx jdi-cli doctor${c.reset}`),
    ];
    ui.nextSteps(nextStepList);
  } else {
    const doctorCmd = `${c.cyan}npx jdi-cli doctor${c.reset}`;
    ui.errorSummary(tr('install.fail_title'), [
      `${sym.error} ${tr('label.exit_code')}: ${code}`,
      `${sym.info} ${tr('install.fail_hint', doctorCmd)}`,
    ]);
    process.exit(code);
  }
}

async function cmdBuild(parsed) {
  // `build <runtime>` rebuilds only that runtime (both builders take it).
  const runtime = runtimeArg(parsed) || 'all';
  ensureRuntime(runtime);

  await ui.bannerAnimated();

  ui.header(tr('build.header'));
  ui.info(`${tr('label.source')}: ${c.dim}${PKG_ROOT}/core/${c.reset}`);
  ui.info(`${tr('label.output')}: ${c.dim}${PKG_ROOT}/runtimes/${c.reset}`);
  console.log('');

  const { code } = runShellScript('jdi-build', isWindows ? ['-Target', runtime] : [runtime]);

  if (code === 0) {
    const runtimesDir = `${c.dim}runtimes/${c.reset}`;
    const built = runtime === 'all' ? RUNTIME_NAMES : [runtime];
    ui.successSummary(tr('build.success_title'), [
      `${sym.success} ${tr('build.success_line1', built.length, built.join(', '))}`,
      `${sym.success} ${tr('build.success_line2', runtimesDir)}`,
    ]);
    ui.nextSteps([
      tr('build.next1', `${c.cyan}npx jdi-cli install <runtime>${c.reset}`),
      tr('build.next2', `${c.cyan}npx jdi-cli doctor${c.reset}`),
    ]);
  } else {
    ui.errorSummary(tr('build.fail_title'), [`${sym.error} ${tr('label.exit_code')}: ${code}`]);
    process.exit(code);
  }
}

async function cmdUpdate({ flags }) {
  await ui.bannerAnimated();

  ui.header(tr('update.header'));
  ui.info(`${tr('label.directory')}: ${c.dim}${process.cwd()}${c.reset}`);
  console.log('');

  const args = buildFlagArgs(flags, [
    { key: 'force-specialists', win: '-ForceSpecialists', nix: '--force-specialists' },
    { key: 'skip-specialists', win: '-SkipSpecialists', nix: '--skip-specialists' },
    { key: 'dry-run', win: '-DryRun', nix: '--dry-run' },
    { key: 'force', win: '-Force', nix: '--force' },
  ]);

  const { code } = runShellScript('jdi-update', args);

  if (code !== 0) {
    process.exit(code);
  }
}

async function cmdUninstall(parsed) {
  const { flags } = parsed;
  // No runtime given = all of them (documented); `--runtime claude` is claude
  // only — it used to fall through to `all` (#35).
  const runtime = runtimeArg(parsed) || 'all';
  ensureRuntime(runtime);
  ensureScope(flags.scope, UNINSTALL_SCOPES);

  await ui.bannerAnimated();

  ui.header(tr('uninstall.header'));
  ui.info(`${tr('label.directory')}: ${c.dim}${process.cwd()}${c.reset}`);
  console.log('');

  const args = (isWindows ? ['-Runtime', runtime] : ['--runtime', runtime]).concat(
    buildFlagArgs(flags, [
      { key: 'scope', win: '-Scope', nix: '--scope', value: true },
      { key: 'purge', win: '-Purge', nix: '--purge' },
      { key: 'yes', win: '-Yes', nix: '--yes' },
      { key: 'dry-run', win: '-DryRun', nix: '--dry-run' },
    ])
  );

  const { code } = runShellScript('jdi-uninstall', args);

  if (code !== 0) {
    process.exit(code);
  }
}

async function cmdInstallPlaywright({ flags }) {
  await ui.bannerAnimated();

  ui.header(tr('playwright.header'));
  ui.info(`${tr('label.directory')}: ${c.dim}${process.cwd()}${c.reset}`);
  console.log('');

  const args = buildFlagArgs(flags, [
    { key: 'skip-browser', win: '-SkipBrowser', nix: '--skip-browser' },
    { key: 'skip-mcp', win: '-SkipMcp', nix: '--skip-mcp' },
    { key: 'runtime', win: '-Runtime', nix: '--runtime', value: true },
    { key: 'antigravity-scope', win: '-AntigravityScope', nix: '--antigravity-scope', value: true },
  ]);

  const { code } = runShellScript('jdi-install-playwright', args);

  if (code === 0) {
    ui.successSummary(tr('playwright.success_title'), [
      `${sym.success} ${tr('playwright.line_installed')}`,
      `${sym.success} ${flags['skip-browser'] ? tr('playwright.line_browser_skipped') : tr('playwright.line_browser_installed')}`,
      `${sym.success} ${flags['skip-mcp'] ? tr('playwright.line_mcp_skipped') : tr('playwright.line_mcp_injected')}`,
    ]);
    ui.nextSteps([
      tr('playwright.next1'),
      tr('playwright.next2', `${c.cyan}/mcp${c.reset}`),
      tr('playwright.next3', `${c.cyan}opencode reload${c.reset}`),
    ]);
  } else {
    ui.errorSummary(tr('playwright.fail_title'), [`${sym.error} ${tr('label.exit_code')}: ${code}`]);
    process.exit(code);
  }
}

async function cmdInstallCaveman({ flags }) {
  await ui.bannerAnimated();

  ui.header(tr('caveman.header'));
  ui.info(`${tr('label.directory')}: ${c.dim}${process.cwd()}${c.reset}`);
  console.log('');

  const args = buildFlagArgs(flags, [
    { key: 'repo', win: '-Repo', nix: '--repo', value: true },
    { key: 'scope', win: '-Scope', nix: '--scope', value: true },
    { key: 'force', win: '-Force', nix: '--force' },
  ]);

  const { code } = runShellScript('jdi-install-caveman', args);

  if (code === 0) {
    ui.successSummary(tr('caveman.success_title'), [
      `${sym.success} ${tr('caveman.line_cloned')}`,
      `${sym.info} ${tr('caveman.line_restart')}`,
    ]);
    ui.nextSteps([
      tr('caveman.next1', `${c.cyan}/caveman-help${c.reset}`),
      tr('caveman.next2', `${c.cyan}/caveman lite|full|ultra${c.reset}`),
    ]);
  } else {
    ui.errorSummary(tr('caveman.fail_title'), [`${sym.error} ${tr('label.exit_code')}: ${code}`]);
    process.exit(code);
  }
}

async function cmdDoctor({ flags }) {
  await ui.bannerAnimated();

  ui.header(tr('doctor.header'));
  ui.info(`${tr('doctor.dir_label')}: ${c.dim}${process.cwd()}${c.reset}`);
  console.log('');

  let args = [];
  if (flags.verbose) {
    args = isWindows ? ['-Verbose'] : ['--verbose'];
  }
  const { code } = runShellScript('jdi-doctor', args);

  if (code !== 0) {
    process.exit(code);
  }
}

async function cmdHelp() {
  await ui.bannerAnimated();

  console.log(`${c.bold}${tr('help.usage_label')}${c.reset}`);
  console.log(`  ${c.cyan}${tr('help.usage_line')}${c.reset}`);
  console.log('');

  console.log(`${c.bold}${tr('help.commands_label')}${c.reset}`);
  console.log(`  ${c.cyan}install${c.reset} ${c.gray}<runtime>${c.reset}      ${tr('help.cmd.install')}`);
  console.log(`  ${c.cyan}update${c.reset}                 ${tr('help.cmd.update')}`);
  console.log(`  ${c.cyan}uninstall${c.reset} ${c.gray}[runtime]${c.reset}    ${tr('help.cmd.uninstall')}`);
  console.log(`  ${c.cyan}build${c.reset} ${c.gray}[runtime]${c.reset}        ${tr('help.cmd.build')}`);
  console.log(`  ${c.cyan}doctor${c.reset}                 ${tr('help.cmd.doctor')}`);
  console.log(`  ${c.cyan}install-playwright${c.reset}     ${tr('help.cmd.install_playwright')}`);
  console.log(`  ${c.cyan}install-caveman${c.reset}        ${tr('help.cmd.install_caveman')}`);
  console.log(`  ${c.cyan}help${c.reset}                   ${tr('help.cmd.help')}`);
  console.log(`  ${c.cyan}--version${c.reset}              ${tr('help.cmd.version')}`);
  console.log('');

  console.log(`${c.bold}${tr('help.helpers_label')}${c.reset}`);
  console.log(`  ${c.cyan}resolve-phase${c.reset} ${c.gray}<slug|pos> [--json]${c.reset}  ${tr('help.helper.resolve_phase')}`);
  console.log(`  ${c.cyan}validate-slug${c.reset} ${c.gray}<slug> [--check-unique]${c.reset}  ${tr('help.helper.validate_slug')}`);
  console.log(`  ${c.cyan}validate-phase${c.reset} ${c.gray}<slug|pos> [--for-pr]${c.reset}  ${tr('help.helper.validate_phase')}`);
  console.log(`  ${c.cyan}truncate${c.reset} ${c.gray}<file> <max>${c.reset}      ${tr('help.helper.truncate')}`);
  console.log(`  ${c.cyan}monitor${c.reset} ${c.gray}<file...>${c.reset}          ${tr('help.helper.monitor')}`);
  console.log(`  ${c.cyan}render${c.reset} ${c.gray}[--check]${c.reset}          ${tr('help.helper.render')}`);
  console.log(`  ${c.cyan}migrate-layout${c.reset} ${c.gray}[--dry-run]${c.reset}  ${tr('help.helper.migrate_layout')}`);
  console.log(`  ${c.cyan}sync-specialists${c.reset} ${c.gray}[runtime] [--check]${c.reset}  ${tr('help.helper.sync_specialists')}`);
  console.log(`  ${c.cyan}cost${c.reset} ${c.gray}[--targets|--timeline|--by-model] [--json] [--since d]${c.reset}  ${tr('help.helper.cost')}`);
  console.log(`  ${c.cyan}quota${c.reset} ${c.gray}[--json] | record${c.reset}  ${tr('help.helper.quota')}`);
  console.log(`  ${c.cyan}template${c.reset} ${c.gray}<name> [--out f] | --list${c.reset}  ${tr('help.helper.template')}`);
  console.log(`  ${c.cyan}learnings${c.reset} ${c.gray}[--last N] [--out f]${c.reset}  ${tr('help.helper.learnings')}`);
  console.log(`  ${c.cyan}decisions${c.reset} ${c.gray}[--index|--ids|--phase|--recent N]${c.reset}  ${tr('help.helper.decisions')}`);
  console.log(`  ${c.cyan}next${c.reset} ${c.gray}[phase] [--loop] [--json] [--status]${c.reset}  ${tr('help.helper.next')}`);
  console.log(`  ${c.cyan}add-phase${c.reset} ${c.gray}"<name>" [--goal g] [--before|--after s] [--unique]${c.reset}  ${tr('help.helper.add_phase')}`);
  console.log(`  ${c.cyan}ship${c.reset} ${c.gray}<phase> [--learnings-file f]${c.reset}  ${tr('help.helper.ship')}`);
  console.log(`  ${c.cyan}phases archive${c.reset} ${c.gray}[--dry-run] [--keep N] [--rewrite-refs]${c.reset}  ${tr('help.helper.phases')}`);
  console.log(`  ${c.cyan}dod${c.reset} ${c.gray}<parse|lint|extract|bait> <phase>${c.reset}  ${tr('help.helper.dod')}`);
  console.log(`  ${c.cyan}brief${c.reset} ${c.gray}<phase> --role <r> [--task T-N] [--stack s]${c.reset}  ${tr('help.helper.brief')}`);
  console.log(`  ${c.cyan}gates${c.reset} ${c.gray}<run|show|wait> <phase> [--stack s[,s2]] [--only dod] [--detach] [--failures --all]${c.reset}  ${tr('help.helper.gates')}`);
  console.log(`  ${c.cyan}review${c.reset} ${c.gray}<verdict|blockers|plan|baseline|merge|fresh|from-gates> <phase>${c.reset}  ${tr('help.helper.review')}`);
  console.log(`  ${c.cyan}loop${c.reset} ${c.gray}<init|record|reset|status> <phase>${c.reset}  ${tr('help.helper.loop')}`);
  console.log(`  ${c.cyan}budgets${c.reset} ${c.gray}<phase>${c.reset}  ${tr('help.helper.budgets')}`);
  console.log(`  ${c.cyan}known-errors${c.reset} ${c.gray}<query|migrate|render|list>${c.reset}  ${tr('help.helper.known_errors')}`);
  console.log(`  ${c.cyan}specialists${c.reset} ${c.gray}<lint|upgrade> [--adopt] [--write]${c.reset}  ${tr('help.helper.specialists')}`);
  console.log(`  ${c.cyan}critic${c.reset} ${c.gray}<plan|apply> <phase> [--preflight]${c.reset}  ${tr('help.helper.critic')}`);
  console.log(`  ${c.cyan}size${c.reset} ${c.gray}<phase> [--intake|--direct] [--json]${c.reset}  ${tr('help.helper.size')}`);
  console.log(`  ${c.cyan}route${c.reset} ${c.gray}<phase> --role <r> [--task T-N] [--attempt N] [--runtime rt --agent name]${c.reset}  ${tr('help.helper.route')}`);
  console.log(`  ${c.cyan}ceiling${c.reset} ${c.gray}<phase> [--start] [--json]${c.reset}  ${tr('help.helper.ceiling')}`);
  console.log(`  ${c.cyan}wave${c.reset} ${c.gray}<worktrees|merge|clean> <phase> [--tasks T-1,T-2]${c.reset}  ${tr('help.helper.wave')}`);
  console.log(`  ${c.cyan}evidence${c.reset} ${c.gray}<record|status> <phase> [--row N --scope iteration|ship]${c.reset}  ${tr('help.helper.evidence')}`);
  console.log('');

  console.log(`${c.bold}${tr('help.runtimes_label')}${c.reset}`);
  console.log(`  ${c.cyan}claude${c.reset}                 Claude Code`);
  console.log(`  ${c.cyan}copilot${c.reset}                GitHub Copilot`);
  console.log(`  ${c.cyan}antigravity${c.reset}            Google Antigravity`);
  console.log(`  ${c.cyan}opencode${c.reset}               OpenCode`);
  console.log(`  ${c.cyan}junie${c.reset}                  JetBrains Junie`);
  console.log(`  ${c.cyan}all${c.reset}                    ${tr('help.runtime.all')}`);
  console.log('');

  console.log(`${c.bold}${tr('help.options_label')}${c.reset}`);
  console.log(`  ${c.cyan}--scope${c.reset} ${c.gray}<user|project|both>${c.reset}  ${tr('help.opt.scope')}`);
  console.log(`  ${c.cyan}--runtime${c.reset} ${c.gray}<name>${c.reset}       ${tr('help.opt.runtime')}`);
  console.log(`  ${c.cyan}--githooks${c.reset}             ${tr('help.opt.githooks')}`);
  console.log(`  ${c.cyan}--lang${c.reset} ${c.gray}<en|pt-BR>${c.reset}     ${tr('help.opt.lang')}`);
  console.log(`  ${c.cyan}--verbose${c.reset}              ${tr('help.opt.verbose')}`);
  console.log(`  ${c.cyan}--dry-run${c.reset}              ${tr('help.opt.dry_run')}`);
  console.log(`  ${c.cyan}--purge${c.reset}                ${tr('help.opt.purge')}`);
  console.log(`  ${c.cyan}--yes${c.reset}                  ${tr('help.opt.yes')}`);
  console.log(`  ${c.cyan}--force-specialists${c.reset}    ${tr('help.opt.force_specialists')}`);
  console.log(`  ${c.cyan}--force${c.reset}                ${tr('help.opt.force_files')}`);
  console.log(`  ${c.cyan}--skip-specialists${c.reset}     ${tr('help.opt.skip_specialists')}`);
  console.log(`  ${c.cyan}--no-color${c.reset}             ${tr('help.opt.no_color')}`);
  console.log(`  ${c.cyan}-h, --help${c.reset}             ${tr('help.opt.help')}`);
  console.log('');

  console.log(`${c.bold}${tr('help.examples_label')}${c.reset}`);
  console.log(`  ${c.dim}${tr('help.example.install')}${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli@latest install opencode${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}${tr('help.example.update')}${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli@latest update${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}${tr('help.example.update_dry_run')}${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli@latest update --dry-run${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}${tr('help.example.uninstall')}${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli@latest uninstall${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}${tr('help.example.uninstall_purge')}${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli@latest uninstall --purge --yes${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}${tr('help.example.doctor')}${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli@latest doctor${c.reset}`);
  console.log('');

  console.log(`${c.bold}${tr('help.more_info_label')}${c.reset} ${c.cyan}https://github.com/slipalison/jdi-cli${c.reset}`);
  console.log('');
}

function cmdVersion() {
  console.log(`jdi-cli ${c.bold}v${VERSION}${c.reset}`);
}

// =================================================================
// Main dispatcher
// =================================================================

async function main() {
  const parsed = parseArgs(process.argv);
  libArgStart = 2 + parsed.cmdIndex + 1;

  try {
    cliLang = i18n.resolveLang(parsed.flags);
  } catch (err) {
    ui.fail(err.message);
    process.exit(1);
  }
  ui.setLang(cliLang);
  // Transporte pro script filho (.sh/.ps1) via spawnSync, que herda
  // process.env por default — evita repetir --lang/-Lang em cada script.
  // So propaga quando o usuario passou --lang explicitamente: sem a flag,
  // jdi-update precisa poder cair no .jdi/LANG persistido em vez do
  // default 'en' de cliLang.
  if (parsed.flags?.lang !== undefined) {
    process.env.JDI_LANG = cliLang;
  }

  // Usage errors stop here, before any banner or script (#36).
  if (parsed.errors.length > 0) {
    const helpCmd = `${c.cyan}npx jdi-cli help${c.reset}`;
    for (const e of parsed.errors) ui.fail(e);
    console.error(`  ${tr('error.see_help', helpCmd)}`);
    process.exit(1);
  }

  // `-h` / `-V` after an install-side command: help or version, never the
  // command itself (`install claude -h` used to install). The plumbing
  // helpers get their argv untouched.
  if (Object.hasOwn(COMMAND_FLAGS, parsed.cmd)) {
    if (parsed.flags.help) {
      await cmdHelp();
      return;
    }
    if (parsed.flags.version) {
      cmdVersion();
      return;
    }
  }

  switch (parsed.cmd) {
    case 'install':
      await cmdInstall(parsed);
      break;
    case 'update':
      await cmdUpdate(parsed);
      break;
    case 'uninstall':
      await cmdUninstall(parsed);
      break;
    case 'build':
      await cmdBuild(parsed);
      break;
    case 'install-playwright':
      await cmdInstallPlaywright(parsed);
      break;
    case 'install-caveman':
      await cmdInstallCaveman(parsed);
      break;
    case 'doctor':
      await cmdDoctor(parsed);
      break;
    // Plumbing helpers for slash commands inside consumer projects — raw argv,
    // no banner, exit code passthrough.
    case 'resolve-phase':
      cmdResolvePhase(libArgs());
      break;
    case 'validate-slug':
      cmdLibPassthrough('jdi-validate-slug', 'validate-slug <slug> [--check-unique]', libArgs());
      break;
    case 'validate-phase': {
      // --budgets: the shell validation first, then the Node budget check
      // (one implementation for every platform); exit = the worst of both.
      const raw = libArgs();
      if (!raw.includes('--budgets')) {
        cmdLibPassthrough('jdi-validate-phase', 'validate-phase <slug|position> [--for-pr] [--quiet] [--budgets]', raw);
        break;
      }
      const rest = raw.filter((a) => a !== '--budgets');
      const shellCode = rest.length ? runLibScript('jdi-validate-phase', rest).code : 1;
      runNodeHelper('budgets', rest.filter((a) => !a.startsWith('--')));
      process.exitCode = Math.max(shellCode, process.exitCode || 0);
      break;
    }
    case 'truncate':
      cmdLibPassthrough('jdi-truncate', 'truncate <file> <max_chars>', libArgs());
      break;
    case 'render':
      cmdLibZeroArg('jdi-render', libArgs());
      break;
    case 'migrate-layout':
      cmdLibZeroArg('jdi-migrate-layout', libArgs());
      break;
    case 'sync-specialists': {
      // the runtime copies first (shell, byte-identical twins), then the
      // tier variants Copilot and OpenCode need for `route` (0.22)
      const { code } = runLibScript('jdi-sync-specialists', libArgs());
      if (code !== 0) process.exit(code);
      runNodeHelper('tiers', libArgs());
      break;
    }
    case 'monitor':
      cmdLibPassthrough('jdi-monitor', 'monitor <file...>', libArgs());
      break;
    // Node helpers (single implementation for every platform — no .sh/.ps1
    // twins to drift apart, #48).
    case 'cost':
    case 'template':
    case 'learnings':
    case 'decisions':
    case 'dod':
    case 'budgets':
    case 'known-errors':
    case 'brief':
    case 'gates':
    case 'review':
    case 'loop':
    case 'next':
    case 'specialists':
    case 'critic':
    case 'size':
    case 'evidence':
    case 'route':
    case 'quota':
    case 'ceiling':
    case 'wave':
      runNodeHelper(parsed.cmd, libArgs());
      break;
    case 'add-phase':
    case 'ship':
    case 'phases': {
      const ops = require(path.join(PKG_ROOT, 'bin', 'lib', 'phase-ops.js'));
      runNodeHelper({ main: (a) => ops.main(parsed.cmd, a) }, libArgs());
      break;
    }
    case 'validate-dod':
      runNodeHelper('dod', ['lint', ...libArgs()]);
      break;
    case 'help':
    case '--help':
    case '-h':
      await cmdHelp();
      break;
    case '--version':
    case '-V':
    case '-v':
      cmdVersion();
      break;
    default: {
      const helpCmd = `${c.cyan}npx jdi-cli help${c.reset}`;
      ui.fail(tr('error.unknown_command', parsed.cmd));
      console.error(`  ${tr('error.see_help', helpCmd)}`);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    ui.fail(err?.message ? err.message : String(err));
    process.exit(1);
  });
}

module.exports = { parseArgs, exitCodeOf };
