'use strict';

// 0.17.0 helpers: dod, budgets, known-errors, brief, gates, review, loop,
// next, add-phase, ship — on throwaway fixture projects.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir, write, read, jdi } = require('./helpers');

const CONTEXT = `# Phase 1: Alpha — Context (slug: alpha)

## Goal
Do the alpha thing.

## Locked decisions
- D-2026-01-01-alpha-1: tokens only in memory
- D-2026-01-01-alpha-2: lists are paged

## Definition of Done

### Auto-verifiable
- [ ] **1. The parser handles empty input (\`src/parser.js\`).**
      **Verify:** \`true\`
      **Source:** CONTEXT
- [ ] **2. Filtered tests prove the rule.**
      **Verify:** \`cargo test parser_rule\`
      **Source:** CONTEXT
- [ ] **3. A long proof.**
      **Verify:** \`${'echo ok >/dev/null; '.repeat(25)}true\` — explained here
      **Source:** CONTEXT
- [ ] **4. Real login E2E passes.**
      **Verify:** \`npm run e2e\`
      **Source:** CONTEXT

### Manual
- [ ] Stakeholder approves the copy
      **Verify:** human confirmation required
      **Evidence:** screenshot
      **Source:** CONTEXT
`;

const PLAN = `# Phase 1: Alpha — Plan (slug: alpha)

## Tasks

### Wave 1

#### T-1: Parser handles empty input (D-1)
- **Specialist:** jdi-doer-x
- **Files modified:** \`src/parser.js\`, \`src/{a,b}.js\`
- **Acceptance:**
  - empty input returns []
- **Dependencies:** none
- **Test:** parser test
- **Status:** pending

#### T-2: Something else
- **Files modified:** \`docs/x.md\`
- **Status:** pending

## Orchestrator notes
Use the small parser.
`;

