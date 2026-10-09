'use strict';

// 0.18.0 helpers: dod bait, critic (lean cadence), size, incremental verify
// (review plan/merge), the stale-review guard of ship, gates --failures — on
// throwaway git fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir, write, read, jdi } = require('./helpers');

function repo(files) {
  const root = tmpdir('jdi-018-');
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

const ROADMAP = { '.jdi/roadmap/alpha.md': '---\norder: 1\nname: Alpha\ncreated_with: 0.18.0\n---\n- **Slug:** alpha\n- **Goal:** a\n' };

const CTX_BAIT = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. The total is returned.**
      **Verify:** \`grep -q 'return total' src/cart.js\`
      **Bait:** \`sed -i 's/return total/return 0/' src/cart.js\`
- [ ] **2. The file exists (weak proof).**
      **Verify:** \`test -f src/cart.js\`
      **Bait:** \`sed -i 's/return total/return 0/' src/cart.js\`
- [ ] **3. A bait that changes nothing.**
      **Verify:** \`true\`
      **Bait:** \`true\`
- [ ] **4. Baseline broken in a clean checkout.**
      **Verify:** \`test -f untracked.txt\`
      **Bait:** \`sed -i 's/return total/return 0/' src/cart.js\`
`;

test('dod parse reads Bait; the row hash follows criterion, Verify and Bait', () => {
  const dod = require('../bin/lib/dod');
  const items = dod.parse(CTX_BAIT).items;
  assert.equal(items[0].bait, "sed -i 's/return total/return 0/' src/cart.js");
  const h = dod.rowHash(items[0]);
  assert.equal(h, dod.rowHash({ ...items[0] }));
  assert.notEqual(h, dod.rowHash({ ...items[0], bait: 'other' }));
  assert.notEqual(h, dod.rowHash({ ...items[0], verify: { ...items[0].verify, raw: 'x' } }));
});

test('dod bait: CAUGHT, HOLLOW, INCONCLUSIVE; caught rows are cached; worktrees are removed', () => {
  const { root, g } = repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_BAIT, 'src/cart.js': 'function t(total) {\n  return total;\n}\n', '.gitignore': '.jdi/cache/\nuntracked.txt\n' });
  write(root, 'untracked.txt', 'only in the main checkout');
  const r = jdi(root, ['dod', 'bait', 'alpha', '--json']);
  assert.equal(r.code, 2, r.stderr + r.stdout); // a HOLLOW row
  const by = Object.fromEntries(JSON.parse(r.stdout).map((x) => [x.id, x.status]));
  assert.deepEqual(by, { 1: 'CAUGHT', 2: 'HOLLOW', 3: 'INCONCLUSIVE', 4: 'INCONCLUSIVE' });
  assert.equal(g('worktree', 'list').stdout.trim().split('\n').length, 1, 'no worktree left behind');
  assert.equal(read(root, 'src/cart.js').includes('return total'), true, 'the main checkout is untouched');
  const again = JSON.parse(jdi(root, ['dod', 'bait', 'alpha', '--json', '--rows', '1']).stdout);
  assert.equal(again[0].cached, true);
});

const CTX_CRITIC = `# Alpha

## Definition of Done

### Auto-verifiable
- [ ] **1. Rate limit returns 429.**
      **Verify:** \`grep -R 'limit' src/\`
- [ ] **2. Totals are summed.**
      **Verify:** \`node test/sum.js\`
- [ ] **3. Logs are structured.**
      **Verify:** \`grep -q json src/log.js\`
- [ ] **4. E2E with a real login.**
      **Verify (evidence):** \`npm run e2e\`
`;

const REVIEW = '# Review\n\n**Verdict:** APPROVED\n\n## Blockers\n- (none)\n';

function criticRepo() {
  return repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_CRITIC, '.jdi/phases/alpha/REVIEW.md': REVIEW, 'src/a.js': 'x\n' });
}

