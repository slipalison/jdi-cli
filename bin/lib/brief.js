'use strict';

// `jdi-cli brief <phase> --role <doer|reviewer|planner|asker|critic> [--task T-N]
//                [--stack <agent>] [--runtime <rt>] [--out <file>] [--print]`
//
// Writes the ONE file an agent reads before acting, under the
// `budgets.brief_tokens` cap, to .jdi/cache/briefs/<slug>/<role>[-<task|stack>].md
// and prints `<path> (~N tokens)`.
//
// Why: measured on a real project, agents read 110-350k tokens before their
// first useful action (instruction files twice, whole CONTEXT/PLAN, the whole
// error catalog, other phases' artifacts) and re-read all of it on every later
// turn. A brief is deterministic, built from the artifacts, and carries
// pointers for anything it leaves out — the agent may still open a file, but
// it starts small.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const dod = require('./dod');
const learnings = require('./learnings');
const decisions = require('./decisions');
const knownErrors = require('./known-errors');

// --------------------------------------------------------------------------
// Artifact readers
// --------------------------------------------------------------------------

function sections(text) {
  // H2 sections: [{ title, start, body }]
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    const m = /^## (.*)$/.exec(l);
    if (m) {
      cur = { title: m[1].trim(), line: i + 1, lines: [] };
      out.push(cur);
    } else if (cur) cur.lines.push(l);
  });
  return out.map((s) => ({ title: s.title, line: s.line, body: s.lines.join('\n').trim() }));
}

function section(text, re) {
  return sections(text).find((s) => re.test(s.title)) || null;
}

function expandBraces(p) {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(p);
  if (!m) return [p];
  return m[2].split(',').flatMap((alt) => expandBraces(m[1] + alt.trim() + m[3]));
}

// `### T-1.2: Title` / `#### T-3 Title` -> { id, title } (string scan, no
// backtracking regex).
function taskHeading(line) {
  const hashes = /^#{3,4}/.exec(line);
  if (!hashes || !/\s/.test(line[hashes[0].length] || '')) return null;
  const t = line.slice(hashes[0].length).trim();
  if (!t.startsWith('T-')) return null;
  const stop = t.slice(2).search(/[^\dA-Za-z.]/);
  const end = stop === -1 ? t.length : stop + 2;
  if (end === 2) return null;
  let title = t.slice(end).trimStart();
  if (title.startsWith(':')) title = title.slice(1).trimStart();
  return { id: t.slice(0, end), title: title.trim() };
}

