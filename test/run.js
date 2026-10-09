#!/usr/bin/env node
'use strict';

// Test runner: `node test/run.js` (same on Linux, macOS and Windows — no shell
// glob needed). Runs every test/*.test.js with the built-in node:test runner.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = __dirname;
const only = process.argv.slice(2);
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort()
  .map((f) => path.join(dir, f));

if (files.length === 0) {
  console.error('nenhum teste encontrado');
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
