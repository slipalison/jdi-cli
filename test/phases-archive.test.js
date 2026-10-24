'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir, write, jdi } = require('./helpers');

const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

// Six shipped phases (p1..p6) and a seventh in progress, all committed.
function project() {
  const root = tmpdir();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  for (let i = 1; i <= 7; i++) {
    write(root, `.jdi/roadmap/p${i}-x.md`, `---\norder: ${i}\nname: P${i}\n---\n- **Slug:** p${i}-x\n`);
    write(root, `.jdi/phases/p${i}-x/CONTEXT.md`, `# p${i}\n`);
    if (i < 7) write(root, `.jdi/phases/p${i}-x/SHIPPED.md`, 'shipped_at: 2026-01-01T00:00:00Z\nverdict: APPROVED\n');
  }
  write(root, 'docs/roadmap.md', 'see .jdi/phases/p1-x/CONTEXT.md\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const archived = (root, slug) => fs.existsSync(path.join(root, '.jdi', 'archive', slug));

test('phases archive --dry-run: lists, moves nothing; a referenced phase is skipped (#73)', () => {
  const root = project();
  const r = jdi(root, ['phases', 'archive', '--dry-run', '--keep', '3']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'dry-run');
  assert.deepEqual(out.moved.map((m) => m.phase), ['p2-x', 'p3-x']);
  assert.equal(out.skipped[0].phase, 'p1-x');
  assert.deepEqual(out.skipped[0].refs, ['docs/roadmap.md']);
  assert.ok(!archived(root, 'p2-x'));
});

test('phases archive: moves the old ones; --rewrite-refs updates the links (#73)', () => {
  const root = project();
  const r = jdi(root, ['phases', 'archive', '--keep', '3', '--rewrite-refs']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).moved.map((m) => m.phase), ['p1-x', 'p2-x', 'p3-x']);
  assert.ok(archived(root, 'p1-x') && archived(root, 'p3-x') && !archived(root, 'p4-x'));
  assert.equal(fs.readFileSync(path.join(root, 'docs/roadmap.md'), 'utf8'), 'see .jdi/archive/p1-x/CONTEXT.md\n');
  // an archived phase still resolves
  const rp = JSON.parse(jdi(root, ['resolve-phase', 'p1-x', '--json']).stdout);
  assert.equal(rp.dir, '.jdi/archive/p1-x');
  assert.equal(rp.folder_exists, true);
});

test('phases archive: compaction.archive_after 0 = off', () => {
  const root = project();
  write(root, '.jdi/config.json', '{"compaction":{"archive_after":0}}\n');
  assert.equal(JSON.parse(jdi(root, ['phases', 'archive']).stdout).status, 'off');
});

test('ship moves no other phase and keeps adopted: true in STATE.md (#73)', () => {
  const root = project();
  write(root, '.jdi/phases/p7-x/REVIEW.md', '# Review\n\n**Verdict:** APPROVED\n');
  write(root, '.jdi/STATE.md', 'current_phase: 7\nadopted: true\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'review');
  const r = jdi(root, ['ship', 'p7-x', '--no-archive']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'shipped');
  assert.ok(!fs.existsSync(path.join(root, '.jdi', 'archive')));
  assert.match(fs.readFileSync(path.join(root, '.jdi/STATE.md'), 'utf8'), /^adopted: true$/m);
});

test('phases archive: references match whole path segments; a bare link is rewritten too (#73)', () => {
  const root = project();
  write(root, 'docs/roadmap.md', 'see [p1](.jdi/phases/p1-x) and .jdi/phases/p2-x-old/notes\n');
  git(root, 'commit', '-qam', 'links');
  const out = JSON.parse(jdi(root, ['phases', 'archive', '--keep', '3', '--rewrite-refs']).stdout);
  assert.deepEqual(out.moved.map((m) => [m.phase, m.rewritten.length]), [['p1-x', 1], ['p2-x', 0], ['p3-x', 0]]);
  assert.equal(fs.readFileSync(path.join(root, 'docs/roadmap.md'), 'utf8'), 'see [p1](.jdi/archive/p1-x) and .jdi/phases/p2-x-old/notes\n');
});
