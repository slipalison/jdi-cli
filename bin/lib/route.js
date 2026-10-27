'use strict';

// `jdi-cli route <phase> --role <role> [--task T-N] [--attempt N] [--json]`
//
// Which model and reasoning effort an agent gets, decided by a rule, not by
// the orchestrator's judgment of the moment (0.21). The answer is
// `{ role, task, tier, model, effort, why }`; the commands pass `model` and
// `effort` to the spawn (Claude Code takes both per call; runtimes that fix
// the model in the agent definition ignore them).
//
// config.json `routing`:
//   mode       "on" | "off". off (the default for projects created before
//              0.21) keeps `models.<role>` as before.
//   profile    the active profile; `profiles.<name>.tiers` overrides `tiers`
//   tiers      cheap / standard / strong -> { model, effort }
//   rules      first match wins: { role, if: [conditions], tier }. Conditions
//              of a task: light, standard, deep (its `Weight:`), kind:<k>
//              (its `Kind:`), sensitive (a file in sizing.sensitive_globs);
//              without --task (lite doer, reviewer, critic): the heaviest
//              task's weight, sensitive = any task
//   floors     the lowest tier a role may get (reviewer, critic: standard —
//              cheap models miss real defects)
//   escalate   true: attempt N (a fix after a red gate or a BLOCKED doer)
//              goes N-1 tiers up, to strong at most — on a measured failure,
//              never on an agent's own claim
//   quota_aware  (0.22, default true) while `jdi-cli quota` says `tight`
//              (cached, at most 15 min old): a doer task that is neither deep
//              nor sensitive, on its first attempt, goes one tier down
//   adapt      (0.22) { mode: "off" | "on", min_samples, raise_below,
//              lower_above } — learn from this project's own history: every
//              decision goes to the route log (<git common dir>/jdi/
//              route-log.jsonl: shared by every worktree of the clone, kept
//              when one is removed). A doer decision counts once its phase
//              has an outcome — a reviewer was routed (the gates were green)
//              or a fix was — and passed the first time when no fix (attempt
//              >= 2) of its phase names its task or no task: a fix that names
//              no task counts against every task of the phase (conservative —
//              it can only keep a tier up). With min_samples
//              of a weight on a tier: below raise_below -> one tier up; at or
//              above lower_above, and the tier below not known to fail ->
//              one tier down (never for deep or sensitive work)
//   runtime_models  (0.22) { copilot: { cheap, standard, strong }, opencode:
//              {...} } — each runtime's model id per tier. Those runtimes fix
//              the model in the agent file, so `sync-specialists` writes a
//              copy of each agent per configured tier (`<agent>--<tier>`, see
//              tiers.js) and `--runtime <rt> --agent <name>` answers `agent`:
//              the variant to spawn (the agent itself when the tier has no
//              variant — the runtime's own model). Effort: Claude Code only.
// No rule matches -> standard. Order: rule, adapt, quota, attempt, floor.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const brief = require('./brief');
const quota = require('./quota');
const tiers = require('./tiers');

const TIERS = ['cheap', 'standard', 'strong'];

function tierRank(t) {
  const i = TIERS.indexOf(t);
  return i === -1 ? 1 : i;
}

function tasksOf(phase) {
  const plan = core.readIf(path.join(phase.absDir, 'PLAN.md'));
  return plan ? brief.parseTasks(plan) : [];
}

const WEIGHTS = ['light', 'standard', 'deep'];

// The conditions that hold for this role (and task). Without a task (a lite
// doer running them all, a reviewer, the critic) the phase counts: its
// heaviest task, sensitive when any task is.
function conditionsOf(task, tasks, sensitiveGlobs) {
  const sensitive = (files) => files.some((f) => core.matchesAny(f, sensitiveGlobs));
  const weightOf = (t) => t.weight || 'standard';
  const conds = new Set();
  if (task) {
    conds.add(weightOf(task));
    if (task.kind) conds.add(`kind:${task.kind}`);
    if (sensitive(task.files)) conds.add('sensitive');
    return conds;
  }
  if (tasks.length) conds.add(WEIGHTS[Math.max(...tasks.map((t) => WEIGHTS.indexOf(weightOf(t))))]);
  if (tasks.some((t) => sensitive(t.files))) conds.add('sensitive');
  return conds;
}

function pickRule(rules, role, conds) {
  return (rules || []).find((r) => r.role === role && [r.if || []].flat().every((c) => (c.startsWith('not ') ? !conds.has(c.slice(4)) : conds.has(c))));
}

function resolveTier(cfg, tier) {
  const base = cfg.tiers?.[tier] || {};
  const over = cfg.profiles?.[cfg.profile]?.tiers?.[tier] || {};
  return { model: over.model ?? base.model ?? null, effort: over.effort ?? base.effort ?? null };
}

// Routing off: the fixed model of the role, no effort (before 0.21).
function fixedModel(config, role, taskId) {
  const m = config.models?.[role] || 'inherit';
  return { role, task: taskId, tier: null, model: m === 'inherit' ? null : m, effort: null, why: `routing off — models.${role}: ${m}` };
}

