'use strict';

// `jdi-cli cost --timeline` — where a phase's CLOCK went, from the Claude Code
// transcripts on this machine (the same ones `cost` reads for tokens).
//
// Measured on a real project: the model was 22% of a phase's critical path;
// heavy commands (suites, E2E, builds, the local CI) were 61%, and agents spent
// hours blocked in polling loops. Without this view every speed change is a
// guess; with it, a release proves (or not) that phases got shorter.
//
// Agent time per category (hours summed over agents — parallel agents add up):
//   model      gaps between an event and the agent's next model call (capped:
//              a longer gap is `idle`)
//   commands   foreground Bash time, by kind: tests/build, e2e, gates,
//              local-ci, polling (sleep/until/watch/pgrep/tail -f), other
//   subagents  an orchestrator waiting on an Agent/Task call (parallel calls
//              of one agent count once)
//   background an agent idle until a background task's notification
//   tools      every other tool
//   human      an orchestrator waiting for the user's next prompt
// Per phase: the subagents attributed to it (phase_slug in their prompt), with
// their span and the same split. Waste: foreground commands that hit the
// 10-minute tool limit, polling loops, `pgrep -f` waits (they match their own
// command line and never end).
//
// Privacy: numbers, roles, phase slugs and the first 80 characters of the
// longest commands — never message content.

const MODEL_GAP_MAX_MS = 10 * 60 * 1000;
const TOOL_LIMIT_MS = 590 * 1000;
const HOUR = 3600 * 1000;

const KINDS = [
  { kind: 'polling', re: /\b(sleep|until|watch|pgrep)\b|\btail\s+(-f|--pid)/ },
  { kind: 'local-ci', re: /\bvalidar-local\b|\bact\s+(pull_request|push|-W)/ },
  { kind: 'e2e', re: /\bplaywright\b|\bcypress\b|\bnpm run e2e\b|\be2e\b/ },
  { kind: 'gates', re: /\bgates\s+run\b/ },
];

function commandKind(cmd, isGateCommand) {
  const hit = KINDS.find((x) => x.re.test(cmd));
  if (hit) return hit.kind;
  return isGateCommand(cmd) ? 'tests-build' : 'other';
}

const ms = (a, b) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : 0);

function emptySplit() {
  return { model: 0, 'tests-build': 0, e2e: 0, gates: 0, 'local-ci': 0, polling: 0, other: 0, subagents: 0, background: 0, tools: 0, human: 0, idle: 0 };
}

// One agent's time, split by category (ms), plus the waste it shows.
// A foreground command: its kind's time, and the waste it shows.
function commandTime(cmd, d, split, waste, isGateCommand) {
  const kind = commandKind(cmd, isGateCommand);
  split[kind] += d;
  if (kind === 'polling') waste.pollCalls++;
  if (/\bpgrep\s+-f\b/.test(cmd)) waste.pgrepWaits++;
  if (d >= TOOL_LIMIT_MS) waste.limitHits.push({ minutes: Math.round(d / 60000), command: cmd.replaceAll(/\s+/g, ' ').slice(0, 80) });
}

// Time covered by intervals that may overlap (three Agent calls in one
// message: the orchestrator waits once, not three times).
function covered(spans) {
  let total = 0;
  let end = -Infinity;
  for (const [s, e] of spans.sort((x, y) => x[0] - y[0])) {
    if (e <= end) continue;
    total += e - Math.max(s, end);
    end = e;
  }
  return total;
}

function agentSplit(a, isGateCommand, inRange) {
  const split = emptySplit();
  const waste = { limitHits: [], pollCalls: 0, pgrepWaits: 0 };
  const spans = { subagents: [], tools: [] };
  for (const tu of a.toolUses.values()) {
    if (!inRange(tu.startTs) || !tu.endTs) continue;
    const span = [Date.parse(tu.startTs), Math.max(Date.parse(tu.startTs), Date.parse(tu.endTs))];
    if (tu.name === 'Agent' || tu.name === 'Task') spans.subagents.push(span);
    else if (tu.name !== 'Bash') spans.tools.push(span);
    // a background run returns at once; its run is not this agent's time
    else if (!tu.input.run_in_background) commandTime(String(tu.input.command || ''), span[1] - span[0], split, waste, isGateCommand);
  }
  split.subagents = covered(spans.subagents);
  split.tools = covered(spans.tools);
  modelAndWaits(a, split, inRange);
  return { split, waste };
}

