#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ui = require('./lib/ui');
const { c, sym } = ui;

const VERSION = require('../package.json').version;
const PKG_ROOT = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

const VALID_RUNTIMES = ['claude', 'copilot', 'antigravity', 'opencode', 'all'];
const VALID_SCOPES = ['user', 'project'];

// =================================================================
// Argument parsing — minimal, no deps
// =================================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { cmd: 'help' };

  const cmd = args[0];
  const rest = args.slice(1);
  const flags = {};
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--scope' || a === '-s') {
      flags.scope = rest[++i];
    } else if (a === '--verbose' || a === '-v') {
      flags.verbose = true;
    } else if (a === '--help' || a === '-h') {
      flags.help = true;
    } else if (a === '--version') {
      flags.version = true;
    } else if (a === '--no-color') {
      flags.noColor = true;
    } else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else {
      positional.push(a);
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

function runShellScript(scriptName, scriptArgs = []) {
  const scriptPath = getScriptPath(scriptName);

  if (!fs.existsSync(scriptPath)) {
    ui.fail(`Script nao encontrado: ${scriptPath}`);
    return { code: 1 };
  }

  let cmd, args;
  if (isWindows) {
    cmd = 'powershell.exe';
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
// Validation helpers
// =================================================================

function ensureRuntime(runtime) {
  if (!runtime) {
    ui.fail('Runtime obrigatorio.');
    console.log('');
    console.log(`  Uso: ${c.cyan}jdi install <runtime> [--scope user|project]${c.reset}`);
    console.log(`  Runtimes: ${VALID_RUNTIMES.join(', ')}`);
    console.log('');
    process.exit(1);
  }
  if (!VALID_RUNTIMES.includes(runtime)) {
    ui.fail(`Runtime invalido: ${runtime}`);
    console.log(`  Validos: ${VALID_RUNTIMES.join(', ')}`);
    process.exit(1);
  }
}

function ensureScope(scope) {
  if (scope && !VALID_SCOPES.includes(scope)) {
    ui.fail(`Scope invalido: ${scope}`);
    console.log(`  Validos: ${VALID_SCOPES.join(', ')}`);
    process.exit(1);
  }
}

// =================================================================
// Commands
// =================================================================

function cmdInstall({ positional, flags }) {
  const runtime = positional[0];
  const scope = flags.scope || 'project';

  ensureRuntime(runtime);
  ensureScope(scope);

  ui.banner();

  ui.header(`Instalando JDI para ${c.bold}${runtime}${c.reset}`);
  ui.info(`Diretorio: ${c.dim}${process.cwd()}${c.reset}`);
  ui.info(`Scope: ${c.dim}${scope}${c.reset}`);
  ui.info(`Plataforma: ${c.dim}${process.platform} (${isWindows ? 'PowerShell' : 'bash'})${c.reset}`);
  console.log('');

  const args = isWindows
    ? ['-Runtime', runtime, '-Scope', scope]
    : [runtime, '--scope', scope];

  const sp = ui.spinner(`Instalando adapters em ${runtime}...`);
  sp.stop();

  const { code } = runShellScript('jdi-install', args);

  if (code === 0) {
    ui.successSummary('JDI instalado com sucesso', [
      `${sym.success} Runtime: ${c.bold}${runtime}${c.reset}`,
      `${sym.success} Scope: ${c.bold}${scope}${c.reset}`,
      `${sym.success} Diretorio: ${c.dim}${process.cwd()}${c.reset}`,
    ]);

    const nextStepList = [
      `Abre teu runtime (${runtime}) no diretorio do projeto`,
      `Roda ${c.cyan}/jdi-new "<descricao do projeto>"${c.reset} pra inicializar`,
      `Depois ${c.cyan}/jdi-bootstrap${c.reset} pra criar specialists per-project`,
      `Comando ${c.cyan}npx jdi-cli doctor${c.reset} pra diagnostico`,
    ];
    ui.nextSteps(nextStepList);
  } else {
    ui.errorSummary('Instalacao falhou', [
      `${sym.error} Exit code: ${code}`,
      `${sym.info} Tente ${c.cyan}npx jdi-cli doctor${c.reset} pra diagnostico`,
    ]);
    process.exit(code);
  }
}

function cmdBuild({ flags }) {
  ui.banner();

  ui.header('Building JDI runtimes');
  ui.info(`Source: ${c.dim}${PKG_ROOT}/core/${c.reset}`);
  ui.info(`Output: ${c.dim}${PKG_ROOT}/runtimes/${c.reset}`);
  console.log('');

  const { code } = runShellScript('jdi-build');

  if (code === 0) {
    ui.successSummary('Build completo', [
      `${sym.success} 4 runtimes gerados (claude, copilot, antigravity, opencode)`,
      `${sym.success} Adapters em ${c.dim}runtimes/${c.reset}`,
    ]);
    ui.nextSteps([
      `Instala em projeto: ${c.cyan}npx jdi-cli install <runtime>${c.reset}`,
      `Diagnostico: ${c.cyan}npx jdi-cli doctor${c.reset}`,
    ]);
  } else {
    ui.errorSummary('Build falhou', [`${sym.error} Exit code: ${code}`]);
    process.exit(code);
  }
}

function cmdDoctor({ flags }) {
  ui.banner();

  ui.header('JDI Doctor');
  ui.info(`Diretorio atual: ${c.dim}${process.cwd()}${c.reset}`);
  console.log('');

  const args = flags.verbose ? (isWindows ? ['-Verbose'] : ['--verbose']) : [];
  const { code } = runShellScript('jdi-doctor', args);

  if (code !== 0) {
    process.exit(code);
  }
}

function cmdHelp() {
  ui.banner();

  console.log(`${c.bold}Uso:${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli <comando> [opcoes]${c.reset}`);
  console.log('');

  console.log(`${c.bold}Comandos:${c.reset}`);
  console.log(`  ${c.cyan}install${c.reset} ${c.gray}<runtime>${c.reset}      Instala JDI no projeto atual`);
  console.log(`  ${c.cyan}build${c.reset}                  Re-builda runtimes/ a partir de core/`);
  console.log(`  ${c.cyan}doctor${c.reset}                 Diagnostico do projeto + JDI`);
  console.log(`  ${c.cyan}help${c.reset}                   Mostra esta ajuda`);
  console.log(`  ${c.cyan}--version${c.reset}              Mostra versao`);
  console.log('');

  console.log(`${c.bold}Runtimes (install):${c.reset}`);
  console.log(`  ${c.cyan}claude${c.reset}                 Claude Code`);
  console.log(`  ${c.cyan}copilot${c.reset}                GitHub Copilot`);
  console.log(`  ${c.cyan}antigravity${c.reset}            Google Antigravity`);
  console.log(`  ${c.cyan}opencode${c.reset}               OpenCode`);
  console.log(`  ${c.cyan}all${c.reset}                    Todos os 4`);
  console.log('');

  console.log(`${c.bold}Opcoes:${c.reset}`);
  console.log(`  ${c.cyan}--scope${c.reset} ${c.gray}<user|project>${c.reset}   Escopo da instalacao (default: project)`);
  console.log(`  ${c.cyan}--verbose${c.reset}              Output detalhado (so doctor)`);
  console.log(`  ${c.cyan}--no-color${c.reset}             Desabilita cores ANSI`);
  console.log(`  ${c.cyan}-h, --help${c.reset}             Esta ajuda`);
  console.log('');

  console.log(`${c.bold}Exemplos:${c.reset}`);
  console.log(`  ${c.dim}# Instalacao no projeto atual${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli install opencode${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}# Instalacao global (user-scope)${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli install claude --scope user${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}# Diagnostico${c.reset}`);
  console.log(`  ${c.cyan}npx jdi-cli doctor${c.reset}`);
  console.log('');

  console.log(`${c.bold}Saiba mais:${c.reset} ${c.cyan}https://github.com/<owner>/jdi${c.reset}`);
  console.log('');
}

function cmdVersion() {
  console.log(`jdi-cli ${c.bold}v${VERSION}${c.reset}`);
}

// =================================================================
// Main dispatcher
// =================================================================

function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.flags && parsed.flags.noColor) {
    process.env.NO_COLOR = '1';
  }

  if (parsed.flags && parsed.flags.version) {
    cmdVersion();
    return;
  }

  switch (parsed.cmd) {
    case 'install':
      cmdInstall(parsed);
      break;
    case 'build':
      cmdBuild(parsed);
      break;
    case 'doctor':
      cmdDoctor(parsed);
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    case '--version':
    case '-V':
      cmdVersion();
      break;
    default:
      ui.fail(`Comando desconhecido: ${parsed.cmd}`);
      console.log(`  Use ${c.cyan}npx jdi-cli help${c.reset} pra ver comandos disponiveis.`);
      process.exit(1);
  }
}

main();
