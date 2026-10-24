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
