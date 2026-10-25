'use strict';

// 0.20 — time on the critical path: audit gate, preflight (ENV), several
// stacks per call (parallel), `Verify (test):` proven by the JUnit report,
// one failures list, reviewers in parallel (segments), BLOCKED from gates,
// DOD-L7, one bait worktree per run — on throwaway git fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir, write, read, jdi } = require('./helpers');

function repo(files) {
  const root = tmpdir('jdi-020-');
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

const ROADMAP = { '.jdi/roadmap/alpha.md': '---\norder: 1\nname: Alpha\ncreated_with: 0.20.0\n---\n- **Slug:** alpha\n- **Goal:** a\n' };
const BASE = { ...ROADMAP, '.gitignore': '.jdi/cache/\nout/\n', '.jdi/phases/alpha/CONTEXT.md': '# Alpha\n\n## Definition of Done\n\n### Auto-verifiable\n- _(none)_\n', 'src/a.js': 'return total;\n' };
const stack = (name, extra) => ({ [`.jdi/stacks/${name}.json`]: JSON.stringify({ name, file_glob: ['src/**'], ...extra }) });
const ran = (root) => (fs.existsSync(path.join(root, 'out/ran')) ? read(root, 'out/ran').split('\n').filter(Boolean) : []);
const json = (r) => JSON.parse(r.stdout);

test('audit gate: runs when the build fails, and is never reused (0.20)', () => {
  const { root } = repo({ ...BASE, ...stack('node', { gates: { build: 'exit 1', audit: 'mkdir -p out && echo audit >> out/ran' } }) });
  let r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'node', '--json']);
  assert.equal(r.code, 1);
  const res = Object.fromEntries(json(r).results.map((x) => [x.gate, x.status]));
  assert.deepEqual(res, { build: 'FAIL', audit: 'PASS' });
  write(root, '.jdi/stacks/node.json', JSON.stringify({ name: 'node', file_glob: ['src/**'], gates: { audit: 'mkdir -p out && echo audit >> out/ran' } }));
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']);
  r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']);
  assert.equal(r.code, 0);
  assert.deepEqual(ran(root), ['audit', 'audit', 'audit'], 'a PASS on the same inputs is not reused for the audit');
});

test('preflight: an unmet `requires` is ENV (exit 5), nothing runs, the loop does not see a defect (0.20)', () => {
  const { root } = repo({ ...BASE, ...stack('node', { gates: { test: 'mkdir -p out && echo test >> out/ran' }, requires: { env: ['JDI_TEST_NOPE'], commands: ['no-such-command-jdi'], check: 'exit 3' } }) });
  const r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']);
  assert.equal(r.code, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /ENV\s+node: env JDI_TEST_NOPE is not set/);
  assert.match(r.stdout, /command `no-such-command-jdi` not found/);
  assert.match(r.stdout, /`exit 3` exits 3/);
  assert.deepEqual(ran(root), [], 'no gate ran');
  const f = jdi(root, ['gates', 'show', 'alpha', '--failures', '--all']);
  assert.equal(f.code, 5);
  // met: runs
  const env = { JDI_TEST_NOPE: '1' };
  write(root, '.jdi/stacks/node.json', JSON.stringify({ name: 'node', file_glob: ['src/**'], gates: { test: 'mkdir -p out && echo test >> out/ran' }, requires: { env: ['JDI_TEST_NOPE'], commands: ['git'], disk_free_mb: 1, check: 'true' } }));
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--stack', 'node'], env).code, 0);
  assert.deepEqual(ran(root), ['test']);
});

