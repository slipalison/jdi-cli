'use strict';

// `jdi-cli wave <worktrees|merge|clean> <phase> [--tasks T-1,T-2] [--json]`
//
// Doers of a parallel wave, each in its OWN git worktree (0.22, opt-in with
// `economy.worktree_doers`). In one shared tree, a doer's targeted test
// compiles the half-written code of the doer next to it — a red that is nobody's
// fault — and their commits race on the index. Here each doer gets a checkout
// of the wave's base commit on its own branch, and the orchestrator brings the
// commits back in task order. The price: a worktree starts cold (no build
// output, no installed dependencies — a stack's `worktree_setup` runs there
// first), and the runtime may load the worktree's copy of the instruction
// files. Worth it when parallel doers break each other's builds.
//
//   worktrees  one per task: branch jdi/<slug>/<T-N>, at
//              .jdi/cache/worktrees/<slug>/<T-N> (git-ignored), from HEAD;
//              then each stack's `worktree_setup` there. Prints the paths.
//   merge      task by task, in order: its commits since the wave base are
//              cherry-picked onto HEAD. A conflict rolls that task back (exit
//              1: run it again in the main checkout); the others go on. Files
//              a task committed outside its `Files modified` are reported. If
//              the main checkout changed meanwhile (a doer wrote outside its
//              worktree), nothing is merged (exit 3). Then the worktrees go —
//              the next suite's test runners must not find their copies — and
//              so do the merged branches; a conflicted branch is kept.
//   clean      removes every worktree and branch of the phase.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const brief = require('./brief');
const gates = require('./gates');

const wtRoot = (root, phase) => path.join(root, core.JDI_DIR, 'cache', 'worktrees', phase.slug);
const stateFile = (root, phase) => path.join(root, core.JDI_DIR, 'cache', 'worktrees', `${phase.slug}.json`);
const branchOf = (phase, task) => `jdi/${phase.slug}/${task}`;

function readState(root, phase) {
  const st = core.readJson(stateFile(root, phase), null);
  if (!st?.tasks) throw new core.JdiError(`no worktree wave for ${phase.slug} — run \`jdi-cli wave worktrees\` first`, 2);
  return st;
}

function removeWorktree(root, dir) {
  core.git(['worktree', 'remove', '--force', dir], root);
  fs.rmSync(dir, { recursive: true, force: true });
  core.git(['worktree', 'prune'], root);
}

function setup(root, dir, task, phase) {
  for (const s of gates.loadStacks(root).filter((x) => x.worktree_setup)) {
    const log = path.join(wtRoot(root, phase), `${task}-setup-${s.id}.log`);
    const r = gates.run(s.worktree_setup, { root, cwd: dir, env: gates.envFor([s]), shell: gates.shellFor(s), timeoutMin: s.timeout_min || 30, log });
    if (r.exit !== 0) return `\`${s.worktree_setup}\` (${s.id}) exited ${r.exit} — log ${path.relative(root, log).split(path.sep).join('/')}`;
  }
  return null;
}

const saveState = (root, phase, st) => core.writeFileEnsured(stateFile(root, phase), JSON.stringify(st, null, 2) + '\n', root);
const slash = (p) => p.split(path.sep).join('/');

// Product files that differ from HEAD in the main checkout (.jdi/ apart),
// with the hash of their content — to tell what changed DURING the wave from
// what was already modified before it.
function productState(root) {
  const tracked = core.git(['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD'], root).stdout;
  const untracked = core.git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], root).stdout;
  const crypto = require('node:crypto');
  const out = {};
  for (const f of `${tracked}\n${untracked}`.split('\n').filter((x) => x && !x.startsWith(`${core.JDI_DIR}/`))) {
    const bytes = core.readIf(path.join(root, f));
    out[f] = bytes === null ? '-' : crypto.createHash('sha256').update(bytes).digest('hex');
  }
  return out;
}

