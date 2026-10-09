'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mergeText, stripText } = require('../bin/lib/instructions');

const BLOCK = '<!-- JDI:BEGIN managed -->\n# JDI\nnew\n<!-- JDI:END -->\n';

test('creates the file when absent', () => {
  assert.deepEqual(mergeText(BLOCK, null, 'claude', []), { content: BLOCK, action: 'created' });
});

test('replaces only the managed block and keeps every other byte', () => {
  const before = 'top line\r\n\n<!-- JDI:BEGIN old -->\nold\n<!-- JDI:END -->\n# Project rules\nkeep me\n';
  const { content, action } = mergeText(BLOCK, Buffer.from(before), 'claude', []);
  assert.equal(action, 'updated');
  assert.equal(content, 'top line\r\n\n' + BLOCK + '# Project rules\nkeep me\n');
});

test('migrates a file that starts with a version JDI shipped', () => {
  const legacy = '# JDI — Instrucoes Claude Code\nold generic block\n';
  const list = [{ runtime: 'claude', bytes: Buffer.byteLength(legacy), sha256: crypto.createHash('sha256').update(legacy).digest('hex') }];
  const project = '\n---\n\n# Este repositorio\nregras do projeto\n';
  const { content, action } = mergeText(BLOCK, Buffer.from(legacy + project), 'claude', list);
  assert.equal(action, 'migrated');
  assert.equal(content, BLOCK + project);
});

test('never guesses: unknown content gets the block prepended, untouched below', () => {
  const user = '# My rules\nx\n';
  const { content, action } = mergeText(BLOCK, Buffer.from(user), 'claude', []);
  assert.equal(action, 'prepended');
  assert.equal(content, BLOCK + '\n' + user);
});

test('idempotent', () => {
  const once = mergeText(BLOCK, Buffer.from('# mine\n'), 'claude', []).content;
  assert.equal(mergeText(BLOCK, Buffer.from(once), 'claude', []).action, 'unchanged');
});

test('strip removes only the block; empty file means delete', () => {
  assert.deepEqual(stripText(BLOCK + '\n# mine\n'), { content: '# mine\n', action: 'stripped' });
  assert.equal(stripText(BLOCK).action, 'empty');
  assert.equal(stripText('# mine\n').action, 'absent');
});
