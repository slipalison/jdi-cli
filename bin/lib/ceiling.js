'use strict';

// `jdi-cli ceiling <phase> [--start] [--json] [--claude-dir d]`
//
// The ceiling of an AUTONOMOUS run (/jdi-issue) on one phase (0.22). Without a
// human watching, a phase that does not converge keeps spawning agents; the
// loop's iteration fuse counts rounds, not what each round cost. Measured on a
// real project: phases took 3 to 40 subagent spawns and 8 to 45 million
// cache-weighted tokens — and one runaway took 172 million.
//
// config.json `orchestration.phase_ceiling` (each null = no limit):
//   spawns         subagents spawned for the phase in this run
//   hours          wall-clock hours since the run started
//   weighted_mtok  their tokens, cache-weighted (the unit of `cost`), millions
// `--start` records when the run began (.jdi/cache/ceiling/<slug>.json); the
// check counts only what happened after it. Spawns and tokens come from the
// Claude Code transcripts on this machine; `--runtime <rt>` other than
// claude counts hours only (those transcripts are not that runtime's).
// Exit 0 within, 3 over (the orchestrator stops with a HANDOFF).

const path = require('node:path');
const os = require('node:os');
const core = require('./jdi-core');
const cost = require('./cost');

const runFile = (root, phase) => path.join(root, core.JDI_DIR, 'cache', 'ceiling', `${phase.slug}.json`);

function start(root, phase, now = Date.now()) {
  const rec = { started: new Date(now).toISOString() };
  core.writeFileEnsured(runFile(root, phase), JSON.stringify(rec) + '\n', root);
  return rec;
}

function measure(root, phase, since, claudeProjects) {
  const { dirs, agents } = cost.loadAgents({ projectDir: root, claudeProjects, since: since || undefined });
  if (!dirs.length) return { spawns: null, weighted_mtok: null, first: null };
  const mine = agents.filter((a) => a.kind === 'subagent' && a.phase === phase.slug && (!since || (a.firstTs && a.firstTs >= since)));
  const units = mine.reduce((n, a) => n + (a.total.weighted || 0), 0);
  const first = mine.map((a) => a.firstTs).filter(Boolean).sort(core.compareStr)[0] || null;
  return { spawns: mine.length, weighted_mtok: Math.round(units / 1e5) / 10, first };
}

// Since the run's `--start`; without one (a run started by hand), since the
// phase's first agent — a squash-merged history has no earlier commit to use.
function check(root, phase, { claudeProjects, now = Date.now(), runtime = null } = {}) {
  const limits = core.loadConfig(root).orchestration?.phase_ceiling || {};
  const run = core.readJson(runFile(root, phase), null)?.started || null;
  const other = runtime && runtime !== 'claude';
  const { first, ...used } = other ? { spawns: null, weighted_mtok: null, first: null } : measure(root, phase, run, claudeProjects);
  const since = run || first;
  used.hours = since ? Math.round((now - Date.parse(since)) / 360000) / 10 : 0;
  const over = ['spawns', 'hours', 'weighted_mtok'].filter((k) => limits[k] != null && used[k] != null && used[k] > limits[k]);
  let from = 'nothing yet';
  if (run) from = 'run';
  else if (first) from = 'first agent of the phase';
  return { phase: phase.slug, status: over.length ? 'over' : 'within', since, since_from: from, used, limits, over };
}

function render(r) {
  const part = (k, unit) => {
    const v = r.used[k] == null ? '?' : r.used[k];
    return `${v}${r.limits[k] == null ? '' : '/' + r.limits[k]}${unit}`;
  };
  const head = r.over.length ? `over (${r.over.join(', ')})` : 'within';
  return `${head} — ${part('spawns', ' spawns')}, ${part('hours', ' h')}, ${part('weighted_mtok', 'M tokens')} since ${r.since || '-'} (${r.since_from})`;
}

function main(argv) {
  const id = argv.find((a, i) => !a.startsWith('--') && !['--claude-dir', '--runtime'].includes(argv[i - 1]));
  if (!id) throw new core.JdiError('usage: jdi ceiling <phase> [--start] [--json]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  if (argv.includes('--start')) {
    const rec = start(root, phase);
    process.stdout.write(`ceiling: run of ${phase.slug} started at ${rec.started}\n`);
    return 0;
  }
  const i = argv.indexOf('--claude-dir');
  const rt = argv.includes('--runtime') ? argv[argv.indexOf('--runtime') + 1] : null;
  const r = check(root, phase, { claudeProjects: i === -1 ? path.join(os.homedir(), '.claude', 'projects') : argv[i + 1], runtime: rt });
  process.stdout.write((argv.includes('--json') ? JSON.stringify(r) : render(r)) + '\n');
  return r.over.length ? 3 : 0;
}

module.exports = { main, check, start };
