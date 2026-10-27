'use strict';

// 0.22 — quota, ceiling and isolation; learning from the history: quota (status
// line snapshot, block in the transcripts, local estimate), quota record, the
// phase ceiling, the brief score, worktree waves, the route log, adapt and the
// quota-aware route, cost --by-model — on throwaway fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cost = require('../bin/lib/cost');
const { tmpdir, write, read, jdi, CLI } = require('./helpers');

function repo(files) {
  const root = tmpdir('jdi-022-');
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Tester');
  g('config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { root, g };
}

const ROADMAP = { '.jdi/roadmap/alpha.md': '---\norder: 1\nname: Alpha\ncreated_with: 0.22.0\n---\n- **Slug:** alpha\n- **Goal:** a\n' };
const BASE = { ...ROADMAP, '.gitignore': '.jdi/cache/\nout/\n', '.jdi/phases/alpha/CONTEXT.md': '# Alpha\n\n## Definition of Done\n\n### Auto-verifiable\n- _(none)_\n', 'src/a.js': 'a\n', 'src/b.js': 'b\n' };
const json = (r) => JSON.parse(r.stdout);
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const usage = (out) => ({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out });

// A Claude projects dir with one session of `project`: model calls at the
// given times (each worth `units` cache-weighted tokens: output x5), plus
// extra records.
function claudeDir(project, calls, extra = []) {
  const claude = tmpdir('jdi-022-claude-');
  const dir = path.join(claude, cost.encodeProjectPath(project));
  fs.mkdirSync(dir, { recursive: true });
  const rows = calls.map((c, i) => ({ type: 'assistant', timestamp: iso(c.at), message: { id: `m${i}-${c.at}`, model: c.model || 'claude-sonnet-x', usage: usage(c.units / 5), content: [{ type: 'text', text: 'x' }] } }));
  fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), jsonl([...rows, ...extra]));
  return { claude, dir };
}

// ------------------------------------------------------------------- quota

test('quota: a fresh status line snapshot decides — ok, tight (exit 3), stop (exit 4); a stale one is ignored (0.22)', () => {
  const { root } = repo(BASE);
  const { claude } = claudeDir(root, []);
  const snap = path.join(tmpdir('jdi-022-snap-'), 'rate-limits.json');
  const run = (five, seven, at = Date.now()) => {
    fs.writeFileSync(snap, JSON.stringify({ at: iso(at), five_hour: { pct: five, resetsAt: Date.now() + 3600e3 }, seven_day: { pct: seven, resetsAt: null } }));
    return jdi(root, ['quota', '--json', '--claude-dir', claude], { JDI_QUOTA_FILE: snap });
  };
  let r = run(40, 10);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(json(r).verdict, 'ok');
  assert.equal(json(r).source, 'status line');
  r = run(85, 10);
  assert.equal(r.code, 3);
  assert.equal(json(r).verdict, 'tight');
  r = run(40, 97);
  assert.equal(r.code, 4);
  assert.equal(json(r).verdict, 'stop');
  assert.ok(json(r).resume_at === null || typeof json(r).resume_at === 'string');
  r = run(99, 99, Date.now() - 20 * 60e3);
  assert.equal(json(r).verdict, 'unknown', 'a snapshot older than 15 min is not trusted');
  assert.ok(fs.existsSync(path.join(root, '.jdi/cache/quota.json')), 'the verdict is cached for route');
});

test('quota record: keeps the rate_limits of a status line input; anything else is a silent no-op (0.22)', () => {
  const snap = path.join(tmpdir('jdi-022-rec-'), 'sub', 'rate-limits.json');
  const rec = (input) => spawnSync(process.execPath, [CLI, 'quota', 'record'], { input, encoding: 'utf8', env: { ...process.env, JDI_QUOTA_FILE: snap } });
  let r = rec('not json');
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(snap));
  r = rec(JSON.stringify({ model: { id: 'x' } }));
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(snap), 'no rate_limits, nothing written');
  r = rec(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42.5, resets_at: 1790321400 }, seven_day: { used_percentage: 7 } } }));
  assert.equal(r.status, 0);
  const s = JSON.parse(fs.readFileSync(snap, 'utf8'));
  assert.deepEqual(s.five_hour, { pct: 42.5, resetsAt: 1790321400000 });
  assert.equal(s.seven_day.pct, 7);
  assert.equal(r.stdout, '', 'a status line prints nothing extra');
});

