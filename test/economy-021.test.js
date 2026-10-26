'use strict';

// 0.21 — the clock and the route: cost --timeline, the gate watchdog (idle
// timeout, whole-tree kill, ENV causes), gates --detach / wait, the read-only
// check of reviewers, `route` (model + effort by rule), size --direct and the
// planner's Kind / Weight — on throwaway fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const cost = require('../bin/lib/cost');
const timeline = require('../bin/lib/timeline');
const brief = require('../bin/lib/brief');
const { tmpdir, write, read, jdi } = require('./helpers');

function repo(files) {
  const root = tmpdir('jdi-021-');
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

const ROADMAP = { '.jdi/roadmap/alpha.md': '---\norder: 1\nname: Alpha\ncreated_with: 0.21.0\n---\n- **Slug:** alpha\n- **Goal:** a\n' };
const BASE = { ...ROADMAP, '.gitignore': '.jdi/cache/\nout/\n', '.jdi/phases/alpha/CONTEXT.md': '# Alpha\n\n## Definition of Done\n\n### Auto-verifiable\n- _(none)_\n', 'src/a.js': 'return total;\n' };
const stack = (name, extra) => ({ [`.jdi/stacks/${name}.json`]: JSON.stringify({ name, file_glob: ['src/**'], ...extra }) });
const json = (r) => JSON.parse(r.stdout);
const results = (r) => Object.fromEntries(json(r).results.map((x) => [x.gate, x]));

// ---------------------------------------------------------------- timeline

const T0 = Date.parse('2026-10-01T10:00:00Z');
const ts = (min) => new Date(T0 + min * 60000).toISOString();
const MIN = 60000;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const usage = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 };
const call = (id, min, content) => ({ type: 'assistant', timestamp: ts(min), message: { id, model: 'x', usage, content } });
const bash = (id, command, extra = {}) => ({ type: 'tool_use', id, name: 'Bash', input: { command, ...extra } });
const result = (min, id, extra = {}) => ({ type: 'user', timestamp: ts(min), ...extra, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

function timelineFixture() {
  const project = path.join(tmpdir(), 'proj');
  write(project, '.jdi/roadmap/beta.md', '---\norder: 1\n---\n');
  const claude = tmpdir();
  const dir = path.join(claude, cost.encodeProjectPath(project));
  const sub = path.join(dir, 'sess-1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  // orchestrator: a prompt, a 19-min Agent call, then 19 min waiting on the human
  fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), jsonl([
    { type: 'user', timestamp: ts(0), message: { content: 'go' } },
    call('a1', 1, [
      { type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'jdi-doer-proj', description: 'Execute T-1', prompt: 'phase_slug=beta, task=T-1' } },
      { type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'jdi-reviewer-proj', description: 'Verify', prompt: 'phase_slug=beta' } },
    ]),
    result(15, 'tu2'),
    result(20, 'tu1', { toolUseResult: { agentId: 'abc' } }),
    call('a2', 21, [{ type: 'text', text: 'done' }]),
    { type: 'user', timestamp: ts(40), message: { content: 'next' } },
    call('a3', 41, [{ type: 'text', text: 'ok' }]),
    // a background run's end arrives as a user turn: not the human
    { type: 'user', timestamp: ts(50), message: { content: '<task-notification>\n<status>completed</status>\n</task-notification>' } },
    call('a4', 51, [{ type: 'text', text: 'ok' }]),
  ]));
  fs.writeFileSync(path.join(sub, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'jdi-doer-proj', description: 'Execute T-1' }));
  // doer: an 11-min suite (hits the tool limit), a polling loop, a pgrep wait,
  // a background run (not its time), a Read
  fs.writeFileSync(path.join(sub, 'agent-abc.jsonl'), jsonl([
    { type: 'user', timestamp: ts(1), message: { content: 'phase_slug=beta, task=T-1' } },
    call('s1', 2, [bash('b1', 'npm test')]),
    result(13, 'b1'),
    call('s2', 13, [bash('b2', 'until test -f out/done; do sleep 5; done')]),
    result(15, 'b2'),
    call('s3', 15, [bash('b3', 'pgrep -f vitest')]),
    result(16, 'b3'),
    call('s4', 16, [bash('b4', 'npm run e2e', { run_in_background: true })]),
    result(16, 'b4'),
    call('s5', 17, [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: path.join(project, 'src/a.js') } }]),
    result(18, 'r1'),
    call('s6', 18, [{ type: 'text', text: 'done' }]),
  ]));
  return { project, claude };
}

