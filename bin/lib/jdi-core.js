'use strict';

// jdi-core.js — shared, dependency-free helpers for the Node subcommands
// (cost, brief, gates, dod, review, loop, known-errors, ...).
//
// One implementation for every platform: the Node helpers replace the
// .sh/.ps1 twin pattern for new code, so there is no parity to drift (#48).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const JDI_DIR = '.jdi';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Defaults merged under .jdi/config.json. Budgets are in TOKENS, estimated
// with chars_per_token (measured: Claude tokenizes pt-BR JDI artifacts at
// 2.0-2.4 chars/token — the old "4 chars/token" heuristic undercounted 2x).
const CONFIG_DEFAULTS = {
  budgets: {
    context_tokens: 10000,
    plan_tokens: 12000,
    summary_tokens: 3000,
    review_segment_tokens: 6000,
    brief_tokens: 6000,
    known_errors_query_tokens: 2000,
    verify_inline_chars: 300,
    phase_extra_file_kb: 50,
    enforce: 'warn',
  },
  chars_per_token: { 'pt-BR': 2.2, en: 3.2 },
  models: {
    asker: 'inherit',
    planner: 'inherit',
    doer: 'inherit',
    reviewer: 'inherit',
    critic: 'inherit',
  },
  economy: {
    critic: 'lean',
    incremental_verify: true,
    wave_suite: true,
    sizing: true,
  },
  sizing: {
    lite_max_tasks: 3,
    lite_max_files: 6,
    lite_max_dod_rows: 6,
    sensitive_globs: [],
  },
  compaction: { archive_after: 5 },
  loop: { non_product_globs: [] },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function loadConfig(root = process.cwd()) {
  const raw = readJson(path.join(root, JDI_DIR, 'config.json'), {}) || {};
  return deepMerge(CONFIG_DEFAULTS, raw);
}

function projectLang(root = process.cwd()) {
  try {
    const v = fs.readFileSync(path.join(root, JDI_DIR, 'LANG'), 'utf8').replace(/^﻿/, '').trim();
    return v || 'en';
  } catch {
    return 'en';
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function charsPerToken(config, lang) {
  const table = config?.chars_per_token || CONFIG_DEFAULTS.chars_per_token;
  if (typeof table === 'number') return table;
  return table[lang] || table.en || 3.2;
}

function estimateTokens(text, ratio) {
  return Math.ceil([...String(text)].length / ratio);
}

// ---------------------------------------------------------------------------
// Frontmatter (the YAML subset JDI files use: scalars, lists, nested maps)
// ---------------------------------------------------------------------------

function splitFrontmatter(text) {
  const t = text.replace(/^﻿/, '');
  if (!t.startsWith('---\n') && !t.startsWith('---\r\n')) return { fm: '', body: t, hasFm: false };
  const lines = t.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') {
      return { fm: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n'), hasFm: true };
    }
  }
  return { fm: '', body: t, hasFm: false };
}

function parseScalar(v) {
  const s = v.trim();
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map((x) => parseScalar(x)).filter((x) => x !== '');
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const comment = s.search(/\s#/); // inline ` # comment`
  return comment === -1 ? s : s.slice(0, comment).trimEnd();
}

// Minimal YAML: indentation-based maps, `- scalar` lists, inline [a, b].
// (Lists of maps are not part of any JDI file format and are not supported.)
const isListItem = (text) => text === '-' || text.startsWith('- ');
const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => !line.trim() || line.trim().startsWith('#');

// Pop the containers the current line no longer belongs to.
function unwind(stack, indent, isItem) {
  while (stack.length > 1) {
    const top = stack.at(-1);
    const stays = top.type === 'list' ? (isItem && indent === top.itemIndent) || indent > top.itemIndent : indent > top.indent;
    if (stays) return;
    stack.pop();
  }
}

// `key:` with nothing after it opens a list or a map, decided by the next
// meaningful line.
function openContainer(stack, parent, key, lines, i, indent) {
  let j = i + 1;
  while (j < lines.length && isBlank(lines[j])) j++;
  const next = lines[j] || '';
  if (isListItem(next.trim()) && indentOf(next) >= indent) {
    parent.obj[key] = [];
    stack.push({ type: 'list', itemIndent: indentOf(next), obj: parent.obj[key] });
  } else {
    parent.obj[key] = {};
    stack.push({ type: 'map', indent, obj: parent.obj[key] });
  }
}

function parseYaml(src) {
  const root = {};
  const stack = [{ type: 'map', indent: -1, obj: root }];
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  lines.forEach((raw, i) => {
    if (isBlank(raw)) return;
    const text = raw.trim();
    const indent = indentOf(raw);
    const isItem = isListItem(text);
    unwind(stack, indent, isItem);
    const parent = stack.at(-1);
    if (isItem) {
      if (parent.type === 'list') parent.obj.push(parseScalar(text.slice(1)));
      return;
    }
    const m = /^([A-Za-z0-9_$.-]+):(.*)$/.exec(text);
    if (!m || parent.type !== 'map') return;
    const [, key, rest] = m;
    if (rest.trim() === '') openContainer(stack, parent, key, lines, i, indent);
    else parent.obj[key] = parseScalar(rest);
  });
  return root;
}

function readFrontmatter(file) {
  const { fm } = splitFrontmatter(fs.readFileSync(file, 'utf8'));
  return parseYaml(fm);
}

// ---------------------------------------------------------------------------
// Phases (Node port of jdi-resolve-phase.sh, layout v3 + legacy ROADMAP.md)
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,49}$/;

class JdiError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// Total order on strings without locale rules (stable across machines).
function compareStr(a, b) {
  return Number(a > b) - Number(a < b);
}

function entryOrder(file) {
  try {
    const fmo = readFrontmatter(file).order;
    if (typeof fmo === 'number') return fmo;
    if (fmo !== undefined && fmo !== '' && !Number.isNaN(Number(fmo))) return Number(fmo);
  } catch {
    // unreadable entry keeps the default order
  }
  return 999999;
}

function listV3(roadmapDir) {
  return fs
    .readdirSync(roadmapDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('LEGACY'))
    .map((f) => ({ slug: f.slice(0, -3), order: entryOrder(path.join(roadmapDir, f)) }))
    .sort((a, b) => a.order - b.order || compareStr(a.slug, b.slug))
    .map((e, i) => ({ slug: e.slug, rawSlug: e.slug, position: i + 1, layout: 3 }));
}

function listLegacy(roadmap) {
  const out = [];
  let current = null;
  for (const line of fs.readFileSync(roadmap, 'utf8').split('\n')) {
    const l = line.replace(/\r$/, '');
    const ph = /^### Phase (\d+)/.exec(l);
    const sl = ph ? null : /^- \*\*Slug:\*\*\s*(\S+)/.exec(l);
    if (ph) current = Number(ph[1]);
    else if (sl && current !== null) {
      out.push({ slug: sl[1].replace(/^\d+-/, ''), rawSlug: sl[1], position: current, layout: 1 });
      current = null;
    }
  }
  return out;
}

// Ordered list of { slug, rawSlug, position } for every roadmap phase.
function listPhases(root = process.cwd()) {
  const jdi = path.join(root, JDI_DIR);
  const roadmapDir = path.join(jdi, 'roadmap');
  if (fs.existsSync(roadmapDir) && fs.statSync(roadmapDir).isDirectory()) return listV3(roadmapDir);
  const roadmap = path.join(jdi, 'ROADMAP.md');
  if (!fs.existsSync(roadmap)) throw new JdiError('.jdi/ROADMAP.md not found (run /jdi-new first)', 3);
  return listLegacy(roadmap);
}

function phaseFolder(root, phase) {
  const phasesDir = path.join(root, JDI_DIR, 'phases');
  const nn = String(phase.position).padStart(2, '0');
  const candidates = [phase.slug, phase.rawSlug, `${nn}-${phase.slug}`];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(phasesDir, c))) return { dir: path.join(JDI_DIR, 'phases', c), exists: true };
  }
  if (fs.existsSync(phasesDir)) {
    const any = fs.readdirSync(phasesDir).filter((d) => d.endsWith(`-${phase.slug}`) && /^\d+-/.test(d));
    if (any.length === 1) return { dir: path.join(JDI_DIR, 'phases', any[0]), exists: true };
    if (any.length > 1) throw new JdiError(`multiple folder candidates for slug '${phase.slug}': ${any.join(', ')}`, 4);
  }
  return { dir: path.join(JDI_DIR, 'phases', phase.slug), exists: false };
}