test('quota: a block in the transcripts is a stop until it resets; a past one is history (0.22)', () => {
  const { root } = repo(BASE);
  const now = Date.now();
  const block = (resetsAt) => ({ type: 'assistant', timestamp: iso(now - 60e3), error: 'rate_limit', isApiErrorMessage: true, quotaLimits: { status: 'rejected', resetsAt: Math.round(resetsAt / 1000), rateLimitType: 'five_hour' }, message: { content: [{ type: 'text', text: "You've hit your session limit" }] } });
  let { claude } = claudeDir(root, [{ at: now - 3600e3, units: 50e6 }], [block(now + 2 * 3600e3)]);
  let r = jdi(root, ['quota', '--json', '--claude-dir', claude], { JDI_QUOTA_FILE: path.join(claude, 'none.json') });
  assert.equal(r.code, 4, r.stdout);
  assert.equal(json(r).source, 'transcripts');
  assert.equal(Date.parse(json(r).resume_at), Math.round((now + 2 * 3600e3) / 1000) * 1000);
  ({ claude } = claudeDir(root, [{ at: now - 3600e3, units: 50e6 }], [block(now - 600e3)]));
  r = jdi(root, ['quota', '--json', '--claude-dir', claude], { JDI_QUOTA_FILE: path.join(claude, 'none.json') });
  assert.equal(r.code, 0);
  assert.equal(json(r).verdict, 'unknown');
  assert.equal(json(r).local.atBlocks.length, 1, 'the past block is listed with the local usage at it');
  assert.match(jdi(root, ['quota', '--claude-dir', claude], { JDI_QUOTA_FILE: path.join(claude, 'none.json') }).stdout, /past block .* used here in that session/);
});

test('quota: the local estimate against quota.session_mtok — only this machine, and only when configured (0.22)', () => {
  const now = Date.now();
  const { root } = repo({ ...BASE, '.jdi/config.json': JSON.stringify({ quota: { session_mtok: 10 } }) });
  // an old session (6 h ago) does not count; the current one started 1 h ago
  const { claude } = claudeDir(root, [
    { at: now - 6.5 * 3600e3, units: 9e6 },
    { at: now - 3600e3, units: 5e6 },
    { at: now - 1800e3, units: 3.5e6 },
  ]);
  const r = jdi(root, ['quota', '--json', '--claude-dir', claude], { JDI_QUOTA_FILE: path.join(claude, 'none.json') });
  assert.equal(r.code, 3, r.stdout);
  const q = json(r);
  assert.equal(q.source, 'local estimate');
  assert.equal(q.local.session.mtok, 8.5);
  assert.equal(q.local.weekly_mtok, 17.5);
  assert.equal(Math.round(q.windows[0].pct), 85);
});

// ----------------------------------------------------------------- ceiling

function phaseAgents(root, starts) {
  const { claude, dir } = claudeDir(root, []);
  const sub = path.join(dir, 'sess-1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  starts.forEach((at, i) => {
    fs.writeFileSync(path.join(sub, `agent-a${i}.meta.json`), JSON.stringify({ agentType: 'jdi-doer-x', description: 'Execute T-1' }));
    fs.writeFileSync(path.join(sub, `agent-a${i}.jsonl`), jsonl([
      { type: 'user', timestamp: iso(at), message: { content: 'phase_slug=alpha, task=T-1' } },
      { type: 'assistant', timestamp: iso(at + 1000), message: { id: `s${i}`, model: 'x', usage: usage(2e5), content: [{ type: 'text', text: 'done' }] } },
    ]));
  });
  return claude;
}

