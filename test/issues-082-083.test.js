'use strict';

// #82 — the gates do not inherit what `npx` injects into jdi-cli's environment.
// #83 — the reason of a failing `Verify (test):` row is said, never `undefined`.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { write, read, jdi, gitRepo } = require('./helpers');

const repo = (files) => gitRepo(files, 'jdi-8283-');

// one phase, its roadmap entry, a product file; out/ for what the gates write
const BASE = {
  '.jdi/roadmap/alpha.md': ['---', 'order: 1', 'name: Alpha', '---', '- **Slug:** alpha', ''].join('\n'),
  '.jdi/phases/alpha/CONTEXT.md': '# Alpha\n',
  '.gitignore': ['.jdi/cache/', 'out/', ''].join('\n'),
  'src/a.js': 'a\n',
};
const stack = (extra) => ({ '.jdi/stacks/api.json': JSON.stringify({ name: 'api', file_glob: ['src/**'], ...extra }) });

test('#82: a gate run under npx sees neither npm_* variables nor the npx .bin on PATH; a stack may declare one', () => {
  const probe = 'mkdir -p out && (env | grep -i "^npm_" | sort > out/env || true) && echo "$PATH" > out/path';
  const { root } = repo({ ...BASE, ...stack({ gates: { test: probe }, env: { npm_config_registry: 'https://registry.example' } }) });
  const npx = path.join(root, 'cache', '_npx', 'abc', 'node_modules', '.bin');
  const env = {
    npm_command: 'exec',
    npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
    npm_config_allow_scripts: 'true',
    npm_lifecycle_event: 'npx',
    npm_package_name: 'x',
    PATH: `${npx}${path.delimiter}${process.env.PATH}`,
  };
  const r = jdi(root, ['gates', 'run', 'alpha', '--stack', 'api'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(read(root, 'out/env').trim(), 'npm_config_registry=https://registry.example', 'only what the stack declares');
  assert.ok(!read(root, 'out/path').includes('_npx'), 'the npx .bin is gone from PATH');
  // not run by npm: a variable the user exported stays
  const r2 = jdi(root, ['gates', 'run', 'alpha', '--stack', 'api', '--fresh'], { npm_config_allow_scripts: 'true', npm_command: '', npm_execpath: '' });
  assert.equal(r2.code, 0);
  assert.match(read(root, 'out/env'), /npm_config_allow_scripts=true/);
});

const CTX = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. The 101st call is rejected.**
      **Verify (test):** \`limits::rejects_101st\`
`;
const report = (xml) => `mkdir -p out && printf '%s' '${xml}' > out/junit.xml`;
const suite = (cases) => `<testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;

test('#83: every failing Verify (test) row says why — no testcase, cases that failed, no report at HEAD, a cut-off report', () => {
  const { root, g } = repo({ ...BASE, '.jdi/phases/alpha/CONTEXT.md': CTX, ...stack({ gates: { test: report(suite('<testcase classname="cart" name="sums"/>')) }, test_report: 'out/junit.xml' }) });
  const dodRun = () => jdi(root, ['gates', 'run', 'alpha', '--only', 'dod']);
  const check = (r, re) => {
    assert.doesNotMatch(r.stdout, /undefined/, r.stdout);
    assert.match(r.stdout, re);
  };
  // no report at HEAD: ENV, with the sha
  let r = dodRun();
  assert.equal(r.code, 5);
  check(r, /ENV \w+ 1: Verify \(test\): no report at HEAD [0-9a-f]{10} for api/);
  // no testcase matches
  jdi(root, ['gates', 'run', 'alpha', '--stack', 'api']);
  r = dodRun();
  assert.equal(r.code, 1);
  check(r, /FAIL \w+ 1: Verify \(test\): no testcase matches `limits::rejects_101st`/);
  // cases that failed, by name
  const setGate = (xml, msg) => {
    write(root, '.jdi/stacks/api.json', JSON.stringify({ name: 'api', file_glob: ['src/**'], gates: { test: report(xml) }, test_report: 'out/junit.xml' }));
    g('commit', '-qam', msg);
    jdi(root, ['gates', 'run', 'alpha', '--stack', 'api']);
  };
  setGate(suite('<testcase classname="limits" name="rejects_101st"><failure message="x"/></testcase><testcase classname="limits" name="rejects_101st"/>'), 'bad');
  r = dodRun();
  check(r, /FAIL \w+ 1: Verify \(test\): `limits::rejects_101st` — 2 case\(s\), 1 not passed \(failed\): limits::rejects_101st/);
  // the work list of a fix round carries the reason too
  check(jdi(root, ['gates', 'show', 'alpha', '--failures', '--all']), /not passed/);
  // a report cut off mid-test
  setGate('<testsuites><testsuite name="s"><testcase classname="limits" name="rejects_101st"><system-out>killed', 'cut');
  r = dodRun();
  check(r, /report cut off \(the run was interrupted\) at limits::rejects_101st/);
});
