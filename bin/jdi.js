#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ui = require('./lib/ui');
const i18n = require('./lib/i18n');
const { c, sym } = ui;

const VERSION = require('../package.json').version;
const PKG_ROOT = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

const VALID_RUNTIMES = ['claude', 'copilot', 'antigravity', 'opencode', 'junie', 'all'];
const VALID_SCOPES = ['user', 'project'];

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
  '-h': 'help', '--help': 'help',
  '--no-color': 'noColor',
};
const BOOL_FLAGS = new Set(['verbose', 'help', 'version', 'noColor']);
// Flags whose value is the NEXT token (`--flag value`), besides `--flag=value`.
// Without this, `--runtime claude` parsed as {runtime:true} + positional
// "claude" and broke the shell delegation.
const VALUE_FLAGS = new Set(['scope', 'runtime', 'repo', 'antigravity-scope', 'lang']);

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { cmd: 'help' };

  const cmd = args[0];
  const rest = args.slice(1);
  const flags = {};
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('-')) { positional.push(a); continue; }

    const eq = a.indexOf('=');
    const raw = eq === -1 ? a : a.slice(0, eq);
    const key = FLAG_ALIAS[raw] || raw.replace(/^--?/, '');

    if (eq !== -1) { flags[key] = a.slice(eq + 1); continue; }
    if (BOOL_FLAGS.has(key)) { flags[key] = true; continue; }

    const next = rest[i + 1];
    if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('-')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { cmd, positional, flags };
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

  return { code: result.status ?? 0 };
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

  return { code: result.status ?? 0, stdout: opts.capture ? (result.stdout || '') : '' };
}

// Parse the resolver's KEY='value' lines into a plain object.
function parseResolverOutput(text) {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)='(.*)'$/.exec(line);
    if (m) map[m[1]] = m[2];
  }
  return {
    slug: map.JDI_PHASE_SLUG ?? null,
    dir: map.JDI_PHASE_DIR ?? null,
    position: map.JDI_PHASE_POSITION == null ? null : Number(map.JDI_PHASE_POSITION),
    schema_version: map.JDI_PHASE_SCHEMA == null ? null : Number(map.JDI_PHASE_SCHEMA),
    folder_exists: map.JDI_PHASE_FOLDER_EXISTS === 'true',
  };
}

// Plumbing subcommands receive RAW argv (everything after the subcommand):
// their flags (--json, --check-unique, ...) belong to the helper scripts,
// not to jdi.js's own flag parser.
function cmdResolvePhase(rawArgs) {
  const json = rawArgs.includes('--json');
  const rest = rawArgs.filter((a) => a !== '--json');
  if (rest.length === 0) {
    console.error('usage: jdi resolve-phase <slug|position> [--json]');
    process.exit(1);
  }
  if (json) {
    const { code, stdout } = runLibScript('jdi-resolve-phase', rest, { capture: true });
    if (code !== 0) process.exit(code);
    console.log(JSON.stringify(parseResolverOutput(stdout)));
    return;
  }
  const { code } = runLibScript('jdi-resolve-phase', rest);
  process.exit(code);
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
    console.log('');
    console.log(`  ${tr('help.usage_label')} ${c.cyan}jdi install <runtime> [--scope user|project]${c.reset}`);
    console.log(`  ${tr('error.runtimes_label')}: ${VALID_RUNTIMES.join(', ')}`);
    console.log('');
    process.exit(1);
  }
  if (!VALID_RUNTIMES.includes(runtime)) {
    ui.fail(tr('error.runtime_invalid', runtime));
    console.log(`  ${tr('error.valid_options')}: ${VALID_RUNTIMES.join(', ')}`);
    process.exit(1);
  }
}

function ensureScope(scope) {
  if (scope && !VALID_SCOPES.includes(scope)) {
    ui.fail(tr('error.scope_invalid', scope));
    console.log(`  ${tr('error.valid_options')}: ${VALID_SCOPES.join(', ')}`);
    process.exit(1);
  }
}

// =================================================================
// Commands
// =================================================================

