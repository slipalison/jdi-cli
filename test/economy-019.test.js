'use strict';

// Round-trip economy, from the issues measured on a real project: DoD lint
// rules and critic remedies (#62), gate reuse (#69), evidence freshness (#70),
// one fix batch per round (#71), intake size (#72) — on throwaway git fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir, write, read, jdi } = require('./helpers');

function repo(files) {
  const root = tmpdir('jdi-019-');
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Tester');
  g('config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { root, g, head: () => g('rev-parse', 'HEAD').stdout.trim() };
}

const ROADMAP = { '.jdi/roadmap/alpha.md': '---\norder: 1\nname: Alpha\ncreated_with: 0.19.0\n---\n- **Slug:** alpha\n- **Goal:** a\n' };

const CTX_LINT = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. The smoke scenario covers the login.**
      **Verify:** \`grep -rq '@smoke' features/\`
- [ ] **2. The handler logs the request id.**
      **Verify:** \`grep -A3 'fn handle' src/h.rs | grep -q request_id\`
- [ ] **3. docs/api.md documents the 429.**
      **Verify:** \`grep -q 429 src/limits.rs\`
- [ ] **4. CHANGELOG.md has the entry.**
      **Verify:** \`grep -q '## \\[0.2.0\\]' CHANGELOG.md\`
`;

test('dod lint: Gherkin tag over a glob (L4), unread document (L5), grep window (L6) — #62', () => {
  const { root } = repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_LINT });
  const dod = require('../bin/lib/dod');
  const f = dod.lint(path.join(root, '.jdi/phases/alpha/CONTEXT.md'), { root });
  const at = (rule) => f.filter((x) => x.rule === rule).map((x) => x.msg.slice(0, 7));
  assert.deepEqual(at('DOD-L4'), ['item 1:']);
  assert.deepEqual(at('DOD-L6'), ['item 2:']);
  assert.deepEqual(at('DOD-L5'), ['item 3:'], 'row 4 reads the CHANGELOG it names');
  assert.ok(f.every((x) => x.level !== 'ERROR'), 'the new rules warn, never block');
  assert.deepEqual(dod.lintCommand("grep -q '@smoke' features/login.feature"), [], 'anchored on one file: fine');
});

const CTX_CRITIC = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. Rate limit returns 429.**
      **Verify:** \`grep -R 'limit' src/\`
- [ ] **2. Totals are summed.**
      **Verify:** \`node test/sum.js\`
`;

test('critic: a hollow finding carries its fix and bait into the fix list and REVIEW.md (#62)', () => {
  const { root } = repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_CRITIC, '.jdi/phases/alpha/REVIEW.md': '# Review\n\n**Verdict:** APPROVED\n', 'src/a.js': 'x\n' });
  let p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha', '--preflight']).stdout);
  const finding = { row: 1, hollow: true, objective: true, evidence: 'matches a comment', fix: 'run the limits test with a count check', bait: "sed -i 's/429/200/' src/a.js" };
  write(root, p.findings, JSON.stringify([finding, { row: 2, hollow: false }]));
  const pre = jdi(root, ['critic', 'apply', 'alpha', '--preflight']);
  assert.equal(pre.code, 3);
  assert.match(read(root, JSON.parse(pre.stdout).fixes), /DoD 1 \[objective\]: matches a comment — fix: run the limits test with a count check · bait: `sed -i 's\/429\/200\/' src\/a.js`/);
  p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha']).stdout);
  write(root, p.findings, JSON.stringify([finding]));
  jdi(root, ['critic', 'apply', 'alpha']);
  assert.match(read(root, '.jdi/phases/alpha/REVIEW.md'), /- \[hollow DoD 1\] matches a comment — fix: run the limits test/);
});

const CTX_GATES = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. The source has the total.**
      **Verify:** \`echo dod >> .jdi/cache/ran && grep -q total src/a.js\`
`;

function gatesRepo() {
  const r = repo({
    ...ROADMAP,
    '.gitignore': '.jdi/cache/\n',
    '.jdi/phases/alpha/CONTEXT.md': CTX_GATES,
    // each run appends to an ignored counter, outside the product inputs
    '.jdi/stacks/node.json': JSON.stringify({ name: 'node', file_glob: ['src/**'], gates: { build: 'echo build >> .jdi/cache/ran', test: 'echo test >> .jdi/cache/ran && grep -q total src/a.js' } }),
    'src/a.js': 'return total;\n',
    'docs/notes.md': 'notes\n',
    '.jdi/config.json': JSON.stringify({ loop: { non_product_globs: ['docs/**'] } }),
  });
  write(r.root, '.jdi/cache/ran', '');
  r.ran = () => read(r.root, '.jdi/cache/ran').split('\n').filter(Boolean);
  return r;
}

