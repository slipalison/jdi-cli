#!/usr/bin/env node
'use strict';

// doctor-economy.js — section "Economia de tokens" of `jdi doctor` (called by
// both jdi-doctor.sh and jdi-doctor.ps1, so the two never drift). Prints
// `  OK    ...` / `  WARN  ...` / `  note  ...` lines; the caller counts WARN.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./jdi-core');

const INSTALLED_COMMAND_DIRS = ['.claude/commands', '.claude/agents', '.github/prompts', '.github/agents', '.opencode/commands', '.opencode/agents', '.junie/skills', '.agents/skills'];
const INSTRUCTION_FILES = [['CLAUDE.md', 'claude'], ['.github/copilot-instructions.md', 'copilot'], ['AGENTS.md', 'opencode'], ['.junie/AGENTS.md', 'junie'], ['.agents/agents.md', 'antigravity']];
const REREAD_RE = /(subagente n[aã]o herda|subagent does not inherit|ler com Read ANTES|read with Read BEFORE|(leia|ler|read)[^.\n]{0,40}\.claude\/rules|\.claude\/rules\/[^\n]{0,12}\((leia|read))/i;

function walkMd(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Versions the installed commands pin, and how many files call the CLI unpinned.
function installedPins(root) {
  const versions = new Set();
  let unpinned = 0;
  const files = INSTALLED_COMMAND_DIRS.flatMap((d) => walkMd(path.join(root, d)));
  for (const t of files.map((f) => fs.readFileSync(f, 'utf8'))) {
    for (const m of t.matchAll(/jdi-cli@(\d[\dA-Za-z.+-]*)/g)) versions.add(m[1]);
    if (/npx\s+(-y\s+)?jdi-cli(?![@\w-])/.test(t)) unpinned++;
  }
  return { versions, unpinned };
}

// 1. CLI pinned to one version, matching .jdi/VERSION
function checkPinned(root, say) {
  const { versions, unpinned } = installedPins(root);
  const declared = core.readIf(path.join(root, '.jdi', 'VERSION'))?.trim();
  if (unpinned > 0) say.warn(`${unpinned} arquivo(s) instalado(s) chamam \`npx -y jdi-cli\` sem versao (pre-0.16: cache velho ou release nova muda o helper) — rode \`npx jdi-cli@latest update\``);
  else if (versions.size > 1) say.warn(`comandos instalados misturam versoes do CLI: ${[...versions].join(', ')} — rode \`jdi update\``);
  else if (versions.size === 0) say.note('nenhum comando JDI instalado neste projeto');
  else checkOnePin([...versions][0], declared, say);
  if (fs.existsSync(path.join(root, '.jdi')) && !declared) say.warn('.jdi/VERSION ausente — o gate de CI e o update nao sabem a versao (rode `jdi update`)');
}

function checkOnePin(v, declared, say) {
  if (declared && declared !== v) say.warn(`comandos fixados em jdi-cli@${v}, mas .jdi/VERSION diz ${declared} — rode \`npx jdi-cli@${declared} update\``);
  else say.ok(`CLI fixado em jdi-cli@${v} nos comandos instalados`);
}

// 2. Managed instruction block (no full-file overwrite, no legacy block)
function checkInstructionBlocks(root, say) {
  const legacy = core.readJson(path.join(__dirname, 'instructions-legacy.json'), []) || [];
  const isLegacy = (buf, rt) => legacy.some((e) => e.runtime === rt && buf.length >= e.bytes && crypto.createHash('sha256').update(buf.subarray(0, e.bytes)).digest('hex') === e.sha256);
  for (const [rel, rt] of INSTRUCTION_FILES) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    if (buf.toString('utf8').includes('<!-- JDI:BEGIN')) say.ok(`${rel}: bloco JDI gerenciado`);
    else if (isLegacy(buf, rt)) say.warn(`${rel}: bloco JDI antigo (<= 0.15) — \`jdi update\` troca so o bloco e preserva o resto do arquivo`);
  }
}

// 3. Specialists that make every task pay for instructions twice
function checkSpecialists(root, say) {
  const agentsDir = path.join(root, '.jdi', 'agents');
  if (!fs.existsSync(agentsDir)) return;
  const texts = fs.readdirSync(agentsDir).filter((n) => n.endsWith('.md')).map((f) => [f, fs.readFileSync(path.join(agentsDir, f), 'utf8')]);
  const reread = texts.filter(([, t]) => REREAD_RE.test(t)).map(([f]) => f);
  const skills = texts.filter(([, t]) => t.includes('<skills_to_load>')).map(([f]) => f);
  if (reread.length) say.warn(`specialists mandam reler CLAUDE.md/rules que o runtime ja injeta: ${reread.join(', ')} — remova essa instrucao`);
  if (skills.length) say.warn(`specialists com <skills_to_load> (nunca carrega: sem ferramenta Skill): ${skills.join(', ')}`);
  if (!reread.length && !skills.length) say.ok('specialists sem releitura de instrucoes');
}

// 4. Config with token budgets (pre-0.16 budgets were chars nobody read)
function checkConfig(root, say) {
  const cfgPath = path.join(root, '.jdi', 'config.json');
  if (!fs.existsSync(cfgPath)) return;
  const cfg = core.readJson(cfgPath, {}) || {};
  if (cfg.budgets?.context_tokens) say.ok('config.json com orcamentos em tokens');
  else say.warn('config.json sem `budgets.context_tokens` (orcamento antigo em caracteres, nunca lido) — compare com `npx -y jdi-cli template config`');
}

// 5. Worktrees: one session per worktree
function checkWorktrees(root, say) {
  const wt = core.git(['worktree', 'list', '--porcelain'], root);
  if (wt.code !== 0) return;
  const n = (wt.stdout.match(/^worktree /gm) || []).length;
  if (n > 1) say.note(`${n} worktrees: trabalho em paralelo = uma sessao aberta DENTRO de cada worktree (agente apontado para checkout vizinho recarrega CLAUDE.md e rules dele)`);
}

function checks(root) {
  const lines = [];
  const say = {
    ok: (m) => lines.push(`  OK    ${m}`),
    warn: (m) => lines.push(`  WARN  ${m}`),
    note: (m) => lines.push(`  note  ${m}`),
  };
  for (const check of [checkPinned, checkInstructionBlocks, checkSpecialists, checkConfig, checkWorktrees]) check(root, say);
  return lines;
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || process.cwd());
  for (const l of checks(root)) console.log(l);
}

module.exports = { checks };