test('cost --timeline: model, commands by kind, polling, subagents, human; waste and per phase (0.21)', () => {
  const { project, claude } = timelineFixture();
  const { agents } = cost.loadAgents({ projectDir: project, claudeProjects: claude });
  const tl = timeline.timeline(agents, cost.isGateCommand);
  assert.equal(tl.total.model, 5 * MIN, 'orchestrator 4 min + doer 1 min');
  assert.equal(tl.total.subagents, 19 * MIN, 'two Agent calls in one message: waited on once');
  assert.equal(tl.total.human, 19 * MIN, 'the notification is not a human turn');
  assert.equal(tl.total.background, 9 * MIN);
  assert.equal(tl.total['tests-build'], 11 * MIN);
  assert.equal(tl.total.polling, 3 * MIN);
  assert.equal(tl.total.e2e, 0, 'a background run is not the agent waiting');
  assert.equal(tl.total.tools, 1 * MIN);
  assert.deepEqual(tl.waste.limitHits, [{ minutes: 11, command: 'npm test' }]);
  assert.equal(tl.waste.pollCalls, 2);
  assert.equal(tl.waste.pgrepWaits, 1);
  assert.deepEqual(Object.keys(tl.byPhase), ['beta']);
  assert.deepEqual(tl.byPhase.beta.roles, { doer: 1 });
  assert.equal(tl.byPhase.beta.split['tests-build'], 11 * MIN);
  // the command: text, and never message content
  const r = jdi(project, ['cost', '--timeline', '--claude-dir', claude]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 foreground command\(s\) hit the 10-min tool limit · 2 polling call\(s\) · 1 `pgrep -f` wait/);
  assert.match(r.stdout, /beta: /);
  assert.doesNotMatch(r.stdout, /phase_slug=beta, task=T-1|done/);
});

test('cost: a subagent transcript copied into another session folder counts once (0.21)', () => {
  const { project, claude } = timelineFixture();
  const dir = path.join(claude, cost.encodeProjectPath(project));
  const copy = path.join(dir, 'sess-2', 'subagents');
  fs.mkdirSync(copy, { recursive: true });
  for (const f of ['agent-abc.jsonl', 'agent-abc.meta.json']) fs.copyFileSync(path.join(dir, 'sess-1', 'subagents', f), path.join(copy, f));
  const rep = cost.analyze({ projectDir: project, claudeProjects: claude });
  assert.equal(rep.byRole.doer.spawns, 1);
});

test('commandKind: polling first, then local CI, e2e, gates, tests/build, other', () => {
  const k = (c) => timeline.commandKind(c, cost.isGateCommand);
  assert.equal(k('sleep 30 && npm test'), 'polling');
  assert.equal(k('tail -f out.log'), 'polling');
  assert.equal(k('validar-local -W ci.yml'), 'local-ci');
  assert.equal(k('npx playwright test'), 'e2e');
  assert.equal(k('npx -y jdi-cli gates run alpha'), 'gates');
  assert.equal(k('cargo test'), 'tests-build');
  assert.equal(k('git status'), 'other');
});

// ---------------------------------------------------------------- watchdog

const gone = (pid) => {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
  }
  return false;
};

test('gates: a silent command is killed after idle_timeout_s — a FAIL with the reason, not ENV (0.21)', () => {
  const { root } = repo({ ...BASE, ...stack('node', { gates: { test: 'echo start; sleep 60' }, idle_timeout_s: 2 }) });
  const t0 = Date.now();
  const r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'node', '--json']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(Date.now() - t0 < 30000, 'killed long before the sleep ended');
  const t = results(r).test;
  assert.equal(t.status, 'FAIL', 'a deadlock in the code is a defect a doer can fix');
  assert.match(t.excerpt, /^no output for 2 s — stalled/);
  // no idle_timeout_s: off (a suite that buffers its output is not cut)
  write(root, '.jdi/stacks/node.json', JSON.stringify({ name: 'node', file_glob: ['src/**'], gates: { test: 'sleep 3' } }));
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']).code, 0);
});

