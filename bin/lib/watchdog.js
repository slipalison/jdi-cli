'use strict';

// Runs ONE gate command under watch, for `gates.run` (which stays
// synchronous: it spawns this file with spawnSync). Usage, internal:
//
//   node watchdog.js '<json: { cmd, args, timeoutMs, idleMs }>'
//
// - The command's stdout and stderr go, interleaved, to this process's stdout.
// - On the deadline, or after `idleMs` with no output at all (a deadlock, a
//   lock held elsewhere, a dead connection), the WHOLE process tree is killed:
//   the shell and everything it started. Killing only the shell (spawnSync's
//   own timeout) left `cargo test` or an E2E running and holding locks after
//   the gate had already "ended".
// - When the shell exits, what it left running (a server started with `&`)
//   is ended too: it would hold the pipes open and the gate would never return.
// - Interrupted (Ctrl+C, a parent killed by its own limit): the tree goes too.
// - Exit code: the shell's own; on a kill, a `jdi-watchdog:` line on stderr
//   says which (gates.run reads it), and the code is 124 (130 interrupted).
// - The shell itself not found: exit 127, message on stderr.

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const KILL_GRACE_MS = 5000;
// after the shell exits, how long its leftovers get to release the pipes
const RELEASE_MS = 5000;
// by its fixed path, not whatever `taskkill` comes first on PATH
const TASKKILL = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'taskkill.exe');
const POSIX = process.platform !== 'win32';

// POSIX: the shell runs in its own process group — signal all of it.
function signalGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    // the group is already gone
  }
}

function killTree(child) {
  if (!POSIX) {
    if (child.exitCode === null) spawnSync(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  signalGroup(child.pid, 'SIGTERM');
  setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
}

function watch(spec) {
  const started = Date.now();
  let last = started;
  let reason = null;
  let shellCode = null;
  const child = spawn(spec.cmd, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // own process group on POSIX, so the whole tree can be killed; on
    // Windows `detached` would open a console — taskkill /T covers the tree
    detached: POSIX,
    windowsHide: true,
  });
  const onData = (b) => {
    last = Date.now();
    process.stdout.write(b);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let timer = null;
  const stop = (why) => {
    reason = why;
    clearInterval(timer);
    killTree(child);
  };
  timer = setInterval(() => {
    const now = Date.now();
    if (spec.timeoutMs && now - started > spec.timeoutMs) stop(`timed out after ${Math.round(spec.timeoutMs / 60000)} min`);
    else if (spec.idleMs && now - last > spec.idleMs) stop(`no output for ${Math.round(spec.idleMs / 1000)} s — stalled (a deadlock, a lock held elsewhere, a dead connection?)`);
  }, 1000);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(`interrupted (${sig})`));
  child.on('error', (err) => {
    clearInterval(timer);
    process.stderr.write(`jdi-watchdog: cannot start ${spec.cmd}: ${err.message}\n`);
    process.exitCode = 127;
  });
  child.on('exit', (code) => {
    shellCode = code;
    clearInterval(timer);
    if (POSIX) signalGroup(child.pid, 'SIGTERM');
    // a leftover outside the group (or on Windows) may still hold the pipes
    setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, RELEASE_MS).unref();
  });
  child.on('close', (code) => {
    clearInterval(timer);
    if (POSIX) signalGroup(child.pid, 'SIGKILL'); // whatever ignored SIGTERM
    if (reason) {
      process.stderr.write(`jdi-watchdog: ${reason}\n`);
      process.exitCode = reason.startsWith('interrupted') ? 130 : 124;
    } else if (process.exitCode !== 127) process.exitCode = shellCode ?? code ?? 1;
  });
}

if (require.main === module) watch(JSON.parse(process.argv[2]));

module.exports = { watch };