test('gates: a PASS on the same inputs is reused, marked reused; docs-only changes keep it (#69)', () => {
  const { root, ran } = gatesRepo();
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']).code, 0);
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']).code, 0);
  assert.deepEqual(ran(), ['build', 'test', 'dod']);
  write(root, 'docs/notes.md', 'more notes\n');
  const again = jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']);
  assert.match(again.stdout, /test\s+PASS \(reused [0-9a-f]{12}: passed on /);
  jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']);
  assert.deepEqual(ran(), ['build', 'test', 'dod'], 'nothing ran again');
  const report = JSON.parse(read(root, '.jdi/cache/gates/alpha/node.json'));
  assert.ok(report.results.every((x) => x.reused));
  // --fresh runs everything
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'node', '--fresh']);
  assert.deepEqual(ran().slice(3), ['build', 'test']);
});

test('gates: a product change, a changed DoD proof or a FAIL is never reused (#69)', () => {
  const { root, ran } = gatesRepo();
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']);
  write(root, 'src/a.js', 'return total + 0;\n'); // untracked edit of a product file
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']);
  assert.deepEqual(ran(), ['build', 'test', 'build', 'test']);
  jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']);
  write(root, '.jdi/phases/alpha/CONTEXT.md', CTX_GATES.replace('grep -q total', 'grep -qw total'));
  jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']);
  assert.equal(ran().filter((x) => x === 'dod').length, 2, 'a new proof runs');
  write(root, 'src/a.js', 'nothing\n');
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']).code, 1);
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']).code, 1, 'the FAIL ran again');
  assert.equal(ran().filter((x) => x === 'test').length, 4);
  // off
  write(root, '.jdi/config.json', JSON.stringify({ economy: { gate_cache: false }, loop: { non_product_globs: ['docs/**'] } }));
  write(root, 'src/a.js', 'return total;\n');
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']);
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'node']);
  assert.equal(ran().filter((x) => x === 'test').length, 6);
});

test('gates: a DoD row that reads a non-product file runs again when that file changes (#69)', () => {
  const { root, ran } = gatesRepo();
  write(root, '.jdi/phases/alpha/CONTEXT.md', CTX_GATES.replace('grep -q total src/a.js', 'grep -q notes docs/notes.md'));
  jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']);
  jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']);
  assert.equal(ran().length, 1, 'same inputs: reused');
  write(root, 'docs/notes.md', 'gone\n');
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']).code, 1, 'docs/ is non-product, but the row reads it');
});

const reviewOf = (verdict, blockers) => `# Review\n\n**Verdict:** ${verdict}\n\n### Blockers\n${blockers.map((b) => `- ${b}`).join('\n')}\n`;

test('loop precheck: nothing the verify reads changed -> converge or gate without verifying (#69)', () => {
  const { root, g } = gatesRepo();
  const core = require('../bin/lib/jdi-core');
  const loop = require('../bin/lib/loop');
  const phase = core.resolvePhase('alpha', root);
  assert.equal(loop.precheck(phase, { root }).status, 'verify', 'no loop yet');
  write(root, '.jdi/phases/alpha/REVIEW.md', reviewOf('BLOCKED', ['[hollow DoD 1] grep passes on a comment']));
  assert.equal(loop.record(phase, { root }).status, 'continue');
  // the fix round touched only docs/ (non-product) and .jdi/
  write(root, 'docs/notes.md', 'fixed the wording\n');
  g('add', '-A');
  g('commit', '-qm', 'docs');
  const d = loop.precheck(phase, { root });
  assert.equal(d.status, 'converged-with-warnings', JSON.stringify(d));
  assert.equal(d.skipped, 'verify');
  // a defect that the fix round did not touch: gate, not another verify
  const { root: r2, g: g2 } = gatesRepo();
  const p2 = core.resolvePhase('alpha', r2);
  write(r2, '.jdi/phases/alpha/REVIEW.md', reviewOf('BLOCKED', ['[defect] wrong total']));
  loop.record(p2, { root: r2 });
  assert.equal(loop.precheck(p2, { root: r2 }).status, 'gate');
  // a DoD row changed: verify
  write(r2, '.jdi/phases/alpha/CONTEXT.md', CTX_GATES.replace('grep -q total', 'grep -qw total'));
  assert.equal(loop.precheck(p2, { root: r2 }).status, 'verify');
  // a product change: verify
  write(r2, '.jdi/phases/alpha/CONTEXT.md', CTX_GATES);
  write(r2, 'src/a.js', 'return total * 1;\n');
  g2('commit', '-qam', 'fix');
  assert.equal(loop.precheck(p2, { root: r2 }).status, 'verify');
});

