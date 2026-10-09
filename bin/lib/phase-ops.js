'use strict';

// Deterministic phase operations the commands used to run as prose:
//
//   jdi-cli add-phase "<name>" [--slug s] [--goal g] [--reason r]
//                     [--before <slug> | --after <slug>] [--unique]   (layout v3)
//   --unique: a taken slug gets -2, -3 … instead of exit 3 (unattended intake)
//   jdi-cli ship <phase> [--learnings-file <f>] [--no-archive] [--allow-stale "<reason>"]
//
// add-phase stamps `created_with: <version>` in the roadmap entry — the budget
// rules of 0.17+ apply only to phases created from then on.
// ship refuses BLOCKED / pending-manual phases and a stale review (product
// files changed after the verify commit; exit 4 — `--allow-stale` records the
// reason in SHIPPED.md), writes SHIPPED.md (learnings:
// at most 5 one-line bullets, from the file the command's model wrote), updates
// the advisory STATE.md and runs the archive compaction (config
// compaction.archive_after; 0 = off). It prints JSON with the paths to commit.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const review = require('./review');

const VERSION = require('../../package.json').version;
const RESERVED = new Set('current all none archive removed history latest pending ready done blocked partial'.split(' '));

function validateSlug(slug, root) {
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(slug) || slug.includes('--') || slug.endsWith('-')) {
    throw new core.JdiError(`slug '${slug}' invalid shape (lowercase a-z0-9-, start with a letter, 3-40 chars, no '--', no trailing '-')`, 1);
  }
  if (RESERVED.has(slug)) throw new core.JdiError(`slug '${slug}' is reserved (JDI keyword)`, 2);
  if (fs.existsSync(path.join(root, core.JDI_DIR, 'roadmap', `${slug}.md`))) throw new core.JdiError(`slug '${slug}' already in the roadmap`, 3);
  const phases = path.join(root, core.JDI_DIR, 'phases');
  const hits = fs.existsSync(phases) ? fs.readdirSync(phases).filter((d) => d === slug || d.replace(/^\d+-/, '') === slug) : [];
  if (hits.length > 1) throw new core.JdiError(`ambiguous existing folders for slug '${slug}': ${hits.join(' ')} (repo state corrupt — run /jdi-migrate-phases)`, 4);
  if (hits.length) throw new core.JdiError(`slug '${slug}' already exists (folder: ${hits[0]})`, 3);
}

// Strip leading/trailing '-' (index scan instead of an unanchored regex).
function trimDashes(s) {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '-') a++;
  while (b > a && s[b - 1] === '-') b--;
  return s.slice(a, b);
}

function slugify(name) {
  const base = trimDashes(name.toLowerCase().normalize('NFD').replaceAll(/[̀-ͯ]/g, '').replaceAll(/[^a-z0-9]+/g, '-'));
  const s = trimDashes(base.slice(0, 40));
  return /^\d/.test(s) ? trimDashes(`phase-${s}`.slice(0, 40)) : s;
}

function orders(root) {
  const d = path.join(root, core.JDI_DIR, 'roadmap');
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('LEGACY'))
    .map((f) => ({ slug: f.slice(0, -3), order: Number(core.readFrontmatter(path.join(d, f)).order ?? 999999) }))
    .sort((a, b) => a.order - b.order || core.compareStr(a.slug, b.slug));
}

function currentPosition(root) {
  for (const p of core.listPhases(root)) {
    const r = core.resolvePhase(String(p.position), root);
    if (!fs.existsSync(path.join(r.absDir, 'SHIPPED.md'))) return p.position;
  }
  return Infinity;
}

function uniqueSlug(base, root) {
  for (let n = 1; n < 10; n++) {
    const cand = n === 1 ? base : `${trimDashes(base.slice(0, 40 - String(n).length - 1))}-${n}`;
    try {
      validateSlug(cand, root);
      return cand;
    } catch (e) {
      if (e.code !== 3) throw e;
    }
  }
  throw new core.JdiError(`slug '${base}' and its -2..-9 variants are all taken`, 3);
}