test('ceiling: spawns, hours and tokens of the phase against orchestration.phase_ceiling; --start counts only this run (0.22)', () => {
  const now = Date.now();
  const { root } = repo({ ...BASE, '.jdi/config.json': JSON.stringify({ orchestration: { phase_ceiling: { spawns: 2, hours: 12, weighted_mtok: 50 } } }) });
  const claude = phaseAgents(root, [now - 5 * 3600e3, now - 4 * 3600e3, now - 600e3]);
  let r = jdi(root, ['ceiling', 'alpha', '--json', '--claude-dir', claude]);
  assert.equal(r.code, 3, r.stdout);
  const c = json(r);
  assert.equal(c.used.spawns, 3);
  assert.equal(c.used.weighted_mtok, 3, 'each agent: 200k output x5');
  assert.deepEqual(c.over, ['spawns']);
  assert.equal(c.since_from, 'first agent of the phase');
  assert.match(jdi(root, ['ceiling', 'alpha', '--claude-dir', claude]).stdout, /^over \(spawns\) — 3\/2 spawns, 5(\.0)?\/12 h, 3\/50M tokens/);
  // a new run: only what came after its start
  write(root, '.jdi/cache/ceiling/alpha.json', JSON.stringify({ started: iso(now - 3600e3) }));
  r = jdi(root, ['ceiling', 'alpha', '--json', '--claude-dir', claude]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(json(r).used.spawns, 1);
  assert.equal(json(r).since_from, 'run');
  assert.equal(jdi(root, ['ceiling', 'alpha', '--start']).code, 0);
  assert.ok(Date.parse(JSON.parse(read(root, '.jdi/cache/ceiling/alpha.json')).started) >= now);
});

// ------------------------------------------------------------- brief score

test('brief: a doer brief is scored; a task without a verifiable result or scope is WEAK (0.22)', () => {
  const plan = '# Plan\n\n#### T-1: rename the export flag\n- **Files modified:** `src/a.js`\n- **Acceptance:**\n  - the flag is renamed\n- **Test:** `npm test -- a`\n\n#### T-2: do it\n- **Status:** pending\n';
  const { root } = repo({ ...BASE, '.jdi/phases/alpha/PLAN.md': plan });
  let r = jdi(root, ['brief', 'alpha', '--role', 'doer', '--task', 'T-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /score 3\/4 — missing constraints\)/);
  assert.doesNotMatch(r.stderr, /WEAK/, 'constraints alone do not make a brief weak');
  r = jdi(root, ['brief', 'alpha', '--role', 'doer', '--task', 'T-2']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /score 1\/4/);
  assert.match(r.stderr, /WEAK BRIEF: T-2 has no verifiable result, no scope/);
  // the path is still the first word (the commands `cut -d' ' -f1`)
  assert.match(r.stdout.split(' ')[0], /^\.jdi\/cache\/briefs\/alpha\/doer-T-2\.md$/);
});

test('briefScore: bold sub-bullets stay in their field; a Dockerfile is a scope; one word is an objective (0.22)', () => {
  const { parseTasks, briefScore } = require('../bin/lib/brief');
  const plan = [
    '#### T-1: A isca vermelha',
    '- **Files modified:** `Dockerfile`, `Makefile`',
    '- **Acceptance:**',
    '  - **O sha:** o da T-1',
    '  - **A execução:** numa worktree',
    '- **Dependencies:** none',
    '',
    '#### T-2: deploy',
    '- **Files modified:** `src/a.js`',
    '- **Test:** `npm test -- a`',
  ].join('\n');
  const [t1, t2] = parseTasks(plan);
  assert.deepEqual(briefScore(t1, true), { score: 4, of: 4, missing: [], weak: false });
  assert.equal(briefScore(t2, false).weak, false);
  assert.deepEqual(briefScore(t2, false).missing, ['constraints']);
});

// -------------------------------------------------------------- worktrees

test('wave: worktrees per task, commits brought back in task order, a conflict rolled back, setup run (0.22)', () => {
  const plan = '# Plan\n\n#### T-1: one\n- **Files modified:** `src/a.js`\n\n#### T-2: two\n- **Files modified:** `src/b.js`\n\n#### T-3: three\n- **Files modified:** `src/c.js`\n';
  const stack = { '.jdi/stacks/node.json': JSON.stringify({ name: 'node', file_glob: ['src/**'], worktree_setup: 'mkdir -p out && touch out/setup-ran' }) };
  const { root, g } = repo({ ...BASE, ...stack, '.jdi/phases/alpha/PLAN.md': plan, 'src/shared.js': 's\n' });
  let r = jdi(root, ['wave', 'worktrees', 'alpha', '--tasks', 'T-1,T-2,T-3', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const wt = Object.fromEntries(json(r).map((w) => [w.task, w.dir]));
  assert.ok(fs.existsSync(path.join(wt['T-1'], 'out/setup-ran')), 'worktree_setup ran in the worktree');
  assert.ok(!wt['T-1'].includes('\\'), 'printed with forward slashes');
  const inWt = (task, file, text, msg) => {
    fs.writeFileSync(path.join(wt[task], file), text);
    spawnSync('git', ['add', file], { cwd: wt[task] });
    spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd: wt[task] });
  };
  inWt('T-1', 'src/a.js', 'a1\n', 'T-1 a');
  inWt('T-1', 'src/shared.js', 's1\n', 'T-1 shared');
  inWt('T-2', 'src/shared.js', 's2\n', 'T-2 shared');
  // T-3 committed nothing
  r = jdi(root, ['wave', 'merge', 'alpha']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /T-1 merged \(2 commit\(s\)\) — outside its Files modified: src\/shared\.js/);
  assert.match(r.stdout, /T-2 CONFLICT — rolled back/);
  assert.match(r.stdout, /T-3 had no commit/);
  assert.equal(read(root, 'src/a.js'), 'a1\n');
  assert.equal(read(root, 'src/shared.js'), 's1\n');
  assert.equal(g('status', '--porcelain', '--untracked-files=no').stdout, '', 'the conflict left nothing behind');
  assert.equal(g('worktree', 'list').stdout.trim().split('\n').length, 1, 'every worktree removed');
  assert.deepEqual(g('branch', '--list', 'jdi/*', '--format=%(refname:short)').stdout.trim().split('\n'), ['jdi/alpha/T-2'], 'the conflicted branch is kept');
  assert.equal(jdi(root, ['wave', 'clean', 'alpha']).code, 0);
  assert.equal(g('branch', '--list', 'jdi/*').stdout.trim(), '');
});

test('wave merge: a file of a wave task changed or committed in the main checkout merges nothing (exit 3); commits of the orchestrator are fine (0.22)', () => {
  const plan = '# Plan\n\n#### T-1: one\n- **Files modified:** `src/a.js`\n\n#### T-2: two\n- **Files modified:** `src/b.js`\n';
  const { root, g } = repo({ ...BASE, '.jdi/phases/alpha/PLAN.md': plan });
  write(root, 'notes.txt', 'already here before the wave\n'); // dirty before: not the doers' doing
  const commitIn = (dir, file, text, msg) => {
    fs.writeFileSync(path.join(dir, file), text);
    spawnSync('git', ['add', file], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd: dir });
  };
  let wt = json(jdi(root, ['wave', 'worktrees', 'alpha', '--tasks', 'T-1', '--json']))[0].dir;
  commitIn(wt, 'src/a.js', 'a1\n', 'T-1');
  write(root, 'src/a.js', 'T-1 written in the main checkout\n');
  let r = jdi(root, ['wave', 'merge', 'alpha']);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /main checkout changed during the wave — src\/a\.js changed there/);
  assert.ok(fs.existsSync(wt), 'nothing thrown away: the worktree is kept');
  // put back; a commit of another file (the orchestrator's) is fine
  g('checkout', '--', 'src/a.js');
  commitIn(root, 'src/b.js', 'b-orchestrator\n', 'T-2 run in the main checkout');
  r = jdi(root, ['wave', 'merge', 'alpha']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(read(root, 'src/a.js'), 'a1\n');
  // a doer that committed its own file in the MAIN checkout
  wt = json(jdi(root, ['wave', 'worktrees', 'alpha', '--tasks', 'T-1', '--json']))[0].dir;
  commitIn(root, 'src/a.js', 'a-main\n', 'stray');
  r = jdi(root, ['wave', 'merge', 'alpha']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /src\/a\.js changed there \(committed or edited\)/);
  assert.notEqual(jdi(root, ['wave', 'merge', 'nope']).code, 0);
});

test('wave: CONFLICT + UNCOMMITTED in one wave both resolve; a worktree holding work is never reset (0.22)', () => {
  const plan = '# Plan\n\n#### T-1: one\n- **Files modified:** `src/a.js`\n\n#### T-2: two\n- **Files modified:** `src/b.js`\n\n#### T-3: three\n- **Files modified:** `src/c.js`\n';
  const { root } = repo({ ...BASE, '.jdi/phases/alpha/PLAN.md': plan, 'src/c.js': 'c\n', 'src/shared.js': 's\n' });
  const wt = Object.fromEntries(json(jdi(root, ['wave', 'worktrees', 'alpha', '--tasks', 'T-1,T-2,T-3', '--json'])).map((w) => [w.task, w.dir]));
  const commitIn = (dir, file, text) => {
    fs.writeFileSync(path.join(dir, file), text);
    spawnSync('git', ['add', file], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', file], { cwd: dir });
  };
  commitIn(wt['T-1'], 'src/shared.js', 's1\n');
  commitIn(wt['T-2'], 'src/shared.js', 's2\n'); // conflicts with T-1
  fs.writeFileSync(path.join(wt['T-3'], 'src/c.js'), 'c3, not committed\n');
  let r = jdi(root, ['wave', 'merge', 'alpha']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /T-2 CONFLICT/);
  assert.match(r.stdout, /T-3 left UNCOMMITTED/);
  // asking for T-3's worktree again must not wipe it
  r = jdi(root, ['wave', 'worktrees', 'alpha', '--tasks', 'T-3']);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /T-3 still has a worktree/);
  assert.equal(fs.readFileSync(path.join(wt['T-3'], 'src/c.js'), 'utf8'), 'c3, not committed\n');
  // the orchestrator re-runs T-2 in the main checkout (a commit) and commits T-3's work
  commitIn(root, 'src/b.js', 'b2\n');
  spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qam', 'T-3'], { cwd: wt['T-3'] });
  r = jdi(root, ['wave', 'merge', 'alpha']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(read(root, 'src/c.js'), 'c3, not committed\n');
});

test('wave: uncommitted work in a worktree is never thrown away; a failed setup sends its task to the main checkout (0.22)', () => {
  const plan = '# Plan\n\n#### T-1: one\n- **Files modified:** `src/a.js`\n\n#### T-2: two\n- **Files modified:** `src/b.js`\n';
  const stack = { '.jdi/stacks/node.json': JSON.stringify({ name: 'node', file_glob: ['src/**'], worktree_setup: 'test -f src/a.js && [ "$(basename "$PWD")" != T-2 ]' }) };
  const { root, g } = repo({ ...BASE, ...stack, '.jdi/phases/alpha/PLAN.md': plan });
  let r = jdi(root, ['wave', 'worktrees', 'alpha', '--tasks', 'T-1,T-2']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /T-2 FAILED — run it in the main checkout/);
  assert.deepEqual(g('branch', '--list', 'jdi/*', '--format=%(refname:short)').stdout.trim().split('\n'), ['jdi/alpha/T-1'], 'the failed task left no branch');
  const wt = path.join(root, '.jdi/cache/worktrees/alpha/T-1');
  fs.writeFileSync(path.join(wt, 'src/a.js'), 'edited, not committed\n');
  r = jdi(root, ['wave', 'merge', 'alpha']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /T-1 left UNCOMMITTED work in .*T-1 — kept/);
  assert.equal(fs.readFileSync(path.join(wt, 'src/a.js'), 'utf8'), 'edited, not committed\n');
  spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qam', 'T-1'], { cwd: wt });
  r = jdi(root, ['wave', 'merge', 'alpha']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(read(root, 'src/a.js'), 'edited, not committed\n');
});

// ------------------------------------------------------------ route log

const PLAN = '# Plan\n\n#### T-1: rename\n- **Weight:** light\n- **Files modified:** `src/a.js`\n\n#### T-2: feature\n- **Weight:** standard\n- **Files modified:** `src/b.js`\n\n#### T-3: auth\n- **Weight:** standard\n- **Files modified:** `src/auth/x.js`\n';

function routeRepo(extra = {}) {
  const config = { routing: { mode: 'on', adapt: { mode: 'on', min_samples: 4 } }, sizing: { sensitive_globs: ['src/auth/**'] }, ...extra };
  return repo({ ...BASE, '.jdi/phases/alpha/PLAN.md': PLAN, '.jdi/config.json': JSON.stringify(config) }).root;
}
const route = (root, ...a) => json(jdi(root, ['route', 'alpha', ...a, '--json']));

// n decisions of `weight` on `tier` in other phases, `fail` of them fixed later
function history(root, weight, tier, n, fail) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const phase = `old-${weight}-${tier}-${i}`;
    rows.push({ at: iso(1000 + i), phase, role: 'doer', task: 'T-1', attempt: 1, weight, tier });
    // the outcome: a fix (failed), or the reviewers (the gates were green)
    if (i < fail) rows.push({ at: iso(5000 + i), phase, role: 'doer', task: i % 2 ? 'T-1' : null, attempt: 2, weight, tier: 'strong' });
    else rows.push({ at: iso(5000 + i), phase, role: 'reviewer', task: null, attempt: 1, weight, tier: 'standard' });
  }
  const f = path.join(root, '.git/jdi/route-log.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, jsonl(rows));
}

test('route: every answer is logged; adapt raises a tier that fails the first time, lowers one that never does (0.22)', () => {
  let root = routeRepo();
  assert.equal(route(root, '--role', 'doer', '--task', 'T-1').tier, 'cheap');
  const log = read(root, '.git/jdi/route-log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].phase, log[0].role, log[0].task, log[0].attempt, log[0].weight, log[0].tier], ['alpha', 'doer', 'T-1', 1, 'light', 'cheap']);
  // light on cheap: 2 of 5 passed the first time -> standard
  history(root, 'light', 'cheap', 5, 3);
  let r = route(root, '--role', 'doer', '--task', 'T-1');
  assert.equal(r.tier, 'standard', r.why);
  assert.match(r.why, /adapt: light work on cheap passed first time \d+\/\d+ \(< 70%\) -> standard/);
  // standard on standard: always passes -> try cheap (cheap for standard work never measured)
  history(root, 'standard', 'standard', 5, 0);
  r = route(root, '--role', 'doer', '--task', 'T-2');
  assert.equal(r.tier, 'cheap', r.why);
  assert.match(r.why, /-> trying cheap/);
  // never for sensitive work
  assert.equal(route(root, '--role', 'doer', '--task', 'T-3').tier, 'strong');
  // ...and not once cheap is known to fail for standard work
  history(root, 'standard', 'cheap', 4, 3);
  assert.equal(route(root, '--role', 'doer', '--task', 'T-2').tier, 'standard');
  // decisions without an outcome yet (the same wave, seconds ago) do not count
  root = routeRepo();
  const f = path.join(root, '.git/jdi/route-log.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, jsonl(Array.from({ length: 9 }, (_, i) => ({ at: iso(Date.now() - 1000 + i), phase: 'alpha', role: 'doer', task: `T-${i + 10}`, attempt: 1, weight: 'standard', tier: 'standard' }))));
  r = route(root, '--role', 'doer', '--task', 'T-2');
  assert.equal(r.tier, 'standard', r.why);
  assert.doesNotMatch(r.why, /adapt/);
  // adapt off (the default): the rules alone
  root = routeRepo({ routing: { mode: 'on' } });
  history(root, 'light', 'cheap', 9, 9);
  assert.equal(route(root, '--role', 'doer', '--task', 'T-1').tier, 'cheap');
});

test('route: quota tight puts lighter doer work one tier down — never deep or sensitive work, never a fix (0.22)', () => {
  const root = routeRepo({ routing: { mode: 'on' } });
  write(root, '.jdi/cache/quota.json', JSON.stringify({ at: iso(Date.now()), verdict: 'tight', why: '5h 88%' }));
  const r = route(root, '--role', 'doer', '--task', 'T-2');
  assert.equal(r.tier, 'cheap', r.why);
  assert.match(r.why, /quota tight \(5h 88%\) -> cheap/);
  assert.equal(route(root, '--role', 'doer', '--task', 'T-3').tier, 'strong', 'sensitive');
  assert.equal(route(root, '--role', 'doer', '--task', 'T-2', '--attempt', '2').tier, 'strong', 'a fix keeps its escalation');
  assert.equal(route(root, '--role', 'reviewer').tier, 'strong', 'reviewers untouched');
  // a stale verdict does nothing
  write(root, '.jdi/cache/quota.json', JSON.stringify({ at: iso(Date.now() - 20 * 60e3), verdict: 'tight', why: 'old' }));
  assert.equal(route(root, '--role', 'doer', '--task', 'T-2').tier, 'standard');
});

// ------------------------------------------------------------ by model

test('cost --by-model: subagents by role x model, and the first-time pass of routed doer work (0.22)', () => {
  const root = routeRepo();
  const claude = phaseAgents(root, [Date.now() - 3600e3, Date.now() - 1800e3]);
  history(root, 'light', 'cheap', 4, 1);
  const r = jdi(root, ['cost', '--by-model', '--json', '--claude-dir', claude]);
  assert.equal(r.code, 0, r.stderr);
  const bm = json(r);
  assert.deepEqual(bm.models.map((m) => [m.role, m.model, m.spawns]), [['doer', 'x', 2]]);
  assert.deepEqual(bm.routes, [{ weight: 'light', tier: 'cheap', decisions: 4, first_time: 3, rate: 75 }]);
  assert.match(jdi(root, ['cost', '--by-model', '--claude-dir', claude]).stdout, /light\s+cheap\s+3\/4 \(75%\)/);
});

// ------------------------------------------------- tiers (Copilot, OpenCode)

const SPECIALIST = `---
name: jdi-doer-x
description: "Specialist executor for project X: knows the stack."
runtime_intent:
  role: project_executor
  reasoning: medium
runtime_overrides:
  claude:
    tools: [Read, Write, Edit, Bash]
  copilot:
    tools: [read, write, edit, terminal]
  opencode:
    mode: subagent
    model: anthropic/claude-sonnet-4-5
    temperature: 0.1
---

<role>doer</role>
`;

function tiersRepo(runtimeModels) {
  const config = { routing: { mode: 'on', runtime_models: runtimeModels } };
  return repo({ ...BASE, '.jdi/phases/alpha/PLAN.md': PLAN, '.jdi/agents/jdi-doer-x.md': SPECIALIST, '.jdi/config.json': JSON.stringify(config) });
}

test('sync-specialists: Copilot and OpenCode get one copy per configured tier, with that model; --check sees drift (0.22)', () => {
  const { root } = tiersRepo({ opencode: { cheap: 'anthropic/claude-haiku-4-5', strong: 'anthropic/claude-opus-4-1' }, copilot: { cheap: 'gpt-5-mini' } });
  for (const rt of ['opencode', 'copilot']) assert.equal(jdi(root, ['sync-specialists', rt]).code, 0);
  const oc = read(root, '.opencode/agents/jdi-doer-x--cheap.md');
  assert.match(oc, /^---\ndescription: "Tier cheap of jdi-doer-x, spawned by jdi-cli route - never pick it by hand\. Specialist executor/);
  assert.match(oc, /\nmodel: anthropic\/claude-haiku-4-5\n/);
  assert.doesNotMatch(oc, /claude-sonnet-4-5/, 'the base model is replaced');
  assert.match(oc, /<!-- jdi:tier-variant of=jdi-doer-x tier=cheap -->/);
  assert.match(oc, /<role>doer<\/role>/);
  assert.ok(fs.existsSync(path.join(root, '.opencode/agents/jdi-doer-x--strong.md')));
  assert.ok(!fs.existsSync(path.join(root, '.opencode/agents/jdi-doer-x--standard.md')), 'no model for standard: no copy');
  const cp = read(root, '.github/agents/jdi-doer-x--cheap.agent.md');
  assert.match(cp, /^---\nname: jdi-doer-x--cheap\n/);
  assert.match(cp, /\nmodel: gpt-5-mini\n/);
  assert.equal(jdi(root, ['sync-specialists', 'opencode', '--check']).code, 0);
  // the tier leaves the config: --check says so, a sync removes the copy
  write(root, '.jdi/config.json', JSON.stringify({ routing: { mode: 'on', runtime_models: { opencode: { cheap: 'anthropic/claude-haiku-4-5' } } } }));
  const c = jdi(root, ['sync-specialists', 'opencode', '--check']);
  assert.equal(c.code, 1);
  assert.match(c.stdout, /EXTRA\s+\.opencode\/agents\/jdi-doer-x--strong\.md/);
  assert.equal(jdi(root, ['sync-specialists', 'opencode']).code, 0);
  assert.ok(!fs.existsSync(path.join(root, '.opencode/agents/jdi-doer-x--strong.md')));
  assert.ok(fs.existsSync(path.join(root, '.opencode/agents/jdi-doer-x.md')), 'the agent itself is untouched');
  // routing off: no variants at all
  write(root, '.jdi/config.json', JSON.stringify({ routing: { mode: 'off', runtime_models: { opencode: { cheap: 'x' } } } }));
  jdi(root, ['sync-specialists', 'opencode']);
  assert.deepEqual(fs.readdirSync(path.join(root, '.opencode/agents')), ['jdi-doer-x.md']);
});

test('route --runtime: Copilot/OpenCode spawn the tier copy when it exists, the agent itself when not; Claude unchanged (0.22)', () => {
  const { root } = tiersRepo({ opencode: { cheap: 'anthropic/claude-haiku-4-5' } });
  jdi(root, ['sync-specialists', 'opencode']);
  let r = route(root, '--role', 'doer', '--task', 'T-1', '--runtime', 'opencode', '--agent', 'jdi-doer-x');
  assert.deepEqual([r.agent, r.model, r.effort, r.tier], ['jdi-doer-x--cheap', 'anthropic/claude-haiku-4-5', null, 'cheap']);
  assert.match(r.why, /opencode: spawn jdi-doer-x--cheap/);
  r = route(root, '--role', 'doer', '--task', 'T-1', '--attempt', '2', '--runtime', 'opencode', '--agent', 'jdi-doer-x');
  assert.deepEqual([r.agent, r.model, r.tier], ['jdi-doer-x', null, 'standard']);
  assert.match(r.why, /no standard variant of jdi-doer-x — spawn it as is/);
  r = route(root, '--role', 'doer', '--task', 'T-1', '--runtime', 'copilot', '--agent', 'jdi-doer-x');
  assert.equal(r.agent, 'jdi-doer-x', 'no copilot copy');
  r = route(root, '--role', 'doer', '--task', 'T-1');
  assert.deepEqual([r.agent, r.model, r.effort], [undefined, 'haiku', 'low'], 'Claude Code: model and effort per spawn');
  assert.match(jdi(root, ['route', 'alpha', '--role', 'doer', '--task', 'T-1', '--runtime', 'opencode', '--agent', 'jdi-doer-x']).stdout, /^jdi-doer-x--cheap anthropic\/claude-haiku-4-5 /);
});

test('build: {{JDI_RUNTIME}} becomes the runtime name in every runtime (0.22)', () => {
  const pp = path.join(__dirname, '..', 'bin', 'lib', 'build-postprocess.js');
  for (const rt of ['claude', 'copilot', 'opencode']) {
    const r = spawnSync(process.execPath, [pp, '--stdin', rt, '--version', '9.9.9'], { input: 'route --runtime {{JDI_RUNTIME}} via {{JDI_CLI}}\n', encoding: 'utf8' });
    assert.equal(r.stdout, `route --runtime ${rt} via jdi-cli@9.9.9\n`);
  }
});

// --------------------------------------------------------- review fixes

test('route: routing off on Copilot/OpenCode still names the agent to spawn (0.22)', () => {
  const { root } = repo({ ...BASE, '.jdi/phases/alpha/PLAN.md': PLAN, '.jdi/config.json': JSON.stringify({ routing: { mode: 'off' } }) });
  const r = route(root, '--role', 'doer', '--task', 'T-1', '--runtime', 'opencode', '--agent', 'jdi-doer-x');
  assert.deepEqual([r.agent, r.model, r.tier], ['jdi-doer-x', null, null]);
});

test('quota and ceiling on another runtime do not read Claude Code data (0.22)', () => {
  const { root } = repo({ ...BASE, '.jdi/config.json': JSON.stringify({ orchestration: { phase_ceiling: { spawns: 0 } } }) });
  const claude = phaseAgents(root, [Date.now() - 600e3]);
  let r = jdi(root, ['quota', '--runtime', 'copilot', '--json', '--claude-dir', claude]);
  assert.equal(r.code, 0);
  assert.equal(json(r).verdict, 'unknown');
  r = jdi(root, ['ceiling', 'alpha', '--runtime', 'copilot', '--json', '--claude-dir', claude]);
  assert.equal(r.code, 0, 'spawns are not counted there');
  assert.equal(json(r).used.spawns, null);
  assert.equal(jdi(root, ['ceiling', 'alpha', '--json', '--claude-dir', claude]).code, 3, 'on Claude Code they are');
});

test('route log: one history per JDI project in the repo; the same spawn asked twice in minutes is one decision, later it is two (0.22)', () => {
  const route_ = require('../bin/lib/route');
  const { root } = repo({ ...BASE, 'sub/.jdi/x': '' });
  const f = path.join(root, '.git/jdi/route-log.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const e = (at, extra) => ({ at: iso(at), phase: 'p', role: 'doer', task: 'T-1', attempt: 1, weight: 'light', tier: 'cheap', ...extra });
  fs.writeFileSync(f, jsonl([e(0), e(60e3), e(3600e3), e(0, { project: 'sub' })]));
  assert.equal(route_.readLog(root).length, 2, 'two decisions an hour apart; the burst counts once');
  assert.equal(route_.readLog(path.join(root, 'sub')).length, 1, 'the other project has its own');
  // a lite decision (no task) fails with any fix of its phase
  const stats = route_.doerStats([
    { at: iso(1), phase: 'p', role: 'doer', task: null, attempt: 1, weight: 'deep', tier: 'strong' },
    { at: iso(2), phase: 'p', role: 'doer', task: 'T-2', attempt: 2, weight: 'deep', tier: 'strong' },
  ]);
  assert.deepEqual(stats.get('deep|strong'), { n: 1, pass: 0 });
});

test('sync-specialists --porcelain lists removed tier copies (git add stages the deletion) and no drift lines (0.22)', () => {
  const { root } = tiersRepo({ opencode: { cheap: 'anthropic/claude-haiku-4-5' } });
  jdi(root, ['sync-specialists', 'opencode']);
  write(root, '.jdi/config.json', JSON.stringify({ routing: { mode: 'on', runtime_models: {} } }));
  let r = jdi(root, ['sync-specialists', 'opencode', '--porcelain', '--check']);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /EXTRA|STALE/);
  r = jdi(root, ['sync-specialists', 'opencode', '--porcelain']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\.opencode\/agents\/jdi-doer-x--cheap\.md$/m);
  assert.ok(!fs.existsSync(path.join(root, '.opencode/agents/jdi-doer-x--cheap.md')));
});

test('quota: resume_at comes from the full window only; a window that already reset is empty (0.22)', () => {
  const { root } = repo(BASE);
  const { claude } = claudeDir(root, []);
  const snap = path.join(tmpdir('jdi-022-snap2-'), 'rate-limits.json');
  const now = Date.now();
  const run = (five, seven) => {
    fs.writeFileSync(snap, JSON.stringify({ at: iso(now), five_hour: five, seven_day: seven }));
    return json(jdi(root, ['quota', '--json', '--claude-dir', claude], { JDI_QUOTA_FILE: snap }));
  };
  let q = run({ pct: 96, resetsAt: now + 3600e3 }, { pct: 30, resetsAt: now + 5 * 86400e3 });
  assert.equal(q.verdict, 'stop');
  assert.equal(Date.parse(q.resume_at), Math.round(now + 3600e3), 'the 5h window, not the weekly one');
  q = run({ pct: 97, resetsAt: now - 300e3 }, { pct: 20, resetsAt: now + 86400e3 });
  assert.equal(q.verdict, 'ok', 'the 5h window reset five minutes ago');
});
