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

function next(root = process.cwd(), { id, loop } = {}) {
  if (!fs.existsSync(path.join(root, core.JDI_DIR))) return { next: null, reason: 'Not a JDI project yet: /jdi-new "<short description>" (or /jdi-adopt).' };
  let phase;
  if (id) phase = core.resolvePhase(id, root);
  else {
    for (const p of core.listPhases(root)) {
      const r = core.resolvePhase(String(p.position), root);
      if (!fs.existsSync(path.join(r.absDir, 'SHIPPED.md'))) {
        phase = r;
        break;
      }
    }
    if (!phase) return { next: null, reason: 'All phases shipped. Add more with /jdi-add-phase.' };
  }
  const d = derive(phase);
  const config = core.loadConfig(root);
  const loopMode = loop || config.orchestration?.next_execution === 'loop';
  let cmd;
  let reason = '';
  if (!hasSpecialists(root)) {
    cmd = 'jdi-bootstrap';
    reason = 'specialists missing';
  } else if (d.status === 'done') return { slug: phase.slug, position: phase.position, dir: phase.dir, ...d, next: null, reason: `Phase ${phase.slug} already shipped.` };
  else if (d.status === 'verified') {
    if (!d.verdict) {
      cmd = 'jdi-verify';
      reason = 'REVIEW.md has no verdict';
    } else if (d.verdict === 'BLOCKED') cmd = 'jdi-do';
    else if (d.verdict === 'APPROVED_PENDING_MANUAL') cmd = 'jdi-confirm-dod';
    else cmd = 'jdi-ship';
  } else if (d.status === 'executed') cmd = 'jdi-verify';
  else if (d.status === 'planned') cmd = 'jdi-do';
  else if (d.status === 'discussed') cmd = 'jdi-plan';
  else cmd = 'jdi-discuss';
  if (loopMode && (cmd === 'jdi-do' || cmd === 'jdi-verify')) cmd = 'jdi-loop';
  const loopFile = path.join(phase.absDir, 'LOOP.md');
  const loopStatus = fs.existsSync(loopFile) ? (/^status:\s*(\S+)/m.exec(fs.readFileSync(loopFile, 'utf8')) || [])[1] : null;
  return { slug: phase.slug, position: phase.position, dir: phase.dir, ...d, loop: loopStatus, next: cmd === 'jdi-bootstrap' ? '/jdi-bootstrap' : `/${cmd} ${phase.slug}`, reason };
}

function projectSlug(root) {
  const p = core.readIf(path.join(root, core.JDI_DIR, 'PROJECT.md'));
  const m = /^## Slug\s*\n(?:\s*\n)*\s*(\S+)/m.exec(p || '');
  if (m) return m[1];
  return (/^project_slug:\s*(\S+)/m.exec(core.readIf(path.join(root, core.JDI_DIR, 'STATE.md')) || '') || [])[1] || path.basename(root);
}

function phaseName(root, phase) {
  const entry = path.join(root, core.JDI_DIR, 'roadmap', `${phase.slug}.md`);
  if (fs.existsSync(entry)) return String(core.readFrontmatter(entry).name || phase.slug);
  const roadmap = core.readIf(path.join(root, core.JDI_DIR, 'ROADMAP.md')) || '';
  const m = new RegExp(`^### Phase ${phase.position}:\\s*(.+)$`, 'm').exec(roadmap);
  return m ? m[1].trim() : phase.slug;
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
      return first(/^\*\*(Veredicto|Verdict):\*\*.*$/m).replace(/\*\*/g, '');
    case 'SUMMARY.md':
      return first(/^\*\*(Status|Tasks):\*\*.*$/m).replace(/\*\*/g, '');
    case 'PLAN.md':
      return [first(/Total tasks:\s*\d+/), first(/Waves:\s*\d+/)].filter(Boolean).join(', ');
    case 'CONTEXT.md':
      return ((/^## Goal\s*\n+(.+)$/m.exec(t) || [])[1] || '').trim();
    default:
      return '';
  }
}

function status(root = process.cwd(), opts = {}) {
  const n = next(root, opts);
  if (!fs.existsSync(path.join(root, core.JDI_DIR))) return { ...n, project: null };
  const list = core.listPhases(root);
  const shipped = list.filter((p) => fs.existsSync(path.join(core.resolvePhase(String(p.position), root).absDir, 'SHIPPED.md'))).length;
  const out = { ...n, project: projectSlug(root), total: list.length, shipped, todos: todoCount(root) };
  const phase = n.slug ? core.resolvePhase(n.slug, root) : list.length ? core.resolvePhase(String(list.length), root) : null;
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

function renderStatus(s) {
  const bar = '═'.repeat(50);
  const L = ['', bar, '  JDI status', bar];
  if (!s.project) return [...L, `  ${s.reason}`, bar].join('\n');
  L.push(`  Project:        ${s.project}`);
  if (s.slug) {
    L.push(`  Phase:          ${s.position}/${s.total} — ${s.name} (slug: ${s.slug})`);
    L.push(`  Phase status:   ${s.status || 'done'}`);
    L.push(`  Verdict:        ${s.verdict || '—'}`);
  }
  L.push(`  Shipped:        ${s.shipped}/${s.total} phases`, '');
  if (s.last_artifact) L.push(`  Last artifact:  ${s.last_artifact.file}`, `                  ${s.last_artifact.headline || ''}`.trimEnd());
  else if (s.slug) L.push('  Last artifact:  (none — phase has not started)');
  if (s.loop) L.push(`  Ralph loop:     ${s.loop}`);
  if (s.todos) L.push(`  Todos backlog:  ${s.todos} item(s) in .jdi/todos (captured creep — review at /jdi-discuss)`);
  L.push('', `  Last commit:    ${s.last_commit}`, `  Commits today:  ${s.commits_today}`, '', bar);
  L.push(`  Next step:      ${s.next || s.reason}`, bar);
  return L.join('\n');
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
