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

function checks(root) {
  const lines = [];
  const ok = (m) => lines.push(`  OK    ${m}`);
  const warn = (m) => lines.push(`  WARN  ${m}`);
  const note = (m) => lines.push(`  note  ${m}`);

  // 1. CLI pinned to one version, matching .jdi/VERSION
  const versions = new Set();
  let unpinned = 0;
  for (const d of INSTALLED_COMMAND_DIRS) {
    for (const f of walkMd(path.join(root, d))) {
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/jdi-cli@([0-9][0-9A-Za-z.+-]*)/g)) versions.add(m[1]);
      if (/npx\s+(-y\s+)?jdi-cli(?![@\w-])/.test(t)) unpinned++;
    }
  }
  const declared = core.readIf(path.join(root, '.jdi', 'VERSION'))?.trim();
  if (unpinned > 0) warn(`${unpinned} arquivo(s) instalado(s) chamam \`npx -y jdi-cli\` sem versao (pre-0.16: cache velho ou release nova muda o helper) — rode \`npx jdi-cli@latest update\``);
  else if (versions.size === 1) {
    const [v] = versions;
    if (declared && declared !== v) warn(`comandos fixados em jdi-cli@${v}, mas .jdi/VERSION diz ${declared} — rode \`npx jdi-cli@${declared} update\``);
    else ok(`CLI fixado em jdi-cli@${v} nos comandos instalados`);
  } else if (versions.size > 1) warn(`comandos instalados misturam versoes do CLI: ${[...versions].join(', ')} — rode \`jdi update\``);
  else note('nenhum comando JDI instalado neste projeto');
  if (fs.existsSync(path.join(root, '.jdi')) && !declared) warn('.jdi/VERSION ausente — o gate de CI e o update nao sabem a versao (rode `jdi update`)');

  // 2. Managed instruction block (no full-file overwrite, no legacy block)
  const legacy = core.readJson(path.join(__dirname, 'instructions-legacy.json'), []) || [];
  for (const [rel, rt] of INSTRUCTION_FILES) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    if (buf.toString('utf8').includes('<!-- JDI:BEGIN')) {
      ok(`${rel}: bloco JDI gerenciado`);
      continue;
    }
    const known = legacy.find((e) => e.runtime === rt && buf.length >= e.bytes && crypto.createHash('sha256').update(buf.subarray(0, e.bytes)).digest('hex') === e.sha256);
    if (known) warn(`${rel}: bloco JDI antigo (<= 0.15) — \`jdi update\` troca so o bloco e preserva o resto do arquivo`);
  }

  // 3. Specialists that make every task pay for instructions twice
  const agentsDir = path.join(root, '.jdi', 'agents');
  if (fs.existsSync(agentsDir)) {
    const reread = [];
    const skills = [];
    for (const f of fs.readdirSync(agentsDir).filter((n) => n.endsWith('.md'))) {
      const t = fs.readFileSync(path.join(agentsDir, f), 'utf8');
      if (REREAD_RE.test(t)) reread.push(f);
      if (t.includes('<skills_to_load>')) skills.push(f);
    }
    if (reread.length) warn(`specialists mandam reler CLAUDE.md/rules que o runtime ja injeta: ${reread.join(', ')} — remova essa instrucao`);
    if (skills.length) warn(`specialists com <skills_to_load> (nunca carrega: sem ferramenta Skill): ${skills.join(', ')}`);
    if (!reread.length && !skills.length) ok('specialists sem releitura de instrucoes');
    const specs = fs.readdirSync(agentsDir).filter((n) => /^jdi-(doer|reviewer)-.*\.md$/.test(n));
    const unmanaged = specs.filter((f) => !fs.readFileSync(path.join(agentsDir, f), 'utf8').includes('<!-- jdi:managed id='));
    if (unmanaged.length) warn(`specialists sem blocos gerenciados (anteriores a 0.17: sem brief nem retorno curto): ${unmanaged.join(', ')} — \`npx -y jdi-cli specialists upgrade --adopt\``);
    else if (specs.length) ok('specialists com blocos gerenciados');
    const reviewers = specs.filter((f) => f.startsWith('jdi-reviewer-'));
    const stacksDir = path.join(root, '.jdi', 'stacks');
    const hasStacks = fs.existsSync(stacksDir) && fs.readdirSync(stacksDir).some((f) => f.endsWith('.json'));
    if (reviewers.length && !hasStacks) note('sem .jdi/stacks/: os reviewers rodam build/testes dentro do proprio contexto (caro) — `npx -y jdi-cli template stack` mostra o formato');
  }

  // 4. Config with token budgets (pre-0.16 budgets were chars nobody read)
  const cfgPath = path.join(root, '.jdi', 'config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = core.readJson(cfgPath, {}) || {};
    if (cfg.budgets && cfg.budgets.context_tokens) ok('config.json com orcamentos em tokens');
    else warn('config.json sem `budgets.context_tokens` (orcamento antigo em caracteres, nunca lido) — compare com `npx -y jdi-cli template config`');
  }

  // 5. Worktrees: one session per worktree
  const wt = core.git(['worktree', 'list', '--porcelain'], root);
  if (wt.code === 0) {
    const n = (wt.stdout.match(/^worktree /gm) || []).length;
    if (n > 1) note(`${n} worktrees: trabalho em paralelo = uma sessao aberta DENTRO de cada worktree (agente apontado para checkout vizinho recarrega CLAUDE.md e rules dele)`);
  }
  return lines;
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || process.cwd());
  for (const l of checks(root)) console.log(l);
}

module.exports = { checks };