test('gates run --stack a,b: sequential by default, parallel with economy.parallel_gates; one failures list (0.20)', () => {
  // api waits 3 s and records whether web had started meanwhile: only true
  // when both run at once (no timing threshold — a slow runner cannot flake it)
  const api = 'mkdir -p out && touch out/api.start && sleep 3 && if [ -f out/web.start ]; then touch out/api.saw-web; fi';
  const web = 'mkdir -p out && touch out/web.start && sleep 1 && exit 1';
  const files = { ...BASE, ...stack('api', { gates: { test: api } }), ...stack('web', { gates: { test: web } }) };
  const { root } = repo(files);
  let r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'api,web']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /gates alpha\/api: PASS[\s\S]*gates alpha\/web: FAIL/);
  assert.ok(!fs.existsSync(path.join(root, 'out/api.saw-web')), 'sequential: web started after api ended');
  fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
  write(root, '.jdi/config.json', JSON.stringify({ economy: { parallel_gates: true, gate_cache: false } }));
  r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'api,web', '--json']);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(json(r).map((x) => [x.stack, x.status]), [['api', 'PASS'], ['web', 'FAIL']]);
  assert.ok(fs.existsSync(path.join(root, 'out/api.saw-web')), 'parallel: web ran while api was running');
  const f = jdi(root, ['gates', 'show', 'alpha', '--failures', '--all']);
  assert.equal(f.code, 1);
  assert.match(f.stdout, /FAIL web\/test/);
  assert.doesNotMatch(f.stdout, /api\/test/);
});

const JUNIT_OK = '<testsuites><testsuite name="s"><testcase classname="limits" name="rejects_101st"/><testcase classname="cart" name="sums_total"></testcase></testsuite></testsuites>';
const JUNIT_BAD = '<testsuites><testsuite name="s"><testcase classname="limits" name="rejects_101st"><failure message="x"/></testcase></testsuite></testsuites>';
const CTX_TEST = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. The 101st call is rejected.**
      **Verify (test):** \`limits::rejects_101st\`
- [ ] **2. A test that nobody wrote.**
      **Verify (test):** \`limits::never_written\`
`;

test('Verify (test): proven by the JUnit report of the test gate at HEAD, never re-run (0.20)', () => {
  const writeReport = (xml) => `mkdir -p out && echo test >> out/ran && printf '%s' '${xml}' > out/junit.xml`;
  const { root, g } = repo({ ...BASE, '.jdi/phases/alpha/CONTEXT.md': CTX_TEST, ...stack('api', { gates: { test: writeReport(JUNIT_OK) }, test_report: 'out/junit.xml' }) });
  // the stack gates did not run yet: ENV (a setup step is missing), never a pass
  let r0 = jdi(root, ['gates', 'run', 'alpha', '--only', 'dod', '--json']);
  assert.equal(r0.code, 5);
  let d = json(r0).dod;
  assert.equal(d[0].status, 'ENV');
  assert.match(d[0].reason, /no gate results for api at HEAD/);
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'api']);
  // a later partial run overwrites out/junit.xml — the snapshot keeps the proof
  fs.writeFileSync(path.join(root, 'out/junit.xml'), '<testsuites/>');
  d = json(jdi(root, ['gates', 'run', 'alpha', '--only', 'dod', '--json'])).dod;
  assert.equal(d[0].status, 'PASS', JSON.stringify(d[0]));
  assert.equal(d[1].status, 'FAIL');
  assert.match(d[1].reason, /no testcase named `limits::never_written`/);
  assert.deepEqual(ran(root), ['test'], 'the suite ran once, for the stack gate only');
  // a failing testcase fails the row
  write(root, '.jdi/stacks/api.json', JSON.stringify({ name: 'api', file_glob: ['src/**'], gates: { test: writeReport(JUNIT_BAD) }, test_report: 'out/junit.xml' }));
  g('commit', '-qam', 'bad');
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'api']);
  d = json(jdi(root, ['gates', 'run', 'alpha', '--only', 'dod', '--json'])).dod;
  assert.match(d[0].reason, /failed/);
  // the lint knows it is a test name, not a command
  const dod = require('../bin/lib/dod');
  assert.deepEqual(dod.lint(path.join(root, '.jdi/phases/alpha/CONTEXT.md'), { root }).filter((f) => f.level === 'ERROR'), []);
});

test('parseJunit: names, classnames, entities, failures and skips', () => {
  const { parseJunit } = require('../bin/lib/gates');
  const cases = parseJunit(`<testcase name="a &amp; b" classname='x'/><testcase name="c"><skipped/></testcase><testcase name="d"><error/></testcase>`);
  assert.deepEqual(cases, [
    { name: 'a & b', classname: 'x', status: 'passed' },
    { name: 'c', classname: '', status: 'skipped' },
    { name: 'd', classname: '', status: 'failed' },
  ]);
});

