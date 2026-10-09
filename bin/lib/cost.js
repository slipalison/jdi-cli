'use strict';

// cost.js — `jdi-cli cost`: where a JDI project's tokens went, measured from
// the Claude Code session transcripts stored on THIS machine
// (~/.claude/projects/<encoded project path>/).
//
// Privacy: transcripts are read locally and only aggregated. The report holds
// numbers, agent types, phase slugs and file paths — never message content.
//
// Weighted tokens = Anthropic list-price ratios relative to base input:
// input 1x, cache read 0.1x, cache write 1.25x (5 min) or 2x (1 h), output 5x.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./jdi-core');

const WEIGHT = { in: 1, cr: 0.1, cc5m: 1.25, cc1h: 2, out: 5 };
const MISS_MIN_CTX = 50000;
const GATE_CMD_RE = /\b(gates run|cargo (test|build|check|clippy|llvm-cov|nextest)|npm (run|test|ci)|pnpm|yarn|vitest|jest|pytest|go (test|build)|dotnet (test|build)|mvn|gradle|playwright|tsc|eslint|ruff|make)\b/;
const ARTIFACT_RE = /\.jdi\/phases\/([a-z0-9][a-z0-9-]*)\/(CONTEXT|PLAN|SUMMARY|REVIEW[A-Za-z0-9._-]*|LOOP|HANDOFF)\.md/g;
const SHELL_READ_RE = /\b(cat|sed|head|tail|less|more|nl|awk)\b/;

// Defaults of the token-economy plan; override in config.json economy.targets.
const DEFAULT_TARGETS = {
  critic_share_max: 0.08,
  critic_spawn_ctx_max: 150000,
  critic_spawn_calls_max: 60,
  first_action_ctx_max: { doer: 100000, reviewer: 100000, planner: 130000, asker: 130000 },
  long_command_rewrite_share_max: 0.01,
  main_avg_ctx_max: 250000,
  instruction_rereads_max: 0,
  duplicate_instruction_loads_max: 0,
  cross_phase_reads_max: 0,
  known_errors_full_reads_max: 0,
};

function encodeProjectPath(p) {
  return path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

function sessionDirs(claudeProjects, projectDir, siblings = true) {
  const enc = encodeProjectPath(projectDir);
  if (!fs.existsSync(claudeProjects)) return [];
  return fs
    .readdirSync(claudeProjects)
    .filter((d) => d === enc || (siblings && d.startsWith(enc + '-')))
    .map((d) => path.join(claudeProjects, d))
    .filter((d) => fs.statSync(d).isDirectory());
}

function readJsonl(file) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // truncated line (session still being written) — skip
    }
  }
  return out;
}

function usageOf(u) {
  const cc = u.cache_creation_input_tokens || 0;
  const split = u.cache_creation || {};
  let cc1h = split.ephemeral_1h_input_tokens || 0;
  let cc5m = split.ephemeral_5m_input_tokens || 0;
  if (cc1h + cc5m === 0) cc5m = cc; // older transcripts: no TTL split
  return {
    in: u.input_tokens || 0,
    cr: u.cache_read_input_tokens || 0,
    cc,
    cc1h,
    cc5m,
    out: u.output_tokens || 0,
  };
}

function weighted(u) {
  return u.in * WEIGHT.in + u.cr * WEIGHT.cr + u.cc5m * WEIGHT.cc5m + u.cc1h * WEIGHT.cc1h + u.out * WEIGHT.out;
}

function addUsage(acc, u) {
  for (const k of ['in', 'cr', 'cc', 'cc1h', 'cc5m', 'out']) acc[k] = (acc[k] || 0) + u[k];
  acc.weighted = (acc.weighted || 0) + weighted(u);
  return acc;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join(' ');
}

function resultSize(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c?.type === 'text') n += (c.text || '').length;
  }
  return n;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Key that identifies "the same instruction file" across checkouts/worktrees.
function instructionKey(p) {
  const f = String(p).replace(/\\/g, '/');
  const rule = /\.claude\/rules\/(.+)$/.exec(f);
  if (rule) return `.claude/rules/${rule[1]}`;
  if (/(^|\/)CLAUDE\.md$/.test(f)) {
    return f.includes('/.claude/CLAUDE.md') ? '~/.claude/CLAUDE.md' : 'CLAUDE.md';
  }
  if (/(^|\/)AGENTS\.md$/.test(f)) return 'AGENTS.md';
  return null;
}

