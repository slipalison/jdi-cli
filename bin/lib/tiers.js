'use strict';

// Tier variants of the agents, for the runtimes that fix the model in the
// agent file (0.22): GitHub Copilot and OpenCode. Run by `jdi-cli
// sync-specialists`, after the copies it writes (same flags: [runtime]
// [--check] [--quiet] [--porcelain]).
//
// Claude Code takes the model and the effort per spawn (`route` answers them).
// Copilot and OpenCode take the `model:` of the agent being spawned — so the
// way to give a light task a cheap model there is another copy of the agent
// with another `model:`. With `routing.mode: "on"` and
// `routing.runtime_models.<runtime>.<tier>` naming that runtime's model id for
// a tier, every per-project specialist (and the core agents the commands
// route: planner, asker, critic) gets, per configured tier, a copy
// `<name>--<tier>` made from the runtime copy `sync-specialists` just wrote,
// with only the name, the description's first words and `model:` changed.
// `route --runtime <rt> --agent <name>` answers which one to spawn.
//
// Left out: Junie (it delegates by description match — no way to pick a
// variant — and never names a model) and Antigravity (no model in skills).
// Effort stays a Claude Code feature: neither agent format takes it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./jdi-core');

const TIER_NAMES = ['cheap', 'standard', 'strong'];
const RUNTIMES = {
  copilot: { dir: '.github/agents', file: (n) => `${n}.agent.md`, userDir: null, named: true },
  opencode: { dir: '.opencode/agents', file: (n) => `${n}.md`, userDir: path.join(os.homedir(), '.config', 'opencode', 'agents'), named: false },
};
const CORE_ROUTED = ['jdi-planner', 'jdi-asker', 'jdi-dod-critic'];
const MARK_RE = /^<!-- jdi:tier-variant of=(\S+) tier=(\w+) -->$/m;
const variantName = (name, tier) => `${name}--${tier}`;

function baseNames(root) {
  const d = path.join(root, core.JDI_DIR, 'agents');
  const specialists = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^jdi-.*\.md$/.test(f)).map((f) => f.slice(0, -3)) : [];
  return [...specialists.sort(core.compareStr), ...CORE_ROUTED];
}

// The runtime copy a variant is made from: the project's, else the user's.
function baseCopy(root, rt, name) {
  const r = RUNTIMES[rt];
  for (const dir of [path.join(root, r.dir), r.userDir].filter(Boolean)) {
    const text = core.readIf(path.join(dir, r.file(name)));
    if (text !== null) return text.replaceAll('\r\n', '\n');
  }
  return null;
}

// A description that keeps its YAML quoting.
function describe(line, tier, name) {
  const note = `Tier ${tier} of ${name}, spawned by jdi-cli route - never pick it by hand. `;
  const value = line.slice('description:'.length).trim();
  const q = value[0];
  if (q === '"' || q === "'") return `description: ${q}${note}${value.slice(1)}`;
  return `description: ${note}${value}`;
}

function render(baseText, rt, name, tier, model) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(baseText);
  if (!m) return null;
  const fm = m[1].split('\n').filter((l) => !l.startsWith('model:'));
  const out = [];
  for (const l of fm) {
    if (l.startsWith('name:') && RUNTIMES[rt].named) out.push(`name: ${variantName(name, tier)}`);
    else if (l.startsWith('description:')) out.push(describe(l, tier, name), `model: ${model}`);
    else out.push(l);
  }
  if (!fm.some((l) => l.startsWith('description:'))) out.push(`model: ${model}`);
  return `---\n${out.join('\n')}\n---\n<!-- jdi:tier-variant of=${name} tier=${tier} -->\n${baseText.slice(m[0].length)}`;
}

