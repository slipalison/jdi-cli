#!/usr/bin/env node
// jdi-hook-version: {{JDI_VERSION}}
// Background worker spawned by jdi-check-update.js (SessionStart hook).
// Reads installed version (from the jdi-cli package the hook ships with),
// fetches latest from npm registry, compares semver, writes cache.
//
// Path-resolution strategy:
//   - The worker lives at <jdi-cli-package>/bin/lib/jdi-check-update-worker.js
//     when installed via npm (global or local).
//   - When copied into ~/.claude/hooks/ by `jdi install`, the package.json
//     path is no longer reachable. Fallback: env var JDI_INSTALLED_VERSION
//     (set by the install script when copying), or read from a sibling
//     VERSION file under the same hook dir.
//
// Failure mode is silent — this never breaks the user's session.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const cacheFile = process.env.JDI_CACHE_FILE;
if (!cacheFile) {
  process.exit(0);
}

const NPM_TIMEOUT_MS = 10000;
const PACKAGE_NAME = 'jdi-cli';

function readInstalledVersion() {
  // 1. Env var override (set by `jdi install` when copying the hook to ~/.claude/hooks/)
  if (process.env.JDI_INSTALLED_VERSION) {
    return process.env.JDI_INSTALLED_VERSION.trim();
  }

  // 2. Sibling VERSION file (written by the install script next to the hook)
  try {
    const versionFile = path.join(__dirname, 'JDI_VERSION');
    if (fs.existsSync(versionFile)) {
      return fs.readFileSync(versionFile, 'utf8').trim();
    }
  } catch (_e) {}

  // 3. Walk up looking for jdi-cli's package.json (case: still inside node_modules)
  try {
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
      const pkgFile = path.join(dir, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg && pkg.name === PACKAGE_NAME && pkg.version) {
          return String(pkg.version).trim();
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (_e) {}

  return '0.0.0';
}

// Compare semver: true if `a` is strictly newer than `b`.
// Strips pre-release suffixes (e.g. '3-beta.1' → '3') to avoid NaN from Number().
function isNewer(a, b) {
  const pa = (a || '').split('.').map((s) => Number(String(s).replace(/-.*/, '')) || 0);
  const pb = (b || '').split('.').map((s) => Number(String(s).replace(/-.*/, '')) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function writeCache(result) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(result));
  } catch (_e) {
    // Cache write failure: nothing to surface — the banner reads next session,
    // which will simply find no cache and skip.
  }
}

function npmViewLatest(callback) {
  // On Windows `npm` is `npm.cmd`. Node's execFile does not consult PATHEXT,
  // so we route through the shell on win32. POSIX stays direct.
  execFile(
    'npm',
    ['view', PACKAGE_NAME, 'version'],
    {
      encoding: 'utf8',
      timeout: NPM_TIMEOUT_MS,
      windowsHide: true,
      shell: process.platform === 'win32',
    },
    (err, stdout) => {
      if (err || !stdout) {
        callback(null);
        return;
      }
      callback(String(stdout).trim());
    }
  );
}

const installed = readInstalledVersion();

npmViewLatest((latest) => {
  const result = {
    update_available: !!(latest && isNewer(latest, installed)),
    installed,
    latest: latest || 'unknown',
    checked: Math.floor(Date.now() / 1000),
  };
  writeCache(result);
  process.exit(0);
});