function project() {
  const root = tmpdir('jdi-017-');
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Tester');
  write(root, '.jdi/config.json', JSON.stringify({ budgets: { verify_inline_chars: 300, brief_tokens: 6000, context_tokens: 10000 } }));
  write(root, '.jdi/PROJECT.md', '# P\n\n## Stack\n- Node\n\n## Code Design\n**LOCKED:** Vertical Slice\n\n## Definition of Done\n\n### Auto-verifiable\n- [ ] Unit tests pass\n      **Verify:** `true`\n      **Source:** PROJECT\n');
  write(root, '.jdi/roadmap/alpha.md', '---\norder: 1\nname: Alpha\ncreated_with: 0.17.0\n---\n- **Slug:** alpha\n- **Goal:** alpha\n');
  write(root, '.jdi/roadmap/beta.md', '---\norder: 2\nname: Beta\n---\n- **Slug:** beta\n- **Goal:** beta\n');
  write(root, '.jdi/phases/alpha/CONTEXT.md', CONTEXT);
  write(root, '.jdi/phases/alpha/PLAN.md', PLAN);
  write(root, '.jdi/decisions/D-2026-01-01-alpha-1.md', 'D-2026-01-01-alpha-1 (2026-01-01): tokens only in memory, never in storage');
  write(root, '.jdi/agents/jdi-doer-x.md', '---\nname: jdi-doer-x\n---\nbody\n');
  write(root, 'src/parser.js', 'module.exports = 1;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { root, g };
}

test('dod parse/lint: items, filters without counts, long inline, E2E', () => {
  const { root } = project();
  const dod = require('../bin/lib/dod');
  const doc = dod.parse(CONTEXT);
  assert.equal(doc.items.length, 5);
  assert.deepEqual(doc.items.map((i) => i.type), ['auto', 'auto', 'auto', 'auto', 'manual']);
  const f = dod.lint(path.join(root, '.jdi/phases/alpha/CONTEXT.md'), { root });
  const rules = f.map((x) => `${x.level}:${x.rule}`).sort();
  assert.ok(rules.includes('ERROR:DOD-L1'), 'cargo test with a filter and no count');
  assert.ok(rules.includes('WARN:DOD-S2'), 'long inline Verify');
  assert.ok(rules.includes('WARN:DOD-L3'), 'E2E in an auto Verify');
  const r = jdi(root, ['validate-dod', 'alpha']);
  assert.equal(r.code, 1);
});

test('dod extract: moves the long Verify to a script, keeps the tail, is idempotent, refuses shipped phases', () => {
  const { root } = project();
  const r = jdi(root, ['dod', 'extract', 'alpha', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.map((x) => `${x.id}:${x.action}`), ['3:extracted']);
  const ctx = read(root, '.jdi/phases/alpha/CONTEXT.md');
  assert.match(ctx, /\*\*Verify:\*\* `bash \.jdi\/phases\/alpha\/verify\/dod-3\.sh` — explained here/);
  const script = read(root, '.jdi/phases/alpha/verify/dod-3.sh');
  assert.ok(script.endsWith(`${'echo ok >/dev/null; '.repeat(25)}true\n`));
  assert.ok(!/set -e/.test(script), 'no shell options added: same semantics as eval');
  assert.equal(JSON.parse(jdi(root, ['dod', 'extract', 'alpha', '--json']).stdout).length, 0);
  write(root, '.jdi/phases/alpha/SHIPPED.md', 'shipped_at: x\n');
  assert.equal(jdi(root, ['dod', 'extract', 'alpha']).code, 1);
});

test('budgets: enforced for phases created with 0.17+, informative before', () => {
  const { root } = project();
  write(root, '.jdi/phases/alpha/SUMMARY.md', 'x'.repeat(20000));
  write(root, '.jdi/phases/beta/SUMMARY.md', 'x'.repeat(20000));
  const budgets = require('../bin/lib/budgets');
  const core = require('../bin/lib/jdi-core');
  const a = budgets.check(core.resolvePhase('alpha', root), root);
  const b = budgets.check(core.resolvePhase('beta', root), root);
  assert.ok(a.enforced && a.findings.some((f) => f.level === 'WARN' && f.file === 'SUMMARY.md'));
  assert.ok(!b.enforced && b.findings.every((f) => f.level === 'NOTE'));
});

test('known-errors: migrate a table catalog, query skips mechanized entries and caps', () => {
  const { root } = project();
  write(root, 'cat.md', [
    '# Erros conhecidos', 'intro', '',
    '## DoD: Verify oco', '', '| ID | Sintoma | Prevenção | Origem |', '|---|---|---|---|',
    '| KE-DOD-1 | cargo test filter exits 0 | `dod-lint` **DOD-L1**: require count | p1 |',
    '| KE-DOD-2 | grep on a glob \\| anything | anchor the file | p2 |', '',
    '## Testes', '', '| ID | Sintoma | Prevenção | Origem |', '|---|---|---|---|',
    '| KE-TEST-1 | flaky first test | CI=1 locally | p3 |', '',
  ].join('\n'));
  const r = jdi(root, ['known-errors', 'migrate', 'cat.md']);
  assert.equal(r.code, 0, r.stderr);
  const ke = require('../bin/lib/known-errors');
  const all = ke.load(root);
  assert.equal(all.length, 3);
  assert.equal(all.find((e) => e.id === 'KE-DOD-1').mechanizedBy, 'dod-lint:DOD-L1');
  const q = ke.query(all, { stage: 'plan' });
  assert.deepEqual(q.lines.map((l) => l.split(':')[0]), ['- KE-DOD-2']);
  assert.deepEqual(ke.query(all, { stage: 'do' }).lines.map((l) => l.split(':')[0]), ['- KE-TEST-1']);
  assert.equal(ke.query(all, { stage: 'plan', maxTokens: 5 }).dropped, 1);
});

test('brief doer: task block, notes, cited decision, DoD rows of its files, under the cap', () => {
  const { root } = project();
  const r = jdi(root, ['brief', 'alpha', '--role', 'doer', '--task', 'T-1']);
  assert.equal(r.code, 0, r.stderr);
  const text = read(root, '.jdi/cache/briefs/alpha/doer-T-1.md');
  assert.match(text, /#### T-1: Parser handles empty input/);
  assert.match(text, /Use the small parser/);
  assert.match(text, /tokens only in memory, never in storage/, 'decision D-1 resolved to the phase decision file');
  assert.match(text, /DoD 1 \(auto\)/);
  assert.doesNotMatch(text, /DoD 2 \(auto\)/, 'rows that do not touch the task files stay out');
  assert.doesNotMatch(text, /T-2: Something else/);
  assert.match(read(root, '.gitignore'), /\.jdi\/cache\//);
  const brief = require('../bin/lib/brief');
  assert.deepEqual(brief.expandBraces('src/{a,b}.js'), ['src/a.js', 'src/b.js']);
});

test('brief planner/asker/reviewer/critic build without errors', () => {
  const { root } = project();
  for (const args of [['--role', 'planner'], ['--role', 'asker'], ['--role', 'reviewer', '--stack', 'jdi-reviewer-x'], ['--role', 'critic', '--preflight']]) {
    const r = jdi(root, ['brief', 'alpha', ...args]);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
  }
});

test('gates run: build/coverage/lint from the stack, test inside coverage, DoD once with evidence and manual', () => {
  const { root } = project();
  write(root, '.jdi/stacks/node.json', JSON.stringify({
    name: 'node', agent: 'jdi-reviewer-x', file_glob: ['src/**'],
    gates: { build: 'true', test: 'echo TESTS', coverage: 'echo coverage-ok', lint: 'exit 3' },
    coverage_runs_tests: true, lint_blocks: false, evidence_only: ['npm run e2e'],
  }));
  const gates = require('../bin/lib/gates');
  const core = require('../bin/lib/jdi-core');
  const phase = core.resolvePhase('alpha', root);
  const rep = gates.runGates(phase, { stack: 'jdi-reviewer-x' }, root);
  const st = Object.fromEntries(rep.results.map((x) => [x.gate, x.status]));
  assert.deepEqual(st, { build: 'PASS', coverage: 'PASS', test: 'PASS', lint: 'WARN' });
  assert.equal(rep.status, 'PASS');
  const d = gates.runGates(phase, { only: ['dod'] }, root);
  const byId = Object.fromEntries(d.dod.map((x) => [`${x.source}-${x.id}`, x.status]));
  assert.equal(byId['PROJECT-1'], 'PASS');
  assert.equal(byId['CONTEXT-1'], 'PASS');
  assert.equal(byId['CONTEXT-4'], 'EVIDENCE');
  assert.equal(byId['CONTEXT-5'], 'MANUAL_REQUIRED');
  assert.ok(fs.existsSync(path.join(root, '.jdi/cache/gates/alpha/dod.json')));
});

test('gates run --changed-since: untouched stack is SKIPPED', () => {
  const { root, g } = project();
  write(root, '.jdi/stacks/node.json', JSON.stringify({ name: 'node', file_glob: ['src/**'], gates: { build: 'exit 1' } }));
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const gates = require('../bin/lib/gates');
  const core = require('../bin/lib/jdi-core');
  const rep = gates.runGates(core.resolvePhase('alpha', root), { stack: 'node', changedSince: head }, root);
  assert.equal(rep.results[0].status, 'SKIPPED');
});

const REVIEW = (verdict, blockers) => `# Review\n\n## Reviewer: a\n\n**Verdict:** ${verdict}\n\n## Blockers\n${blockers.map((b) => `- ${b}`).join('\n') || '- (none)'}\n\n## Warnings\n- w1\n\n## DoD Checklist\n| # | c | s | t | Status | e |\n|---|---|---|---|---|---|\n| 1 | x | CONTEXT | Auto | PASS | ok |\n`;

test('review verdict/blockers', () => {
  const { root } = project();
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('APPROVED', []) + '\n## Reviewer: b\n\n**Verdict:** BLOCKED\n\n## Blockers\n- [defect] crash on null\n');
  assert.equal(jdi(root, ['review', 'verdict', 'alpha']).stdout.trim(), 'BLOCKED');
  const b = jdi(root, ['review', 'blockers', 'alpha']).stdout;
  assert.match(b, /crash on null/);
  assert.match(b, /w1/);
});

test('loop: hollow proof blocks once per row, then converges with warnings; defects always block', () => {
  const { root, g } = project();
  const core = require('../bin/lib/jdi-core');
  const loop = require('../bin/lib/loop');
  const phase = core.resolvePhase('alpha', root);
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('BLOCKED', ['[hollow DoD 2] grep passes on the heading']));
  let d = loop.record(phase, { root });
  assert.equal(d.status, 'continue');
  assert.deepEqual(d.hollowSpent, [2]);
  write(root, 'src/parser.js', 'module.exports = 2;\n');
  g('commit', '-qam', 'change');
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('BLOCKED', ['[hollow DoD 2] still hollow in another way']));
  d = loop.record(phase, { root });
  assert.equal(d.status, 'converged-with-warnings');
  // a fresh loop: a defect blocks even without product change
  fs.rmSync(path.join(root, '.jdi/phases/alpha/LOOP.md'));
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('BLOCKED', ['[defect] wrong total']));
  assert.equal(loop.record(phase, { root }).status, 'continue');
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('BLOCKED', ['[defect] wrong total']));
  assert.equal(loop.record(phase, { root }).status, 'gate', 'same findings again = oscillation');
  assert.equal(loop.reset(phase, { root, reason: 'x' }).status, 'continue');
  assert.equal(loop.reset(phase, { root, reason: 'y' }).status, 'continue');
  assert.equal(loop.reset(phase, { root, reason: 'z' }).status, 'killed');
});

