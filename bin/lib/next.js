'use strict';

// `jdi-cli next [phase] [--loop] [--json] [--status]` — where the project is
// and which command comes next, derived from the artifacts alone (same ladder
// as /jdi-next and /jdi-status, as one deterministic call instead of a loop of
// shell steps the orchestrator executes and reads turn by turn).
//
// Output (text): `/<command> <slug>` — or a sentence when nothing can run.
// --json: { slug, position, dir, status, verdict, loop, next, reason }
// --status: the whole /jdi-status screen (project, phase, last artifact and
//   its headline, loop, todos, last commit, next step). Read-only.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const review = require('./review');

function hasSpecialists(root) {
  const d = path.join(root, core.JDI_DIR, 'agents');
  return fs.existsSync(d) && fs.readdirSync(d).some((f) => /^jdi-doer-.*\.md$/.test(f));
}

function derive(phase) {
  const has = (f) => fs.existsSync(path.join(phase.absDir, f));
  if (has('SHIPPED.md')) return { status: 'done' };
  if (has('REVIEW.md')) {
    const v = review.verdictOf(fs.readFileSync(path.join(phase.absDir, 'REVIEW.md'), 'utf8'));
    return { status: 'verified', verdict: v.verdict };
  }
  if (has('SUMMARY.md')) return { status: 'executed' };
  if (has('PLAN.md')) return { status: 'planned' };
  if (has('CONTEXT.md')) return { status: 'discussed' };
  return { status: 'pending' };
}

// First roadmap phase without SHIPPED.md, or null when all are shipped.
function currentPhase(root) {
  for (const p of core.listPhases(root)) {
    const r = core.resolvePhase(String(p.position), root);
    if (!fs.existsSync(path.join(r.absDir, 'SHIPPED.md'))) return r;
  }
  return null;
}

const BY_VERDICT = { BLOCKED: 'jdi-do', APPROVED_PENDING_MANUAL: 'jdi-confirm-dod' };
const BY_STATUS = { executed: 'jdi-verify', planned: 'jdi-do', discussed: 'jdi-plan' };

// The command for a derived phase status: [command, reason].
function commandFor(d) {
  if (d.status !== 'verified') return [BY_STATUS[d.status] || 'jdi-discuss', ''];
  if (!d.verdict) return ['jdi-verify', 'REVIEW.md has no verdict'];
  return [BY_VERDICT[d.verdict] || 'jdi-ship', ''];
}

function loopStatusOf(phase) {
  const loopFile = path.join(phase.absDir, 'LOOP.md');
  if (!fs.existsSync(loopFile)) return null;
  return (/^status:\s*(\S+)/m.exec(fs.readFileSync(loopFile, 'utf8')) || [])[1];
}

function next(root = process.cwd(), { id, loop } = {}) {
  if (!fs.existsSync(path.join(root, core.JDI_DIR))) return { next: null, reason: 'Not a JDI project yet: /jdi-new "<short description>" (or /jdi-adopt).' };
  const phase = id ? core.resolvePhase(id, root) : currentPhase(root);
  if (!phase) return { next: null, reason: 'All phases shipped. Add more with /jdi-add-phase.' };
  const d = derive(phase);
  const where = { slug: phase.slug, position: phase.position, dir: phase.dir, ...d };
  if (!hasSpecialists(root)) return { ...where, loop: loopStatusOf(phase), next: '/jdi-bootstrap', reason: 'specialists missing' };
  if (d.status === 'done') return { ...where, next: null, reason: `Phase ${phase.slug} already shipped.` };
  let [cmd, reason] = commandFor(d);
  const loopMode = loop || core.loadConfig(root).orchestration?.next_execution === 'loop';
  if (loopMode && (cmd === 'jdi-do' || cmd === 'jdi-verify')) cmd = 'jdi-loop';
  return { ...where, loop: loopStatusOf(phase), next: `/${cmd} ${phase.slug}`, reason };
}

// First non-blank line after the line `heading`, or null.
function lineAfter(text, heading) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) return null;
  return lines.slice(i + 1).find((l) => l.trim()) ?? null;
}

function projectSlug(root) {
  const slugLine = lineAfter(core.readIf(path.join(root, core.JDI_DIR, 'PROJECT.md')) || '', '## Slug');
  if (slugLine) return slugLine.trim().split(/\s/)[0];
  return (/^project_slug:\s*(\S+)/m.exec(core.readIf(path.join(root, core.JDI_DIR, 'STATE.md')) || '') || [])[1] || path.basename(root);
}

function phaseName(root, phase) {
  const entry = path.join(root, core.JDI_DIR, 'roadmap', `${phase.slug}.md`);
  if (fs.existsSync(entry)) return String(core.readFrontmatter(entry).name || phase.slug);
  const prefix = `### Phase ${phase.position}:`;
  const line = (core.readIf(path.join(root, core.JDI_DIR, 'ROADMAP.md')) || '').split('\n').find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() || phase.slug : phase.slug;
}

