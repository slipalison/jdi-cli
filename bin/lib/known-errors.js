'use strict';

// `jdi-cli known-errors` — the catalog of errors that already cost a round,
// as DATA (one file per entry) instead of a document every agent reads whole.
//
//   known-errors query --stage <s> [--files a,b] [--max-tokens N] [--include-mechanized]
//   known-errors migrate <file.md>      single-file table catalog -> one file per entry
//   known-errors render                 regenerate the human view .jdi/known-errors.md
//   known-errors list [--json]
//
// Entry: .jdi/known-errors/<ID>.md
//   ---
//   id: KE-DOD-1
//   section: "DoD: Verify oco"
//   stage: [discuss, plan, critic, verify]     who must know it
//   globs: [backend/**]                        only when the task touches these (empty = always)
//   mechanized_by: dod-lint:DOD-L1             a gate already blocks it -> agents need not read it
//   origin: calculadora-basal, iteration 2
//   ---
//   **Symptom:** ...
//   **Prevention:** ...
//
// Why: in a real project the single-file catalog grew to ~47k tokens and was
// read in full by every role (238 reads in 105 spawns), including entries a
// lint rule already enforced. The query returns only what still needs
// judgment for THIS stage and THESE files, under a token cap.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');

const DIR = 'known-errors';
const STAGES = ['discuss', 'plan', 'do', 'verify', 'critic', 'orchestrator'];

function dirOf(root) {
  return path.join(root, core.JDI_DIR, DIR);
}

function asList(v) {
  if (Array.isArray(v)) return v;
  return typeof v === 'string' && v ? [v] : [];
}

function load(root = process.cwd()) {
  const d = dirOf(root);
  if (!fs.existsSync(d)) return [];
  const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('LEGACY'))
    .sort(natural)
    .map((f) => {
      const text = fs.readFileSync(path.join(d, f), 'utf8');
      const { fm, body } = core.splitFrontmatter(text);
      const y = core.parseYaml(fm);
      const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
      return {
        id: String(y.id || f.slice(0, -3)),
        section: str(y.section),
        stage: asList(y.stage).map(String),
        globs: asList(y.globs).map(String),
        mechanizedBy: str(y.mechanized_by),
        origin: str(y.origin),
        body: body.trim(),
      };
    });
}

function oneLine(e) {
  const flat = e.body.replaceAll(/\s+/g, ' ').replaceAll('**', '');
  return `- ${e.id}: ${flat}`;
}

function query(entries, { stage, files = [], includeMechanized = false, maxTokens = 2000, ratio = 3.2 }) {
  const picked = entries.filter((e) => {
    if (!includeMechanized && e.mechanizedBy) return false;
    if (stage && e.stage.length && !e.stage.includes(stage)) return false;
    if (e.globs.length && files.length && !files.some((f) => core.matchesAny(f, e.globs))) return false;
    if (e.globs.length && !files.length) return true; // no file context: keep (caller did not scope)
    return true;
  });
  const out = [];
  let used = 0;
  let dropped = 0;
  for (const e of picked) {
    const line = oneLine(e);
    const t = core.estimateTokens(line, ratio);
    if (used + t > maxTokens) {
      dropped++;
      continue;
    }
    out.push(line);
    used += t;
  }
  return { lines: out, dropped, total: picked.length, mechanizedSkipped: includeMechanized ? 0 : entries.filter((e) => e.mechanizedBy).length };
}

// --------------------------------------------------------------------------
// Migration from the single-file table format
// --------------------------------------------------------------------------

function stagesForSection(title) {
  const t = title.toLowerCase();
  if (/dod|verify/.test(t)) return ['discuss', 'plan', 'critic', 'verify'];
  if (/test/.test(t)) return ['do', 'verify'];
  if (/orquestra|orchestr|loop|ferrament|tool/.test(t)) return ['orchestrator'];
  return ['plan', 'do', 'verify'];
}

function splitRow(line) {
  // | a | b | c | d |  — pipes inside backticks are content, not separators
  const cells = [];
  let buf = '';
  let tick = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    // `\|` is a table's escaped pipe (GFM requires it even inside code): the
    // entry keeps the pipe, not the escape
    if (c === '\\' && line[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (c === '`') tick = !tick;
    if (c === '|' && !tick) {
      cells.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  cells.push(buf);
  return cells.slice(1, -1).map((s) => s.trim());
}

// One table row -> entry (null for rows that are not a KE-* entry).
function rowEntry(header, cells, section) {
  const idIdx = header.indexOf('id');
  const id = cells[idIdx === -1 ? 0 : idIdx];
  if (!/^KE-[A-Z]+-\d+$/i.test(id || '')) return null;
  const get = (re) => {
    const i = header.findIndex((c) => re.test(c));
    return i === -1 ? '' : cells[i] || '';
  };
  const prevention = get(/preven/);
  const mech = /dod-lint\s*\*\*(DOD-L\d+)\*\*/i.exec(prevention) || /\b(DOD-L\d+)\b/.exec(prevention);
  return {
    id: id.toUpperCase(),
    section,
    stage: stagesForSection(section),
    symptom: get(/sintoma|symptom/),
    prevention,
    origin: get(/origem|origin/),
    mechanizedBy: mech ? `dod-lint:${mech[1]}` : '',
  };
}

function parseCatalog(text) {
  const entries = [];
  let section = '';
  let header = null;
  const intro = [];
  let seenSection = false;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) {
      section = line.slice(2).trim();
      header = null;
      seenSection = true;
    } else if (!seenSection) intro.push(line);
    else if (line.trim().startsWith('|')) {
      const cells = splitRow(line.trim());
      if (!header) header = cells.map((c) => c.toLowerCase());
      else if (!cells.every((c) => /^:?-+:?$/.test(c))) entries.push(rowEntry(header, cells, section));
    }
  }
  return { intro: intro.join('\n').trim(), entries: entries.filter(Boolean) };
}

function yamlStr(s) {
  return JSON.stringify(String(s));
}

function writeEntry(dir, e) {
  const fm = [
    '---',
    `id: ${e.id}`,
    `section: ${yamlStr(e.section)}`,
    `stage: [${e.stage.join(', ')}]`,
    'globs: []',
    `mechanized_by: ${yamlStr(e.mechanizedBy || '')}`,
    `origin: ${yamlStr(e.origin)}`,
    '---',
    `**Symptom:** ${e.symptom}`,
    '',
    `**Prevention:** ${e.prevention}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${e.id}.md`), fm);
}

