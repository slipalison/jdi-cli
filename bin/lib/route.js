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
// No rule matches -> standard.

const path = require('node:path');
const core = require('./jdi-core');
const brief = require('./brief');

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

function route(phase, { role, task: taskId = null, attempt = 1 }, root = process.cwd()) {
  const config = core.loadConfig(root);
  const cfg = config.routing || {};
  if (cfg.mode !== 'on') return fixedModel(config, role, taskId);
  const tasks = tasksOf(phase);
  const task = taskId ? tasks.find((t) => t.id === taskId) : null;
  if (taskId && !task) throw new core.JdiError(`no task ${taskId} in ${phase.dir}/PLAN.md`, 2);
  const conds = conditionsOf(task, tasks, config.sizing?.sensitive_globs || []);
  const rule = pickRule(cfg.rules, role, conds);
  const why = [ruleText(rule, role)];
  const tier = TIERS[adjustRank(cfg, role, tierRank(rule?.tier || 'standard'), attempt, why)];
  const { model, effort } = resolveTier(cfg, tier);
  if (!model) why.push(`tier ${tier} has no model — the session's model is used`);
  return { role, task: taskId, tier, model, effort, profile: cfg.profile || null, conditions: [...conds], why: why.join('; ') };
}

function main(argv) {
  const [id, ...rest] = argv.filter((a, i) => !a.startsWith('--') && !['--role', '--task', '--attempt'].includes(argv[i - 1]));
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (!id || rest.length || !opt('--role')) throw new core.JdiError('usage: jdi route <phase> --role <doer|reviewer|critic|planner|asker> [--task T-N] [--attempt N] [--json]', 1);
  const root = process.cwd();
  const r = route(core.resolvePhase(id, root), { role: opt('--role'), task: opt('--task') || null, attempt: Number(opt('--attempt') || 1) }, root);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r) + '\n');
  else process.stdout.write(`${r.model || 'inherit'} ${r.effort || '-'} — ${r.tier || 'off'}: ${r.why}\n`);
  return 0;
}

module.exports = { main, route, TIERS };