test('DOD-L7: a positive grep over source code is a weak proof (0.20)', () => {
  const dod = require('../bin/lib/dod');
  assert.deepEqual(dod.lintCommand("grep -q 'fn rejects' src/limits.rs").map((f) => f.rule), ['DOD-L7']);
  assert.deepEqual(dod.lintCommand('! grep -rq TODO src/a.rs'), [], 'a negative grep is a fine check');
  assert.deepEqual(dod.lintCommand('grep -q 429 docs/api.md'), [], 'docs are not source code');
});

const SEG_AGENT = (n) => ({ [`.jdi/agents/${n}.md`]: '---\nname: x\n---\n<inputs>\n- `segment_file=<path>` in the prompt\n</inputs>\n' });

test('review plan: parallel with segment files when every reviewer knows them; merge in registry order (0.20)', () => {
  const stacks = { ...stack('api', { agent: 'jdi-reviewer-api', gates: {} }), ...stack('web', { agent: 'jdi-reviewer-web', gates: {} }) };
  const { root } = repo({ ...BASE, ...SEG_AGENT('jdi-reviewer-api'), ...SEG_AGENT('jdi-reviewer-web'), ...stacks });
  const plan = json(jdi(root, ['review', 'plan', 'alpha', '--reviewers', 'jdi-reviewer-api jdi-reviewer-web', '--full']));
  assert.equal(plan.parallel, true);
  // a reviewer that wrote nothing: merge refuses (never a verdict without it)
  write(root, plan.segments['jdi-reviewer-api'], '## Reviewer: jdi-reviewer-api\n\n**Verdict:** APPROVED\n');
  assert.equal(jdi(root, ['review', 'merge', 'alpha']).code, 2);
  write(root, plan.segments['jdi-reviewer-web'], '## Reviewer: jdi-reviewer-web\n\n**Verdict:** APPROVED\n');
  write(root, plan.segments['jdi-reviewer-api'], '## Reviewer: jdi-reviewer-api\n\n**Verdict:** BLOCKED\n\n### Blockers\n- [defect] x\n');
  assert.equal(jdi(root, ['review', 'merge', 'alpha']).code, 0);
  const text = read(root, '.jdi/phases/alpha/REVIEW.md');
  assert.match(text, /## Reviewer: jdi-reviewer-api[\s\S]*## Reviewer: jdi-reviewer-web[\s\S]*jdi:verified head=/);
  assert.equal(jdi(root, ['review', 'verdict', 'alpha']).stdout.trim(), 'BLOCKED');
  // without a stack file per reviewer (reviewers run their own gates): sequential
  fs.rmSync(path.join(root, '.jdi/stacks'), { recursive: true });
  assert.equal(json(jdi(root, ['review', 'plan', 'alpha', '--reviewers', 'jdi-reviewer-api jdi-reviewer-web', '--full'])).parallel, false);
  write(root, '.jdi/stacks/api.json', JSON.stringify({ name: 'api', agent: 'jdi-reviewer-api' }));
  write(root, '.jdi/stacks/web.json', JSON.stringify({ name: 'web', agent: 'jdi-reviewer-web' }));
  // an older specialist (no segment_file) keeps the review sequential
  write(root, '.jdi/agents/jdi-reviewer-web.md', '---\nname: x\n---\n<inputs>\n</inputs>\n');
  assert.equal(json(jdi(root, ['review', 'plan', 'alpha', '--reviewers', 'jdi-reviewer-api jdi-reviewer-web', '--full'])).parallel, false);
});

test('review from-gates: red gates make a BLOCKED review with [defect] blockers, no reviewer (0.20)', () => {
  const { root } = repo({ ...BASE, ...stack('api', { agent: 'jdi-reviewer-api', gates: { test: 'exit 1' } }), ...stack('web', { agent: 'jdi-reviewer-web', gates: { lint: 'exit 1' }, lint_blocks: true }) });
  assert.equal(jdi(root, ['review', 'from-gates', 'alpha']).code, 2, 'nothing measured yet');
  const core = require('../bin/lib/jdi-core');
  const loop = require('../bin/lib/loop');
  assert.throws(() => loop.record(core.resolvePhase('alpha', root), { root }), /REVIEW\.md not found/);
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'api,web']);
  const r = json(jdi(root, ['review', 'from-gates', 'alpha']));
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.blockers, 2);
  assert.match(read(root, '.jdi/phases/alpha/REVIEW.md'), /## Reviewer: jdi-reviewer-api[\s\S]*- \[defect\] gate api\/test failed/);
  // each stack's doer gets only its own failures
  const api = jdi(root, ['review', 'blockers', 'alpha', '--stack', 'jdi-reviewer-api']).stdout;
  assert.match(api, /api\/test/);
  assert.doesNotMatch(api, /web\/lint/);
  const d = loop.record(core.resolvePhase('alpha', root), { root });
  assert.equal(d.status, 'continue');
  assert.ok(d.defects >= 1);
});