test('gates: the whole process tree is killed, not only the shell (0.21)', { skip: process.platform === 'win32' }, () => {
  const { root } = repo({ ...BASE, ...stack('node', { gates: { test: 'mkdir -p out; sleep 60 & echo $! > out/child.pid; wait' }, idle_timeout_s: 2 }) });
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']).code, 1);
  const pid = Number(read(root, 'out/child.pid').trim());
  assert.ok(gone(pid), `child ${pid} of the gate shell still running`);
});

test('gates: a shell that exits leaving a background process returns with its own code (0.21)', { skip: process.platform === 'win32' }, () => {
  // a server started with `&` holds the pipes: the gate used to never return
  const cmd = 'mkdir -p out; sleep 30 & echo $! > out/bg.pid; echo tests passed';
  const { root } = repo({ ...BASE, ...stack('node', { gates: { test: cmd }, idle_timeout_s: 2 }) });
  const t0 = Date.now();
  const r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'node', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(results(r).test.status, 'PASS', 'not a stall: the shell had already exited 0');
  assert.ok(Date.now() - t0 < 20000, 'did not wait for the background sleep');
  assert.ok(gone(Number(read(root, 'out/bg.pid').trim())), 'the leftover was ended');
});

test('watchdog: an interrupt (Ctrl+C) takes the whole tree down (0.21)', { skip: process.platform === 'win32' }, () => {
  const dir = tmpdir('jdi-021-int-');
  const pidFile = path.join(dir, 'child.pid');
  const spec = { cmd: 'bash', args: ['-c', `sleep 60 & echo $! > '${pidFile}'; wait`], timeoutMs: 60000, idleMs: 0 };
  const wd = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'lib', 'watchdog.js'), JSON.stringify(spec)], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (!fs.existsSync(pidFile) || !read(dir, 'child.pid').trim()) return;
      clearInterval(poll);
      const pid = Number(read(dir, 'child.pid').trim());
      wd.on('exit', (code) => {
        try {
          assert.equal(code, 130);
          assert.ok(gone(pid), `child ${pid} survived the interrupt`);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      wd.kill('SIGINT');
    }, 50);
  });
});

test('gates: ENV only for a missing command or a full disk, read from the output — never from the command text (0.21)', () => {
  const gates = {
    build: 'echo building',
    test: 'echo "write error: No space left on device" >&2; exit 1',
    lint: 'echo "fatal: Could not resolve host: example.invalid" >&2; exit 128',
    coverage: 'echo "1 test failed"; exit 1',
  };
  const { root } = repo({ ...BASE, ...stack('node', { gates, lint_blocks: true }) });
  let res = results(jdi(root, ['gates', 'run', 'alpha', '--stack', 'node', '--json']));
  assert.equal(res.test.status, 'ENV');
  assert.match(res.test.reason, /^disk full/);
  assert.equal(res.lint.status, 'FAIL', 'a network error may be the code: not ENV');
  assert.equal(res.coverage.status, 'FAIL');
  // a missing tool: ENV, and the build stops the run (fail-fast)
  write(root, '.jdi/stacks/node.json', JSON.stringify({ name: 'node', file_glob: ['src/**'], gates: { build: 'no-such-command-jdi-021', test: 'mkdir -p out && touch out/ran' } }));
  res = results(jdi(root, ['gates', 'run', 'alpha', '--stack', 'node', '--json']));
  assert.equal(res.build.status, 'ENV');
  assert.match(res.build.reason, /exit 127|not found/);
  assert.equal(res.test.status, 'SKIPPED');
  assert.ok(!fs.existsSync(path.join(root, 'out/ran')));
  // a gate that does not block stays a warning, whatever its cause
  write(root, '.jdi/stacks/node.json', JSON.stringify({ name: 'node', file_glob: ['src/**'], audit_blocks: false, gates: { audit: 'no-such-audit-jdi-021', test: 'true' } }));
  const r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'node', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(results(r).audit.status, 'WARN');
  // a DoD row that greps for the words fails as a FAIL: the text is not the disk
  write(root, '.jdi/stacks/node.json', JSON.stringify({ name: 'node', file_glob: ['src/**'], gates: {} }));
  write(root, '.jdi/phases/alpha/CONTEXT.md', '# Alpha\n\n## Definition of Done\n\n### Auto-verifiable\n- [ ] **1. Storage handles a full disk.**\n      **Verify:** `grep -q "ENOSPC: no space left on device" src/a.js`\n');
  const dod = jdi(root, ['gates', 'run', 'alpha', '--only', 'dod', '--json']);
  assert.equal(dod.code, 1, dod.stdout);
  assert.equal(json(dod).dod[0].status, 'FAIL');
});

