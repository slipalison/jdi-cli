'use strict';

// `jdi-cli decisions` — locked decisions without reading the whole
// DECISIONS.md view (in a real project the view passed 120 KB, ~50k tokens).
//
//   --index                    one line per decision: ID + first 160 chars
//   --ids D-a,D-b              full text of these decisions
//   --phase <slug>             only decisions recorded by that phase
//   --grep <text>              only decisions mentioning <text> (case-insensitive)
//   --recent N                 init decisions + those of the N most recent phases
//   --max-chars N              cap the output (default 6000)
//   --out <file>               write instead of printing

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');

function loadDecisions(root) {
  const dir = path.join(root, core.JDI_DIR, 'decisions');
  const out = [];
  if (fs.existsSync(dir)) {
    const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
    for (const f of fs.readdirSync(dir).sort(natural)) {
      if (!f.endsWith('.md') || f.startsWith('LEGACY')) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      out.push({ id: f.slice(0, -3), text });
    }
    const legacy = path.join(dir, 'LEGACY.md');
    if (fs.existsSync(legacy)) out.push(...parseLegacy(fs.readFileSync(legacy, 'utf8')));
    return out;
  }
  const view = path.join(root, core.JDI_DIR, 'DECISIONS.md');
  if (fs.existsSync(view)) return parseLegacy(fs.readFileSync(view, 'utf8'));
  return out;
}

function parseLegacy(text) {
  const out = [];
  for (const block of text.split(/\n(?=D-[0-9A-Za-z-]+[ (:])/)) {
    const m = /^(D-[0-9A-Za-z-]+?)(?=[ (:])/.exec(block.trim());
    if (m) out.push({ id: m[1], text: block.trim() });
  }
  return out;
}

function firstLine(text) {
  const l = text.split('\n')[0];
  return l.length > 160 ? l.slice(0, 157) + '...' : l;
}

// Phase slug of a v2/v3 decision id: D-YYYY-MM-DD-<slug>-<seq>.
function phaseOfId(id) {
  return /^D-\d{4}-\d{2}-\d{2}-(.+)-\d+$/.exec(id)?.[1] || null;
}

function select(decisions, { ids, phase, grep, recent }) {
  let ds = decisions;
  if (recent) {
    // init decisions (D-1, D-2, ...) + every decision of the N most recent phases
    const order = [];
    for (const d of [...decisions].sort((a, b) => (a.id < b.id ? 1 : -1))) {
      const p = phaseOfId(d.id);
      if (p && !order.includes(p)) order.push(p);
    }
    const keep = new Set(order.slice(0, recent));
    ds = ds.filter((d) => !phaseOfId(d.id) || keep.has(phaseOfId(d.id)));
  }
  if (ids?.length) ds = ds.filter((d) => ids.includes(d.id));
  if (phase) ds = ds.filter((d) => d.id.includes(`-${phase}-`) || d.id.endsWith(`-${phase}`));
  if (grep) ds = ds.filter((d) => d.text.toLowerCase().includes(grep.toLowerCase()));
  return ds;
}

function render(ds, { index, maxChars = 6000 }) {
  const parts = [];
  let used = 0;
  for (const d of ds) {
    const s = index ? firstLine(d.text) : d.text;
    if (used + s.length > maxChars) {
      parts.push(`(truncado em ${maxChars} caracteres — ${ds.length - parts.length} decisao(oes) a mais; use --ids)`);
      break;
    }
    parts.push(s);
    used += s.length + 1;
  }
  return parts.join(index ? '\n' : '\n\n') + (parts.length ? '\n' : '');
}

function main(argv) {
  const o = { index: false, maxChars: 6000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--index') o.index = true;
    else if (a === '--ids') o.ids = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--phase') o.phase = argv[++i];
    else if (a === '--grep') o.grep = argv[++i];
    else if (a === '--recent') o.recent = Number(argv[++i]);
    else if (a === '--max-chars') o.maxChars = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else throw new core.JdiError(`unknown argument: ${a}`, 1);
  }
  const text = render(select(loadDecisions(process.cwd()), o), o);
  if (o.out) core.writeFileEnsured(path.resolve(o.out), text);
  else process.stdout.write(text);
  return 0;
}

module.exports = { main, loadDecisions, select, render, phaseOfId };