// Gaps on the agent's own timeline: before a model call = the model working
// (or idle, when too long); before a user prompt = waiting on the human;
// before a task notification = waiting on a background run.
function modelAndWaits(a, split, inRange) {
  const events = [
    ...a.calls.map((c) => ({ t: c.ts, k: 'call' })),
    ...[...a.toolUses.values()].filter((tu) => tu.endTs).map((tu) => ({ t: tu.endTs, k: 'end' })),
    ...a.prompts.map((t) => ({ t, k: 'prompt' })),
    ...(a.notifications || []).map((t) => ({ t, k: 'notify' })),
  ]
    .filter((e) => e.t && inRange(e.t))
    // same instant: the tool's end comes before the call it fed
    .sort((x, y) => Date.parse(x.t) - Date.parse(y.t) || Number(x.k === 'call') - Number(y.k === 'call'));
  for (let i = 1; i < events.length; i++) {
    const gap = ms(events[i - 1].t, events[i].t);
    if (events[i].k === 'prompt') split.human += gap;
    else if (events[i].k === 'notify') split.background += gap;
    else if (events[i].k === 'call') {
      if (gap > MODEL_GAP_MAX_MS) split.idle += gap;
      else split.model += gap;
    }
  }
}

function addSplit(acc, s) {
  for (const k of Object.keys(s)) acc[k] = (acc[k] || 0) + s[k];
}

function timeline(agents, isGateCommand, inRange = () => true) {
  const total = emptySplit();
  const byPhase = {};
  const waste = { limitHits: [], pollCalls: 0, pgrepWaits: 0 };
  for (const a of agents) {
    const r = agentSplit(a, isGateCommand, inRange);
    addSplit(total, r.split);
    waste.limitHits.push(...r.waste.limitHits);
    waste.pollCalls += r.waste.pollCalls;
    waste.pgrepWaits += r.waste.pgrepWaits;
    if (a.kind !== 'subagent' || !a.phase) continue;
    const p = (byPhase[a.phase] ||= { split: emptySplit(), first: null, last: null, roles: {} });
    addSplit(p.split, r.split);
    if (!p.first || a.firstTs < p.first) p.first = a.firstTs;
    if (!p.last || a.lastTs > p.last) p.last = a.lastTs;
    p.roles[a.role] = (p.roles[a.role] || 0) + 1;
  }
  waste.limitHits.sort((x, y) => y.minutes - x.minutes);
  return { total, byPhase, waste };
}

const h = (v) => (v / HOUR).toFixed(1);
const pct = (v, d) => (d ? `${Math.round((100 * v) / d)}%` : '-');
const COMMAND_KINDS = ['tests-build', 'e2e', 'gates', 'local-ci', 'other'];

function sumOf(s, keys) {
  return keys.reduce((n, k) => n + (s[k] || 0), 0);
}

function render(tl) {
  const t = tl.total;
  const work = sumOf(t, ['model', ...COMMAND_KINDS, 'polling', 'subagents', 'background', 'tools']);
  const cmds = sumOf(t, COMMAND_KINDS);
  const lines = [
    'Timeline — agent hours (parallel agents add up)',
    `  model ${h(t.model)} h (${pct(t.model, work)}) · commands ${h(cmds)} h (${pct(cmds, work)}): tests/build ${h(t['tests-build'])}, e2e ${h(t.e2e)}, gates ${h(t.gates)}, local CI ${h(t['local-ci'])}, other ${h(t.other)}`,
    `  polling ${h(t.polling)} h (${pct(t.polling, work)}) · waiting on subagents ${h(t.subagents)} h · on background runs ${h(t.background)} h · other tools ${h(t.tools)} h · waiting on you ${h(t.human)} h · idle gaps ${h(t.idle)} h`,
    `  waste: ${tl.waste.limitHits.length} foreground command(s) hit the 10-min tool limit · ${tl.waste.pollCalls} polling call(s) · ${tl.waste.pgrepWaits} \`pgrep -f\` wait(s)`,
  ];
  for (const x of tl.waste.limitHits.slice(0, 5)) lines.push(`    ${x.minutes} min — ${x.command}`);
  const phases = Object.entries(tl.byPhase).sort((a, b) => (b[1].last || '').localeCompare(a[1].last || ''));
  if (phases.length) {
    lines.push('', 'Per phase (its subagents): span · model · commands · polling · agents');
    for (const [slug, p] of phases.slice(0, 15)) {
      const roles = Object.entries(p.roles).map(([r, n]) => `${r} ${n}`).join(', ');
      lines.push(`  ${slug}: ${h(ms(p.first, p.last))} h · model ${h(p.split.model)} h · commands ${h(sumOf(p.split, COMMAND_KINDS))} h · polling ${h(p.split.polling)} h · ${roles}`);
    }
  }
  return lines.join('\n');
}

module.exports = { timeline, render, commandKind };