test('critic: plan lists only rows to examine, apply folds findings and only tightens', () => {
  const { root } = criticRepo();
  let p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha']).stdout);
  assert.deepEqual(p.rows, [1, 2, 3], 'evidence rows are never examined');
  assert.ok(fs.existsSync(path.join(root, p.brief)));
  assert.match(read(root, p.brief), /findings\.json/);
  write(root, p.findings, JSON.stringify([
    { row: 1, hollow: true, objective: true, evidence: 'matches a comment in src/a.js:1' },
    { row: 2, hollow: false, objective: false, evidence: 'asserts the sum' },
    { row: 3, hollow: true, objective: false, evidence: 'shallow' },
    { row: 9, hollow: true, objective: true, evidence: 'not asked — ignored' },
  ]));
  const a = JSON.parse(jdi(root, ['critic', 'apply', 'alpha']).stdout);
  assert.equal(a.verdict, 'BLOCKED');
  const review = read(root, '.jdi/phases/alpha/REVIEW.md');
  assert.match(review, /## DoD Critic[\s\S]*### Blockers\n- \[hollow DoD 1\] matches a comment/);
  assert.match(review, /- \[hollow DoD 3\] \(suspicion\) shallow/);
  assert.doesNotMatch(review, /DoD 9/);
  assert.equal(jdi(root, ['review', 'verdict', 'alpha']).stdout.trim(), 'BLOCKED');
  // re-applying replaces the segment instead of stacking it
  write(root, p.findings, '[]');
  jdi(root, ['critic', 'apply', 'alpha']);
  assert.equal((read(root, '.jdi/phases/alpha/REVIEW.md').match(/## DoD Critic/g) || []).length, 1);

  // lean cadence: the sound row 2 is skipped; hollow rows come back
  p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha']).stdout);
  assert.deepEqual(p.rows, [1, 3]);
  // a changed proof is examined again
  write(root, '.jdi/phases/alpha/CONTEXT.md', CTX_CRITIC.replace('node test/sum.js', 'node test/sum.js --strict'));
  p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha']).stdout);
  assert.deepEqual(p.rows, [1, 2, 3]);
  // a row whose hollow-proof block the loop spent is carried as a warning, not re-examined
  write(root, p.findings, JSON.stringify([{ row: 1, hollow: true, objective: true, evidence: 'still a comment' }, { row: 2, hollow: false }, { row: 3, hollow: false }]));
  jdi(root, ['critic', 'apply', 'alpha']);
  write(root, '.jdi/phases/alpha/LOOP.md', '---\nphase_slug: alpha\niter: 1\nhollow_spent: [1]\n---\n\n## History\n');
  // looked at once more after the block (the doer may have fixed it) — but it can no longer block
  p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha']).stdout);
  assert.deepEqual(p.rows, [1], JSON.stringify(p));
  write(root, p.findings, JSON.stringify([{ row: 1, hollow: true, objective: true, evidence: 'still a comment' }]));
  let c = JSON.parse(jdi(root, ['critic', 'apply', 'alpha']).stdout);
  assert.equal(c.verdict, 'APPROVED_WITH_WARNINGS');
  assert.match(read(root, '.jdi/phases/alpha/REVIEW.md'), /- \[hollow DoD 1\] \(block spent\) still a comment/);
  // then it is carried as a warning, not re-examined, until its proof changes
  p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha']).stdout);
  assert.deepEqual(p.rows, [], JSON.stringify(p));
  c = JSON.parse(jdi(root, ['critic', 'apply', 'alpha']).stdout);
  assert.equal(c.verdict, 'APPROVED_WITH_WARNINGS');
  assert.deepEqual(c.carried, [1]);
});

test('critic: preflight exit 3 with a fix list; fail-open without findings; "off" spawns nothing', () => {
  const { root } = criticRepo();
  let p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha', '--preflight']).stdout);
  write(root, p.findings, JSON.stringify([{ row: 1, hollow: true, objective: true, evidence: 'grep passes on a comment' }]));
  const r = jdi(root, ['critic', 'apply', 'alpha', '--preflight']);
  assert.equal(r.code, 3);
  assert.match(read(root, JSON.parse(r.stdout).fixes), /DoD 1 \[objective\]: grep passes on a comment/);
  assert.equal(read(root, '.jdi/phases/alpha/REVIEW.md'), REVIEW, 'preflight never touches REVIEW.md');
  // fail-open
  p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha']).stdout);
  const a = JSON.parse(jdi(root, ['critic', 'apply', 'alpha']).stdout);
  assert.equal(a.verdict, 'APPROVED');
  assert.match(a.problem, /no findings\.json/);
  // off
  write(root, '.jdi/config.json', JSON.stringify({ economy: { critic: 'off' } }));
  p = JSON.parse(jdi(root, ['critic', 'plan', 'alpha']).stdout);
  assert.deepEqual(p.rows, []);
  assert.match(p.skip, /off/);
});

const planWith = (tasks) =>
  `# Plan\n\n## Tasks\n\n${tasks.map((files, i) => `#### T-${i + 1}: task ${i + 1}\n- **Files modified:** ${files.map((f) => `\`${f}\``).join(', ')}\n- **Status:** pending\n`).join('\n')}`;

test('size: lite for a small single-stack plan; full on tasks, stacks or sensitive files', () => {
  const doer = (name, glob) => [`.jdi/agents/${name}.md`, `---\nname: ${name}\nscope:\n  file_glob: "${glob}"\n---\nbody\n`];
  const { root } = repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_CRITIC, '.jdi/phases/alpha/PLAN.md': planWith([['src/a.js'], ['src/b.js']]), ...Object.fromEntries([doer('jdi-doer-back', 'src/**'), doer('jdi-doer-front', 'web/**')]) });
  let s = JSON.parse(jdi(root, ['size', 'alpha', '--json']).stdout);
  assert.equal(s.size, 'lite', JSON.stringify(s));
  assert.equal(s.doer, 'jdi-doer-back');
  write(root, '.jdi/phases/alpha/PLAN.md', planWith([['src/a.js'], ['web/b.js']]));
  s = JSON.parse(jdi(root, ['size', 'alpha', '--json']).stdout);
  assert.equal(s.size, 'full');
  assert.match(s.reasons.join(), /2 stacks/);
  write(root, '.jdi/phases/alpha/PLAN.md', planWith([['src/a.js'], ['src/b.js'], ['src/c.js'], ['src/d.js']]));
  assert.match(JSON.parse(jdi(root, ['size', 'alpha', '--json']).stdout).reasons.join(), /4 tasks > 3/);
  write(root, '.jdi/phases/alpha/PLAN.md', planWith([['src/auth/login.js']]));
  write(root, '.jdi/config.json', JSON.stringify({ sizing: { sensitive_globs: ['src/auth/**'] } }));
  assert.match(JSON.parse(jdi(root, ['size', 'alpha', '--json']).stdout).reasons.join(), /sensitive files: src\/auth\/login\.js/);
});

test('review plan/merge: an untouched reviewer is carried, the DoD owner always runs, BLOCKED is never carried', () => {
  const reviewer = (name, glob) => [`.jdi/agents/${name}.md`, `---\nname: ${name}\nscope:\n  file_glob: "${glob}"\n---\nbody\n`];
  const { root, g } = repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_CRITIC, '.jdi/phases/alpha/PLAN.md': planWith([['back/a.rs']]), 'back/a.rs': '1\n', 'web/b.ts': '1\n', '.gitignore': '.jdi/cache/\n', ...Object.fromEntries([reviewer('jdi-reviewer-back', 'back/**'), reviewer('jdi-reviewer-web', 'web/**')]) });
  const R = 'jdi-reviewer-back jdi-reviewer-web';
  const seg = (name, v) => `## Reviewer: ${name}\n\n**Verdict:** ${v}\n\n## Blockers\n- (none)\n`;
  let p = JSON.parse(jdi(root, ['review', 'plan', 'alpha', '--reviewers', R]).stdout);
  assert.deepEqual(p.run, ['jdi-reviewer-back', 'jdi-reviewer-web']);
  write(root, '.jdi/phases/alpha/REVIEW.md', `# Review\n\n${seg('jdi-reviewer-back', 'BLOCKED')}\n${seg('jdi-reviewer-web', 'APPROVED')}`);
  g('add', '-A');
  g('commit', '-qm', 'verify 1');
  write(root, 'back/a.rs', '2\n');
  g('commit', '-qam', 'fix back');
  p = JSON.parse(jdi(root, ['review', 'plan', 'alpha', '--reviewers', R]).stdout);
  assert.deepEqual(p.run, ['jdi-reviewer-back']);
  assert.deepEqual(p.carry, ['jdi-reviewer-web']);
  assert.equal(fs.existsSync(path.join(root, '.jdi/phases/alpha/REVIEW.md')), false, 'REVIEW.md is regenerated');
  write(root, '.jdi/phases/alpha/REVIEW.md', `# Review\n\n${seg('jdi-reviewer-back', 'APPROVED')}`);
  assert.equal(JSON.parse(jdi(root, ['review', 'merge', 'alpha']).stdout).carried, 1);
  const merged = read(root, '.jdi/phases/alpha/REVIEW.md');
  assert.match(merged, /## Reviewer: jdi-reviewer-back[\s\S]*## Reviewer: jdi-reviewer-web\n<!-- jdi:carried from=[0-9a-f]{12} -->/);
  // a BLOCKED segment is never carried; --full runs everyone
  write(root, '.jdi/phases/alpha/REVIEW.md', `# Review\n\n${seg('jdi-reviewer-back', 'APPROVED')}\n${seg('jdi-reviewer-web', 'BLOCKED')}`);
  g('add', '-A');
  g('commit', '-qm', 'verify 2');
  p = JSON.parse(jdi(root, ['review', 'plan', 'alpha', '--reviewers', R]).stdout);
  assert.deepEqual(p.carry, []);
  assert.match(p.reasons['jdi-reviewer-web'], /BLOCKED/);
});

test('ship refuses a stale review (code changed after the verify commit) unless the reason is recorded', () => {
  const { root, g } = repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_CRITIC, '.jdi/phases/alpha/REVIEW.md': REVIEW, 'src/a.js': 'x\n', '.gitignore': '.jdi/cache/\n' });
  assert.equal(jdi(root, ['review', 'fresh', 'alpha']).code, 0);
  write(root, '.jdi/STATE.md', 'x\n');
  g('add', '-A');
  g('commit', '-qm', 'state only');
  assert.equal(jdi(root, ['review', 'fresh', 'alpha']).code, 0, '.jdi/ changes do not count');
  write(root, 'src/a.js', 'y\n');
  g('commit', '-qam', 'late change');
  assert.equal(jdi(root, ['review', 'fresh', 'alpha']).code, 3);
  const r = jdi(root, ['ship', 'alpha']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /stale/);
  const ok = jdi(root, ['ship', 'alpha', '--allow-stale', 'typo fix in a comment']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(read(root, '.jdi/phases/alpha/SHIPPED.md'), /stale_review: 1 product file\(s\) changed after [0-9a-f]{10} — typo fix in a comment/);
});

