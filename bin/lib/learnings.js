'use strict';

// `jdi-cli learnings [--last N] [--max-chars N] [--out <file>]`
// The `## Learnings` of the N most recently SHIPPED phases, ordered by the
// `shipped_at:` field of SHIPPED.md — not by folder name. (Up to 0.15.x the
// planner's `ls .jdi/phases/*/SHIPPED.md | tail -40` returned the
// alphabetically-last phases, which in a real project were old ones.)

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');

function shippedPhases(root) {
  const out = [];
  for (const base of ['phases', 'archive']) {
    const dir = path.join(root, core.JDI_DIR, base);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, 'SHIPPED.md');
      if (!fs.existsSync(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      const at = /^shipped_at:\s*(\S+)/m.exec(text)?.[1] || '';
      const bullets = learningBullets(text);
      out.push({ slug: d.replace(/^\d+-/, ''), shippedAt: at, bullets });
    }
  }
  return out.sort((a, b) => core.compareStr(b.shippedAt, a.shippedAt));
}

// The `- ` lines of the `## Learnings` section (until the next `## `).
function learningBullets(text) {
  const bullets = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) inside = line.startsWith('## Learnings');
    else if (inside && line.trimStart().startsWith('- ')) bullets.push(line.trim());
  }
  return bullets;
}

function render(root, last = 3, maxChars = 4000) {
  const phases = shippedPhases(root).filter((p) => p.bullets.length).slice(0, last);
  if (!phases.length) return '';
  const lines = [];
  let used = 0;
  let cut = false;
  for (const p of phases) {
    const head = `### ${p.slug} (${p.shippedAt})`;
    lines.push(head);
    used += head.length + 1;
    for (const b of p.bullets) {
      if (used + b.length + 1 > maxChars) {
        cut = true;
        break;
      }
      lines.push(b);
      used += b.length + 1;
    }
    if (cut) break;
  }
  if (cut) lines.push(`(truncado em ${maxChars} caracteres — o resto esta nos SHIPPED.md)`);
  return lines.join('\n') + '\n';
}

function main(argv) {
  let last = 3;
  let maxChars = 4000;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--last') last = Number(argv[++i]);
    else if (argv[i] === '--max-chars') maxChars = Number(argv[++i]);
    else if (argv[i] === '--out') out = argv[++i];
    else throw new core.JdiError(`unknown argument: ${argv[i]}`, 1);
  }
  if (!fs.existsSync(path.join(process.cwd(), core.JDI_DIR))) throw new core.JdiError('not a JDI project (.jdi/ missing)', 2);
  const text = render(process.cwd(), last, maxChars);
  if (out) core.writeFileEnsured(path.resolve(out), text);
  else process.stdout.write(text);
  return 0;
}

module.exports = { main, render, shippedPhases };
