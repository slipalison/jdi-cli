'use strict';

// `jdi-cli cost --by-model [--json]` — what each model did for each role, and
// how often the routed work passed the first time (0.22). Read-only.
//
//   by role x model   from the Claude Code transcripts: subagents spawned,
//                     cache-weighted tokens, agent hours (an agent counts for
//                     the model of most of its calls)
//   by weight x tier  from `route`'s own log: doer decisions whose phase has
//                     an outcome, and the share that needed no fix — a
//                     decision fails when a later fix of the same phase
//                     (attempt >= 2) names its task, or no task
// The second table is what `routing.adapt` acts on; read it before turning
// adapt on, or to choose `rules` by hand.

const route = require('./route');

const HOUR = 3600 * 1000;

function dominantModel(calls) {
  const n = new Map();
  for (const c of calls) if (c.model && c.model !== '<synthetic>') n.set(c.model, (n.get(c.model) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
}

function byModel(agents, routeEntries) {
  const rows = new Map();
  for (const a of agents.filter((x) => x.kind === 'subagent')) {
    const model = dominantModel(a.calls);
    const k = `${a.role}|${model}`;
    const r = rows.get(k) || { role: a.role, model, spawns: 0, units: 0, ms: 0 };
    r.spawns += 1;
    r.units += a.total.weighted || 0;
    // the calls are already cut to the --since/--until range
    const first = a.calls[0]?.ts;
    const last = a.calls.at(-1)?.ts;
    r.ms += first && last ? Date.parse(last) - Date.parse(first) : 0;
    rows.set(k, r);
  }
  const models = [...rows.values()]
    .map((r) => ({ role: r.role, model: r.model, spawns: r.spawns, weighted_mtok: Math.round(r.units / 1e5) / 10, hours: Math.round(r.ms / (HOUR / 10)) / 10 }))
    .sort((a, b) => a.role.localeCompare(b.role) || b.spawns - a.spawns);
  const routes = [...route.doerStats(routeEntries).entries()]
    .map(([k, s]) => {
      const [weight, tier] = k.split('|');
      return { weight, tier, decisions: s.n, first_time: s.pass, rate: Math.round((100 * s.pass) / s.n) };
    })
    .sort((a, b) => a.weight.localeCompare(b.weight) || route.TIERS.indexOf(a.tier) - route.TIERS.indexOf(b.tier));
  return { models, routes };
}

function render(r) {
  const lines = ['By role x model (subagents, from the transcripts)'];
  if (!r.models.length) lines.push('  (no subagent in the transcripts)');
  const rw = Math.max(9, ...r.models.map((m) => m.role.length));
  const mw = Math.max(9, ...r.models.map((m) => m.model.length));
  for (const m of r.models) lines.push(`  ${m.role.padEnd(rw)} ${m.model.padEnd(mw)} ${String(m.spawns).padStart(4)} spawns · ${m.weighted_mtok}M tokens · ${m.hours} agent h · ${m.spawns ? Math.round((10 * m.weighted_mtok) / m.spawns) / 10 : 0}M per spawn`);
  lines.push('', 'Doer work by weight x tier (route log): passed the first time');
  if (!r.routes.length) lines.push('  (no route decisions yet — routing.mode "on" logs them)');
  for (const x of r.routes) lines.push(`  ${x.weight.padEnd(9)} ${x.tier.padEnd(9)} ${x.first_time}/${x.decisions} (${x.rate}%)`);
  return lines.join('\n');
}

module.exports = { byModel, render, dominantModel };