function worktrees(root, phase, tasks) {
  if (!tasks.length) throw new core.JdiError('--tasks T-1,T-2 is required', 1);
  core.ensureCacheIgnored(root); // the worktrees live under .jdi/cache/
  // a worktree still in the state may hold work (UNCOMMITTED, a conflict):
  // never reset it from here
  const prev = core.readJson(stateFile(root, phase), null)?.tasks || {};
  const busy = tasks.filter((t) => prev[t]);
  if (busy.length) throw new core.JdiError(`${busy.join(', ')} still has a worktree from an earlier wave (work kept there?) — \`wave merge\` it first`, 3);
  const base = core.git(['rev-parse', 'HEAD'], root).stdout;
  const st = { head: base, before: productState(root), tasks: prev };
  saveState(root, phase, st);
  const out = [];
  for (const task of tasks) {
    const dir = path.join(wtRoot(root, phase), task);
    removeWorktree(root, dir);
    const add = core.git(['worktree', 'add', '-B', branchOf(phase, task), dir, base], root);
    const failed = add.code === 0 ? setup(root, dir, task, phase) : `git worktree add failed: ${add.stderr.split('\n')[0]}`;
    if (failed) {
      // this task runs in the main checkout instead: leave nothing behind
      removeWorktree(root, dir);
      core.git(['branch', '-D', branchOf(phase, task)], root);
      out.push({ task, dir: null, status: 'failed', reason: failed });
      continue;
    }
    st.tasks[task] = { branch: branchOf(phase, task), dir, base };
    saveState(root, phase, st); // one task at a time: a later failure loses nothing
    out.push({ task, dir: slash(dir), status: 'ok' });
  }
  return out;
}

// Files of the tasks still in the wave that changed in the main checkout —
// committed since the last check, or edited — or null. Other commits (a task
// re-run in the main checkout after a conflict, the wave's status lines,
// anything under .jdi/) are the orchestrator's: they do not count.
function mainCheckoutMoved(root, st, planTasks) {
  const head = core.git(['rev-parse', 'HEAD'], root).stdout;
  const committed = head === st.head ? [] : core.git(['-c', 'core.quotePath=false', 'diff', '--name-only', `${st.head}..${head}`], root).stdout.split('\n');
  const now = productState(root);
  const before = st.before || {};
  const edited = [...new Set([...Object.keys(now), ...Object.keys(before)])].filter((f) => now[f] !== before[f]);
  const watched = new Set(Object.keys(st.tasks).flatMap((t) => planTasks.find((p) => p.id === t)?.files || []));
  const hit = [...new Set([...committed, ...edited])].filter((f) => f && !f.startsWith(`${core.JDI_DIR}/`) && (!watched.size || watched.has(f))).sort(core.compareStr);
  if (!hit.length) return null;
  return `${hit.slice(0, 5).join(', ')} changed there${head === st.head ? '' : ' (committed or edited)'}`;
}

function mergeTask(root, st, task, planTasks) {
  const { branch, dir, base } = st.tasks[task];
  // work the doer did not commit would be lost with the worktree
  if (core.git(['status', '--porcelain'], dir).stdout) return { task, status: 'uncommitted', dir: slash(dir) };
  const range = `${base}..${branch}`;
  const commits = core.git(['rev-list', '--count', range], root).stdout;
  if (!Number(commits)) return { task, status: 'empty' };
  // three dots: from where the branch forked, whatever HEAD has taken since
  const files = core.git(['-c', 'core.quotePath=false', 'diff', '--name-only', `${base}...${branch}`], root).stdout.split('\n').filter(Boolean);
  const scope = planTasks.find((t) => t.id === task)?.files || [];
  const outside = scope.length ? files.filter((f) => !scope.includes(f)) : [];
  // one sequence per task: --abort puts HEAD back where the task started
  const pick = core.git(['cherry-pick', range], root);
  if (pick.code !== 0) {
    core.git(['cherry-pick', '--abort'], root);
    return { task, status: 'conflict', reason: (pick.stderr || pick.stdout).split('\n')[0] };
  }
  return { task, status: 'merged', commits: Number(commits), ...(outside.length && { outside }) };
}

// The worktree goes once its commits are in (or there were none); a task that
// conflicted keeps its branch, one with uncommitted work keeps everything.
function settle(root, st, r) {
  const t = st.tasks[r.task];
  if (r.status === 'uncommitted') return;
  removeWorktree(root, t.dir);
  if (r.status !== 'conflict') core.git(['branch', '-D', t.branch], root);
  delete st.tasks[r.task];
}

