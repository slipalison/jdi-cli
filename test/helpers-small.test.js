'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir, write, jdi } = require('./helpers');
const learnings = require('../bin/lib/learnings');
const decisions = require('../bin/lib/decisions');

test('learnings: most recent by shipped_at, not by folder name', () => {
  const root = tmpdir();
  write(root, '.jdi/phases/zeta-old/SHIPPED.md', 'shipped_at: 2026-01-01T00:00:00Z\n\n## Learnings\n- old lesson\n');
  write(root, '.jdi/phases/alpha-new/SHIPPED.md', 'shipped_at: 2026-03-01T00:00:00Z\n\n## Learnings\n- new lesson\n\n## Evidencia\n- not a learning\n');
  write(root, '.jdi/phases/beta-mid/SHIPPED.md', 'shipped_at: 2026-02-01T00:00:00Z\n\n## Learnings\n- mid lesson\n');
  const out = learnings.render(root, 2, 4000);
  assert.match(out, /alpha-new[\s\S]*new lesson[\s\S]*beta-mid[\s\S]*mid lesson/);
  assert.doesNotMatch(out, /old lesson|not a learning/);
});

test('learnings: respects the char cap', () => {
  const root = tmpdir();
  write(root, '.jdi/phases/a-phase/SHIPPED.md', `shipped_at: 2026-01-01\n\n## Learnings\n- ${'x'.repeat(300)}\n- ${'y'.repeat(300)}\n`);
  const out = learnings.render(root, 3, 400);
  assert.ok(out.length < 520);
  assert.match(out, /truncado/);
});

test('decisions: index, ids, phase and recent filters', () => {
  const root = tmpdir();
  write(root, '.jdi/decisions/D-1.md', 'D-1 (2026-01-01): Code design = The Method');
  write(root, '.jdi/decisions/D-2026-01-02-auth-1.md', 'D-2026-01-02-auth-1 (2026-01-02): tokens only in memory\nlong rationale');
  write(root, '.jdi/decisions/D-2026-01-05-board-1.md', 'D-2026-01-05-board-1 (2026-01-05): cards are ordered');
  write(root, '.jdi/decisions/D-2026-01-05-board-10.md', 'D-2026-01-05-board-10 (2026-01-05): tenth');
  write(root, '.jdi/decisions/D-2026-01-05-board-2.md', 'D-2026-01-05-board-2 (2026-01-05): second');
  const all = decisions.loadDecisions(root);
  assert.deepEqual(all.map((d) => d.id), ['D-1', 'D-2026-01-02-auth-1', 'D-2026-01-05-board-1', 'D-2026-01-05-board-2', 'D-2026-01-05-board-10']);
  const idx = decisions.render(all, { index: true });
  assert.ok(!idx.includes('long rationale'));
  assert.equal(decisions.select(all, { phase: 'auth' }).length, 1);
  assert.deepEqual(decisions.select(all, { recent: 1 }).map((d) => d.id), ['D-1', 'D-2026-01-05-board-1', 'D-2026-01-05-board-2', 'D-2026-01-05-board-10']);
  assert.match(decisions.render(decisions.select(all, { ids: ['D-2026-01-02-auth-1'] }), {}), /long rationale/);
});

test('template: prints with the CLI pinned and refuses unknown names', () => {
  const root = tmpdir();
  const r = jdi(root, ['template', 'dod-schema']);
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('{{JDI_CLI}}'));
  assert.equal(jdi(root, ['template', 'nope']).code, 1);
});
