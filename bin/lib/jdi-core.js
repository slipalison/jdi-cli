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
    briefs: true,
    gates_runner: true,
    incremental_verify: true,
    critic: 'lean',
    sizing: true,
  },
  sizing: {
    lite_max_files: 6,
    lite_max_dod_rows: 6,
    sensitive_globs: [],
  },
  compaction: { archive_after: 5 },
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
  return s.replace(/\s+#.*$/, '');
}

// Minimal YAML: indentation-based maps, `- scalar` lists, inline [a, b].
// (Lists of maps are not part of any JDI file format and are not supported.)
function parseYaml(src) {
  const root = {};
  const stack = [{ type: 'map', indent: -1, obj: root }];
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const text = raw.trim();
    if (!text || text.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const isItem = text === '-' || text.startsWith('- ');
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      if (top.type === 'list') {
        if ((isItem && indent === top.itemIndent) || indent > top.itemIndent) break;
      } else if (indent > top.indent) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (isItem) {
      if (parent.type === 'list') parent.obj.push(parseScalar(text.slice(1)));
      continue;
    }
    const m = /^([A-Za-z0-9_$.-]+):(.*)$/.exec(text);
    if (!m || parent.type !== 'map') continue;
    const [, key, rest] = m;
    if (rest.trim() !== '') {
      parent.obj[key] = parseScalar(rest);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
    const next = lines[j] || '';
    const nextIndent = next.length - next.trimStart().length;
    const nextIsItem = next.trim() === '-' || next.trim().startsWith('- ');
    if (nextIsItem && nextIndent >= indent) {
      parent.obj[key] = [];
      stack.push({ type: 'list', itemIndent: nextIndent, obj: parent.obj[key] });
    } else {
      parent.obj[key] = {};
      stack.push({ type: 'map', indent, obj: parent.obj[key] });
    }
  }
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

// Ordered list of { slug, rawSlug, position } for every roadmap phase.
function listPhases(root = process.cwd()) {
  const jdi = path.join(root, JDI_DIR);
  const roadmapDir = path.join(jdi, 'roadmap');
  if (fs.existsSync(roadmapDir) && fs.statSync(roadmapDir).isDirectory()) {
    const entries = [];
    for (const f of fs.readdirSync(roadmapDir)) {
      if (!f.endsWith('.md') || f.startsWith('_') || f.startsWith('LEGACY')) continue;
      const slug = f.slice(0, -3);
      let order = 999999;
      try {
        const fmo = readFrontmatter(path.join(roadmapDir, f)).order;
        if (typeof fmo === 'number') order = fmo;
        else if (fmo !== undefined && fmo !== '' && !Number.isNaN(Number(fmo))) order = Number(fmo);
      } catch {
        // unreadable entry keeps the default order
      }
      entries.push({ slug, order });
    }
    entries.sort((a, b) => a.order - b.order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    return entries.map((e, i) => ({ slug: e.slug, rawSlug: e.slug, position: i + 1, layout: 3 }));
  }
  const roadmap = path.join(jdi, 'ROADMAP.md');
  if (!fs.existsSync(roadmap)) throw new JdiError('.jdi/ROADMAP.md not found (run /jdi-new first)', 3);
  const out = [];
  let current = null;
  for (const line of fs.readFileSync(roadmap, 'utf8').split('\n')) {
    const l = line.replace(/\r$/, '');
    const ph = /^### Phase (\d+)/.exec(l);
    if (ph) {
      current = Number(ph[1]);
      continue;
    }
    const sl = /^- \*\*Slug:\*\*\s*(\S+)/.exec(l);
    if (sl && current !== null) {
      const raw = sl[1];
      out.push({ slug: raw.replace(/^\d+-/, ''), rawSlug: raw, position: current, layout: 1 });
      current = null;
    }
  }
  return out;
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

function git(args, cwd = process.cwd()) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Minimal glob -> RegExp (**, *, ?, {a,b}). Paths use forward slashes.
function globToRegExp(glob) {
  let re = '';
  let i = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const close = g.indexOf('}', i);
      if (close === -1) re += '\\{';
      else {
        re += '(?:' + g.slice(i + 1, close).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
        i = close;
      }
    } else if ('.+^$()|[]\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
    i++;
  }
  return new RegExp('^' + re + '$');
}

function matchesAny(file, globs) {
  const f = file.replace(/\\/g, '/');
  return (globs || []).some((g) => globToRegExp(g).test(f));
}

module.exports = {
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
