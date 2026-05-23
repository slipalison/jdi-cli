#!/usr/bin/env node
// jdi-hook-version: {{JDI_VERSION}}
// SessionStart hook entry: spawns a detached worker that checks for jdi-cli
// updates against npm, writes the result to ~/.cache/jdi/jdi-update-check.json.
//
// Design constraints:
//   - Never blocks SessionStart. Spawns worker detached + unref, exits immediately.
//   - Fails open (silent) on any error — never breaks the user's session.
//   - Opt-in: only registered in settings.json when user runs `jdi enable-update-check`.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Respect explicit disable: env var, used by CI or paranoid users.
if (process.env.JDI_NO_UPDATE_CHECK === '1' || process.env.JDI_NO_UPDATE_CHECK === 'true') {
  process.exit(0);
}

const homeDir = os.homedir();
const cacheDir = path.join(homeDir, '.cache', 'jdi');

try {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
} catch (_e) {
  // Best-effort: if cache dir cannot be created, the worker will also fail
  // silently. SessionStart hooks must never produce errors to the runtime.
  process.exit(0);
}

const cacheFile = path.join(cacheDir, 'jdi-update-check.json');
const workerPath = path.join(__dirname, 'jdi-check-update-worker.js');

try {
  const child = spawn(process.execPath, [workerPath], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    env: {
      ...process.env,
      JDI_CACHE_FILE: cacheFile,
    },
  });
  child.unref();
} catch (_e) {
  // Spawn failure (e.g., worker missing) — silent exit.
}

process.exit(0);