function todoCount(root) {
  const d = path.join(root, core.JDI_DIR, 'todos');
  const texts = fs.existsSync(d)
    ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(d, f), 'utf8'))
    : [core.readIf(path.join(root, core.JDI_DIR, 'todos.md')) || ''];
  return texts.reduce((n, t) => n + (t.match(/^- /gm) || []).length, 0);
}

function headline(file, name) {
  const t = fs.readFileSync(file, 'utf8');
  const first = (re) => (re.exec(t) || [])[0] || '';
  switch (name) {
    case 'SHIPPED.md':
      return t.split('\n').slice(0, 2).join(' ').trim();
    case 'REVIEW.md':
      return first(/^\*\*(Veredicto|Verdict):\*\*.*$/m).replaceAll('**', '');
    case 'SUMMARY.md':
      return first(/^\*\*(Status|Tasks):\*\*.*$/m).replaceAll('**', '');
    case 'PLAN.md':
      return [first(/Total tasks:\s*\d+/), first(/Waves:\s*\d+/)].filter(Boolean).join(', ');
    case 'CONTEXT.md':
      return (lineAfter(t, '## Goal') || '').trim();
    default:
      return '';
  }
}

// The phase the status screen describes: the current one, else the last.
function statusPhase(root, n, list) {
  if (n.slug) return core.resolvePhase(n.slug, root);
  return list.length ? core.resolvePhase(String(list.length), root) : null;
}

function status(root = process.cwd(), opts = {}) {
  const n = next(root, opts);
  if (!fs.existsSync(path.join(root, core.JDI_DIR))) return { ...n, project: null };
  const list = core.listPhases(root);
  const shipped = list.filter((p) => fs.existsSync(path.join(core.resolvePhase(String(p.position), root).absDir, 'SHIPPED.md'))).length;
  const out = { ...n, project: projectSlug(root), total: list.length, shipped, todos: todoCount(root) };
  const phase = statusPhase(root, n, list);
  if (phase) {
    out.slug = phase.slug;
    out.position = phase.position;
    out.dir = phase.dir;
    out.name = phaseName(root, phase);
    const last = ['SHIPPED.md', 'REVIEW.md', 'SUMMARY.md', 'PLAN.md', 'CONTEXT.md'].find((f) => fs.existsSync(path.join(phase.absDir, f)));
    if (last) out.last_artifact = { file: `${phase.dir}/${last}`, headline: headline(path.join(phase.absDir, last), last) };
  }
  const log = core.git(['log', '-1', '--format=%h  %s'], root);
  out.last_commit = log.code === 0 && log.stdout ? log.stdout : '(no commits yet)';
  const today = core.git(['log', '--since=midnight', '--format=%h'], root);
  out.commits_today = today.code === 0 && today.stdout ? today.stdout.split('\n').length : 0;
  return out;
}

function artifactLines(s) {
  if (s.last_artifact) return [`  Last artifact:  ${s.last_artifact.file}`, `                  ${s.last_artifact.headline || ''}`.trimEnd()];
  return s.slug ? ['  Last artifact:  (none — phase has not started)'] : [];
}

function renderStatus(s) {
  const bar = '═'.repeat(50);
  const head = ['', bar, '  JDI status', bar];
  if (!s.project) return [...head, `  ${s.reason}`, bar].join('\n');
  const phase = s.slug ? [`  Phase:          ${s.position}/${s.total} — ${s.name} (slug: ${s.slug})`, `  Phase status:   ${s.status || 'done'}`, `  Verdict:        ${s.verdict || '—'}`] : [];
  return [
    ...head,
    `  Project:        ${s.project}`,
    ...phase,
    `  Shipped:        ${s.shipped}/${s.total} phases`,
    '',
    ...artifactLines(s),
    ...(s.loop ? [`  Ralph loop:     ${s.loop}`] : []),
    ...(s.todos ? [`  Todos backlog:  ${s.todos} item(s) in .jdi/todos (captured creep — review at /jdi-discuss)`] : []),
    '',
    `  Last commit:    ${s.last_commit}`,
    `  Commits today:  ${s.commits_today}`,
    '',
    bar,
    `  Next step:      ${s.next || s.reason}`,
    bar,
  ].join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const loop = argv.includes('--loop');
  const id = argv.find((a) => !a.startsWith('--'));
  if (argv.includes('--status')) {
    const s = status(process.cwd(), { id, loop });
    process.stdout.write((json ? JSON.stringify(s) : renderStatus(s)) + '\n');
    return 0;
  }
  const r = next(process.cwd(), { id, loop });
  if (json) process.stdout.write(JSON.stringify(r) + '\n');
  else process.stdout.write((r.next || r.reason) + '\n');
  return 0;
}

module.exports = { main, next, derive, status, renderStatus };
