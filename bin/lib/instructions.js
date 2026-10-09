#!/usr/bin/env node
'use strict';

// instructions.js — the JDI section of the project instruction files
// (CLAUDE.md, .github/copilot-instructions.md, AGENTS.md, .junie/AGENTS.md,
// .agents/agents.md) is a MANAGED BLOCK between markers:
//
//   <!-- JDI:BEGIN ... -->  ...  <!-- JDI:END -->
//
// install/update replace only that block; everything else in the file is the
// project's and is preserved byte for byte. Up to 0.15.x the installer copied
// the whole file over the project's (`cp`), wiping project rules.
//
// Migration of files written by <= 0.15.x: when the file STARTS with the exact
// bytes of a version JDI itself shipped (sha256 list in
// instructions-legacy.json), that prefix is replaced by the managed block.
// Anything else is never guessed at: without markers and without a known
// prefix, the block is prepended and the rest is left untouched.
//
// Usage:
//   node instructions.js merge <managed-src> <dest> <runtime>
//   node instructions.js strip <dest>     (uninstall: remove only the block)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BEGIN = '<!-- JDI:BEGIN';
const END = '<!-- JDI:END -->';

function legacyList() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'instructions-legacy.json'), 'utf8'));
  } catch {
    return [];
  }
}

function findBlock(text) {
  const b = text.indexOf(BEGIN);
  if (b === -1) return null;
  const lineStart = text.lastIndexOf('\n', b) + 1;
  const e = text.indexOf(END, b);
  if (e === -1) return null;
  let end = e + END.length;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  return { start: lineStart, end };
}

function legacyPrefix(buf, runtime, list = legacyList()) {
  for (const entry of list) {
    if (entry.runtime !== runtime || buf.length < entry.bytes) continue;
    const sha = crypto.createHash('sha256').update(buf.subarray(0, entry.bytes)).digest('hex');
    if (sha === entry.sha256) return entry.bytes;
  }
  return 0;
}

// Pure merge: returns { content, action }.
function mergeText(managed, existingBuf, runtime, list) {
  const block = managed.endsWith('\n') ? managed : managed + '\n';
  if (existingBuf === null) return { content: block, action: 'created' };
  const existing = existingBuf.toString('utf8');
  const found = findBlock(existing);
  if (found) {
    const content = existing.slice(0, found.start) + block + existing.slice(found.end);
    return { content, action: content === existing ? 'unchanged' : 'updated' };
  }
  const prefix = legacyPrefix(existingBuf, runtime, list);
  if (prefix > 0) {
    const rest = existingBuf.subarray(prefix).toString('utf8');
    return { content: block + rest, action: 'migrated' };
  }
  return { content: block + '\n' + existing, action: 'prepended' };
}

function stripText(existing) {
  const found = findBlock(existing);
  if (!found) return { content: existing, action: 'absent' };
  let rest = existing.slice(0, found.start) + existing.slice(found.end);
  if (rest.startsWith('\n') && found.start === 0) rest = rest.slice(1);
  return { content: rest, action: rest.trim() === '' ? 'empty' : 'stripped' };
}

const STRIP_MESSAGES = {
  empty: 'removido (so tinha o bloco JDI)',
  stripped: 'bloco JDI removido, resto preservado',
  absent: 'sem bloco JDI',
};

function mergeFile(src, dest, runtime) {
  if (!src || !dest || !runtime) throw new Error('usage: instructions.js merge <src> <dest> <runtime>');
  const managed = fs.readFileSync(src, 'utf8');
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  const { content, action } = mergeText(managed, existing, runtime);
  if (action !== 'unchanged') {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  console.log(`  -> ${path.basename(dest)}: bloco JDI ${action}`);
  if (action === 'prepended') {
    console.log(`     aviso: ${dest} nao tinha o bloco JDI nem uma versao conhecida dele;`);
    console.log('     o bloco novo foi posto no topo. Se houver um bloco JDI antigo abaixo, apague-o.');
  }
  return 0;
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'merge') return mergeFile(...args);
  if (cmd === 'strip') {
    const [dest] = args;
    if (!dest || !fs.existsSync(dest)) return 0;
    const { content, action } = stripText(fs.readFileSync(dest, 'utf8'));
    if (action === 'empty') fs.rmSync(dest);
    else if (action === 'stripped') fs.writeFileSync(dest, content);
    console.log(`  -> ${path.basename(dest)}: ${STRIP_MESSAGES[action] || STRIP_MESSAGES.absent}`);
    return 0;
  }
  throw new Error('usage: instructions.js merge <src> <dest> <runtime> | strip <dest>');
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`instructions: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { mergeText, stripText, findBlock, legacyPrefix, BEGIN, END };
