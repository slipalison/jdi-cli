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

function parseTasks(planText) {
  const lines = planText.split('\n');
  const tasks = [];
  let cur = null;
  lines.forEach((l, i) => {
    const h = /^#{3,4}\s+(T-[0-9A-Za-z.]+)\s*:?\s*(.*)$/.exec(l);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), line: i + 1, lines: [l] };
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
      specialist: field(/\*\*Specialist:\*\*\s*([^\s·]+)/),
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

function resolveDecisionIds(refs, all, slug) {
  const byId = new Map(all.map((d) => [d.id, d]));
  const picked = [];
  for (const r of refs) {
    if (byId.has(r)) picked.push(byId.get(r));
    else {
      const m = /^D-(\d+)$/.exec(r);
      if (m) {
        const local = all.find((d) => new RegExp(`^D-\\d{4}-\\d{2}-\\d{2}-${slug}-${m[1]}$`).test(d.id));
        if (local) picked.push(local);
        else if (byId.has(r)) picked.push(byId.get(r));
      }
    }
  }
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
  return globs && globs.length ? files.filter((f) => core.matchesAny(f, globs)) : files;
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
      cand.text = `${cand.text.slice(0, at).trimEnd()}\n… (cut to fit the brief${cand.pointer ? ` — full text: ${cand.pointer}` : ''})`;
    }
    // 2) drop whole sections, least important first
    while (over()) {
      const cand = keep.filter((p) => p.priority >= 2).sort((a, b) => b.priority - a.priority)[0];
      if (!cand) break;
      keep.splice(keep.indexOf(cand), 1);
      dropped.push(cand.heading + (cand.pointer ? ` (${cand.pointer})` : ''));
    }
    let text = build();
    if (dropped.length) text += `\n## Left out (brief cap ${this.cap} tokens)\n\n${dropped.map((d) => `- ${d}`).join('\n')}\n`;
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

function build(phase, opts, root = process.cwd()) {
  const config = core.loadConfig(root);
  const ratio = core.charsPerToken(config, core.projectLang(root));
  const cap = config.budgets?.brief_tokens || 6000;
  const limit = config.budgets?.verify_inline_chars ?? 300;
  const ctxPath = path.join(phase.absDir, 'CONTEXT.md');
  const planPath = path.join(phase.absDir, 'PLAN.md');
  const ctxText = core.readIf(ctxPath) || '';
  const planText = core.readIf(planPath) || '';
  const ctxRel = `${phase.dir}/CONTEXT.md`;
  const planRel = `${phase.dir}/PLAN.md`;
  const doc = ctxText ? dod.parse(ctxText, ctxPath) : { items: [] };
  const allDecisions = decisions.loadDecisions(root);
  const role = opts.role;
  const b = new Brief(`Brief — ${role}${opts.task ? ` ${opts.task}` : ''}${opts.stack ? ` (${opts.stack})` : ''} — phase ${phase.slug}`, ratio, cap);
  b.add('How to use this brief', [
    `Generated by \`jdi-cli brief\` from the phase artifacts. It is your starting context: act from it.`,
    `Open an artifact only for what the brief points to, and say why. Never read other phases' artifacts or the whole \`.jdi/DECISIONS.md\`.`,
    runtimeNote(opts.runtime),
  ].join('\n'), 0);

  const ke = (stage, files) => {
    const r = knownErrors.query(knownErrors.load(root), { stage, files, maxTokens: config.budgets?.known_errors_query_tokens || 2000, ratio });
    return r.lines.length ? r.lines.join('\n') + (r.dropped ? `\n(${r.dropped} more — \`jdi-cli known-errors query --stage ${stage} --files ...\`)` : '') : '';
  };
  const learn = () => learnings.render(root, 3, 1500).trim();

  if (role === 'doer') {
    const tasks = parseTasks(planText);
    const task = tasks.find((t) => t.id === opts.task);
    if (!task) throw new core.JdiError(`task ${opts.task} not found in ${planRel}`, 2);
    b.add(`Your task (${planRel}:${task.line})`, task.block, 0);
    const notes = sections(planText).filter((s) => /orchestrator notes|nota do orquestrador|notas do orquestrador/i.test(s.title));
    if (notes.length) b.add('Orchestrator notes (from PLAN.md — they override the task text)', notes.map((n) => n.body).join('\n\n'), 1, `${planRel}:${notes[0].line}`);
    const refs = decisionRefs(task.block, phase.slug).ids;
    const picked = resolveDecisionIds(refs, allDecisions, phase.slug);
    if (picked.length) b.add('Decisions your task cites', picked.map((d) => d.text).join('\n\n'), 1, `\`jdi-cli decisions --ids ${picked.map((d) => d.id).join(',')}\``);
    const locked = section(ctxText, /^locked decisions/i);
    if (locked) {
      const index = locked.body.split('\n').filter((l) => /^\s*[-*]\s|^###\s/.test(l)).map((l) => (l.length > 200 ? l.slice(0, 197) + '...' : l));
      b.add(`Locked decisions of the phase (index — full text: ${ctxRel}:${locked.line})`, index.join('\n'), 4, `${ctxRel}:${locked.line}`);
    }
    const rows = doc.items.filter((it) => fileTouches(it, task.files) || it.criterion.includes(task.id));
    if (rows.length) {
      b.add('Definition of Done lines that touch your files', rows.map((it) => `- DoD ${it.id} (${it.type}): ${it.criterion.slice(0, 400)}\n  Verify: ${verifyRef(it, ctxRel, limit)}`).join('\n'), 1, `${ctxRel} § Definition of Done`);
    }
    b.add('Known errors for your files (judgment only — gates already block the mechanized ones)', ke('do', task.files), 6, '`jdi-cli known-errors query --stage do --files <your files>`');
    b.add('Learnings of the last shipped phases', learn(), 7, '`jdi-cli learnings --last 3`');
    b.add('Do', [
      `Implement only \`${task.id}\`, only in its files. Lint, then the task's targeted test — never the full suite, coverage or E2E (the verify step runs them once).`,
      `Mark \`${task.id}\` \`Status:\` in ${planRel}, append one line to ${phase.dir}/SUMMARY.md, commit atomically. Return at most 10 lines.`,
    ].join('\n'), 0);
  } else if (role === 'reviewer') {
    const globs = agentGlob(root, opts.stack);
    const base = opts.base || defaultBase(root);
    const changed = changedFiles(root, base, globs);
    b.add('Scope', [
      `Reviewer: ${opts.stack || 'single-stack'}${globs.length ? ` — files ${globs.join(', ')}` : ''}`,
      `Base: ${base || '(none found — review the phase commits)'}; ${changed.length} changed file(s) in your scope:`,
      changed.slice(0, 80).map((f) => `- ${f}`).join('\n') + (changed.length > 80 ? `\n- ... ${changed.length - 80} more (\`git diff --name-only ${base}..HEAD\`)` : ''),
    ].join('\n'), 0);
    const gatesFile = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, `${opts.stack || 'default'}.json`);
    const gates = core.readJson(gatesFile, null);
    if (gates) {
      b.add(`Gate results already measured (${path.relative(root, gatesFile)})`, (gates.results || []).map((g) => `- ${g.gate}: ${g.status}${g.duration_s !== undefined ? ` (${g.duration_s}s)` : ''}${g.reason ? ` — ${g.reason}` : ''}${g.log ? ` — log ${g.log}` : ''}`).join('\n'), 0);
    }
    const tasks = parseTasks(planText);
    if (tasks.length) b.add(`Tasks (${planRel})`, tasks.map((t) => `- ${t.id} [${t.status || '?'}] ${t.title.slice(0, 120)} — ${t.files.slice(0, 6).join(', ')}${t.files.length > 6 ? ', ...' : ''}`).join('\n'), 2);
    const rows = doc.items.filter((it) => !it.stack || !opts.stack || it.stack.includes(opts.stack) || opts.stack.includes(it.stack));
    if (rows.length) b.add(`Definition of Done (${ctxRel})`, rows.map((it) => `- DoD ${it.id} (${it.type}${it.stack ? `, ${it.stack}` : ''}): ${it.criterion.slice(0, 300)}\n  Verify: ${verifyRef(it, ctxRel, limit)}`).join('\n'), 1);
    const locked = section(ctxText, /^locked decisions/i);
    if (locked) b.add(`Locked decisions (Gate 6) — full text: ${ctxRel}:${locked.line}; others by id: \`jdi-cli decisions --ids\``, locked.body.split('\n').filter((l) => /^\s*[-*]\s|^###\s/.test(l)).map((l) => (l.length > 220 ? l.slice(0, 217) + '...' : l)).join('\n'), 3);
    b.add('Known errors for these files (judgment only)', ke('verify', changed), 6);
  } else if (role === 'planner') {
    const goal = section(ctxText, /^goal/i);
    if (goal) b.add('Goal', goal.body, 0);
    const locked = section(ctxText, /^locked decisions/i);
    if (locked) b.add(`Locked decisions (${ctxRel}:${locked.line})`, locked.body, 1);
    if (doc.items.length) b.add('Definition of Done (criteria; the Verify is the reviewer\'s)', doc.items.map((it) => `- DoD ${it.id} (${it.type}): ${it.criterion.slice(0, 400)}\n  Verify: ${verifyRef(it, ctxRel, limit)}`).join('\n'), 1);
    const project = core.readIf(path.join(root, core.JDI_DIR, 'PROJECT.md')) || '';
    const stack = section(project, /^stack/i);
    const design = section(project, /^code design/i);
    b.add('Stack and code design (PROJECT.md)', [stack?.body, design?.body].filter(Boolean).join('\n\n'), 2);
    const spec = core.readIf(path.join(root, core.JDI_DIR, 'specialists.md'));
    if (spec) b.add('Specialists (routing by file glob)', spec.split('\n').filter((l) => l.startsWith('|')).join('\n'), 2);
    b.add('Learnings of the last shipped phases (turn recurring ones into acceptance criteria)', learn(), 4);
    b.add('Known errors to plan around (judgment only)', ke('plan', []), 5);
  } else if (role === 'asker') {
    const project = core.readIf(path.join(root, core.JDI_DIR, 'PROJECT.md')) || '';
    for (const re of [/^vision/i, /^stack/i, /^code design/i, /^global constraints/i]) {
      const s = section(project, re);
      if (s) b.add(`PROJECT.md — ${s.title}`, s.body, 1);
    }
    const entry = core.readIf(path.join(root, core.JDI_DIR, 'roadmap', `${phase.slug}.md`));
    if (entry) b.add('Roadmap entry', core.splitFrontmatter(entry).body.trim(), 0);
    const recent = decisions.select(allDecisions, { recent: 2 });
    b.add('Locked decisions (init + 2 most recent phases; full text: `.jdi/decisions/<ID>.md`)', decisions.render(recent, { index: true, maxChars: 6000 }), 3);
    b.add('Known errors to avoid when writing the DoD (judgment only)', ke('discuss', []), 5);
    b.add('DoD schema', 'Read `.jdi/cache/dod-schema.md` (written by /jdi-discuss). A `Verify:` longer than one short command goes to `' + phase.dir + '/verify/dod-N.sh`.', 0);
  } else if (role === 'critic') {
    const preflight = Boolean(opts.preflight);
    const changedRows = opts.rows ? opts.rows.split(',').map((x) => Number(x.trim())).filter(Boolean) : null;
    const rows = doc.items.filter((it) => it.type === 'auto' && (!changedRows || changedRows.includes(it.id)));
    b.add('Mode', preflight ? 'PREFLIGHT — before code: for each row, list the mutations its Verify must fail and what it does not cover yet.' : `VERIFY — re-examine only the rows below (${rows.length}); the others were examined at an unchanged Verify or already spent their hollow-proof block.`, 0);
    b.add(`Rows to examine (${ctxRel})`, rows.map((it) => `- DoD ${it.id}: ${it.criterion.slice(0, 500)}\n  Verify: ${verifyRef(it, ctxRel, 2000)}`).join('\n'), 0);
    b.add('Known errors about hollow proofs (judgment only — lint already blocks the mechanized ones)', ke('critic', []), 4);
  } else {
    throw new core.JdiError(`unknown role '${role}' (doer, reviewer, planner, asker, critic)`, 1);
  }
  return b.render();
}

function defaultOut(root, phase, opts) {
  const suffix = opts.task ? `-${opts.task}` : opts.stack ? `-${opts.stack}` : opts.preflight ? '-preflight' : '';
  return path.join(root, core.JDI_DIR, 'cache', 'briefs', phase.slug, `${opts.role}${suffix}.md`);
}

function main(argv) {
  const opts = { runtime: 'claude' };
  let id = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--role') opts.role = v();
    else if (a === '--task') opts.task = v();
    else if (a === '--stack') opts.stack = v();
    else if (a === '--runtime') opts.runtime = v();
    else if (a === '--out') opts.out = v();
    else if (a === '--base') opts.base = v();
    else if (a === '--rows') opts.rows = v();
    else if (a === '--preflight') opts.preflight = true;
    else if (a === '--print') opts.print = true;
    else if (a.startsWith('--')) throw new core.JdiError(`unknown flag: ${a}`, 1);
    else id = a;
  }
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
  console.log(`${path.relative(root, out).split(path.sep).join('/')} (~${r.tokens} tokens${r.dropped.length ? `; left out: ${r.dropped.join(', ')}` : ''})`);
  return 0;
}

module.exports = { main, build, parseTasks, expandBraces, sections };