function roleOf(agentType, prompt, desc) {
  const t = agentType || 'unknown';
  const head = `${desc || ''} ${(prompt || '').slice(0, 400)}`;
  const mode = /mode=([a-z_-]+)/.exec(prompt || '')?.[1];
  if (t === 'jdi-dod-critic') return /preflight/i.test(head) ? 'critic-preflight' : 'critic';
  if (t.startsWith('jdi-reviewer')) {
    if (/preflight/i.test(head)) return 'critic-preflight';
    if (mode === 'dod-critic' || /critic|cr[ií]tico/i.test(desc || '')) return 'critic';
    return 'reviewer';
  }
  if (t.startsWith('jdi-doer')) return mode === 'fix_blockers' || /\bfix\b|corre[cç][aã]o/i.test(desc || '') ? 'doer-fix' : 'doer';
  if (t === 'jdi-asker') return 'asker';
  if (t === 'jdi-planner') return 'planner';
  return t;
}

function phaseOf(prompt, desc, slugs) {
  const text = prompt || '';
  const explicit = /phase_slug=([a-z0-9][a-z0-9-]*)/.exec(text);
  if (explicit) return explicit[1];
  const pathRef = /\.jdi\/phases\/([a-z0-9][a-z0-9-]*)\//.exec(text);
  if (pathRef) return pathRef[1].replace(/^\d+-/, '');
  const hay = `${desc || ''}\n${text}`;
  let best = null;
  for (const s of slugs) {
    const i = hay.indexOf(s);
    if (i === -1) continue;
    if (!best || i < best.i || (i === best.i && s.length > best.s.length)) best = { s, i };
  }
  return best ? best.s : null;
}

// Slugs mentioned by the transcripts themselves (a phase may exist only on a
// branch that this checkout has not pulled yet).
function slugsFromPrompts(agents) {
  const set = new Set();
  for (const a of agents) {
    const t = a.prompt || '';
    for (const m of t.matchAll(/phase_slug=([a-z0-9][a-z0-9-]*)/g)) set.add(m[1]);
    for (const m of t.matchAll(/\.jdi\/phases\/([a-z0-9][a-z0-9-]*)\//g)) set.add(m[1].replace(/^\d+-/, ''));
  }
  return set;
}

// --------------------------------------------------------------------------
// Transcript -> agent records
// --------------------------------------------------------------------------

function parseAgent(records, kind) {
  const agent = {
    kind,
    calls: [],
    seenMsg: new Set(),
    prompt: null,
    resumes: 0,
    branches: new Set(),
    instructions: new Map(), // key -> abs path
    nested: [],
    reads: [], // { key, path, size, tool, full }
    toolUses: new Map(),
    callIndexById: new Map(),
    spawned: [],
    firstTs: null,
    lastTs: null,
  };
  let pending = { tool: null, userText: false, bgDone: false };
  for (const o of records) {
    if (o.gitBranch) agent.branches.add(o.gitBranch);
    if (o.timestamp) {
      if (!agent.firstTs || o.timestamp < agent.firstTs) agent.firstTs = o.timestamp;
      if (!agent.lastTs || o.timestamp > agent.lastTs) agent.lastTs = o.timestamp;
    }
    if (o.type === 'attachment' && o.attachment) {
      const a = o.attachment;
      if (a.type === 'instructions') {
        for (const f of a.files || []) {
          const k = instructionKey(f.path);
          if (k) agent.instructions.set(k, f.path);
        }
      } else if (a.type === 'nested_memory') {
        agent.nested.push({ path: a.path, key: instructionKey(a.path), size: (a.content?.content || '').length });
      } else if (a.type === 'queued_command') {
        if (String(a.prompt || '').includes('<task-notification>')) pending.bgDone = true;
        else pending.userText = true;
      }
      continue;
    }
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      const isToolResult = Array.isArray(c) && c.some((x) => x?.type === 'tool_result');
      if (isToolResult) {
        for (const x of c) {
          if (x?.type !== 'tool_result') continue;
          const tu = agent.toolUses.get(x.tool_use_id);
          if (tu) tu.size = resultSize(x.content);
          if (o.toolUseResult?.agentId) agent.spawned.push({ agentId: o.toolUseResult.agentId, toolUseId: x.tool_use_id });
        }
      } else if (!o.isMeta) {
        const t = textOf(c);
        if (agent.prompt === null && kind === 'subagent') agent.prompt = t;
        else if (t && !t.startsWith('<local-command') && !t.startsWith('<command-name>')) {
          if (kind === 'subagent') agent.resumes++;
          pending.userText = true;
        }
      }
      continue;
    }
    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      const id = m.id || o.requestId;
      if (m.usage && !agent.seenMsg.has(id)) {
        agent.seenMsg.add(id);
        const u = usageOf(m.usage);
        agent.callIndexById.set(id, agent.calls.length);
        agent.calls.push({ ts: o.timestamp, u, ctx: u.in + u.cr + u.cc, model: m.model, before: pending });
        pending = { tool: null, userText: false, bgDone: false };
      }
      const callIndex = agent.callIndexById.has(id) ? agent.callIndexById.get(id) : agent.calls.length - 1;
      for (const c of m.content || []) {
        if (c?.type !== 'tool_use') continue;
        const tu = { name: c.name, input: c.input || {}, size: 0, callIndex };
        agent.toolUses.set(c.id, tu);
        pending.tool = c.name === 'Bash' ? (tu.input.run_in_background ? 'bash-bg' : 'bash-fg') : c.name;
      }
    }
  }
  return agent;
}