test('next: derives the next command from the artifacts', () => {
  const { root } = project();
  assert.equal(JSON.parse(jdi(root, ['next', '--json']).stdout).next, '/jdi-do alpha');
  write(root, '.jdi/phases/alpha/SUMMARY.md', '- T-1: done\n');
  assert.equal(JSON.parse(jdi(root, ['next', '--json']).stdout).next, '/jdi-verify alpha');
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('BLOCKED', ['[defect] x']));
  assert.equal(JSON.parse(jdi(root, ['next', '--json']).stdout).next, '/jdi-do alpha');
  assert.equal(JSON.parse(jdi(root, ['next', '--json', '--loop']).stdout).next, '/jdi-loop alpha');
});

test('add-phase and ship', () => {
  const { root } = project();
  let r = jdi(root, ['add-phase', 'Gamma Ray', '--goal', 'g', '--reason', 'card #9']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.slug, 'gamma-ray');
  assert.match(read(root, '.jdi/roadmap/gamma-ray.md'), /order: 3\n[\s\S]*created_with: /);
  assert.equal(jdi(root, ['add-phase', 'Gamma Ray']).code, 3, 'duplicate slug');
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('BLOCKED', ['[defect] x']));
  assert.equal(jdi(root, ['ship', 'alpha']).code, 1, 'BLOCKED refuses');
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('APPROVED_WITH_WARNINGS', []));
  write(root, 'learn.md', '- one\n- two\n');
  r = jdi(root, ['ship', 'alpha', '--learnings-file', 'learn.md']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(read(root, '.jdi/phases/alpha/SHIPPED.md'), /verdict: APPROVED_WITH_WARNINGS[\s\S]*## Learnings\n- one\n- two/);
  assert.equal(JSON.parse(jdi(root, ['ship', 'alpha']).stdout).status, 'already-shipped');
  write(root, 'many.md', '- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n');
  write(root, '.jdi/phases/beta/REVIEW.md', REVIEW('APPROVED', []));
  assert.equal(jdi(root, ['ship', 'beta', '--learnings-file', 'many.md']).code, 1, 'at most 5 learnings');
});

