'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transform } = require('../bin/lib/build-postprocess');

test('keeps a jdi:only block only in the listed runtimes and drops the markers', () => {
  const src = 'a\n<!-- jdi:only claude -->\nso claude\n<!-- jdi:end -->\nb\n';
  assert.equal(transform(src, 'claude', '1.2.3'), 'a\nso claude\nb\n');
  assert.equal(transform(src, 'copilot', '1.2.3'), 'a\nb\n');
});

test('accepts a runtime list', () => {
  const src = '<!-- jdi:only copilot, opencode -->\nx\n<!-- jdi:end -->\n';
  assert.equal(transform(src, 'opencode', '1'), 'x\n');
  assert.equal(transform(src, 'junie', '1'), '');
});

test('pins the CLI and the version', () => {
  assert.equal(transform('npx -y {{JDI_CLI}} brief\n{{JDI_VERSION}}\n', 'claude', '0.16.0'),
    'npx -y jdi-cli@0.16.0 brief\n0.16.0\n');
});

test('is idempotent on its own output', () => {
  const once = transform('<!-- jdi:only claude -->\nx {{JDI_CLI}}\n<!-- jdi:end -->\n', 'claude', '9.9.9');
  assert.equal(transform(once, 'claude', '9.9.9'), once);
});

test('rejects malformed blocks', () => {
  assert.throws(() => transform('<!-- jdi:only claude -->\nx\n', 'claude', '1'), /never closed/);
  assert.throws(() => transform('<!-- jdi:end -->\n', 'claude', '1'), /without jdi:only/);
  assert.throws(() => transform('<!-- jdi:only claude -->\n<!-- jdi:only copilot -->\n', 'claude', '1'), /nested/);
  assert.throws(() => transform('<!-- jdi:only gemini -->\n<!-- jdi:end -->\n', 'claude', '1'), /unknown runtime/);
});
