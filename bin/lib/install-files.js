'use strict';

// `node install-files.js <src_runtime_dir> <dest_dir> --dirs agents,commands,skills
//                        [--lang pt-BR] [--update] [--force] [--json]`
//
// Copies the files JDI ships for one runtime into the project (or user) dir
// and keeps a manifest of what it wrote: `<dest_dir>/.jdi-installed.json`
// (relative path -> sha256 of the bytes written). Called by jdi-install.sh and
// jdi-install.ps1, so both platforms share one implementation (#78).
//
// Why: the install copied whole directories and then injected the pt-BR
// directive into EVERY agent and skill it found — a third-party agent or skill
// in .claude/agents/ or .claude/skills/ changed behaviour on `jdi update`, and
// a JDI file the project had edited was overwritten without a word.
//
// Rules:
// - only files present in the runtime source are written, and only they get
//   the language directive;
// - a file JDI wrote (its hash matches the manifest) is replaced;
// - a file that differs from what JDI wrote last time (edited by the project,
//   or a same-name file JDI never wrote) is KEPT: the new version goes next to
//   it as `<file>.jdi-new` — `--force` replaces it;
// - no manifest yet (installs up to 0.20.0): JDI's files are replaced as
//   before and adopted into the manifest — there is no baseline to compare;
// - a file JDI wrote before and no longer ships is removed when unedited.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST = '.jdi-installed.json';
const LANG_MARKER = '<!-- jdi:lang-directive -->';
const DIRECTIVE_FILE = path.join(__dirname, '..', '..', 'core', 'templates', 'lang-directive.pt-BR.md');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

// Same bytes as `inject_lang_directive_stream` (jdi-agent-emit.sh, awk): the
// directive goes right after the frontmatter's closing `---`; every line ends
// with \n; a text that already has the marker is left alone.
function injectLang(text, directive) {
  if (text.includes(LANG_MARKER)) return text;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) return '';
  const dir = directive.split('\n');
  if (dir.at(-1) === '') dir.pop();
  const out = [];
  let fm = 0;
  for (const l of lines) {
    out.push(l);
    if (l === '---' && fm < 2) {
      fm++;
      if (fm === 2) out.push(...dir);
    }
  }
  return out.join('\n') + '\n';
}

// agents/*.md, commands/*.md, prompts/*.md (first level) and skills/*/SKILL.md
// — the files the installers always injected.
function injectable(rel) {
  const parts = rel.split('/');
  if (parts.length === 2 && ['agents', 'commands', 'prompts'].includes(parts[0])) return parts[1].endsWith('.md');
  return parts.length === 3 && parts[0] === 'skills' && parts[2] === 'SKILL.md';
}

function walk(dir, base = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [posix(path.relative(base, p))];
  });
}

function readManifest(dest) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), 'utf8'));
    return m && typeof m.files === 'object' ? m : null;
  } catch {
    return null;
  }
}

function readIf(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// The bytes JDI ships for `rel`, with the language directive when asked.
function shipped(src, rel, lang, directive) {
  const buf = fs.readFileSync(path.join(src, rel));
  return lang === 'pt-BR' && injectable(rel) ? Buffer.from(injectLang(buf.toString('utf8'), directive), 'utf8') : buf;
}

function writeFile(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

// What to do with one shipped file, given what is on disk and the manifest.
function decide(current, recorded, next, { force, legacy }) {
  if (current === null) return 'write';
  const cur = sha(current);
  if (cur === sha(next)) return 'same';
  if (force || legacy || cur === recorded) return 'write';
  return 'keep';
}

// Shipped before, not anymore: remove what is still JDI's own bytes.
function removeDropped(dest, prev, files, dirs, report) {
  for (const [rel, recorded] of Object.entries(prev?.files || {})) {
    if (rel in files || !dirs.some((d) => rel.startsWith(`${d}/`))) continue;
    const current = readIf(path.join(dest, rel));
    if (current === null) continue;
    if (sha(current) === recorded) {
      fs.rmSync(path.join(dest, rel));
      report.removed.push(rel);
    } else report.kept_removed.push(rel);
  }
}

function install(src, dest, { dirs, lang = 'en', force = false, version = '' }) {
  const directive = lang === 'pt-BR' ? fs.readFileSync(DIRECTIVE_FILE, 'utf8') : '';
  const prev = readManifest(dest);
  const legacy = prev === null;
  const files = {};
  const report = { written: [], same: 0, kept: [], removed: [], kept_removed: [] };
  const rels = dirs.flatMap((d) => walk(path.join(src, d)).map((r) => `${d}/${r}`));
  for (const rel of rels) {
    const next = shipped(src, rel, lang, directive);
    const target = path.join(dest, rel);
    const recorded = prev?.files?.[rel];
    const action = decide(readIf(target), recorded, next, { force, legacy });
    if (action === 'keep') {
      writeFile(`${target}.jdi-new`, next);
      report.kept.push(rel);
      if (recorded) files[rel] = recorded; // still JDI's baseline for the next update
      continue;
    }
    if (action === 'write') {
      writeFile(target, next);
      report.written.push(rel);
    } else report.same++;
    fs.rmSync(`${target}.jdi-new`, { force: true });
    files[rel] = sha(next);
  }
  removeDropped(dest, prev, files, dirs, report);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, MANIFEST), JSON.stringify({ jdi: version, files }, null, 2) + '\n');
  return report;
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv) {
  const [src, dest] = argv.filter((a, i) => !a.startsWith('--') && !['--dirs', '--lang'].includes(argv[i - 1]));
  if (!src || !dest) {
    console.error('usage: install-files.js <src_runtime_dir> <dest_dir> --dirs a,b [--lang pt-BR] [--force] [--json]');
    return 1;
  }
  const dirs = String(opt(argv, '--dirs') || '').split(',').filter(Boolean);
  const version = require('../../package.json').version;
  const r = install(src, dest, { dirs, lang: opt(argv, '--lang') || 'en', force: argv.includes('--force'), version });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(r) + '\n');
    return 0;
  }
  // stderr: `jdi update` discards the installer's stdout, never these lines
  for (const rel of r.kept) console.error(`  aviso: ${path.join(dest, rel)} foi editado no projeto — mantido; a versao nova do JDI esta em ${rel}.jdi-new (\`jdi update --force\` substitui)`);
  for (const rel of r.kept_removed) console.error(`  aviso: ${path.join(dest, rel)} saiu do JDI, mas foi editado no projeto — mantido`);
  if (r.removed.length) console.error(`  -> ${r.removed.length} arquivo(s) que o JDI nao distribui mais foram removidos de ${dest}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { install, injectLang, injectable, MANIFEST };