// Fractional order for the new entry: append, or the midpoint next to an anchor.
function newOrder(root, list, before, after) {
  if (!before && !after) return (list.length ? Math.max(...list.map((e) => e.order).filter((o) => o < 999999)) : 0) + 1;
  const anchor = before || after;
  const idx = list.findIndex((e) => e.slug === anchor);
  if (idx === -1) throw new core.JdiError(`anchor slug '${anchor}' not found`, 1);
  const insertPos = before ? idx + 1 : idx + 2;
  const current = currentPosition(root);
  if (current !== Infinity && insertPos <= current) {
    throw new core.JdiError(`cannot insert at position ${insertPos}: shipped and current phases are history`, 1);
  }
  if (before) return idx > 0 ? (list[idx - 1].order + list[idx].order) / 2 : list[idx].order - 1;
  return idx < list.length - 1 ? (list[idx].order + list[idx + 1].order) / 2 : list[idx].order + 1;
}

// The optional audit decision; returns its path when written.
function writeAddDecision(root, name, slug, reason) {
  const date = new Date().toISOString().slice(0, 10);
  const id = `D-${date}-${slug}-1`;
  const df = path.join(root, core.JDI_DIR, 'decisions', `${id}.md`);
  if (fs.existsSync(df)) return null;
  core.writeFileEnsured(df, `${id}: Phase '${name}' (slug: ${slug}) added. Reason: ${reason}.\n`, root);
  return df;
}

function addPhase(root, { name, slug, goal, reason, before, after, unique = false }) {
  if (!fs.existsSync(path.join(root, core.JDI_DIR, 'roadmap'))) {
    throw new core.JdiError('legacy layout (no .jdi/roadmap/): follow the legacy steps of /jdi-add-phase, or run `jdi-cli migrate-layout` first', 3);
  }
  if (!name) throw new core.JdiError('phase name required', 1);
  let s = slug || slugify(name);
  if (unique) s = uniqueSlug(s, root);
  else validateSlug(s, root);
  const order = newOrder(root, orders(root), before, after);
  const entry = ['---', `order: ${Number(order.toFixed(6))}`, `name: ${name}`, `created_with: ${VERSION}`, '---', `- **Slug:** ${s}`, `- **Goal:** ${goal || name}`, ''].join('\n');
  const file = path.join(root, core.JDI_DIR, 'roadmap', `${s}.md`);
  fs.writeFileSync(file, entry);
  const written = [file, reason ? writeAddDecision(root, name, s, reason) : null].filter(Boolean);
  return { slug: s, order, files: written.map((p) => path.relative(root, p).split(path.sep).join('/')) };
}

function readLearnings(file) {
  if (!file) return [];
  const bullets = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.replace(/\s+/g, ' '));
  if (bullets.length > 5) throw new core.JdiError(`learnings: ${bullets.length} bullets — at most 5, one line each`, 1);
  return bullets;
}

// The verdict a shippable phase carries; throws on anything else.
function shippableVerdict(phase, text) {
  const v = review.verdictOf(text);
  if (!v.verdict) throw new core.JdiError(`no verdict in ${phase.dir}/REVIEW.md — re-run /jdi-verify (never ship on silence)`, 1);
  if (v.verdict === 'BLOCKED') throw new core.JdiError(`phase ${phase.slug} is BLOCKED — fix before ship`, 1);
  const pending = review.manualPending(text);
  if (v.verdict === 'APPROVED_PENDING_MANUAL' || pending > 0) throw new core.JdiError(`${pending || '?'} manual DoD item(s) unconfirmed — /jdi-confirm-dod ${phase.slug}`, 1);
  return v.verdict;
}

// advisory STATE.md (untracked cache)
function writeState(root, phase, nextPhase) {
  const state = nextPhase
    ? `current_phase: ${nextPhase.position}\ncurrent_phase_slug: ${nextPhase.slug}\nphase_status: ready\nnext_step: /jdi-discuss ${nextPhase.slug}\n`
    : `current_phase: ${phase.position}\ncurrent_phase_slug: ${phase.slug}\nphase_status: complete\nall_phases_complete: true\nnext_step: project delivered\n`;
  fs.writeFileSync(path.join(root, core.JDI_DIR, 'STATE.md'), state);
}