const CTX_EVIDENCE = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. The login flow works end to end.**
      **Verify (evidence):** \`npm run e2e\`
      **Iteration:** \`npm run e2e -- features/login.feature\`
      **Evidence:** the Playwright report
`;

function evidenceRepo(createdWith = '0.19.0') {
  return repo({
    '.jdi/roadmap/alpha.md': `---\norder: 1\nname: Alpha\ncreated_with: ${createdWith}\n---\n- **Slug:** alpha\n- **Goal:** a\n`,
    '.gitignore': '.jdi/cache/\n',
    '.jdi/config.json': JSON.stringify({ loop: { non_product_globs: ['docs/**'] } }),
    '.jdi/phases/alpha/CONTEXT.md': CTX_EVIDENCE,
    '.jdi/phases/alpha/REVIEW.md': '# Review\n\n**Verdict:** APPROVED\n',
    'src/a.js': 'login();\n',
    'docs/api.md': 'api\n',
    'report.html': '<html>ok</html>\n',
  });
}

const evStatus = (root) => JSON.parse(jdi(root, ['evidence', 'status', 'alpha', '--json']).stdout)[0];

test('evidence: a recorded run stays fresh until its inputs change; ship covers iteration (#70)', () => {
  const { root, g } = evidenceRepo();
  assert.equal(evStatus(root).ship.status, 'missing');
  let r = jdi(root, ['evidence', 'record', 'alpha', '--row', '1', '--scope', 'iteration', '--artifact', 'report.html']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).command, 'npm run e2e -- features/login.feature');
  let s = evStatus(root);
  assert.equal(s.iteration.status, 'fresh');
  assert.equal(s.ship.status, 'missing');
  write(root, 'docs/api.md', 'api, reworded\n'); // non-product: still fresh
  assert.equal(evStatus(root).iteration.status, 'fresh');
  write(root, 'src/a.js', 'login(true);\n');
  g('commit', '-qam', 'product change');
  s = evStatus(root);
  assert.equal(s.iteration.status, 'stale');
  assert.match(s.iteration.reason, /src\/a\.js/);
  jdi(root, ['evidence', 'record', 'alpha', '--row', '1', '--scope', 'ship']);
  s = evStatus(root);
  assert.equal(s.ship.status, 'fresh');
  assert.equal(s.iteration.status, 'fresh');
  assert.equal(s.iteration.via, 'ship');
  // the gates report carries it
  jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']);
  assert.deepEqual(JSON.parse(read(root, '.jdi/cache/gates/alpha/dod.json')).dod[0].evidence, { iteration: 'fresh', ship: 'fresh' });
  // a changed row needs a new run
  write(root, '.jdi/phases/alpha/CONTEXT.md', CTX_EVIDENCE.replace('features/login.feature', 'features/'));
  assert.equal(evStatus(root).ship.status, 'stale');
});