// ---------------------------------------------------------- detach / wait

test('gates run --detach returns at once; gates wait blocks until it ends, exit 75 while running (0.21)', () => {
  const { root } = repo({ ...BASE, ...stack('node', { gates: { test: 'sleep 4; mkdir -p out && echo ran >> out/ran' } }) });
  let r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'node', '--detach']);
  assert.equal(r.code, 0, r.stderr);
  const job = /gates job (\w+) started/.exec(r.stdout)[1];
  r = jdi(root, ['gates', 'wait', 'alpha', '--job', job, '--timeout', '1']);
  assert.equal(r.code, 75, r.stdout);
  assert.match(r.stdout, /still running/);
  r = jdi(root, ['gates', 'wait', 'alpha']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /PASS/);
  assert.equal(read(root, 'out/ran'), 'ran\n');
  assert.equal(JSON.parse(read(root, `.jdi/cache/gates/alpha/jobs/${job}.json`)).code, 0);
  // a detached run that errors keeps its exit code (3: no such stack), as in the foreground
  r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'nope,nada', '--detach']);
  const bad = /gates job (\w+) started/.exec(r.stdout)[1];
  r = jdi(root, ['gates', 'wait', 'alpha', '--job', bad]);
  assert.equal(r.code, 3, r.stdout);
  assert.match(r.stdout, /no stack file/);
  // a job whose process is gone without finishing: not 1 ("gates failed") — nothing was measured
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  write(root, '.jdi/cache/gates/alpha/jobs/zzz.json', JSON.stringify({ job: 'zzz', pid: dead, started: new Date().toISOString(), done: false }));
  r = jdi(root, ['gates', 'wait', 'alpha', '--job', 'zzz']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /died before it finished/);
  assert.equal(jdi(root, ['gates', 'wait', 'alpha', '--job', 'nope']).code, 2);
});

// ---------------------------------------------------------- read-only check