function classifyReads(agent, slugs) {
  for (const tu of agent.toolUses.values()) {
    let paths = [];
    let full = true;
    if (tu.name === 'Read') {
      paths = [tu.input.file_path || ''];
      full = tu.input.offset === undefined && tu.input.limit === undefined;
    } else if (tu.name === 'Bash' && SHELL_READ_RE.test(tu.input.command || '')) {
      const cmd = tu.input.command || '';
      paths = cmd.match(/[^\s"'|;&<>()]+\.(md|json|sh)/g) || [];
      full = /\bcat\b/.test(cmd) && !/\|/.test(cmd);
    } else continue;
    for (const p of paths) {
      agent.reads.push({ path: p, key: instructionKey(p), size: tu.size || 0, tool: tu.name, full, callIndex: tu.callIndex });
    }
  }
  // artifact refs for cross-phase checks
  agent.artifactReads = [];
  for (const r of agent.reads) {
    ARTIFACT_RE.lastIndex = 0;
    let m;
    while ((m = ARTIFACT_RE.exec(r.path)) !== null) {
      agent.artifactReads.push({ slug: m[1].replace(/^\d+-/, ''), file: m[2], size: r.size });
    }
  }
}

function firstActionIndex(agent, role) {
  for (const tu of [...agent.toolUses.values()].sort((a, b) => a.callIndex - b.callIndex)) {
    const n = tu.name;
    const fp = String(tu.input.file_path || '').replace(/\\/g, '/');
    if ((role === 'doer' || role === 'doer-fix') && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(n) && !fp.includes('/.jdi/') && !fp.startsWith('.jdi/')) return tu.callIndex;
    if (role === 'reviewer' && n === 'Bash' && GATE_CMD_RE.test(tu.input.command || '')) return tu.callIndex;
    if ((role === 'asker' || role === 'planner') && ['Write', 'Edit'].includes(n)) return tu.callIndex;
  }
  return null;
}

function cacheMisses(agent) {
  const ttl1h = agent.calls.some((c) => c.u.cc1h > 0);
  const writeMult = ttl1h ? WEIGHT.cc1h : WEIGHT.cc5m;
  const ttlMin = ttl1h ? 60 : 5;
  const misses = [];
  for (let i = 1; i < agent.calls.length; i++) {
    const prev = agent.calls[i - 1];
    const cur = agent.calls[i];
    if (prev.ctx <= MISS_MIN_CTX || cur.u.cr >= 0.9 * prev.ctx) continue;
    const gapMin = prev.ts && cur.ts ? (Date.parse(cur.ts) - Date.parse(prev.ts)) / 60000 : 0;
    const rewritten = prev.ctx - cur.u.cr;
    let cause = 'other';
    if (cur.before.userText) cause = 'resume';
    else if ((cur.before.tool === 'bash-fg' || cur.before.bgDone) && gapMin >= ttlMin) cause = 'long-command';
    else if (gapMin >= ttlMin) cause = 'idle';
    misses.push({ cause, rewritten, wasted: rewritten * (writeMult - WEIGHT.cr), gapMin });
  }
  return misses;
}

// --------------------------------------------------------------------------
// Analysis
// --------------------------------------------------------------------------

function analyze({ projectDir, claudeProjects, since, until, siblings = true }) {
  const dirs = sessionDirs(claudeProjects, projectDir, siblings);
  const slugs = core.knownSlugs(projectDir);
  const inRange = (ts) => (!since || !ts || ts >= since) && (!until || !ts || ts <= until);
  const seenUuid = new Set();
  const agents = [];

  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const recs = readJsonl(path.join(dir, f)).filter((o) => {
        if (o.isSidechain) return false;
        if (o.uuid) {
          if (seenUuid.has(o.uuid)) return false;
          seenUuid.add(o.uuid);
        }
        return true;
      });
      const a = parseAgent(recs, 'main');
      a.id = f.replace(/\.jsonl$/, '');
      a.role = 'orchestrator';
      a.agentType = 'main';
      agents.push(a);
    }
    for (const sess of fs.readdirSync(dir)) {
      const sub = path.join(dir, sess, 'subagents');
      if (!fs.existsSync(sub)) continue;
      for (const f of fs.readdirSync(sub)) {
        if (!f.endsWith('.jsonl')) continue;
        const meta = core.readJson(path.join(sub, f.replace(/\.jsonl$/, '.meta.json')), {}) || {};
        const a = parseAgent(readJsonl(path.join(sub, f)), 'subagent');
        a.id = f.replace(/^agent-|\.jsonl$/g, '');
        a.session = sess;
        a.agentType = meta.agentType || 'unknown';
        a.desc = meta.description || '';
        agents.push(a);
      }
    }
  }

  // Attribute untyped subagents (older transcripts without .meta.json)
  // through the parent's Agent/Task tool_use.
  const typeByAgentId = new Map();
  for (const a of agents) {
    if (a.kind !== 'main') continue;
    for (const sp of a.spawned) {
      const tu = a.toolUses.get(sp.toolUseId);
      if (tu?.input?.subagent_type) typeByAgentId.set(sp.agentId, { type: tu.input.subagent_type, desc: tu.input.description || '' });
    }
  }

  const allSlugs = [...new Set([...slugs, ...slugsFromPrompts(agents)])];
  for (const a of agents) {
    a.calls = a.calls.filter((c) => inRange(c.ts));
    if (a.kind === 'subagent' && a.agentType === 'unknown' && typeByAgentId.has(a.id)) {
      a.agentType = typeByAgentId.get(a.id).type;
      a.desc = a.desc || typeByAgentId.get(a.id).desc;
    }
    if (a.kind === 'subagent') {
      a.role = roleOf(a.agentType, a.prompt, a.desc);
      a.phase = phaseOf(a.prompt, a.desc, allSlugs);
    }
    classifyReads(a, slugs);
    a.total = a.calls.reduce((acc, c) => addUsage(acc, c.u), {});
    a.firstCtx = a.calls[0]?.ctx ?? null;
    a.peakCtx = a.calls.reduce((m, c) => Math.max(m, c.ctx), 0);
    a.misses = cacheMisses(a);
  }

  const active = agents.filter((a) => a.calls.length > 0);
  return summarize(active, dirs, projectDir);
}