test('ship refuses a 0.19+ phase without a fresh full evidence run; older phases are untouched (#70)', () => {
  const { root } = evidenceRepo();
  let r = jdi(root, ['ship', 'alpha']);
  assert.equal(r.code, 5, r.stdout + r.stderr);
  assert.match(r.stderr, /evidence row\(s\) without a fresh full run/);
  jdi(root, ['evidence', 'record', 'alpha', '--row', '1', '--scope', 'iteration']);
  assert.equal(jdi(root, ['ship', 'alpha']).code, 5, 'iteration-only is not enough to ship');
  r = jdi(root, ['ship', 'alpha', '--allow-stale-evidence', 'CI ran it on the PR']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(read(root, '.jdi/phases/alpha/SHIPPED.md'), /stale_evidence: DoD 1: ship evidence missing — CI ran it on the PR/);
  const old = evidenceRepo('0.18.1');
  assert.equal(jdi(old.root, ['ship', 'alpha']).code, 0, 'phases created before 0.19 ship as before');
});

const MULTI_REVIEW = `# Review

## Reviewer: jdi-reviewer-api

**Verdict:** BLOCKED

### Blockers
- [defect] api returns 500 on empty cart

## Reviewer: jdi-reviewer-web

**Verdict:** APPROVED_WITH_WARNINGS

### Warnings
- web: button label truncated

## DoD Critic

### Blockers
- [hollow DoD 2] grep passes on a comment

**Verdict:** BLOCKED
`;

test('review blockers --stack: each doer gets its whole batch; the DoD owner gets the critic (#71)', () => {
  const { root } = repo({ ...ROADMAP, '.jdi/phases/alpha/REVIEW.md': MULTI_REVIEW });
  const api = jdi(root, ['review', 'blockers', 'alpha', '--stack', 'jdi-reviewer-api', '--dod-owner']).stdout;
  assert.match(api, /api returns 500/);
  assert.match(api, /hollow DoD 2/);
  assert.doesNotMatch(api, /button label/);
  const web = jdi(root, ['review', 'blockers', 'alpha', '--stack', 'jdi-reviewer-web']).stdout;
  assert.match(web, /button label/);
  assert.doesNotMatch(web, /api returns 500|hollow DoD/);
  assert.match(jdi(root, ['review', 'blockers', 'alpha']).stdout, /api returns 500[\s\S]*hollow DoD 2[\s\S]*button label/);
});

test('review plan with loop.record_commits "at_ship" keeps every replaced round (#71)', () => {
  const { root } = repo({ ...ROADMAP, '.jdi/config.json': JSON.stringify({ loop: { record_commits: 'at_ship' } }), '.jdi/phases/alpha/REVIEW.md': MULTI_REVIEW });
  jdi(root, ['review', 'plan', 'alpha', '--reviewers', 'jdi-reviewer-api']);
  write(root, '.jdi/phases/alpha/REVIEW.md', '# Review\n\n**Verdict:** APPROVED\n');
  jdi(root, ['review', 'plan', 'alpha', '--reviewers', 'jdi-reviewer-api']);
  assert.equal(read(root, '.jdi/phases/alpha/reviews/round-1.md'), MULTI_REVIEW);
  assert.match(read(root, '.jdi/phases/alpha/reviews/round-2.md'), /APPROVED/);
});

test('size --intake: too many DoD rows or areas -> split, with reasons (#72)', () => {
  const rows = Array.from({ length: 13 }, (_, i) => `- [ ] **${i + 1}. Row ${i + 1} in backend/src/r${i}.rs.**\n      **Verify:** \`test -f backend/src/r${i}.rs\``).join('\n');
  const ctx = `# Alpha\n\n## Acceptance criteria\n- [ ] a\n- [ ] b\n\n## Definition of Done\n\n### Auto-verifiable\n${rows}\n- [ ] **14. The web shows it in frontend/src/App.tsx.**\n      **Verify (evidence):** \`npm run e2e\`\n`;
  const agents = {
    '.jdi/agents/jdi-doer-backend.md': '---\nname: jdi-doer-backend\nscope:\n  file_glob: "backend/**"\n---\n',
    '.jdi/agents/jdi-doer-frontend.md': '---\nname: jdi-doer-frontend\nscope:\n  file_glob: "frontend/**"\n---\n',
  };
  const { root } = repo({ ...ROADMAP, ...agents, '.jdi/phases/alpha/CONTEXT.md': ctx });
  const r = JSON.parse(jdi(root, ['size', 'alpha', '--intake', '--json']).stdout);
  assert.equal(r.intake, 'split');
  assert.equal(r.dod_rows, 14);
  assert.deepEqual(r.areas.sort(), ['backend', 'e2e', 'frontend']);
  assert.equal(r.criteria, 2);
  assert.match(r.reasons.join(), /14 DoD rows > 12/);
  write(root, '.jdi/config.json', JSON.stringify({ sizing: { split_max_dod_rows: 20, split_max_areas: 2 } }));
  assert.match(jdi(root, ['size', 'alpha', '--intake']).stdout, /^split — 3 areas \(/);
});