function ruleText(rule, role) {
  if (!rule) return `no rule for ${role} -> standard`;
  const cond = rule.if ? ` if ${[rule.if].flat().join('+')}` : '';
  return `rule ${role}${cond} -> ${rule.tier}`;
}

// In the clone's common git dir: every worktree of it (one per session, one
// per wave task) writes to the same history, which outlives them.
function logFile(root) {
  const r = core.git(['rev-parse', '--git-common-dir'], root);
  if (r.code === 0 && r.stdout) return path.join(path.resolve(root, r.stdout), 'jdi', 'route-log.jsonl');
  return path.join(root, core.JDI_DIR, 'cache', 'route-log.jsonl');
}
const weightOf = (conds) => WEIGHTS.find((w) => conds.has(w)) || 'standard';
const pct = (x) => `${Math.round(100 * x)}%`;

const BURST_MS = 10 * 60 * 1000;

// This project's place in the clone: several JDI projects can share one repo.
function projectKey(root) {
  const top = core.git(['rev-parse', '--show-toplevel'], root).stdout;
  return top ? path.relative(top, root).split(path.sep).join('/') : '';
}

function readLog(root) {
  const text = core.readIf(logFile(root)) || '';
  const project = projectKey(root);
  const entries = [];
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line);
      if ((e.project || '') === project) entries.push(e);
    } catch {
      // a torn line
    }
  }
  entries.sort((a, b) => core.compareStr(a.at, b.at));
  // the same spawn asked twice within minutes is one decision (the last
  // answer); asked again later, it is a new one
  const out = [];
  const lastOf = new Map();
  for (const e of entries) {
    const k = `${e.phase}|${e.role}|${e.task}|${e.attempt}`;
    const prev = lastOf.get(k);
    if (prev !== undefined && Date.parse(e.at) - Date.parse(out[prev].at) < BURST_MS) out[prev] = e;
    else {
      lastOf.set(k, out.length);
      out.push(e);
    }
  }
  return out;
}

// First-time pass rate of doer decisions, by `weight|tier` — only decisions
// whose phase has an outcome since (a reviewer routed, or a fix).
function doerStats(entries) {
  const fixes = entries.filter((e) => e.role === 'doer' && e.attempt > 1);
  const outcomes = entries.filter((e) => e.role === 'reviewer' || (e.role === 'doer' && e.attempt > 1));
  const stats = new Map();
  for (const e of entries.filter((x) => x.role === 'doer' && x.attempt === 1 && x.tier)) {
    if (!outcomes.some((o) => o.phase === e.phase && o.at > e.at)) continue; // not measured yet
    // a fix naming no task fails every task of the phase; a lite decision
    // (no task) fails with any fix of its phase
    const failed = fixes.some((f) => f.phase === e.phase && f.at > e.at && (f.task === e.task || f.task == null || e.task == null));
    const k = `${e.weight}|${e.tier}`;
    const s = stats.get(k) || { n: 0, pass: 0 };
    s.n += 1;
    s.pass += failed ? 0 : 1;
    stats.set(k, s);
  }
  return stats;
}

function adapt(cfg, ctx, rank, why) {
  const a = cfg.adapt || {};
  if (a.mode !== 'on' || ctx.role !== 'doer' || ctx.conds.has('sensitive')) return rank;
  const weight = weightOf(ctx.conds);
  const stats = doerStats(readLog(ctx.root));
  const known = (r) => {
    const s = stats.get(`${weight}|${TIERS[r]}`);
    return s && s.n >= (a.min_samples ?? 8) ? { ...s, rate: s.pass / s.n } : null;
  };
  const raise = a.raise_below ?? 0.7;
  const here = known(rank);
  if (here && here.rate < raise && rank < TIERS.length - 1) {
    why.push(`adapt: ${weight} work on ${TIERS[rank]} passed first time ${here.pass}/${here.n} (< ${pct(raise)}) -> ${TIERS[rank + 1]}`);
    return rank + 1;
  }
  const below = rank > 0 ? known(rank - 1) : null;
  if (here && weight !== 'deep' && rank > 0 && here.rate >= (a.lower_above ?? 0.95) && !(below && below.rate < raise)) {
    why.push(`adapt: ${weight} work on ${TIERS[rank]} passed first time ${here.pass}/${here.n} -> trying ${TIERS[rank - 1]}`);
    return rank - 1;
  }
  return rank;
}

// `quota tight`: lighter doer work, first attempt, one tier down. Claude Code
// only: the quota sources are Claude Code's (another runtime's account is
// not the one measured).
function quotaDown(cfg, ctx, rank, why) {
  if (cfg.quota_aware === false || ctx.role !== 'doer' || ctx.attempt > 1 || rank === 0) return rank;
  if (ctx.runtime && ctx.runtime !== 'claude') return rank;
  if (ctx.conds.has('deep') || ctx.conds.has('sensitive')) return rank;
  const q = quota.cached(ctx.root);
  if (q?.verdict !== 'tight') return rank;
  why.push(`quota tight (${q.why}) -> ${TIERS[rank - 1]}`);
  return rank - 1;
}