function summarize(agents, dirs, projectDir) {
  const base = path.basename(projectDir);
  const parent = path.dirname(projectDir);
  // Relative paths, or absolute paths inside the project or one of its
  // sibling checkouts (<parent>/<name>-*: worktrees).
  const isProjectPath = (p) => {
    const f = String(p);
    if (!path.isAbsolute(f)) return true;
    const rel = path.relative(parent, f);
    const top = rel.split(path.sep)[0];
    return !rel.startsWith('..') && (top === base || top.startsWith(base + '-'));
  };
  const total = { weighted: 0 };
  const byRole = {};
  const byPhase = {};
  const firstAction = {};
  const missByCause = {};
  let rereads = { calls: 0, chars: 0, files: {} };
  let dups = { loads: 0, chars: 0, files: {} };
  let cross = { reads: 0, chars: 0 };
  let keFull = { reads: 0, chars: 0 };
  const critic = { spawnsOverCtx: 0, spawnsOverCalls: 0, preflights: {} };
  const mains = [];

  for (const a of agents) {
    addUsage(total, a.total);
    const r = (byRole[a.role] ||= { spawns: 0, calls: 0, weighted: 0 });
    r.spawns += a.kind === 'subagent' ? 1 : 0;
    r.calls += a.calls.length;
    r.weighted += a.total.weighted;

    if (a.kind === 'subagent') {
      const p = (byPhase[a.phase || '?'] ||= { spawns: 0, calls: 0, weighted: 0, roles: {} });
      p.spawns++;
      p.calls += a.calls.length;
      p.weighted += a.total.weighted;
      p.roles[a.role] = (p.roles[a.role] || 0) + 1;

      const baseRole = a.role === 'doer-fix' ? 'doer' : a.role;
      if (['doer', 'reviewer', 'planner', 'asker'].includes(baseRole)) {
        const idx = firstActionIndex(a, a.role);
        if (idx !== null && a.calls[idx]) (firstAction[baseRole] ||= []).push(a.calls[idx].ctx);
      }
      if (a.role === 'critic' || a.role === 'critic-preflight') {
        if (a.peakCtx > DEFAULT_TARGETS.critic_spawn_ctx_max) critic.spawnsOverCtx++;
        if (a.calls.length > DEFAULT_TARGETS.critic_spawn_calls_max) critic.spawnsOverCalls++;
        if (a.role === 'critic-preflight') critic.preflights[a.phase || '?'] = (critic.preflights[a.phase || '?'] || 0) + 1;
      }
      for (const ar of a.artifactReads) {
        if (a.phase && ar.slug !== a.phase) {
          cross.reads++;
          cross.chars += ar.size;
        }
      }
    } else {
      const ctxs = a.calls.map((c) => c.ctx);
      mains.push({ id: a.id, calls: a.calls.length, avgCtx: Math.round(ctxs.reduce((s, x) => s + x, 0) / ctxs.length), peakCtx: a.peakCtx, phases: new Set() });
    }

    for (const m of a.misses) {
      const k = (missByCause[m.cause] ||= { count: 0, rewritten: 0, wasted: 0 });
      k.count++;
      k.rewritten += m.rewritten;
      k.wasted += m.wasted;
    }

    for (const rd of a.reads) {
      if (rd.key && a.instructions.size > 0 && isProjectPath(rd.path)) {
        rereads.calls++;
        rereads.chars += rd.size;
        rereads.files[rd.key] = (rereads.files[rd.key] || 0) + 1;
      }
      if (/\.jdi\/known-errors\.md$/.test(rd.path.replace(/\\/g, '/')) && rd.full) {
        keFull.reads++;
        keFull.chars += rd.size;
      }
    }
    const loaded = new Map(a.instructions);
    for (const n of a.nested) {
      if (!n.key) continue;
      if (loaded.has(n.key) && loaded.get(n.key) !== n.path) {
        dups.loads++;
        dups.chars += n.size;
        dups.files[n.key] = (dups.files[n.key] || 0) + 1;
      } else if (!loaded.has(n.key)) loaded.set(n.key, n.path);
    }
  }

  // sessions spanning phases: phases of the subagents each main session spawned
  for (const a of agents) {
    if (a.kind !== 'subagent' || !a.phase) continue;
    const m = mains.find((x) => x.id === a.session);
    if (m) m.phases.add(a.phase);
  }

  const fa = {};
  for (const [k, v] of Object.entries(firstAction)) fa[k] = { n: v.length, median: median(v) };
  const criticWeighted = (byRole.critic?.weighted || 0) + (byRole['critic-preflight']?.weighted || 0);

  return {
    dirs,
    agents: agents.length,
    total,
    byRole,
    byPhase,
    firstAction: fa,
    missByCause,
    rereads,
    dups,
    cross,
    keFull,
    critic: { ...critic, share: total.weighted ? criticWeighted / total.weighted : 0 },
    mains: mains.map((m) => ({ ...m, phases: [...m.phases] })),
  };
}

