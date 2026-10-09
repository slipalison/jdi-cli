'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../bin/lib/jdi-core');
const { tmpdir, write } = require('./helpers');

test('parseYaml: maps, lists, inline arrays, scalars', () => {
  const y = core.parseYaml([
    'name: jdi-doer-x',
    'order: 2.5',
    'flag: true',
    'tools: [Read, Bash]',
    'triggers:',
    '  - "/jdi-do"',
    '  - execute phase',
    'runtime_overrides:',
    '  claude:',
    '    model: sonnet',
    '    tools: [Read]',
    '  opencode:',
    '    temperature: 0.1',
    'list_same_indent:',
    '- a',
    '- b',
    'after: x',
  ].join('\n'));
  assert.equal(y.name, 'jdi-doer-x');
  assert.equal(y.order, 2.5);
  assert.equal(y.flag, true);
  assert.deepEqual(y.tools, ['Read', 'Bash']);
  assert.deepEqual(y.triggers, ['/jdi-do', 'execute phase']);
  assert.equal(y.runtime_overrides.claude.model, 'sonnet');
  assert.equal(y.runtime_overrides.opencode.temperature, 0.1);
  assert.deepEqual(y.list_same_indent, ['a', 'b']);
  assert.equal(y.after, 'x');
});

test('resolvePhase: layout v3 ranks by order then slug', () => {
  const root = tmpdir();
  write(root, '.jdi/roadmap/_header.md', '# x\n');
  write(root, '.jdi/roadmap/beta.md', '---\norder: 2\nname: Beta\n---\n');
  write(root, '.jdi/roadmap/alpha.md', '---\norder: 1\nname: Alpha\n---\n');
  write(root, '.jdi/roadmap/gamma.md', '---\norder: 1.5\nname: Gamma\n---\n');
  write(root, '.jdi/phases/gamma/CONTEXT.md', 'x');
  const r = core.resolvePhase('gamma', root);
  assert.equal(r.position, 2);
  assert.equal(r.dir, '.jdi/phases/gamma');
  assert.equal(r.exists, true);
  assert.equal(core.resolvePhase('3', root).slug, 'beta');
  assert.throws(() => core.resolvePhase('nope-x', root), /not found/);
});

test('resolvePhase: legacy ROADMAP.md with NN- slugs', () => {
  const root = tmpdir();
  write(root, '.jdi/ROADMAP.md', '### Phase 1: A\n- **Slug:** 01-auth-flow\n\n### Phase 2: B\n- **Slug:** todo-crud\n');
  write(root, '.jdi/phases/01-auth-flow/PLAN.md', 'x');
  const r = core.resolvePhase('auth-flow', root);
  assert.equal(r.position, 1);
  assert.equal(r.dir, '.jdi/phases/01-auth-flow');
  assert.equal(core.resolvePhase('2', root).dir, '.jdi/phases/todo-crud');
});

test('globToRegExp', () => {
  assert.ok(core.matchesAny('frontend/src/a/b.tsx', ['frontend/**']));
  assert.ok(core.matchesAny('backend/x.rs', ['**/*.{rs,toml}']));
  assert.ok(!core.matchesAny('docs/x.md', ['frontend/**', 'backend/**']));
  assert.ok(core.matchesAny('a.cs', ['**/*.cs']));
});

test('estimateTokens uses the configured ratio', () => {
  const cfg = core.loadConfig(tmpdir());
  assert.equal(core.charsPerToken(cfg, 'pt-BR'), 2.2);
  assert.equal(core.estimateTokens('x'.repeat(22), 2.2), 10);
});

test('writing into .jdi/cache/ adds it to .gitignore once, keeping a missing final newline safe', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = tmpdir();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules'); // no trailing newline
  core.writeFileEnsured(path.join(root, '.jdi/cache/x.md'), 'x', root);
  core.writeFileEnsured(path.join(root, '.jdi/cache/y.md'), 'y', root);
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gi, /^node_modules\n# JDI[^\n]*\n\.jdi\/cache\/\n$/);
});