function migrate(file, root = process.cwd()) {
  const { intro, entries } = parseCatalog(fs.readFileSync(file, 'utf8'));
  const dir = dirOf(root);
  fs.mkdirSync(dir, { recursive: true });
  const existing = new Set(fs.readdirSync(dir));
  let written = 0;
  for (const e of entries) {
    if (existing.has(`${e.id}.md`)) continue;
    writeEntry(dir, e);
    written++;
  }
  if (intro && !existing.has('_header.md')) fs.writeFileSync(path.join(dir, '_header.md'), intro + '\n');
  return { parsed: entries.length, written, mechanized: entries.filter((e) => e.mechanizedBy).length };
}

const PIPE_ESCAPED = String.raw`\|`;

function render(root = process.cwd()) {
  const dir = dirOf(root);
  const head = core.readIf(path.join(dir, '_header.md')) || '# Known errors\n';
  const entries = load(root);
  const bySection = new Map();
  for (const e of entries) {
    const k = e.section || 'General';
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k).push(e);
  }
  const out = [head.trimEnd(), '', '<!-- GENERATED by `jdi-cli known-errors render` from .jdi/known-errors/ — edit the entries, not this view -->', ''];
  for (const [section, list] of bySection) {
    out.push(`## ${section}`, '', '| ID | Stage | Mechanized by | Entry |', '|---|---|---|---|');
    for (const e of list) {
      const cell = e.body.replaceAll(/\n+/g, ' ').replaceAll('|', PIPE_ESCAPED);
      out.push(`| ${e.id} | ${e.stage.join(', ')} | ${e.mechanizedBy || '—'} | ${cell} |`);
    }
    out.push('');
  }
  const view = path.join(root, core.JDI_DIR, 'known-errors.md');
  fs.writeFileSync(view, out.join('\n'));
  return { entries: entries.length, view };
}

function queryCmd(root, rest, opt) {
  const stage = opt('--stage');
  if (stage && !STAGES.includes(stage)) throw new core.JdiError(`--stage must be one of ${STAGES.join(', ')}`, 1);
  const cfg = core.loadConfig(root);
  const files = (opt('--files') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const r = query(load(root), {
    stage,
    files,
    includeMechanized: rest.includes('--include-mechanized'),
    maxTokens: Number(opt('--max-tokens') || cfg.budgets?.known_errors_query_tokens || 2000),
    ratio: core.charsPerToken(cfg, core.projectLang(root)),
  });
  const text = r.lines.join('\n') + (r.lines.length ? '\n' : '');
  const note = r.dropped ? `(${r.dropped} entrada(s) a mais cortada(s) pelo teto — refine com --files)\n` : '';
  const out = opt('--out');
  if (out) core.writeFileEnsured(path.resolve(out), text + note, root);
  else process.stdout.write(text + note);
  return 0;
}

function migrateCmd(root, rest) {
  const file = rest.find((a) => !a.startsWith('--'));
  if (!file) throw new core.JdiError('usage: jdi known-errors migrate <file.md>', 1);
  const r = migrate(file, root);
  console.log(`known-errors: ${r.parsed} entrada(s) lida(s), ${r.written} escrita(s) em .jdi/known-errors/, ${r.mechanized} ja barrada(s) por regra (mechanized_by)`);
  console.log('Proximo: revise stage/globs das entradas, rode `jdi-cli known-errors render`, e deixe .jdi/known-errors.md fora do git (view gerada).');
  return 0;
}

function listCmd(root, rest) {
  const entries = load(root);
  if (rest.includes('--json')) process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
  else for (const e of entries) console.log(`${e.id}\t${e.stage.join(',')}\t${e.mechanizedBy || '-'}`);
  return 0;
}

function main(argv) {
  const [sub, ...rest] = argv;
  const root = process.cwd();
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  if (sub === 'query') return queryCmd(root, rest, opt);
  if (sub === 'migrate') return migrateCmd(root, rest);
  if (sub === 'render') {
    const r = render(root);
    console.log(`${path.relative(root, r.view)}: ${r.entries} entrada(s)`);
    return 0;
  }
  if (sub === 'list') return listCmd(root, rest);
  throw new core.JdiError('usage: jdi known-errors <query|migrate|render|list> ...', 1);
}

module.exports = { main, load, query, parseCatalog, migrate, render, STAGES };