function evaluateTargets(rep, targets = DEFAULT_TARGETS) {
  const t = core.deepMerge(DEFAULT_TARGETS, targets || {});
  const W = rep.total.weighted || 1;
  const longCmd = rep.missByCause['long-command']?.wasted || 0;
  const mainCalls = rep.mains.reduce((s, m) => s + m.calls, 0);
  const mainAvg = mainCalls ? Math.round(rep.mains.reduce((s, m) => s + m.avgCtx * m.calls, 0) / mainCalls) : 0;
  const checks = [
    ['critic_share', rep.critic.share, t.critic_share_max, (v, m) => v <= m],
    ['critic_spawns_over_ctx', rep.critic.spawnsOverCtx, 0, (v, m) => v <= m],
    ['critic_spawns_over_calls', rep.critic.spawnsOverCalls, 0, (v, m) => v <= m],
    ['critic_preflights_per_phase', Math.max(0, ...Object.values(rep.critic.preflights)), 1, (v, m) => v <= m],
    ['long_command_rewrite_share', longCmd / W, t.long_command_rewrite_share_max, (v, m) => v <= m],
    ['main_avg_ctx', mainAvg, t.main_avg_ctx_max, (v, m) => v <= m],
    ['main_sessions_spanning_phases', rep.mains.filter((m) => m.phases.length > 1).length, 0, (v, m) => v <= m],
    ['instruction_rereads', rep.rereads.calls, t.instruction_rereads_max, (v, m) => v <= m],
    ['duplicate_instruction_loads', rep.dups.loads, t.duplicate_instruction_loads_max, (v, m) => v <= m],
    ['cross_phase_reads', rep.cross.reads, t.cross_phase_reads_max, (v, m) => v <= m],
    ['known_errors_full_reads', rep.keFull.reads, t.known_errors_full_reads_max, (v, m) => v <= m],
  ];
  for (const [role, max] of Object.entries(t.first_action_ctx_max)) {
    const v = rep.firstAction[role]?.median;
    if (v !== undefined && v !== null) checks.push([`first_action_ctx.${role}`, v, max, (x, m) => x <= m]);
  }
  return checks.map(([name, value, max, ok]) => ({ name, value, max, pass: ok(value, max) }));
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

const L = {
  en: {
    title: 'JDI token cost (Claude Code transcripts on this machine)',
    none: 'No transcripts found for this project under',
    dirs: 'Session dirs',
    totals: 'Totals',
    calls: 'API calls',
    weighted: 'weighted tokens',
    raw: 'raw tokens processed',
    byRole: 'By role',
    byPhase: 'By phase (sub-agents only)',
    first: 'Context at the first productive action (median)',
    misses: 'Cache rewrites (context re-written after the cache expired or changed)',
    instr: 'Instruction files',
    rereads: 're-read with Read/shell although already injected',
    dups: 'duplicate loads (same file from another checkout)',
    cross: 'reads of OTHER phases\' artifacts',
    ke: 'full reads of .jdi/known-errors.md',
    mains: 'Orchestrator sessions',
    targets: 'Targets',
  },
  'pt-BR': {
    title: 'Custo de tokens do JDI (transcripts do Claude Code nesta maquina)',
    none: 'Nenhum transcript deste projeto em',
    dirs: 'Pastas de sessao',
    totals: 'Totais',
    calls: 'chamadas a API',
    weighted: 'tokens ponderados',
    raw: 'tokens processados',
    byRole: 'Por papel',
    byPhase: 'Por fase (so subagentes)',
    first: 'Contexto na primeira acao util (mediana)',
    misses: 'Cache reescrito (contexto escrito de novo depois de vencer ou mudar)',
    instr: 'Arquivos de instrucao',
    rereads: 'relidos com Read/shell apesar de ja injetados',
    dups: 'cargas duplicadas (mesmo arquivo de outro checkout)',
    cross: 'leituras de artefatos de OUTRA fase',
    ke: 'leituras inteiras de .jdi/known-errors.md',
    mains: 'Sessoes do orquestrador',
    targets: 'Metas',
  },
};

const fmt = (n) => (n === null || n === undefined ? '-' : Math.round(n).toLocaleString('en-US'));
const M = (n) => `${(n / 1e6).toFixed(1)}M`;
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');

function render(rep, lang, claudeProjects, targets) {
  const t = L[lang] || L.en;
  const out = [];
  out.push(t.title);
  if (!rep.dirs.length) {
    out.push(`${t.none} ${claudeProjects}`);
    return out.join('\n');
  }
  out.push(`${t.dirs}: ${rep.dirs.map((d) => path.basename(d)).join(', ')}`);
  const W = rep.total.weighted;
  const calls = Object.values(rep.byRole).reduce((s, r) => s + r.calls, 0);
  out.push('', `== ${t.totals}`);
  out.push(`  ${fmt(calls)} ${t.calls} | ${fmt(rep.total.in + rep.total.cr + rep.total.cc + rep.total.out)} ${t.raw} | ${M(W)} ${t.weighted}`);
  out.push('', `== ${t.byRole}`);
  for (const [k, r] of Object.entries(rep.byRole).sort((a, b) => b[1].weighted - a[1].weighted)) {
    out.push(`  ${k.padEnd(18)} spawns=${String(r.spawns).padStart(4)} calls=${String(r.calls).padStart(6)} ${M(r.weighted).padStart(8)} ${pct(r.weighted, W).padStart(6)}`);
  }
  out.push('', `== ${t.byPhase}`);
  for (const [k, p] of Object.entries(rep.byPhase).sort((a, b) => b[1].weighted - a[1].weighted)) {
    out.push(`  ${k.slice(0, 44).padEnd(45)} spawns=${String(p.spawns).padStart(3)} calls=${String(p.calls).padStart(5)} ${M(p.weighted).padStart(8)}`);
  }
  out.push('', `== ${t.first}`);
  for (const [k, v] of Object.entries(rep.firstAction)) out.push(`  ${k.padEnd(10)} n=${String(v.n).padStart(3)} ${fmt(v.median)}`);
  out.push('', `== ${t.misses}`);
  for (const [k, v] of Object.entries(rep.missByCause)) {
    out.push(`  ${k.padEnd(14)} n=${String(v.count).padStart(4)} rewritten=${fmt(v.rewritten).padStart(13)} wasted=${M(v.wasted).padStart(7)} ${pct(v.wasted, W)}`);
  }
  out.push('', `== ${t.instr}`);
  out.push(`  ${t.rereads}: ${rep.rereads.calls} (${fmt(rep.rereads.chars)} chars)`);
  out.push(`  ${t.dups}: ${rep.dups.loads} (${fmt(rep.dups.chars)} chars)`);
  out.push(`  ${t.cross}: ${rep.cross.reads} (${fmt(rep.cross.chars)} chars)`);
  out.push(`  ${t.ke}: ${rep.keFull.reads} (${fmt(rep.keFull.chars)} chars)`);
  out.push('', `== ${t.mains}`);
  for (const m of rep.mains) {
    out.push(`  ${m.id.slice(0, 8)} calls=${String(m.calls).padStart(5)} avg_ctx=${fmt(m.avgCtx).padStart(9)} peak=${fmt(m.peakCtx).padStart(9)} phases=${m.phases.length}`);
  }
  if (targets) {
    out.push('', `== ${t.targets}`);
    for (const c of targets) {
      const v = c.value < 1 && c.value > 0 ? `${(100 * c.value).toFixed(2)}%` : fmt(c.value);
      const m = c.max < 1 && c.max > 0 ? `${(100 * c.max).toFixed(2)}%` : fmt(c.max);
      out.push(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(34)} ${v} (max ${m})`);
    }
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const o = { project: process.cwd(), json: false, targets: false, siblings: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--json') o.json = true;
    else if (a === '--targets') o.targets = true;
    else if (a === '--no-worktrees') o.siblings = false;
    else if (a === '--project') o.project = v();
    else if (a === '--claude-dir') o.claudeDir = v();
    else if (a === '--since') o.since = v();
    else if (a === '--until') o.until = v();
    else if (a === '--lang') o.lang = v();
    else throw new core.JdiError(`unknown flag: ${a}`, 1);
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  const claudeProjects = o.claudeDir || path.join(os.homedir(), '.claude', 'projects');
  const projectDir = path.resolve(o.project);
  const rep = analyze({ projectDir, claudeProjects, since: o.since, until: o.until, siblings: o.siblings });
  const cfg = core.loadConfig(projectDir);
  const targets = o.targets ? evaluateTargets(rep, cfg.economy?.targets) : null;
  if (o.json) {
    process.stdout.write(JSON.stringify({ ...rep, targets }, null, 2) + '\n');
  } else {
    const lang = o.lang || core.projectLang(projectDir);
    process.stdout.write(render(rep, lang, claudeProjects, targets) + '\n');
  }
  if (targets && targets.some((c) => !c.pass)) return 2;
  return 0;
}

module.exports = { analyze, evaluateTargets, render, main, encodeProjectPath, instructionKey, roleOf, weighted, usageOf, DEFAULT_TARGETS };