// What should exist in the project's agent dir of `rt`: path -> content.
function expected(root, rt, models) {
  const want = new Map();
  for (const name of baseNames(root)) {
    const base = baseCopy(root, rt, name);
    if (!base) continue;
    for (const tier of TIER_NAMES.filter((t) => models[t])) {
      const text = render(base, rt, name, tier, models[tier]);
      if (text) want.set(path.join(root, RUNTIMES[rt].dir, RUNTIMES[rt].file(variantName(name, tier))), text);
    }
  }
  return want;
}

// Variants already there (recognized by their marker, never by name alone).
function present(root, rt) {
  const d = path.join(root, RUNTIMES[rt].dir);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.includes('--'))
    .map((f) => path.join(d, f))
    .filter((f) => MARK_RE.test(core.readIf(f) || ''));
}

// One copy that should exist: in sync, stale (--check) or written.
function syncCopy(root, file, text, opts, tally) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if ((core.readIf(file) || '').replaceAll('\r\n', '\n') === text) {
    tally.same++;
    if (opts.porcelain) tally.lines.push(rel);
    return;
  }
  if (opts.check) {
    tally.drift++;
    if (!opts.porcelain) tally.lines.push(`STALE   ${rel} (tier variant)`);
    return;
  }
  core.writeFileEnsured(file, text, root);
  tally.written++;
  tally.lines.push(opts.porcelain ? rel : `  ${rel}`);
}

// One copy that should not exist anymore: extra (--check) or removed.
function dropCopy(root, file, opts, tally) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (opts.check) {
    tally.drift++;
    if (!opts.porcelain) tally.lines.push(`EXTRA   ${rel} (tier no longer configured)`);
    return;
  }
  fs.rmSync(file, { force: true });
  tally.removed++;
  // porcelain feeds `git add`: a removed path stages its deletion
  tally.lines.push(opts.porcelain ? rel : `  removed ${rel}`);
}

function syncRuntime(root, rt, models, opts, tally) {
  const want = expected(root, rt, models);
  for (const [file, text] of want) syncCopy(root, file, text, opts, tally);
  for (const file of present(root, rt).filter((f) => !want.has(f))) dropCopy(root, file, opts, tally);
}

function sync(root, opts = {}) {
  const config = core.loadConfig(root);
  const on = config.routing?.mode === 'on';
  const tally = { written: 0, same: 0, drift: 0, removed: 0, lines: [] };
  for (const rt of Object.keys(RUNTIMES).filter((r) => !opts.runtime || opts.runtime === 'all' || opts.runtime === r)) {
    const models = (on && config.routing?.runtime_models?.[rt]) || {};
    syncRuntime(root, rt, models, opts, tally);
  }
  return tally;
}

// The variant `route` should name, if it exists for this runtime.
function variantFor(root, rt, name, tier) {
  const r = RUNTIMES[rt];
  if (!r || !name || !tier) return null;
  const file = path.join(root, r.dir, r.file(variantName(name, tier)));
  return MARK_RE.test(core.readIf(file) || '') ? variantName(name, tier) : null;
}

function main(argv) {
  const opts = { check: argv.includes('--check'), quiet: argv.includes('--quiet'), porcelain: argv.includes('--porcelain'), runtime: argv.find((a) => !a.startsWith('--')) || 'all' };
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, core.JDI_DIR))) return 0;
  const t = sync(root, opts);
  if (opts.porcelain) {
    if (t.lines.length) process.stdout.write(t.lines.join('\n') + '\n');
  } else if (!opts.quiet && (t.written || t.drift || t.removed)) {
    const fix = t.drift ? `, ${t.drift} to fix` : '';
    process.stdout.write([...t.lines, `tier variants: ${t.written} written, ${t.removed} removed, ${t.same} in sync` + fix].join('\n') + '\n');
  }
  return opts.check && t.drift ? 1 : 0;
}

module.exports = { main, sync, variantFor, render, RUNTIMES };

// also run by the installer, `update` and `doctor` scripts, right after the
// shell sync (they call it directly, not through `jdi sync-specialists`)
if (require.main === module) process.exitCode = main(process.argv.slice(2));