test('resolve-phase (Node) keeps the KEY=value contract and the exit codes', () => {
  const { root } = project();
  const r = jdi(root, ['resolve-phase', 'alpha']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^JDI_PHASE_SLUG='alpha'\nJDI_PHASE_DIR='\.jdi\/phases\/alpha'\nJDI_PHASE_POSITION='1'\nJDI_PHASE_SCHEMA='3'\nJDI_PHASE_FOLDER_EXISTS='true'\n$/);
  assert.equal(jdi(root, ['resolve-phase', 'nope-x']).code, 2);
  assert.equal(JSON.parse(jdi(root, ['resolve-phase', '2', '--json']).stdout).slug, 'beta');
});

test('specialists: adopt managed blocks keeps the project text, upgrade is idempotent, lint flags waste', () => {
  const sp = require('../bin/lib/specialists');
  const legacy = '---\nname: jdi-doer-p\n---\n<role>\nYou are the doer.\n</role>\n\n<inputs>\n- Read on: PROJECT.md, DECISIONS.md\n</inputs>\n\n<conventions>\nProject rule: tabs. Leia com Read ANTES: .claude/rules/x.md\n</conventions>\n';
  const r = sp.upgradeText(legacy, 'doer', { adopt: true });
  assert.ok(r.changes.length >= 3);
  assert.match(r.text, /<!-- jdi:managed id=inputs -->\n<inputs>\n- From the prompt/);
  assert.match(r.text, /Project rule: tabs\./, 'project text outside the blocks is kept');
  assert.doesNotMatch(r.text, /Read on: PROJECT.md, DECISIONS.md/);
  assert.equal(sp.upgradeText(r.text, 'doer').changes.length, 0, 'idempotent');
  assert.equal(sp.upgradeText(legacy, 'doer').needsAdopt, true, 'without --adopt nothing is touched');
  const lint = sp.lintText(r.text, 'x');
  assert.ok(lint.some((f) => /reler/.test(f.msg)), 'the project re-read instruction is flagged');
  assert.ok(sp.lintText('{PROJECT_NAME} <return_contract>', 'y').some((f) => f.level === 'ERROR'));
});