// `jdi-doer-x`, from `\`jdi-doer-x\`,` / `jdi-doer-x).` (markdown around a name)
function bareName(s) {
  let a = s.startsWith('`') ? 1 : 0;
  let b = s.length;
  while (b > a && '`,;.)'.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

function parseTasks(planText) {
  const lines = planText.split('\n');
  const tasks = [];
  let cur = null;
  lines.forEach((l, i) => {
    const h = taskHeading(l);
    if (h) {
      cur = { id: h.id, title: h.title, line: i + 1, lines: [l] };
      tasks.push(cur);
      return;
    }
    if (cur && /^#{2,4}\s/.test(l)) {
      cur = null;
      return;
    }
    if (cur) cur.lines.push(l);
  });
  return tasks.map((t) => {
    const block = t.lines.join('\n').trimEnd();
    const field = (re) => {
      const m = re.exec(block);
      return m ? m[1].trim() : '';
    };
    const filesField = field(/\*\*Files modified:\*\*\s*([^\n]*)/);
    const files = [...filesField.matchAll(/`([^`]+)`/g)].flatMap((m) => expandBraces(m[1].trim())).filter((f) => /[/.]/.test(f));
    return {
      id: t.id,
      title: t.title,
      line: t.line,
      block,
      files,
      specialist: bareName(field(/\*\*Specialist:\*\*\s*([^\s·]+)/)),
      status: field(/\*\*Status:\*\*\s*([^\s·]+)/),
    };
  });
}

function decisionRefs(text, slug) {
  const ids = new Set();
  for (const m of text.matchAll(/\bD-\d{4}-\d{2}-\d{2}-[a-z0-9-]+-\d+\b/g)) ids.add(m[0]);
  for (const m of text.matchAll(/\bD-(\d{1,3})\b/g)) ids.add(`short:${m[1]}`);
  const out = [];
  for (const id of ids) {
    if (id.startsWith('short:')) {
      const n = id.slice(6);
      out.push(`D-${n}`); // phase-local shorthand; resolved against the phase's decisions below
    } else out.push(id);
  }
  return { ids: out, slug };
}

// `D-N` shorthand in a task = decision N of this phase (D-YYYY-MM-DD-<slug>-N).
function localDecision(all, slug, n) {
  return all.find((d) => /^D-\d{4}-\d{2}-\d{2}-/.test(d.id) && d.id.slice(13) === `${slug}-${n}`);
}

function resolveDecisionIds(refs, all, slug) {
  const byId = new Map(all.map((d) => [d.id, d]));
  const picked = refs
    .map((r) => {
      if (byId.has(r)) return byId.get(r);
      const m = /^D-(\d+)$/.exec(r);
      return m ? localDecision(all, slug, m[1]) : null;
    })
    .filter(Boolean);
  return [...new Map(picked.map((d) => [d.id, d])).values()];
}

function fileTouches(item, files) {
  const hay = `${item.criterion} ${item.verify ? item.verify.command : ''}`;
  return files.some((f) => {
    if (hay.includes(f)) return true;
    const base = path.basename(f);
    if (base.length > 4 && hay.includes(base)) return true;
    const dir = path.dirname(f);
    return dir !== '.' && dir.split('/').length >= 2 && hay.includes(dir + '/');
  });
}

function verifyRef(item, ctxRel, limit) {
  if (!item.verify) return 'no Verify';
  if (item.evidence) return `evidence: ${item.verify.command.slice(0, 160)}`;
  if (item.script) return `\`bash ${item.script}\``;
  if (item.verify.command.length <= limit) return `\`${item.verify.command}\``;
  return `inline, ${item.verify.command.length} chars — ${ctxRel}:${item.verifyLine}`;
}

function changedFiles(root, base, globs) {
  if (!base) return [];
  const r = core.git(['diff', '--name-only', `${base}..HEAD`], root);
  if (r.code !== 0) return [];
  const files = r.stdout.split('\n').filter(Boolean);
  return globs?.length ? files.filter((f) => core.matchesAny(f, globs)) : files;
}

function defaultBase(root) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const r = core.git(['merge-base', 'HEAD', ref], root);
    if (r.code === 0 && r.stdout) return r.stdout;
  }
  return null;
}

function agentGlob(root, agentName) {
  if (!agentName) return [];
  const f = path.join(root, core.JDI_DIR, 'agents', `${agentName}.md`);
  if (!fs.existsSync(f)) return [];
  const g = core.readFrontmatter(f).scope?.file_glob;
  if (!g || g === '**/*') return [];
  return String(g).split(/[,\s]+/).filter(Boolean);
}

// --------------------------------------------------------------------------
// Assembly with a token cap
// --------------------------------------------------------------------------

class Brief {
  constructor(title, ratio, cap) {
    this.title = title;
    this.ratio = ratio;
    this.cap = cap;
    this.parts = []; // { heading, text, priority (0 = never cut), pointer }
  }

  // priority: 0 = never cut; 1 = may be shortened, never dropped; >= 2 =
  // shortened first, then dropped (highest number first).
  add(heading, text, priority = 5, pointer = '') {
    if (text && String(text).trim()) this.parts.push({ heading, text: String(text).trim(), priority, pointer });
  }

  render() {
    const keep = this.parts.map((p) => ({ ...p }));
    const dropped = [];
    const build = () => [`# ${this.title}`, '', ...keep.flatMap((p) => [`## ${p.heading}`, '', p.text, ''])].join('\n');
    const over = () => core.estimateTokens(build(), this.ratio) > this.cap;
    // 1) shorten the longest cuttable sections, keeping a pointer to the source
    let guard = 0;
    while (over() && guard++ < 200) {
      const cand = keep.filter((p) => p.priority > 0 && p.text.length > 900).sort((a, b) => b.text.length - a.text.length)[0];
      if (!cand) break;
      const target = Math.max(800, Math.floor(cand.text.length * 0.6));
      const cut = cand.text.slice(0, target);
      const at = cut.lastIndexOf('\n') > target * 0.5 ? cut.lastIndexOf('\n') : target;
      const where = cand.pointer ? ' — full text: ' + cand.pointer : '';
      cand.text = `${cand.text.slice(0, at).trimEnd()}\n… (cut to fit the brief${where})`;
    }
    // 2) drop whole sections, least important first
    while (over()) {
      const cand = keep.filter((p) => p.priority >= 2).sort((a, b) => b.priority - a.priority)[0];
      if (!cand) break;
      keep.splice(keep.indexOf(cand), 1);
      dropped.push(cand.pointer ? `${cand.heading} (${cand.pointer})` : cand.heading);
    }
    let text = build();
    if (dropped.length) text += `\n## Left out (brief cap ${this.cap} tokens)\n\n${dropped.map((d) => '- ' + d).join('\n')}\n`;
    return { text, tokens: core.estimateTokens(text, this.ratio), dropped };
  }
}

function runtimeNote(runtime) {
  if (runtime === 'claude') {
    return 'CLAUDE.md and the unscoped `.claude/rules/` are already in your context (Claude Code injects them into every sub-agent); scoped rules load when you read a matching file. Never open them with Read or the shell.';
  }
  return 'The project instruction files your runtime injects are already in your context. Do not re-read them.';
}

// --------------------------------------------------------------------------
// Roles
// --------------------------------------------------------------------------

const indexLines = (body, max) =>
  body
    .split('\n')
    .filter((l) => /^\s*[-*]\s|^###\s/.test(l))
    .map((l) => (l.length > max ? l.slice(0, max - 3) + '...' : l));

function dodRow(it, ctxRel, limit, { stack = false, max = 400 } = {}) {
  const kind = stack && it.stack ? `${it.type}, ${it.stack}` : it.type;
  return `- DoD ${it.id} (${kind}): ${it.criterion.slice(0, max)}\n  Verify: ${verifyRef(it, ctxRel, limit)}`;
}

function doerParts(c) {
  const { b, opts, phase, planText, planRel, ctxText, ctxRel, doc, limit } = c;
  const task = parseTasks(planText).find((t) => t.id === opts.task);
  if (!task) throw new core.JdiError(`task ${opts.task} not found in ${planRel}`, 2);
  b.add(`Your task (${planRel}:${task.line})`, task.block, 0);
  const notes = sections(planText).filter((x) => /orchestrator notes|nota do orquestrador|notas do orquestrador/i.test(x.title));
  if (notes.length) b.add('Orchestrator notes (from PLAN.md — they override the task text)', notes.map((n) => n.body).join('\n\n'), 1, `${planRel}:${notes[0].line}`);
  const picked = resolveDecisionIds(decisionRefs(task.block, phase.slug).ids, c.allDecisions, phase.slug);
  if (picked.length) b.add('Decisions your task cites', picked.map((d) => d.text).join('\n\n'), 1, `\`jdi-cli decisions --ids ${picked.map((d) => d.id).join(',')}\``);
  const locked = section(ctxText, /^locked decisions/i);
  if (locked) b.add(`Locked decisions of the phase (index — full text: ${ctxRel}:${locked.line})`, indexLines(locked.body, 200).join('\n'), 4, `${ctxRel}:${locked.line}`);
  const rows = doc.items.filter((it) => fileTouches(it, task.files) || it.criterion.includes(task.id));
  if (rows.length) b.add('Definition of Done lines that touch your files', rows.map((it) => dodRow(it, ctxRel, limit)).join('\n'), 1, `${ctxRel} § Definition of Done`);
  b.add('Known errors for your files (judgment only — gates already block the mechanized ones)', c.ke('do', task.files), 6, '`jdi-cli known-errors query --stage do --files <your files>`');
  b.add('Learnings of the last shipped phases', c.learn(), 7, '`jdi-cli learnings --last 3`');
  b.add('Do', [
    `Implement only \`${task.id}\`, only in its files. Lint, then the task's targeted test — never the full suite, coverage or E2E (the verify step runs them once).`,
    `Mark \`${task.id}\` \`Status:\` in ${planRel}, append one line to ${phase.dir}/SUMMARY.md, commit atomically. Return at most 10 lines.`,
  ].join('\n'), 0);
}

function gateLine(g) {
  const took = g.duration_s === undefined ? '' : ` (${g.duration_s}s)`;
  const why = g.reason ? ' — ' + g.reason : '';
  const log = g.log ? ' — log ' + g.log : '';
  return `- ${g.gate}: ${g.status}${took}${why}${log}`;
}

function taskLine(t) {
  const files = t.files.slice(0, 6).join(', ') + (t.files.length > 6 ? ', ...' : '');
  return `- ${t.id} [${t.status || '?'}] ${t.title.slice(0, 120)} — ${files}`;
}

function scopeText(opts, globs, base, changed) {
  const files = globs.length ? ' — files ' + globs.join(', ') : '';
  const more = changed.length > 80 ? `\n- ... ${changed.length - 80} more (\`git diff --name-only ${base}..HEAD\`)` : '';
  return [
    `Reviewer: ${opts.stack || 'single-stack'}${files}`,
    `Base: ${base || '(none found — review the phase commits)'}; ${changed.length} changed file(s) in your scope:`,
    changed.slice(0, 80).map((f) => '- ' + f).join('\n') + more,
  ].join('\n');
}

function reviewerParts(c) {
  const { b, opts, root, phase, planText, planRel, ctxText, ctxRel, doc, limit } = c;
  const globs = agentGlob(root, opts.stack);
  const base = opts.base || defaultBase(root);
  const changed = changedFiles(root, base, globs);
  b.add('Scope', scopeText(opts, globs, base, changed), 0);
  const gatesFile = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, `${opts.stack || 'default'}.json`);
  const gates = core.readJson(gatesFile, null);
  if (gates) b.add(`Gate results already measured (${path.relative(root, gatesFile)})`, (gates.results || []).map(gateLine).join('\n'), 0);
  const tasks = parseTasks(planText);
  if (tasks.length) b.add(`Tasks (${planRel})`, tasks.map(taskLine).join('\n'), 2);
  const rows = doc.items.filter((it) => !it.stack || !opts.stack || it.stack.includes(opts.stack) || opts.stack.includes(it.stack));
  if (rows.length) b.add(`Definition of Done (${ctxRel})`, rows.map((it) => dodRow(it, ctxRel, limit, { stack: true, max: 300 })).join('\n'), 1);
  const locked = section(ctxText, /^locked decisions/i);
  if (locked) b.add(`Locked decisions (Gate 6) — full text: ${ctxRel}:${locked.line}; others by id: \`jdi-cli decisions --ids\``, indexLines(locked.body, 220).join('\n'), 3);
  b.add('Known errors for these files (judgment only)', c.ke('verify', changed), 6);
}

function plannerParts(c) {
  const { b, root, ctxText, ctxRel, doc, limit } = c;
  const goal = section(ctxText, /^goal/i);
  if (goal) b.add('Goal', goal.body, 0);
  const locked = section(ctxText, /^locked decisions/i);
  if (locked) b.add(`Locked decisions (${ctxRel}:${locked.line})`, locked.body, 1);
  if (doc.items.length) b.add("Definition of Done (criteria; the Verify is the reviewer's)", doc.items.map((it) => dodRow(it, ctxRel, limit)).join('\n'), 1);
  const project = core.readIf(path.join(root, core.JDI_DIR, 'PROJECT.md')) || '';
  b.add('Stack and code design (PROJECT.md)', [section(project, /^stack/i)?.body, section(project, /^code design/i)?.body].filter(Boolean).join('\n\n'), 2);
  const spec = core.readIf(path.join(root, core.JDI_DIR, 'specialists.md'));
  if (spec) b.add('Specialists (routing by file glob)', spec.split('\n').filter((l) => l.startsWith('|')).join('\n'), 2);
  b.add('Learnings of the last shipped phases (turn recurring ones into acceptance criteria)', c.learn(), 4);
  b.add('Known errors to plan around (judgment only)', c.ke('plan', []), 5);
}

function askerParts(c) {
  const { b, root, phase } = c;
  const project = core.readIf(path.join(root, core.JDI_DIR, 'PROJECT.md')) || '';
  for (const re of [/^vision/i, /^stack/i, /^code design/i, /^global constraints/i]) {
    const sec = section(project, re);
    if (sec) b.add(`PROJECT.md — ${sec.title}`, sec.body, 1);
  }
  const entry = core.readIf(path.join(root, core.JDI_DIR, 'roadmap', `${phase.slug}.md`));
  if (entry) b.add('Roadmap entry', core.splitFrontmatter(entry).body.trim(), 0);
  const recent = decisions.select(c.allDecisions, { recent: 2 });
  b.add('Locked decisions (init + 2 most recent phases; full text: `.jdi/decisions/<ID>.md`)', decisions.render(recent, { index: true, maxChars: 6000 }), 3);
  b.add('Known errors to avoid when writing the DoD (judgment only)', c.ke('discuss', []), 5);
  b.add('DoD schema', 'Read `.jdi/cache/dod-schema.md` (written by /jdi-discuss). A `Verify:` longer than one short command goes to `' + phase.dir + '/verify/dod-N.sh`.', 0);
}

// A row for the critic, with what its last examination found when it was hollow.
function criticRow(it, ctxRel, last) {
  const row = `- DoD ${it.id}: ${it.criterion.slice(0, 500)}\n  Verify: ${verifyRef(it, ctxRel, 2000)}`;
  if (!last?.hollow) return row;
  const kind = last.objective ? '(objective)' : '(suspicion)';
  return `${row}\n  Last examination: hollow ${kind} — ${last.evidence}. Check whether the code or test behind the Verify changed since.`;
}

function criticParts(c) {
  const { b, opts, ctxRel, doc } = c;
  const changedRows = opts.rows ? opts.rows.split(',').map((x) => Number(x.trim())).filter(Boolean) : null;
  const rows = doc.items.filter((it) => it.type === 'auto' && (!changedRows || changedRows.includes(it.id)));
  const mode = opts.preflight
    ? 'PREFLIGHT — before code: for each row, list the mutations its Verify must fail and what it does not cover yet.'
    : `VERIFY — re-examine only the rows below (${rows.length}); the others were examined at an unchanged Verify or already spent their hollow-proof block.`;
  b.add('Mode', mode, 0);
  const prev = core.readJson(path.join(c.root, core.JDI_DIR, 'cache', 'critic', c.phase.slug, 'state.json'), null)?.rows || {};
  b.add(`Rows to examine (${ctxRel})`, rows.map((it) => criticRow(it, ctxRel, prev[it.id])).join('\n'), 0);
  b.add('Output', `Write \`.jdi/cache/critic/${c.phase.slug}/findings.json\`: a JSON array with one object per row above — \`{"row": N, "hollow": true|false, "objective": true|false, "evidence": "file:line or the exact reason"}\`. Then return one line.`, 0);
  b.add('Known errors about hollow proofs (judgment only — lint already blocks the mechanized ones)', c.ke('critic', []), 4);
}

const ROLE_PARTS = { doer: doerParts, reviewer: reviewerParts, planner: plannerParts, asker: askerParts, critic: criticParts };

function briefTitle(phase, opts) {
  const task = opts.task ? ' ' + opts.task : '';
  const stack = opts.stack ? ` (${opts.stack})` : '';
  return `Brief — ${opts.role}${task}${stack} — phase ${phase.slug}`;
}

// Known errors for a stage and files, under the query cap, as brief text.
function knownErrorsText(root, config, ratio, stage, files) {
  const r = knownErrors.query(knownErrors.load(root), { stage, files, maxTokens: config.budgets?.known_errors_query_tokens || 2000, ratio });
  if (!r.lines.length) return '';
  const more = r.dropped ? `\n(${r.dropped} more — \`jdi-cli known-errors query --stage ${stage} --files ...\`)` : '';
  return r.lines.join('\n') + more;
}

function build(phase, opts, root = process.cwd()) {
  const parts = ROLE_PARTS[opts.role];
  if (!parts) throw new core.JdiError(`unknown role '${opts.role}' (doer, reviewer, planner, asker, critic)`, 1);
  const config = core.loadConfig(root);
  const ratio = core.charsPerToken(config, core.projectLang(root));
  const ctxPath = path.join(phase.absDir, 'CONTEXT.md');
  const ctxText = core.readIf(ctxPath) || '';
  const b = new Brief(briefTitle(phase, opts), ratio, config.budgets?.brief_tokens || 6000);
  b.add('How to use this brief', [
    'Generated by `jdi-cli brief` from the phase artifacts. It is your starting context: act from it.',
    "Open an artifact only for what the brief points to, and say why. Never read other phases' artifacts or the whole `.jdi/DECISIONS.md`.",
    runtimeNote(opts.runtime),
  ].join('\n'), 0);
  parts({
    b,
    opts,
    root,
    phase,
    limit: config.budgets?.verify_inline_chars ?? 300,
    ctxText,
    planText: core.readIf(path.join(phase.absDir, 'PLAN.md')) || '',
    ctxRel: `${phase.dir}/CONTEXT.md`,
    planRel: `${phase.dir}/PLAN.md`,
    doc: ctxText ? dod.parse(ctxText, ctxPath) : { items: [] },
    allDecisions: decisions.loadDecisions(root),
    ke: (stage, files) => knownErrorsText(root, config, ratio, stage, files),
    learn: () => learnings.render(root, 3, 1500).trim(),
  });
  return b.render();
}

function defaultOut(root, phase, opts) {
  let suffix = '';
  if (opts.task) suffix = '-' + opts.task;
  else if (opts.stack) suffix = '-' + opts.stack;
  else if (opts.preflight) suffix = '-preflight';
  return path.join(root, core.JDI_DIR, 'cache', 'briefs', phase.slug, `${opts.role}${suffix}.md`);
}

const VALUE_FLAGS = { '--role': 'role', '--task': 'task', '--stack': 'stack', '--runtime': 'runtime', '--out': 'out', '--base': 'base', '--rows': 'rows' };

function parseArgs(argv) {
  const opts = { runtime: 'claude' };
  let id = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS[a]) opts[VALUE_FLAGS[a]] = argv[++i];
    else if (a === '--preflight' || a === '--print') opts[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new core.JdiError(`unknown flag: ${a}`, 1);
    else id = a;
  }
  return { id, opts };
}

function main(argv) {
  const { id, opts } = parseArgs(argv);
  if (!id || !opts.role) throw new core.JdiError('usage: jdi brief <phase> --role <doer|reviewer|planner|asker|critic> [--task T-N] [--stack <agent>] [--runtime <rt>]', 1);
  if (opts.role === 'doer' && !opts.task) throw new core.JdiError('--role doer needs --task T-N', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  const r = build(phase, opts, root);
  if (opts.print) {
    process.stdout.write(r.text);
    return 0;
  }
  const out = opts.out ? path.resolve(opts.out) : defaultOut(root, phase, opts);
  core.writeFileEnsured(out, r.text, root);
  const left = r.dropped.length ? '; left out: ' + r.dropped.join(', ') : '';
  console.log(`${path.relative(root, out).split(path.sep).join('/')} (~${r.tokens} tokens${left})`);
  return 0;
}

module.exports = { main, build, parseTasks, expandBraces, sections };