const CTX_BAIT2 = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. The total is returned (and builds out/).**
      **Verify:** \`mkdir -p out && echo built >> out/build && grep -q 'return total' src/a.js\`
      **Bait:** \`sed -i 's/return total/return 0/' src/a.js\`
- [ ] **2. Needs the build output of the run.**
      **Verify:** \`test -f out/build && grep -q 'return total' src/a.js\`
      **Bait:** \`sed -i 's/return total/return 0/' src/a.js\`
`;

test('dod bait: one worktree per run — ignored build output stays warm between rows (0.20)', () => {
  const { root, g } = repo({ ...BASE, '.jdi/phases/alpha/CONTEXT.md': CTX_BAIT2 });
  const r = jdi(root, ['dod', 'bait', 'alpha', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(json(r).map((x) => x.status), ['CAUGHT', 'CAUGHT'], 'row 2 sees the out/ that row 1 built');
  assert.equal(g('worktree', 'list').stdout.trim().split('\n').length, 1, 'no worktree left behind');
  assert.equal(read(root, 'src/a.js'), 'return total;\n');
});

test('Verify (test): a carried stack keeps its proof; a gate with no fresh report is ENV; a cut-off testcase fails (0.20)', () => {
  const writeReport = (xml) => `mkdir -p out && printf '%s' '${xml}' > out/junit.xml`;
  const { root, g } = repo({ ...BASE, '.jdi/phases/alpha/CONTEXT.md': CTX_TEST, ...stack('api', { gates: { test: writeReport(JUNIT_OK) }, test_report: 'out/junit.xml' }), 'docs/x.md': 'x\n' });
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'api']);
  // a commit outside the stack scope (src/**): the report still proves the row
  write(root, 'docs/x.md', 'y\n');
  g('commit', '-qam', 'docs only');
  let d = json(jdi(root, ['gates', 'run', 'alpha', '--only', 'dod', '--json'])).dod;
  assert.equal(d[0].status, 'PASS', JSON.stringify(d[0]));
  // a test gate that writes nothing new: ENV, not a defect
  write(root, '.jdi/stacks/api.json', JSON.stringify({ name: 'api', file_glob: ['src/**'], gates: { test: 'true' }, test_report: 'out/junit.xml' }));
  g('commit', '-qam', 'stale runner');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(root, 'out/junit.xml'), old, old); // written by an earlier run
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'api']);
  d = json(jdi(root, ['gates', 'run', 'alpha', '--only', 'dod', '--json'])).dod;
  assert.equal(d[0].status, 'ENV');
  assert.match(d[0].reason, /wrote no fresh JUnit/);
  const { parseJunit } = require('../bin/lib/gates');
  assert.equal(parseJunit('<testcase name="x"><system-out>killed').at(0).status, 'failed');
});

test('gates run --stack: an unknown name is skipped with a note, all unknown is exit 3; audit_blocks false warns (0.20)', () => {
  const { root } = repo({ ...BASE, ...stack('api', { gates: { audit: 'exit 1' }, audit_blocks: false }) });
  const r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'api,jdi-reviewer-nostack']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /no stack file for 'jdi-reviewer-nostack'/);
  assert.match(r.stdout, /audit\s+WARN/);
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--stack', 'x,y']).code, 3);
  // ENV through `show --stack --failures` too
  const { root: r2 } = repo({ ...BASE, ...stack('api', { gates: { test: 'true' }, requires: { env: ['JDI_NOPE_2'] } }) });
  jdi(r2, ['gates', 'run', 'alpha', '--stack', 'api']);
  assert.equal(jdi(r2, ['gates', 'show', 'alpha', '--stack', 'api', '--failures']).code, 5);
});