function merge(root, phase, only) {
  const st = readState(root, phase);
  const planTasks = brief.parseTasks(core.readIf(path.join(phase.absDir, 'PLAN.md')) || '');
  const moved = mainCheckoutMoved(root, st, planTasks);
  if (moved) throw new core.JdiError(`the main checkout changed during the wave — ${moved}: a doer wrote outside its worktree? Nothing merged; worktrees and branches kept`, 3);
  const tasks = only.length ? only : Object.keys(st.tasks);
  const results = tasks.map((t) => (st.tasks[t] ? mergeTask(root, st, t, planTasks) : { task: t, status: 'unknown', reason: 'not in this wave' }));
  for (const r of results.filter((x) => st.tasks[x.task])) settle(root, st, r);
  st.head = core.git(['rev-parse', 'HEAD'], root).stdout; // the next merge checks from here
  st.before = productState(root);
  if (Object.keys(st.tasks).length) saveState(root, phase, st);
  else fs.rmSync(stateFile(root, phase), { force: true });
  return results;
}

function clean(root, phase) {
  const st = core.readJson(stateFile(root, phase), null) || { tasks: {} };
  for (const t of Object.values(st.tasks)) removeWorktree(root, t.dir);
  fs.rmSync(wtRoot(root, phase), { recursive: true, force: true });
  core.git(['worktree', 'prune'], root);
  const branches = core.git(['branch', '--list', `jdi/${phase.slug}/*`, '--format=%(refname:short)'], root).stdout.split('\n').filter(Boolean);
  for (const b of branches) core.git(['branch', '-D', b], root);
  fs.rmSync(stateFile(root, phase), { force: true });
  return branches.length;
}

const LINE = {
  merged: (r) => `${r.task} merged (${r.commits} commit(s))` + (r.outside ? ' — outside its Files modified: ' + r.outside.join(', ') : ''),
  empty: (r) => `${r.task} had no commit`,
  uncommitted: (r) => `${r.task} left UNCOMMITTED work in ${r.dir} — kept; commit it there (or discard it), then \`wave merge\` again`,
  conflict: (r) => `${r.task} CONFLICT — rolled back; run it again in the main checkout (${r.reason})`,
  unknown: (r) => `${r.task}: ${r.reason}`,
};

function main(argv) {
  const [sub, ...rest] = argv;
  const id = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--tasks');
  if (!id || !['worktrees', 'merge', 'clean'].includes(sub)) throw new core.JdiError('usage: jdi wave <worktrees|merge|clean> <phase> [--tasks T-1,T-2] [--json]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  const i = rest.indexOf('--tasks');
  const asked = i === -1 ? [] : String(rest[i + 1] || '').split(',').map((t) => t.trim()).filter(Boolean);
  // the ids come from PLAN.md: they name branches and directories
  const known = brief.parseTasks(core.readIf(path.join(phase.absDir, 'PLAN.md')) || '').map((t) => t.id);
  const unknown = asked.filter((t) => !known.includes(t));
  if (unknown.length) throw new core.JdiError(`no task ${unknown.join(', ')} in ${phase.dir}/PLAN.md`, 2);
  const tasks = known.filter((t) => asked.includes(t)).sort((a, b) => asked.indexOf(a) - asked.indexOf(b));
  const json = rest.includes('--json');
  if (sub === 'clean') {
    process.stdout.write(`removed the worktrees of ${phase.slug} and ${clean(root, phase)} branch(es)\n`);
    return 0;
  }
  if (sub === 'worktrees') {
    const out = worktrees(root, phase, tasks);
    process.stdout.write(json ? JSON.stringify(out) + '\n' : out.map((w) => (w.dir ? `${w.task} ${w.dir}` : `${w.task} FAILED — run it in the main checkout: ${w.reason}`)).join('\n') + '\n');
    return out.some((w) => w.status === 'failed') ? 1 : 0;
  }
  const results = merge(root, phase, tasks);
  process.stdout.write(json ? JSON.stringify(results) + '\n' : results.map((r) => LINE[r.status](r)).join('\n') + '\n');
  return results.some((r) => ['conflict', 'uncommitted', 'unknown'].includes(r.status)) ? 1 : 0;
}

module.exports = { main, worktrees, merge, clean };
