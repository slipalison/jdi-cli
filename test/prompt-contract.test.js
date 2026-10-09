'use strict';

// Prompt contract: the shipped prose (core/) must not reintroduce the waste
// and the contradictions measured in real projects. Each rule names the
// failure it prevents.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../bin/lib/jdi-core');

const ROOT = path.resolve(__dirname, '..');

function files(dir, filter = (f) => f.endsWith('.md')) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (filter(p)) out.push(p);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(p, 'utf8');

const AGENTS = files('core/agents');
const COMMANDS = files('core/commands');
const TEMPLATES = files('core/templates');
const SPECIALIST_TEMPLATES = TEMPLATES.filter((p) => /-specialist\.md$/.test(p));
const SHIPPED_PROSE = [...AGENTS, ...COMMANDS, ...TEMPLATES];
// /jdi-create and the architect's create mode run inside the jdi-cli repo only.
const SOURCE_REPO_ONLY = new Set(['core/commands/jdi-create.md']);

function violations(list, re, { skip = () => false } = {}) {
  const out = [];
  for (const p of list) {
    if (SOURCE_REPO_ONLY.has(rel(p))) continue;
    read(p).split('\n').forEach((line, i) => {
      if (re.test(line) && !skip(line, p)) out.push(`${rel(p)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return out;
}

test('the CLI is always pinned ({{JDI_CLI}}) — never a bare npx jdi-cli (stale cache / newer release)', () => {
  assert.deepEqual(violations(SHIPPED_PROSE, /npx\s+(-y\s+)?jdi-cli(?!@)/), []);
});

test('no instruction to (re)read project instruction files the runtime already injects', () => {
  const re = /\b(read|leia|ler|open)\b[^.\n]{0,50}(CLAUDE\.md|\.claude\/rules|AGENTS\.md)/i;
  const allowed = /\b(never|don't|do not|nunca|não|nao|not)\b/i;
  assert.deepEqual(violations(SHIPPED_PROSE, re, { skip: (line) => allowed.test(line) }), []);
});

test('consumer-facing prose never points at core/templates/ (consumers have no core/, #37)', () => {
  const skip = (line, p) => rel(p) === 'core/agents/jdi-architect.md' && (/core\/templates\/(agent|skill)\.md/.test(line) || /create mode/.test(line));
  assert.deepEqual(violations(SHIPPED_PROSE, /core\/templates\//, { skip }), []);
});

test('no dead commands or helpers in the prose', () => {
  assert.deepEqual(violations(SHIPPED_PROSE, /\/jdi-thread\b/), []);
  assert.deepEqual(violations(COMMANDS, /\{\{JDI_CLI\}\}\s+monitor\b/), []);
});

test('no false prompt-cache claims (files read by a tool are not a shared cache prefix)', () => {
  assert.deepEqual(violations(SHIPPED_PROSE, /cache_breakpoints|\(cache breakpoint\)/), []);
});

test('specialist templates: no <skills_to_load> (no Skill tool) and a return contract', () => {
  for (const p of SPECIALIST_TEMPLATES) {
    const t = read(p);
    assert.ok(!t.includes('<skills_to_load>'), `${rel(p)} has <skills_to_load>`);
    assert.ok(t.includes('<return_contract>'), `${rel(p)} lacks <return_contract>`);
  }
});

test('every core agent spawned by a command has a return contract', () => {
  for (const name of ['jdi-asker', 'jdi-planner']) {
    const t = read(path.join(ROOT, 'core/agents', `${name}.md`));
    assert.ok(t.includes('<return_contract>'), `${name} lacks <return_contract>`);
  }
});

test('brownfield-only text is fenced, so greenfield specialists do not carry dead "if adopted" paragraphs', () => {
  for (const p of SPECIALIST_TEMPLATES) {
    const t = read(p);
    assert.ok(!/\{ADOPTED\}/.test(t), `${rel(p)} still has {ADOPTED}`);
    const opens = (t.match(/<!-- jdi:adopted -->/g) || []).length;
    const closes = (t.match(/<!-- jdi:\/adopted -->/g) || []).length;
    assert.equal(opens, closes, `${rel(p)} unbalanced jdi:adopted markers`);
    const boundary = t.split('\n').filter((l) => l.includes('{BOUNDARY_COMMIT}'));
    let inside = false;
    for (const l of t.split('\n')) {
      if (l.includes('<!-- jdi:adopted -->')) inside = true;
      else if (l.includes('<!-- jdi:/adopted -->')) inside = false;
      else if (l.includes('{BOUNDARY_COMMIT}')) assert.ok(inside, `${rel(p)}: {BOUNDARY_COMMIT} outside an adopted block: ${l.trim()}`);
    }
    assert.ok(boundary.length > 0);
  }
});

test('agents without a shell carry no shell steps (they cannot run them)', () => {
  for (const p of [...AGENTS, ...SPECIALIST_TEMPLATES]) {
    const { fm, body } = core.splitFrontmatter(read(p));
    const y = core.parseYaml(fm);
    const tools = y.runtime_overrides?.claude?.tools || [];
    if (!Array.isArray(tools) || tools.includes('Bash')) continue;
    assert.ok(!/```bash/.test(body), `${rel(p)} has no Bash tool but contains a bash block`);
    assert.ok(!/\bgit commit\b/.test(body), `${rel(p)} has no Bash tool but asks for git commit`);
    assert.ok(!/\{\{JDI_CLI\}\}/.test(body) || /\(you have no shell\)|commits? .* after you return|written by `\/jdi-/.test(body), `${rel(p)} has no Bash tool but calls the CLI`);
  }
});

test('runtime blocks are balanced in every source file', () => {
  const { transform, RUNTIMES } = require('../bin/lib/build-postprocess');
  for (const p of SHIPPED_PROSE) {
    for (const rt of RUNTIMES) assert.doesNotThrow(() => transform(read(p), rt, '0.0.0', rel(p)), `${rel(p)} (${rt})`);
  }
});

test('commands use the deterministic CLI instead of hand-parsing artifacts', () => {
  // verdicts: `review verdict` (worst case across segments, exit 2 on silence)
  assert.deepEqual(violations(COMMANDS, /grep[^\n]*\(Verdict\|Veredicto\)/), []);
  // the ralph loop's bookkeeping: `loop record/reset`, never a hand-written LOOP.md history
  assert.deepEqual(violations(COMMANDS, /--- AUTO-RESET[^\n]*>>|echo "- iter /), []);
  // the v3 roadmap entry: `add-phase` (validation, order, created_with)
  assert.deepEqual(violations(COMMANDS, /ORDERS=\$\(|NEW_ORDER=/), []);
});

test('specialist managed blocks: every template block is balanced and named', () => {
  for (const p of SPECIALIST_TEMPLATES) {
    const t = read(p);
    const opens = (t.match(/<!-- jdi:managed id=[a-z_]+ -->/g) || []).length;
    assert.ok(opens >= 2, `${rel(p)}: expected managed blocks`);
    assert.equal(opens, (t.match(/<!-- jdi:\/managed -->/g) || []).length, `${rel(p)}: unbalanced jdi:managed`);
  }
});
