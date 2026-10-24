'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir, write, jdi } = require('./helpers');
const { parseArgs, exitCodeOf } = require('../bin/jdi.js');

const argv = (...a) => ['node', 'jdi.js', ...a];

test('parseArgs: --runtime is the runtime, not a value lost to `all` (#35)', () => {
  const p = parseArgs(argv('uninstall', '--runtime', 'claude', '--dry-run'));
  assert.equal(p.cmd, 'uninstall');
  assert.deepEqual(p.positional, []);
  assert.equal(p.flags.runtime, 'claude');
  assert.equal(p.flags['dry-run'], true);
  assert.deepEqual(p.errors, []);
});

test('parseArgs: an unknown flag of an install-side command is an error (#36)', () => {
  assert.deepEqual(parseArgs(argv('uninstall', '--purge', '--yes', '--dryrun')).errors, ['unknown flag: --dryrun']);
  assert.deepEqual(parseArgs(argv('install', 'claude', '--scope')).errors, ['--scope needs a value']);
});

test('parseArgs: =false turns a boolean off; any other value is an error (#61)', () => {
  assert.equal(parseArgs(argv('uninstall', '--purge=false')).flags.purge, false);
  assert.equal(parseArgs(argv('uninstall', '--purge=true')).flags.purge, true);
  assert.equal(parseArgs(argv('uninstall', '--purge=maybe')).errors.length, 1);
});

test('parseArgs: global flags before the command, aliases, -V after it (#61)', () => {
  const p = parseArgs(argv('--no-color', '--lang', 'pt-BR', 'remove', 'claude'));
  assert.equal(p.cmd, 'uninstall');
  assert.equal(p.cmdIndex, 3);
  assert.equal(p.flags.noColor, true);
  assert.equal(p.flags.lang, 'pt-BR');
  assert.deepEqual(p.positional, ['claude']);
  assert.equal(parseArgs(argv('doctor', '-V')).flags.version, true);
  assert.equal(parseArgs(argv('doctor', '-v')).flags.verbose, true);
});

test('parseArgs: plumbing helpers keep flags the CLI does not know', () => {
  const p = parseArgs(argv('dod', 'lint', 'x', '--json'));
  assert.equal(p.cmd, 'dod');
  assert.deepEqual(p.errors, []);
});

test('exitCodeOf: only status 0 is success (#38)', () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(exitCodeOf({ error: new Error('spawnSync bash ENOENT'), status: null }, 'bash'), 127);
  } finally {
    console.error = quiet;
  }
  assert.equal(exitCodeOf({ status: null, signal: 'SIGKILL' }, 'bash'), 1);
  assert.equal(exitCodeOf({ status: 0 }, 'bash'), 0);
  assert.equal(exitCodeOf({ status: 3 }, 'bash'), 3);
});

test('cli: a typo never reaches the purge — .jdi/ stays (#36)', () => {
  const root = tmpdir();
  write(root, '.jdi/STATE.md', 'x\n');
  const r = jdi(root, ['uninstall', '--purge', '--yes', '--dryrun']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag: --dryrun/);
  assert.ok(fs.existsSync(path.join(root, '.jdi', 'STATE.md')));
});

test('cli: -h after a command shows help and installs nothing (#61)', () => {
  const root = tmpdir();
  const r = jdi(root, ['install', 'claude', '-h']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /install-playwright/);
  assert.ok(!fs.existsSync(path.join(root, '.claude')));
});

test('cli: errors go to stderr; uninstall rejects an invalid --scope (#61)', () => {
  const root = tmpdir();
  const r = jdi(root, ['uninstall', 'claude', '--scope', 'bogus']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bogus/);
  assert.doesNotMatch(r.stdout, /bogus/);
});