test('review merge stamps the verified commit; freshness ignores later REVIEW.md-only commits', () => {
  const { root, g } = repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_CRITIC, '.jdi/phases/alpha/REVIEW.md': REVIEW, 'src/a.js': 'x\n', '.gitignore': '.jdi/cache/\n' });
  const m = JSON.parse(jdi(root, ['review', 'merge', 'alpha']).stdout);
  assert.match(read(root, '.jdi/phases/alpha/REVIEW.md'), new RegExp(`<!-- jdi:verified head=${m.verified} -->`));
  g('add', '-A');
  g('commit', '-qm', 'verify');
  write(root, 'src/a.js', 'late\n');
  g('commit', '-qam', 'late code');
  write(root, '.jdi/phases/alpha/REVIEW.md', read(root, '.jdi/phases/alpha/REVIEW.md') + '\n## DoD Manual Confirmations\n- 4 confirmed\n');
  g('commit', '-qam', 'confirm-dod');
  const f = JSON.parse(jdi(root, ['review', 'fresh', 'alpha']).stdout);
  assert.equal(f.stale, true, 'the confirm-dod commit does not hide the late code change');
  assert.deepEqual(f.files, ['src/a.js']);
});

test('gates show --failures lists only what failed, with the excerpt', () => {
  const { root } = repo({ ...ROADMAP, '.jdi/phases/alpha/CONTEXT.md': CTX_CRITIC, '.jdi/stacks/back.json': JSON.stringify({ name: 'back', gates: { build: 'true', test: 'echo boom-line; exit 1' } }), '.gitignore': '.jdi/cache/\n' });
  assert.equal(jdi(root, ['gates', 'run', 'alpha', '--stack', 'back', '--only', 'build,test']).code, 1);
  const f = jdi(root, ['gates', 'show', 'alpha', '--stack', 'back', '--failures']);
  assert.equal(f.code, 1);
  assert.match(f.stdout, /FAIL back\/test[\s\S]*boom-line/);
  assert.doesNotMatch(f.stdout, /back\/build/);
});

test('specialists lint flags the dead reviewer critic mode', () => {
  const sp = require('../bin/lib/specialists');
  assert.ok(sp.lintText('<return_contract>x</return_contract>\n<dod_critic_mode>\nold\n</dod_critic_mode>', 'r').some((f) => /jdi-dod-critic/.test(f.msg)));
});
