#!/usr/bin/env node
// jdi-hook-version: {{JDI_VERSION}}
// SessionStart banner: reads the cache written by jdi-check-update-worker.js
// and emits a Claude Code / OpenCode-compatible JSON envelope with a
// systemMessage when an update is available.
//
// Opt-in by design: registered in settings.json only when the user runs
// `jdi enable-update-check`. The mere presence of the file in
// ~/.claude/hooks/ is harmless — the runtime does not execute it until
// settings.json references it as a SessionStart hook.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 24h rate-limit for repeated parse-error warnings so a corrupted cache
// does not nag the user every session.
const RATE_LIMIT_SECONDS = 24 * 60 * 60;

function debugLog(label, e) {
  if (process.env.JDI_DEBUG) console.error('[jdi]', label, e?.message);
}

function buildBannerOutput(state) {
  const { cache, parseError, suppressFailureWarning } = state || {};
  if (parseError) {
    if (suppressFailureWarning) return null;
    return { systemMessage: 'jdi-cli update check failed.' };
  }
  if (!cache) return null;
  if (!cache.update_available) return null;
  const installed = cache.installed || 'unknown';
  const latest = cache.latest || 'unknown';
  return {
    systemMessage: `jdi-cli update available: ${installed} → ${latest}. Run \`npm install -g jdi-cli@latest\` to upgrade.`,
  };
}

function readCache(cacheFile) {
  let cache = null;
  let parseError = false;
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      cache = JSON.parse(raw);
    }
  } catch (e) {
    parseError = e instanceof SyntaxError;
  }
  return { cache, parseError };
}

function shouldSuppressFailureWarning(sentinelFile, nowSeconds) {
  try {
    if (!fs.existsSync(sentinelFile)) return false;
    const last = Number.parseInt(fs.readFileSync(sentinelFile, 'utf8').trim(), 10);
    if (!Number.isFinite(last)) return false;
    return nowSeconds - last < RATE_LIMIT_SECONDS;
  } catch (e) {
    debugLog('sentinel read failed:', e);
    return false;
  }
}

function recordFailureWarning(sentinelFile, nowSeconds) {
  try {
    fs.writeFileSync(sentinelFile, String(nowSeconds));
  } catch (e) {
    // Best-effort: a non-writable cache dir means we re-warn next session.
    debugLog('sentinel write failed:', e);
  }
}

function main() {
  if (process.env.JDI_NO_UPDATE_CHECK === '1' || process.env.JDI_NO_UPDATE_CHECK === 'true') {
    return;
  }

  const cacheDir = path.join(os.homedir(), '.cache', 'jdi');
  const cacheFile = path.join(cacheDir, 'jdi-update-check.json');
  const sentinelFile = path.join(cacheDir, 'banner-failure-warned-at');
  const now = Math.floor(Date.now() / 1000);

  const { cache, parseError } = readCache(cacheFile);
  const suppressFailureWarning = parseError
    ? shouldSuppressFailureWarning(sentinelFile, now)
    : false;
  const output = buildBannerOutput({ cache, parseError, suppressFailureWarning });

  if (parseError && !suppressFailureWarning) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch (e) {
      debugLog('cache dir create failed:', e);
    }
    recordFailureWarning(sentinelFile, now);
  }

  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
}

if (require.main === module) main();

module.exports = {
  buildBannerOutput,
  readCache,
  shouldSuppressFailureWarning,
  RATE_LIMIT_SECONDS,
};