function resolvePhase(id, root = process.cwd()) {
  if (!id) throw new JdiError('phase ID required (integer position or slug)', 1);
  const isInt = /^\d+$/.test(id);
  if (!isInt && !SLUG_RE.test(id)) throw new JdiError(`invalid phase ID '${id}'`, 1);
  const phases = listPhases(root);
  let phase;
  if (isInt) {
    phase = phases.find((p) => p.position === Number(id));
    if (!phase) throw new JdiError(`phase ${id} not found in ROADMAP`, 2);
  } else {
    const q = id.replace(/^\d+-/, '');
    phase = phases.find((p) => p.slug === q || p.rawSlug === id);
    if (!phase) throw new JdiError(`slug '${id}' not found in ROADMAP`, 2);
  }
  for (const s of [phase.slug, phase.rawSlug]) {
    if (!SLUG_RE.test(s)) throw new JdiError(`corrupt slug in ROADMAP: '${s}'`, 4);
  }
  const folder = phaseFolder(root, phase);
  return {
    slug: phase.slug,
    position: phase.position,
    dir: folder.dir.split(path.sep).join('/'),
    absDir: path.join(root, folder.dir),
    exists: folder.exists,
  };
}

// Every phase slug the project knows about (roadmap + folders). Used to
// attribute transcripts to phases.
function knownSlugs(root = process.cwd()) {
  const set = new Set();
  try {
    for (const p of listPhases(root)) set.add(p.slug);
  } catch {
    // no roadmap
  }
  const phasesDir = path.join(root, JDI_DIR, 'phases');
  if (fs.existsSync(phasesDir)) {
    for (const d of fs.readdirSync(phasesDir)) {
      if (!d.startsWith('.') && fs.statSync(path.join(phasesDir, d)).isDirectory()) set.add(d.replace(/^\d+-/, ''));
    }
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// Files / git
// ---------------------------------------------------------------------------

function readIf(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// .jdi/cache/ holds derived, per-clone files (briefs, gate results, schema
// copies). Every writer into it makes sure git ignores it — a missing entry
// would put derived files into commits and PR diffs.
function ensureCacheIgnored(root = process.cwd()) {
  const gi = path.join(root, '.gitignore');
  const cur = readIf(gi) ?? '';
  if (/^\.jdi\/cache\/?\s*$/m.test(cur)) return false;
  const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gi, `${cur}${sep}# JDI: derived per-clone files (briefs, gate results, schema copies)\n.jdi/cache/\n`);
  return true;
}

function writeFileEnsured(file, content, root = process.cwd()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel.startsWith('.jdi/cache/')) ensureCacheIgnored(root);
}

// External programs the helpers run. `JDI_<NAME>_BIN` pins an absolute path
// (e.g. a git outside PATH, or a hardened PATH in CI); otherwise the user's
// PATH resolves the name, as their own shell would.
function program(name) {
  return process.env[`JDI_${name.toUpperCase()}_BIN`] || name;
}

function git(args, cwd = process.cwd()) {
  const r = spawnSync(program('git'), args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Minimal glob -> RegExp (**, *, ?, {a,b}). Paths use forward slashes.
const escapeRe = (text) => text.replaceAll(/[.+^$()|[\]\\]/g, String.raw`\$&`);

// One glob token at g[i] -> [regexp source, characters consumed].
function globToken(g, i) {
  const ch = g[i];
  if (ch === '*' && g[i + 1] === '*') return g[i + 2] === '/' ? ['(?:.*/)?', 3] : ['.*', 2];
  if (ch === '*') return ['[^/]*', 1];
  if (ch === '?') return ['[^/]', 1];
  if (ch === '{') {
    const close = g.indexOf('}', i);
    if (close === -1) return [String.raw`\{`, 1];
    const alts = g.slice(i + 1, close).split(',').map((alt) => escapeRe(alt).replaceAll('*', '[^/]*'));
    return [`(?:${alts.join('|')})`, close - i + 1];
  }
  return [escapeRe(ch), 1];
}

function globToRegExp(glob) {
  const g = glob.replaceAll('\\', '/');
  let re = '';
  for (let i = 0; i < g.length; ) {
    const [part, used] = globToken(g, i);
    re += part;
    i += used;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(file, globs) {
  const f = file.replaceAll('\\', '/');
  return (globs || []).some((g) => globToRegExp(g).test(f));
}

module.exports = {
  compareStr,
  program,
  JDI_DIR,
  CONFIG_DEFAULTS,
  JdiError,
  SLUG_RE,
  deepMerge,
  readJson,
  loadConfig,
  projectLang,
  charsPerToken,
  estimateTokens,
  splitFrontmatter,
  parseYaml,
  readFrontmatter,
  listPhases,
  resolvePhase,
  knownSlugs,
  readIf,
  writeFileEnsured,
  ensureCacheIgnored,
  git,
  globToRegExp,
  matchesAny,
};