// archive compaction: shipped phases older than `archive_after` leave phases/
function archiveOld(root, phase, list) {
  const moved = [];
  const archiveAfter = Number(core.loadConfig(root).compaction?.archive_after ?? 5);
  if (archiveAfter <= 0) return moved;
  const threshold = phase.position + 1 - archiveAfter;
  for (const p of list.filter((x) => x.position <= threshold)) {
    const r = core.resolvePhase(String(p.position), root);
    const dest = path.join(root, core.JDI_DIR, 'archive', path.basename(r.absDir));
    if (!r.exists || !fs.existsSync(path.join(r.absDir, 'SHIPPED.md')) || fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(r.absDir, dest);
    moved.push({ from: r.dir, to: path.relative(root, dest).split(path.sep).join('/') });
  }
  return moved;
}

// The review must describe the code being shipped (see review.staleness).
function freshness(root, phase, allowStale) {
  const fresh = review.staleness(phase, root);
  if (!fresh.stale) return null;
  if (!allowStale) {
    const shown = fresh.files.slice(0, 3).join(', ') + (fresh.files.length > 3 ? ', ...' : '');
    throw new core.JdiError(`the review is stale: ${fresh.files.length} product file(s) changed after the verify commit ${fresh.since.slice(0, 10)} (${shown}) — /jdi-verify ${phase.slug}, or ship with --allow-stale "<reason>"`, 4);
  }
  return `stale_review: ${fresh.files.length} product file(s) changed after ${fresh.since.slice(0, 10)} — ${String(allowStale).replaceAll(/\s+/g, ' ')}`;
}

function ship(root, phase, { learningsFile, archive = true, allowStale = null } = {}) {
  const shipped = path.join(phase.absDir, 'SHIPPED.md');
  if (fs.existsSync(shipped)) return { status: 'already-shipped', phase: phase.slug };
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  if (!fs.existsSync(reviewFile)) throw new core.JdiError(`REVIEW.md missing — /jdi-verify ${phase.slug}`, 1);
  const verdict = shippableVerdict(phase, fs.readFileSync(reviewFile, 'utf8'));
  const staleNote = freshness(root, phase, allowStale);
  const learnings = readLearnings(learningsFile);
  const by = core.git(['config', 'user.name'], root).stdout || 'unknown';
  const body = [`shipped_at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`, `verdict: ${verdict}`, `by: ${by}`];
  if (staleNote) body.push(staleNote);
  if (learnings.length) body.push('', '## Learnings', ...learnings);
  fs.writeFileSync(shipped, body.join('\n') + '\n');
  const list = core.listPhases(root);
  const nextPhase = list.find((p) => p.position === phase.position + 1);
  writeState(root, phase, nextPhase);
  const moved = archive ? archiveOld(root, phase, list) : [];
  return { status: 'shipped', phase: phase.slug, verdict, learnings: learnings.length, next: nextPhase ? nextPhase.slug : null, files: [path.relative(root, shipped).split(path.sep).join('/')], archived: moved };
}

function main(cmd, argv) {
  const root = process.cwd();
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const valued = new Set(['--slug', '--goal', '--reason', '--before', '--after', '--learnings-file', '--allow-stale']);
  const first = argv.find((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  let out;
  if (cmd === 'add-phase') {
    if (argv.some((a) => a === '--at' || a.startsWith('--at='))) throw new core.JdiError('--at <N> is not supported on layout v3 (positions are mutable across branches): use --before <slug> or --after <slug>', 1);
    out = addPhase(root, { name: first, slug: opt('--slug'), goal: opt('--goal'), reason: opt('--reason'), before: opt('--before'), after: opt('--after'), unique: argv.includes('--unique') });
  } else if (cmd === 'ship') {
    if (!first) throw new core.JdiError('usage: jdi ship <phase> [--learnings-file f] [--no-archive]', 1);
    out = ship(root, core.resolvePhase(first, root), { learningsFile: opt('--learnings-file'), archive: !argv.includes('--no-archive'), allowStale: opt('--allow-stale') || null });
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  return 0;
}

module.exports = { main, addPhase, ship, validateSlug, slugify };