test('add-phase --unique suffixes a taken slug; --before slots between neighbors; history is protected', () => {
  const { root } = project();
  let r = jdi(root, ['add-phase', 'Alpha', '--unique', '--reason', 'card #1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).slug, 'alpha-2');
  assert.match(read(root, `.jdi/decisions/D-${new Date().toISOString().slice(0, 10)}-alpha-2-1.md`), /^D-\d{4}-\d{2}-\d{2}-alpha-2-1: Phase 'Alpha' \(slug: alpha-2\) added\. Reason: card #1\./);
  r = jdi(root, ['add-phase', 'Mid', '--after', 'beta']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).order, 2.5, 'midpoint between beta (2) and alpha-2 (3)');
  assert.equal(jdi(root, ['add-phase', 'Early', '--before', 'alpha']).code, 1, 'cannot slot before the current phase');
  assert.equal(jdi(root, ['add-phase', '9 lives']).code, 0, 'digit-leading name gets a phase- prefix');
  assert.ok(fs.existsSync(path.join(root, '.jdi/roadmap/phase-9-lives.md')));
  assert.equal(jdi(root, ['add-phase', 'Current']).code, 2, 'reserved slug');
});

test('next --status: one screen derived from the artifacts, no file written', () => {
  const { root, g } = project();
  write(root, '.jdi/todos/alpha.md', '# Todos\n- a\n- b\n');
  g('add', '-A');
  g('commit', '-qm', 'todos');
  const before = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  const s = JSON.parse(jdi(root, ['next', '--status', '--json']).stdout);
  assert.equal(s.slug, 'alpha');
  assert.equal(s.name, 'Alpha');
  assert.equal(s.total, 2);
  assert.equal(s.shipped, 0);
  assert.equal(s.todos, 2);
  assert.equal(s.next, '/jdi-do alpha');
  assert.equal(s.last_artifact.file, '.jdi/phases/alpha/PLAN.md');
  const text = jdi(root, ['next', '--status']).stdout;
  assert.match(text, /Phase: {10}1\/2 — Alpha \(slug: alpha\)/);
  assert.match(text, /Next step: {6}\/jdi-do alpha/);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, before);
});

test('review: manual pending counts only the DoD Checklist table', () => {
  const review = require('../bin/lib/review');
  const text = '**Verdict:** APPROVED_PENDING_MANUAL\n\n## Notes\n| x | MANUAL_REQUIRED | (quoted in a note) |\n\n## DoD Checklist\n| # | c | s | t | Status | e |\n|---|---|---|---|---|---|\n| 1 | a | CONTEXT | Manual | MANUAL_REQUIRED | — |\n| 2 | b | CONTEXT | Manual | CONFIRMED | ok |\n\n## Reviewer: b\n**Verdict:** APPROVED\n';
  const v = review.verdictOf(text);
  assert.equal(v.verdict, 'APPROVED_PENDING_MANUAL');
  assert.equal(v.manualPending, 1);
});

test('loop reset --autonomous honors orchestration.max_resets_autonomous', () => {
  const { root } = project();
  const core = require('../bin/lib/jdi-core');
  const loop = require('../bin/lib/loop');
  write(root, '.jdi/config.json', JSON.stringify({ orchestration: { max_resets_autonomous: 2 } })); // reaching the cap kills (3 = 15 iterations)
  const phase = core.resolvePhase('alpha', root);
  loop.init(phase, { maxIter: 5, maxResets: 3 });
  assert.equal(loop.reset(phase, { root, reason: 'gate', autonomous: true }).status, 'continue');
  assert.equal(loop.reset(phase, { root, reason: 'gate', autonomous: true }).status, 'killed');
  assert.match(read(root, '.jdi/phases/alpha/LOOP.md'), /AUTO-RESET 1[\s\S]*KILLED/);
});

test('specialist templates: managed blocks are balanced, unique, and upgrade of a fresh render is a no-op', () => {
  const sp = require('../bin/lib/specialists');
  const template = require('../bin/lib/template');
  for (const [name, role] of [['doer-specialist', 'doer'], ['reviewer-specialist', 'reviewer']]) {
    const t = template.render(name);
    const opens = (t.match(/<!-- jdi:managed id=[a-z_]+ -->/g) || []).map((m) => m.slice(20, -4));
    assert.equal(opens.length, (t.match(/<!-- jdi:\/managed -->/g) || []).length, `${name}: unbalanced`);
    assert.equal(new Set(opens).size, opens.length, `${name}: duplicate ids`);
    assert.ok(opens.includes('inputs') && opens.includes('return_contract'), `${name}: ${opens}`);
    assert.equal(sp.upgradeText(t, role).changes.length, 0, `${name}: upgrade of the template itself changes it`);
  }
});

test('loop: BLOCKED with no readable reasons or a failed gate never converges; a converged override is written for ship', () => {
  const { root, g } = project();
  const core = require('../bin/lib/jdi-core');
  const loop = require('../bin/lib/loop');
  const phase = core.resolvePhase('alpha', root);
  write(root, '.jdi/phases/alpha/REVIEW.md', '# Review\n\n**Verdict:** BLOCKED\n\nBuild failed, see table.\n');
  assert.equal(loop.record(phase, { root }).status, 'continue', 'no Blockers list = defect');
  fs.rmSync(path.join(root, '.jdi/phases/alpha/LOOP.md'));
  // hollow row spends its block, then a gate fails on HEAD: still a defect
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('BLOCKED', ['[hollow DoD 2] weak']));
  loop.record(phase, { root });
  write(root, 'src/parser.js', 'module.exports = 3;\n');
  g('commit', '-qam', 'fix');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  write(root, '.jdi/cache/gates/alpha/dod.json', JSON.stringify({ head, stack: 'dod', results: [], dod: [{ id: 1, source: 'CONTEXT', status: 'FAIL' }] }));
  write(root, '.jdi/phases/alpha/REVIEW.md', REVIEW('BLOCKED', ['[hollow DoD 2] weak again']));
  assert.equal(loop.record(phase, { root }).status, 'continue', 'a failed DoD gate on HEAD blocks');
  fs.rmSync(path.join(root, '.jdi/cache/gates/alpha/dod.json'));
  write(root, '.jdi/phases/alpha/REVIEW.md', '# Review\n\n## Reviewer: a\n\n**Verdict:** BLOCKED\n\n### Blockers\n1. [hollow DoD 2] weak, third time\n\n### Warnings\n- w\n');
  const d = loop.record(phase, { root });
  assert.equal(d.status, 'converged-with-warnings');
  assert.equal(d.reviewOverridden, true);
  const review = read(root, '.jdi/phases/alpha/REVIEW.md');
  assert.match(review, /\*\*Verdict:\*\* APPROVED_WITH_WARNINGS/);
  assert.match(review, /## Loop override[\s\S]*- \[hollow DoD 2\] weak, third time/);
  assert.equal(jdi(root, ['review', 'verdict', 'alpha']).stdout.trim(), 'APPROVED_WITH_WARNINGS');
});
