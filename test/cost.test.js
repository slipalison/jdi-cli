'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cost = require('../bin/lib/cost');
const { tmpdir, write } = require('./helpers');

const T0 = Date.parse('2026-10-01T10:00:00Z');
const ts = (min) => new Date(T0 + min * 60000).toISOString();
const usage = (cr, cc, out = 10, ttl = '5m') => ({
  input_tokens: 2,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cc,
  cache_creation: ttl === '5m' ? { ephemeral_5m_input_tokens: cc, ephemeral_1h_input_tokens: 0 } : { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cc },
  output_tokens: out,
});
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function buildFixture() {
  const project = path.join(tmpdir(), 'proj');
  write(project, '.jdi/roadmap/alpha.md', '---\norder: 1\n---\n');
  write(project, '.jdi/roadmap/beta.md', '---\norder: 2\n---\n');
  const claude = tmpdir();
  const enc = cost.encodeProjectPath(project);
  const sess = 'sess-1';
  const dir = path.join(claude, enc);
  fs.mkdirSync(path.join(dir, sess, 'subagents'), { recursive: true });

  fs.writeFileSync(path.join(dir, `${sess}.jsonl`), jsonl([
    { type: 'assistant', uuid: 'm1', timestamp: ts(0), message: { id: 'a1', model: 'x', usage: usage(1000, 99000, 10, '1h'), content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'jdi-doer-proj', description: 'Execute T-1', prompt: 'phase_slug=beta, task=T-1' } }] } },
    { type: 'user', uuid: 'm2', timestamp: ts(1), toolUseResult: { agentId: 'abc' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    { type: 'assistant', uuid: 'm3', timestamp: ts(2), message: { id: 'a2', model: 'x', usage: usage(100000, 500, 20, '1h'), content: [{ type: 'text', text: 'done' }] } },
  ]));

  const sub = path.join(dir, sess, 'subagents');
  fs.writeFileSync(path.join(sub, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'jdi-doer-proj', description: 'Execute T-1' }));
  fs.writeFileSync(path.join(sub, 'agent-abc.jsonl'), jsonl([
    { type: 'user', timestamp: ts(0), message: { content: 'phase_slug=beta, task=T-1' } },
    { type: 'attachment', timestamp: ts(0), attachment: { type: 'instructions', files: [{ path: path.join(project, 'CLAUDE.md'), content: 'x' }, { path: path.join(project, '.claude/rules/security.md'), content: 'y' }] } },
    // call 1: reads CLAUDE.md again (re-read) and alpha's CONTEXT (cross-phase)
    { type: 'assistant', timestamp: ts(0), message: { id: 's1', usage: usage(0, 60000), content: [
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: path.join(project, 'CLAUDE.md') } },
      { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: path.join(project, '.jdi/phases/alpha/CONTEXT.md') } },
    ] } },
    { type: 'user', timestamp: ts(1), message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'abc' }, { type: 'tool_result', tool_use_id: 'r2', content: 'abcdef' }] } },
    // nested load of the same CLAUDE.md from a sibling worktree
    { type: 'attachment', timestamp: ts(1), attachment: { type: 'nested_memory', path: path.join(path.dirname(project), 'proj-wt', 'CLAUDE.md'), content: { content: 'dup!' } } },
    // call 2: long foreground bash
    { type: 'assistant', timestamp: ts(1), message: { id: 's2', usage: usage(60000, 40000), content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', timestamp: ts(12), message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'pass' }] } },
    // call 3: 11 minutes later — cache expired, whole 100k context re-written
    { type: 'assistant', timestamp: ts(12), message: { id: 's3', usage: usage(0, 100500), content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(project, 'src/a.ts') } }] } },
    { type: 'user', timestamp: ts(13), message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'edited' }] } },
    { type: 'assistant', timestamp: ts(13), message: { id: 's4', usage: usage(100500, 100), content: [{ type: 'text', text: 'done' }] } },
  ]));
  return { project, claude };
}

test('cost: totals, roles, phase, first action, misses, re-reads, duplicates, cross-phase', () => {
  const { project, claude } = buildFixture();
  const rep = cost.analyze({ projectDir: project, claudeProjects: claude });
  assert.equal(rep.byRole.orchestrator.calls, 2);
  assert.equal(rep.byRole.doer.spawns, 1);
  assert.equal(rep.byRole.doer.calls, 4);
  assert.deepEqual(Object.keys(rep.byPhase), ['beta']);
  // first productive action = the Edit, issued by call 3 (context 100,502)
  assert.equal(rep.firstAction.doer.median, 100502);
  assert.equal(rep.missByCause['long-command'].count, 1);
  assert.equal(rep.missByCause['long-command'].rewritten, 100002);
  assert.equal(rep.rereads.calls, 1);
  assert.equal(rep.dups.loads, 1);
  assert.equal(rep.cross.reads, 1);
  const t = cost.evaluateTargets(rep);
  assert.equal(t.find((c) => c.name === 'instruction_rereads').pass, false);
});

test('cost: weighted uses Anthropic ratios and the TTL split', () => {
  const w = cost.weighted(cost.usageOf(usage(1000, 100, 10, '1h')));
  assert.equal(w, 2 + 1000 * 0.1 + 100 * 2 + 10 * 5);
});

test('cost: never prints message content', () => {
  const { project, claude } = buildFixture();
  const rep = cost.analyze({ projectDir: project, claudeProjects: claude });
  const text = cost.render(rep, 'en', claude, cost.evaluateTargets(rep));
  assert.ok(!text.includes('abcdef'));
  assert.ok(!text.includes('dup!'));
});

test('cost: instruction keys normalize across checkouts', () => {
  assert.equal(cost.instructionKey('/a/b/.claude/rules/rust.md'), '.claude/rules/rust.md');
  assert.equal(cost.instructionKey('/x/proj-wt/CLAUDE.md'), 'CLAUDE.md');
  assert.equal(cost.instructionKey('/home/u/.claude/CLAUDE.md'), '~/.claude/CLAUDE.md');
});

test('cost: paths from shell commands and Windows paths', () => {
  assert.deepEqual(cost.shellPaths('sed -n 1,20p CLAUDE.md:12 && cat "a.md,b.md" | head .jdi/x.jsonl'), ['CLAUDE.md', 'a.md,b.md', '.jdi/x.json']);
  assert.deepEqual(cost.shellPaths('echo .md && ls'), []);
  assert.deepEqual(cost.artifactRefs(String.raw`C:\repo\.jdi\phases\02-alpha\CONTEXT.md`), [{ slug: 'alpha', file: 'CONTEXT' }]);
  assert.deepEqual(cost.artifactRefs('/r/.jdi/phases/beta/REVIEW.md'), [{ slug: 'beta', file: 'REVIEW' }]);
});
