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

function slugify(name) {
  let s = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (/^[0-9]/.test(s)) s = `phase-${s}`.slice(0, 40).replace(/-+$/, '');
  return s;
}

function orders(root) {
  const d = path.join(root, core.JDI_DIR, 'roadmap');
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('LEGACY'))
    .map((f) => ({ slug: f.slice(0, -3), order: Number(core.readFrontmatter(path.join(d, f)).order ?? 999999) }))
    .sort((a, b) => a.order - b.order || (a.slug < b.slug ? -1 : 1));
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
    const cand = n === 1 ? base : `${base.slice(0, 40 - String(n).length - 1).replace(/-+$/, '')}-${n}`;
    try {
      validateSlug(cand, root);
      return cand;
    } catch (e) {
      if (e.code !== 3) throw e;
    }
  }
  throw new core.JdiError(`slug '${base}' and its -2..-9 variants are all taken`, 3);
}

function addPhase(root, { name, slug, goal, reason, before, after, unique = false }) {
  if (!fs.existsSync(path.join(root, core.JDI_DIR, 'roadmap'))) {
    throw new core.JdiError('legacy layout (no .jdi/roadmap/): follow the legacy steps of /jdi-add-phase, or run `jdi-cli migrate-layout` first', 3);
  }
  if (!name) throw new core.JdiError('phase name required', 1);
  let s = slug || slugify(name);
  if (unique) s = uniqueSlug(s, root);
  else validateSlug(s, root);
  const list = orders(root);
  let order;
  if (before || after) {
    const anchor = before || after;
    const idx = list.findIndex((e) => e.slug === anchor);
    if (idx === -1) throw new core.JdiError(`anchor slug '${anchor}' not found`, 1);
    const insertPos = before ? idx + 1 : idx + 2;
    if (insertPos <= currentPosition(root) && currentPosition(root) !== Infinity) {
      throw new core.JdiError(`cannot insert at position ${insertPos}: shipped and current phases are history`, 1);
    }
    if (before) order = idx > 0 ? (list[idx - 1].order + list[idx].order) / 2 : list[idx].order - 1;
    else order = idx < list.length - 1 ? (list[idx].order + list[idx + 1].order) / 2 : list[idx].order + 1;
  } else order = (list.length ? Math.max(...list.map((e) => e.order).filter((o) => o < 999999)) : 0) + 1;
  const entry = ['---', `order: ${Number(order.toFixed(6))}`, `name: ${name}`, `created_with: ${VERSION}`, '---', `- **Slug:** ${s}`, `- **Goal:** ${goal || name}`, ''].join('\n');
  const file = path.join(root, core.JDI_DIR, 'roadmap', `${s}.md`);
  fs.writeFileSync(file, entry);
  const written = [path.relative(root, file)];
  if (reason) {
    const date = new Date().toISOString().slice(0, 10);
    const id = `D-${date}-${s}-1`;
    const df = path.join(root, core.JDI_DIR, 'decisions', `${id}.md`);
    if (!fs.existsSync(df)) {
      core.writeFileEnsured(df, `${id}: Phase '${name}' (slug: ${s}) added. Reason: ${reason}.\n`, root);
      written.push(path.relative(root, df));
    }
  }
  return { slug: s, order, files: written.map((p) => p.split(path.sep).join('/')) };
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

function ship(root, phase, { learningsFile, archive = true, allowStale = null } = {}) {
  const shipped = path.join(phase.absDir, 'SHIPPED.md');
  if (fs.existsSync(shipped)) return { status: 'already-shipped', phase: phase.slug };
  const reviewFile = path.join(phase.absDir, 'REVIEW.md');
  if (!fs.existsSync(reviewFile)) throw new core.JdiError(`REVIEW.md missing — /jdi-verify ${phase.slug}`, 1);
  const text = fs.readFileSync(reviewFile, 'utf8');
  const v = review.verdictOf(text);
  if (!v.verdict) throw new core.JdiError(`no verdict in ${phase.dir}/REVIEW.md — re-run /jdi-verify (never ship on silence)`, 1);
  if (v.verdict === 'BLOCKED') throw new core.JdiError(`phase ${phase.slug} is BLOCKED — fix before ship`, 1);
  const pending = review.manualPending(text);
  if (v.verdict === 'APPROVED_PENDING_MANUAL' || pending > 0) throw new core.JdiError(`${pending || '?'} manual DoD item(s) unconfirmed — /jdi-confirm-dod ${phase.slug}`, 1);
  const fresh = review.staleness(phase, root);
  if (fresh.stale && !allowStale) {
    throw new core.JdiError(`the review is stale: ${fresh.files.length} product file(s) changed after the verify commit ${fresh.since.slice(0, 10)} (${fresh.files.slice(0, 3).join(', ')}${fresh.files.length > 3 ? ', ...' : ''}) — /jdi-verify ${phase.slug}, or ship with --allow-stale "<reason>"`, 4);
  }
  const learnings = readLearnings(learningsFile);
  const by = core.git(['config', 'user.name'], root).stdout || 'unknown';
  const body = [`shipped_at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`, `verdict: ${v.verdict}`, `by: ${by}`];
  if (fresh.stale) body.push(`stale_review: ${fresh.files.length} product file(s) changed after ${fresh.since.slice(0, 10)} — ${String(allowStale).replace(/\s+/g, ' ')}`);
  if (learnings.length) body.push('', '## Learnings', ...learnings);
  fs.writeFileSync(shipped, body.join('\n') + '\n');
  const files = [path.relative(root, shipped)];

  // advisory STATE.md (untracked cache)
  const list = core.listPhases(root);
  const nextPhase = list.find((p) => p.position === phase.position + 1);
  const state = nextPhase
    ? `current_phase: ${nextPhase.position}\ncurrent_phase_slug: ${nextPhase.slug}\nphase_status: ready\nnext_step: /jdi-discuss ${nextPhase.slug}\n`
    : `current_phase: ${phase.position}\ncurrent_phase_slug: ${phase.slug}\nphase_status: complete\nall_phases_complete: true\nnext_step: project delivered\n`;
  fs.writeFileSync(path.join(root, core.JDI_DIR, 'STATE.md'), state);

  // archive compaction
  const moved = [];
  const archiveAfter = Number(core.loadConfig(root).compaction?.archive_after ?? 5);
  if (archive && archiveAfter > 0) {
    const threshold = phase.position + 1 - archiveAfter;
    for (const p of list) {
      if (p.position > threshold) continue;
      const r = core.resolvePhase(String(p.position), root);
      if (!r.exists || !fs.existsSync(path.join(r.absDir, 'SHIPPED.md'))) continue;
      const dest = path.join(root, core.JDI_DIR, 'archive', path.basename(r.absDir));
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(r.absDir, dest);
      moved.push({ from: r.dir, to: path.relative(root, dest).split(path.sep).join('/') });
    }
  }
  return { status: 'shipped', phase: phase.slug, verdict: v.verdict, learnings: learnings.length, next: nextPhase ? nextPhase.slug : null, files: files.map((f) => f.split(path.sep).join('/')), archived: moved };
}

function main(cmd, argv) {
  const root = process.cwd();
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const valued = new Set(['--slug', '--goal', '--reason', '--before', '--after', '--learnings-file', '--allow-stale']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  let out;
  if (cmd === 'add-phase') {
    if (argv.some((a) => a === '--at' || a.startsWith('--at='))) throw new core.JdiError('--at <N> is not supported on layout v3 (positions are mutable across branches): use --before <slug> or --after <slug>', 1);
    out = addPhase(root, { name: positional[0], slug: opt('--slug'), goal: opt('--goal'), reason: opt('--reason'), before: opt('--before'), after: opt('--after'), unique: argv.includes('--unique') });
  } else if (cmd === 'ship') {
    if (!positional[0]) throw new core.JdiError('usage: jdi ship <phase> [--learnings-file f] [--no-archive]', 1);
    out = ship(root, core.resolvePhase(positional[0], root), { learningsFile: opt('--learnings-file'), archive: !argv.includes('--no-archive'), allowStale: opt('--allow-stale') || null });
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  return 0;
}

module.exports = { main, addPhase, ship, validateSlug, slugify };
