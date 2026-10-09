'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'jdi.js');

// Fresh temp dir, removed at process exit.
function tmpdir(prefix = 'jdi-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Recursive copy of a fixture into a temp project dir.
function fixture(name) {
  const dest = tmpdir(`jdi-${name}-`);
  fs.cpSync(path.join(__dirname, 'fixtures', name), dest, { recursive: true });
  return dest;
}

// Run the CLI in `cwd`. Returns { code, stdout, stderr }.
function jdi(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

module.exports = { REPO, CLI, tmpdir, fixture, jdi, write, read };