test('review baseline + merge: changed files warn, a commit during the review blocks (0.21)', () => {
  const { root, g } = repo({ ...BASE, '.jdi/agents/jdi-reviewer-api.md': '---\nname: x\n---\n<inputs>\n</inputs>\n' });
  const review = '# Review\n\n## Reviewer: jdi-reviewer-api\n\n**Verdict:** APPROVED\n';
  const round = () => {
    jdi(root, ['review', 'plan', 'alpha', '--reviewers', 'jdi-reviewer-api', '--full']);
    assert.equal(jdi(root, ['review', 'baseline', 'alpha']).code, 0);
    write(root, '.jdi/phases/alpha/REVIEW.md', review);
  };
  const merged = () => {
    jdi(root, ['review', 'merge', 'alpha']);
    return read(root, '.jdi/phases/alpha/REVIEW.md');
  };
  // clean: nothing added
  round();
  assert.doesNotMatch(merged(), /Read-only check/);
  // a reviewer edited code
  round();
  write(root, 'src/a.js', 'edited by a reviewer\n');
  assert.match(merged(), /## Read-only check[\s\S]*files changed while the reviewers ran[^\n]*src\/a\.js/);
  assert.equal(jdi(root, ['review', 'verdict', 'alpha']).stdout.trim(), 'APPROVED_WITH_WARNINGS');
  g('commit', '-qam', 'reviewer fix');
  // a harness checkpointed the review artifacts (only .jdi/): not a defect
  round();
  g('add', '-f', '.jdi/phases/alpha/REVIEW.md');
  g('commit', '-qm', 'checkpoint');
  assert.doesNotMatch(merged(), /Read-only check/);
  // the baseline is spent: a later merge without one checks nothing
  write(root, 'src/c.js', 'later\n');
  write(root, '.jdi/phases/alpha/REVIEW.md', review);
  assert.doesNotMatch(merged(), /Read-only check/);
  // a reviewer committed product code
  round();
  write(root, 'src/b.js', 'x\n');
  g('add', 'src/b.js');
  g('commit', '-qm', 'sneaky');
  assert.match(merged(), /## Read-only check[\s\S]*\[defect\] a commit entered the branch during the review[^\n]*src\/b\.js/);
  assert.equal(jdi(root, ['review', 'verdict', 'alpha']).stdout.trim(), 'BLOCKED');
});

// ---------------------------------------------------------------- route

const PLAN = `# Plan

### T-1: rename a flag
- **Specialist:** jdi-doer-api · **Status:** pending
- **Kind:** refactor
- **Weight:** light
- **Files modified:** \`src/a.js\`

### T-2: login
- **Kind:** feature
- **Weight:** standard
- **Files modified:** \`src/auth/login.js\`

### T-3: scheduler
- **Weight:** deep
- **Files modified:** \`src/sched.js\`
`;

function routeRepo(config) {
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates-jdi-folder', 'config.json'), 'utf8'));
  return repo({ ...BASE, '.jdi/phases/alpha/PLAN.md': PLAN, '.jdi/config.json': JSON.stringify(config(tpl)) }).root;
}
const route = (root, ...args) => json(jdi(root, ['route', 'alpha', ...args, '--json']));

test('parseTasks: Kind and Weight of a task (0.21)', () => {
  const t = brief.parseTasks(PLAN);
  assert.deepEqual(t.map((x) => [x.id, x.kind, x.weight]), [['T-1', 'refactor', 'light'], ['T-2', 'feature', 'standard'], ['T-3', '', 'deep']]);
});

test('route: rules by weight, kind and sensitive files; floors; escalation on attempts; profiles (0.21)', () => {
  const root = routeRepo((c) => ({ ...c, sizing: { ...c.sizing, sensitive_globs: ['src/auth/**'] } }));
  const pick = (r) => [r.tier, r.model, r.effort];
  assert.deepEqual(pick(route(root, '--role', 'doer', '--task', 'T-1')), ['cheap', 'haiku', 'low']);
  assert.deepEqual(pick(route(root, '--role', 'doer', '--task', 'T-2')), ['strong', 'opus', 'high'], 'sensitive');
  assert.deepEqual(pick(route(root, '--role', 'doer', '--task', 'T-3')), ['strong', 'opus', 'high'], 'deep');
  // a fix after a measured failure: one tier up per attempt, strong at most
  assert.deepEqual(pick(route(root, '--role', 'doer', '--task', 'T-1', '--attempt', '2')), ['standard', 'sonnet', 'medium']);
  assert.match(route(root, '--role', 'doer', '--task', 'T-1', '--attempt', '2').why, /attempt 2 -> standard/);
  assert.equal(route(root, '--role', 'doer', '--task', 'T-1', '--attempt', '9').tier, 'strong');
  // phase level: the reviewer of a phase with a sensitive file gets the strong model
  assert.equal(route(root, '--role', 'reviewer').tier, 'strong');
  assert.deepEqual(route(root, '--role', 'doer').conditions.sort(), ['deep', 'sensitive'], 'lite doer: heaviest task');
  assert.equal(jdi(root, ['route', 'alpha', '--role', 'doer', '--task', 'T-9']).code, 2);
  assert.equal(jdi(root, ['route', 'alpha', '--task', 'T-1']).code, 1, '--role is required');
});

test('route: floors keep reviewers off the cheap tier; profile overrides; off = models.<role> (0.21)', () => {
  let root = routeRepo((c) => ({ ...c, routing: { ...c.routing, rules: [{ role: 'reviewer', tier: 'cheap' }, { role: 'critic', tier: 'cheap' }] } }));
  assert.equal(route(root, '--role', 'reviewer').tier, 'standard');
  assert.match(route(root, '--role', 'critic').why, /floor critic -> standard/);
  root = routeRepo((c) => ({ ...c, routing: { ...c.routing, profile: 'economy' } }));
  assert.deepEqual([route(root, '--role', 'planner').model, route(root, '--role', 'planner').effort], ['sonnet', 'high']);
  root = routeRepo((c) => ({ ...c, routing: { ...c.routing, rules: [{ role: 'doer', if: ['kind:refactor', 'not deep'], tier: 'strong' }] } }));
  assert.equal(route(root, '--role', 'doer', '--task', 'T-1').tier, 'strong');
  assert.equal(route(root, '--role', 'doer', '--task', 'T-2').tier, 'standard');
  // no routing key (a project from before 0.21): models.<role>, no effort
  root = routeRepo((c) => ({ models: { doer: 'sonnet', reviewer: 'inherit' }, sizing: c.sizing }));
  assert.deepEqual(route(root, '--role', 'doer', '--task', 'T-1'), { role: 'doer', task: 'T-1', tier: null, model: 'sonnet', effort: null, why: 'routing off — models.doer: sonnet' });
  assert.equal(route(root, '--role', 'reviewer').model, null);
  assert.match(jdi(root, ['route', 'alpha', '--role', 'doer']).stdout, /^sonnet - — off: /);
});

test('route: `{"mode": "on"}` alone is a working setup — the defaults carry tiers, rules and floors (0.21)', () => {
  const root = routeRepo(() => ({ models: { doer: 'sonnet' }, routing: { mode: 'on', profile: 'economy' } }));
  assert.deepEqual([route(root, '--role', 'planner').model, route(root, '--role', 'planner').effort], ['sonnet', 'high']);
  assert.equal(route(root, '--role', 'doer', '--task', 'T-1').model, 'haiku');
  assert.equal(route(root, '--role', 'critic').tier, 'standard');
  // the template /jdi-new writes = the built-in defaults, routing turned on
  const core = require('../bin/lib/jdi-core');
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates-jdi-folder', 'config.json'), 'utf8'));
  assert.equal(tpl.routing.mode, 'on');
  assert.equal(core.CONFIG_DEFAULTS.routing.mode, 'off');
  assert.deepEqual({ ...tpl.routing, mode: 'off' }, core.CONFIG_DEFAULTS.routing);
});

// ---------------------------------------------------------------- direct

const ctx = (rows, criteria, extra = '') =>
  `# Alpha\n\n## Acceptance criteria\n${criteria.map((c) => `- [ ] ${c}`).join('\n')}\n\n## Definition of Done\n\n### Auto-verifiable\n${rows
    .map((r, i) => `- [ ] **${i + 1}. ${r}**\n      **Verify:** \`test -f ${r}\``)
    .join('\n')}\n${extra}`;

test('size --direct: a narrow card skips the planner; rows, criteria, evidence, areas or sensitive paths do not (0.21)', () => {
  const agents = {
    '.jdi/agents/jdi-doer-api.md': '---\nname: jdi-doer-api\nscope:\n  file_glob: "api/**"\n---\n',
    '.jdi/agents/jdi-doer-web.md': '---\nname: jdi-doer-web\nscope:\n  file_glob: "web/**"\n---\n',
  };
  const { root } = repo({ ...BASE, ...agents, '.jdi/phases/alpha/CONTEXT.md': ctx(['api/src/a.js'], ['a']) });
  const direct = () => json(jdi(root, ['size', 'alpha', '--direct', '--json']));
  assert.equal(direct().path, 'direct', JSON.stringify(direct()));
  assert.match(jdi(root, ['size', 'alpha', '--direct']).stdout, /^direct — 1 DoD row/);
  const cases = [
    [ctx(['api/a', 'api/b', 'api/c', 'api/d'], ['a']), /4 DoD rows > 3/],
    [ctx(['api/a'], ['a', 'b', 'c', 'd']), /4 acceptance criteria > 3/],
    [ctx(['api/a', 'web/b'], ['a']), /2 areas/],
    [ctx(['api/a'], ['a'], '- [ ] **2. it shows**\n      **Verify (evidence):** `npm run e2e`\n'), /evidence row/],
  ];
  for (const [text, why] of cases) {
    write(root, '.jdi/phases/alpha/CONTEXT.md', text);
    const r = direct();
    assert.equal(r.path, 'planned');
    assert.match(r.reasons.join('; '), why);
  }
  write(root, '.jdi/phases/alpha/CONTEXT.md', ctx(['api/auth/login.js'], ['a']));
  write(root, '.jdi/config.json', JSON.stringify({ sizing: { sensitive_globs: ['api/auth/**'] } }));
  assert.match(direct().reasons.join(), /sensitive paths: api\/auth\/login\.js/);
});
