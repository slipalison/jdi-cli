'use strict';

// Cross-platform JSON-safe enable/disable for jdi-cli's update notifier in
// Claude Code's settings.json. Never edits any other field. Always backs up.
//
// On enable:
//   1. Locate or create settings.json (project: ./.claude/settings.json, user: ~/.claude/settings.json)
//   2. Parse existing JSON (or start from {} if absent)
//   3. Ensure hooks.SessionStart array exists, add an entry that runs
//      jdi-check-update.js + jdi-update-banner.js. If a JDI entry already
//      exists (idempotent re-run), skip.
//   4. Write back with a .bak backup of the original.
//
// On disable:
//   1. Read settings.json
//   2. Filter out any hooks.SessionStart entry that references jdi-*.js
//   3. Write back with backup.
//
// Hooks are NEVER deleted from disk — they remain in ~/.claude/hooks/ so a
// future re-enable is instant.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_BASENAMES = ['jdi-check-update.js', 'jdi-update-banner.js'];

function resolveSettingsPath(scope) {
  const claudeDir =
    scope === 'user'
      ? path.join(os.homedir(), '.claude')
      : path.join(process.cwd(), '.claude');
  return {
    claudeDir,
    settingsFile: path.join(claudeDir, 'settings.json'),
    hooksDir: path.join(claudeDir, 'hooks'),
  };
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `settings.json is not valid JSON (${e.message}). Refusing to overwrite. Fix it manually and rerun.`
    );
  }
}

function backupOriginal(file) {
  if (!fs.existsSync(file)) return;
  const bak = file + '.bak';
  fs.copyFileSync(file, bak);
  return bak;
}

function writeSettings(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isJdiEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      h &&
      typeof h.command === 'string' &&
      HOOK_BASENAMES.some((b) => h.command.includes(b))
  );
}

function buildJdiEntry(hooksDir) {
  // Use absolute paths so the runtime doesn't depend on cwd at session start.
  const checkUpdate = path.join(hooksDir, 'jdi-check-update.js');
  const banner = path.join(hooksDir, 'jdi-update-banner.js');
  return {
    matcher: '.*',
    hooks: [
      { type: 'command', command: `node ${JSON.stringify(checkUpdate)}` },
      { type: 'command', command: `node ${JSON.stringify(banner)}` },
    ],
  };
}

function ensureHooksInstalled(hooksDir) {
  for (const basename of HOOK_BASENAMES.concat(['jdi-check-update-worker.js'])) {
    const file = path.join(hooksDir, basename);
    if (!fs.existsSync(file)) {
      throw new Error(
        `Hook missing: ${file}. Run \`jdi install claude\` first (it copies hooks).`
      );
    }
  }
}

function enable({ scope = 'project' } = {}) {
  const { claudeDir, settingsFile, hooksDir } = resolveSettingsPath(scope);

  if (!fs.existsSync(claudeDir)) {
    throw new Error(
      `${claudeDir} does not exist. Run \`jdi install claude --scope ${scope}\` first.`
    );
  }
  ensureHooksInstalled(hooksDir);

  const settings = readJsonSafe(settingsFile);
  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : [];

  const alreadyEnabled = settings.hooks.SessionStart.some(isJdiEntry);
  if (alreadyEnabled) {
    return {
      changed: false,
      settingsFile,
      message: 'Already enabled — no changes.',
    };
  }

  const backup = backupOriginal(settingsFile);
  settings.hooks.SessionStart.push(buildJdiEntry(hooksDir));
  writeSettings(settingsFile, settings);

  return {
    changed: true,
    settingsFile,
    backup,
    message: 'Update notifier enabled — banner fires next SessionStart.',
  };
}

function disable({ scope = 'project' } = {}) {
  const { settingsFile } = resolveSettingsPath(scope);

  if (!fs.existsSync(settingsFile)) {
    return {
      changed: false,
      settingsFile,
      message: 'settings.json not found — nothing to disable.',
    };
  }

  const settings = readJsonSafe(settingsFile);
  const startHooks =
    settings.hooks && Array.isArray(settings.hooks.SessionStart)
      ? settings.hooks.SessionStart
      : null;

  if (!startHooks || startHooks.length === 0) {
    return {
      changed: false,
      settingsFile,
      message: 'No SessionStart hooks configured — nothing to disable.',
    };
  }

  const filtered = startHooks.filter((e) => !isJdiEntry(e));
  if (filtered.length === startHooks.length) {
    return {
      changed: false,
      settingsFile,
      message: 'JDI update notifier not present in settings.json.',
    };
  }

  const backup = backupOriginal(settingsFile);
  settings.hooks.SessionStart = filtered;

  // Tidy up: remove empty containers so settings.json stays minimal.
  if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(settingsFile, settings);

  return {
    changed: true,
    settingsFile,
    backup,
    message: 'Update notifier disabled. Hooks remain on disk for future re-enable.',
  };
}

module.exports = {
  enable,
  disable,
  // exported for tests
  _internal: {
    HOOK_BASENAMES,
    resolveSettingsPath,
    isJdiEntry,
    buildJdiEntry,
  },
};