// The rule's tier, raised by the attempt (escalation) and by the role's floor.
function adjustRank(cfg, role, rank, attempt, why) {
  let r = rank;
  if (cfg.escalate !== false && attempt > 1) {
    const up = Math.min(TIERS.length - 1, r + attempt - 1);
    if (up > r) why.push(`attempt ${attempt} -> ${TIERS[up]} (escalation on a failed check)`);
    r = up;
  }
  const floor = cfg.floors?.[role];
  if (floor && tierRank(floor) > r) {
    r = tierRank(floor);
    why.push(`floor ${role} -> ${floor}`);
  }
  return r;
}

// Routing off: the fixed model of the role — on Copilot/OpenCode, the agent
// itself with its own model.
function offRoute(config, role, taskId, runtime, agent) {
  const r = fixedModel(config, role, taskId);
  return runtime && runtime !== 'claude' ? { ...r, runtime, agent: agent || null, model: null } : r;
}

// Copilot / OpenCode: which agent carries the tier's model.
function forRuntime(cfg, r, runtime, agent, root) {
  if (!runtime || runtime === 'claude' || !tiers.RUNTIMES[runtime]) return r;
  const variant = tiers.variantFor(root, runtime, agent, r.tier);
  const model = variant ? cfg.runtime_models?.[runtime]?.[r.tier] || null : null;
  const why = variant ? `${runtime}: spawn ${variant} (${model})` : `${runtime}: no ${r.tier} variant of ${agent || 'the agent'} — spawn it as is (the runtime's model)`;
  return { ...r, runtime, agent: variant || agent || null, model, effort: null, why: `${r.why}; ${why}` };
}

function route(phase, { role, task: taskId = null, attempt = 1, runtime = null, agent = null }, root = process.cwd()) {
  const config = core.loadConfig(root);
  const cfg = config.routing || {};
  if (cfg.mode !== 'on') return offRoute(config, role, taskId, runtime, agent);
  const tasks = tasksOf(phase);
  const task = taskId ? tasks.find((t) => t.id === taskId) : null;
  if (taskId && !task) throw new core.JdiError(`no task ${taskId} in ${phase.dir}/PLAN.md`, 2);
  const conds = conditionsOf(task, tasks, config.sizing?.sensitive_globs || []);
  const rule = pickRule(cfg.rules, role, conds);
  const why = [ruleText(rule, role)];
  const ctx = { root, role, conds, attempt, runtime };
  const learned = quotaDown(cfg, ctx, adapt(cfg, ctx, tierRank(rule?.tier || 'standard'), why), why);
  const tier = TIERS[adjustRank(cfg, role, learned, attempt, why)];
  const { model, effort } = resolveTier(cfg, tier);
  if (!model) why.push(`tier ${tier} has no model — the session's model is used`);
  const r = { role, task: taskId, tier, model, effort, profile: cfg.profile || null, conditions: [...conds], why: why.join('; ') };
  return forRuntime(cfg, r, runtime, agent, root);
}

// Every answer, for `adapt` and `cost --by-model`.
function log(root, phase, r, attempt) {
  const entry = { at: new Date().toISOString(), project: projectKey(root), phase: phase.slug, role: r.role, task: r.task, attempt, weight: weightOf(new Set(r.conditions)), tier: r.tier, model: r.model, effort: r.effort, ...(r.runtime && { runtime: r.runtime, agent: r.agent }) };
  const line = JSON.stringify(entry) + '\n';
  try {
    const f = logFile(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, line);
    if (f.startsWith(path.join(root, core.JDI_DIR))) core.ensureCacheIgnored(root);
  } catch {
    // the log is a convenience: a route answer never fails on it
  }
}

function main(argv) {
  const [id, ...rest] = argv.filter((a, i) => !a.startsWith('--') && !['--role', '--task', '--attempt', '--runtime', '--agent'].includes(argv[i - 1]));
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (!id || rest.length || !opt('--role')) throw new core.JdiError('usage: jdi route <phase> --role <doer|reviewer|critic|planner|asker> [--task T-N] [--attempt N] [--runtime <rt> --agent <name>] [--json]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  const r = route(phase, { role: opt('--role'), task: opt('--task') || null, attempt: Number(opt('--attempt') || 1), runtime: opt('--runtime') || null, agent: opt('--agent') || null }, root);
  if (r.tier) log(root, phase, r, Number(opt('--attempt') || 1));
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r) + '\n');
  else process.stdout.write(`${r.agent ? r.agent + ' ' : ''}${r.model || 'inherit'} ${r.effort || '-'} — ${r.tier || 'off'}: ${r.why}\n`);
  return 0;
}

module.exports = { main, route, readLog, doerStats, logFile, TIERS };