async function cmdInstall({ positional, flags }) {
  const runtime = positional[0];
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

  const sp = ui.spinner(tr('install.spinner', runtime));
  sp.stop();

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

async function cmdBuild({ flags }) {
  await ui.bannerAnimated();

  ui.header(tr('build.header'));
  ui.info(`${tr('label.source')}: ${c.dim}${PKG_ROOT}/core/${c.reset}`);
  ui.info(`${tr('label.output')}: ${c.dim}${PKG_ROOT}/runtimes/${c.reset}`);
  console.log('');

  const { code } = runShellScript('jdi-build');

  if (code === 0) {
    const runtimesDir = `${c.dim}runtimes/${c.reset}`;
    ui.successSummary(tr('build.success_title'), [
      `${sym.success} ${tr('build.success_line1')}`,
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
  ]);

  const { code } = runShellScript('jdi-update', args);

  if (code !== 0) {
    process.exit(code);
  }
}

async function cmdUninstall({ positional, flags }) {
  await ui.bannerAnimated();

  ui.header(tr('uninstall.header'));
  ui.info(`${tr('label.directory')}: ${c.dim}${process.cwd()}${c.reset}`);
  console.log('');

  const runtime = positional[0] || 'all';
  ensureRuntime(runtime);

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
  console.log(`  ${c.cyan}build${c.reset}                  ${tr('help.cmd.build')}`);
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
  console.log('');

  console.log(`${c.bold}${tr('help.runtimes_label')}${c.reset}`);
  console.log(`  ${c.cyan}claude${c.reset}                 Claude Code`);
  console.log(`  ${c.cyan}copilot${c.reset}                GitHub Copilot`);
  console.log(`  ${c.cyan}antigravity${c.reset}            Google Antigravity`);
  console.log(`  ${c.cyan}opencode${c.reset}               OpenCode`);
  console.log(`  ${c.cyan}all${c.reset}                    ${tr('help.runtime.all')}`);
  console.log('');

  console.log(`${c.bold}${tr('help.options_label')}${c.reset}`);
  console.log(`  ${c.cyan}--scope${c.reset} ${c.gray}<user|project|both>${c.reset}  ${tr('help.opt.scope')}`);
  console.log(`  ${c.cyan}--githooks${c.reset}             ${tr('help.opt.githooks')}`);
  console.log(`  ${c.cyan}--lang${c.reset} ${c.gray}<en|pt-BR>${c.reset}     ${tr('help.opt.lang')}`);
  console.log(`  ${c.cyan}--verbose${c.reset}              ${tr('help.opt.verbose')}`);
  console.log(`  ${c.cyan}--dry-run${c.reset}              ${tr('help.opt.dry_run')}`);
  console.log(`  ${c.cyan}--purge${c.reset}                ${tr('help.opt.purge')}`);
  console.log(`  ${c.cyan}--yes${c.reset}                  ${tr('help.opt.yes')}`);
  console.log(`  ${c.cyan}--force-specialists${c.reset}    ${tr('help.opt.force_specialists')}`);
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

  if (parsed.flags?.noColor) {
    process.env.NO_COLOR = '1';
  }

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

  if (parsed.flags?.version) {
    cmdVersion();
    return;
  }

  switch (parsed.cmd) {
    case 'install':
      await cmdInstall(parsed);
      break;
    case 'update':
    case 'upgrade':
      await cmdUpdate(parsed);
      break;
    case 'uninstall':
    case 'remove':
      await cmdUninstall(parsed);
      break;
    case 'build':
      await cmdBuild(parsed);
      break;
    case 'install-playwright':
    case 'playwright':
      await cmdInstallPlaywright(parsed);
      break;
    case 'install-caveman':
    case 'caveman':
      await cmdInstallCaveman(parsed);
      break;
    case 'doctor':
      await cmdDoctor(parsed);
      break;
    // Plumbing helpers for slash commands inside consumer projects — raw argv,
    // no banner, exit code passthrough.
    case 'resolve-phase':
      cmdResolvePhase(process.argv.slice(3));
      break;
    case 'validate-slug':
      cmdLibPassthrough('jdi-validate-slug', 'validate-slug <slug> [--check-unique]', process.argv.slice(3));
      break;
    case 'validate-phase':
      cmdLibPassthrough('jdi-validate-phase', 'validate-phase <slug|position> [--for-pr] [--quiet]', process.argv.slice(3));
      break;
    case 'truncate':
      cmdLibPassthrough('jdi-truncate', 'truncate <file> <max_chars>', process.argv.slice(3));
      break;
    case 'render':
      cmdLibZeroArg('jdi-render', process.argv.slice(3));
      break;
    case 'migrate-layout':
      cmdLibZeroArg('jdi-migrate-layout', process.argv.slice(3));
      break;
    case 'monitor':
      cmdLibPassthrough('jdi-monitor', 'monitor <file...>', process.argv.slice(3));
      break;
    case 'help':
    case '--help':
    case '-h':
      await cmdHelp();
      break;
    case '--version':
    case '-V':
      cmdVersion();
      break;
    default: {
      const helpCmd = `${c.cyan}npx jdi-cli help${c.reset}`;
      ui.fail(tr('error.unknown_command', parsed.cmd));
      console.log(`  ${tr('error.see_help', helpCmd)}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  ui.fail(err?.message ? err.message : String(err));
  process.exit(1);
});
