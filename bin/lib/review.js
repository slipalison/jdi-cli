'use strict';

// `jdi-cli review verdict <phase> [--json]`   worst-case verdict across REVIEW.md
//                                              segments (BLOCKED > PENDING_MANUAL >
//                                              WITH_WARNINGS > APPROVED); exit 2 if none
// `jdi-cli review blockers <phase> [--max-chars N]`
//                                              the `## Blockers` and `## Warnings`
//                                              items only — the doer's work list in fix
//                                              mode, instead of the whole review
//
// The orchestrator reads verdicts and work lists through here instead of
// opening REVIEW.md: in a long phase REVIEW.md grows to tens of KB and every
// byte read by the orchestrator is re-read on each of its later turns.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');

const RANK = ['APPROVED', 'APPROVED_WITH_WARNINGS', 'APPROVED_PENDING_MANUAL', 'BLOCKED'];
const VERDICT_RE = /(?:Verdict|Veredicto):\*\*\s*(APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|APPROVED|BLOCKED)\b/g;

// Manual DoD rows still pending = MANUAL_REQUIRED cells inside the
// `## DoD Checklist` section(s) only (the table /jdi-confirm-dod flips).
function manualPending(text) {
  let n = 0;
  for (const m of text.matchAll(/^## DoD Checklist[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) {
    n += (m[1].match(/\|\s*MANUAL_REQUIRED\s*\|/g) || []).length;
  }
  return n;
}

function verdictOf(text) {
  const all = [...text.matchAll(VERDICT_RE)].map((m) => m[1]);
  if (!all.length) return { verdict: null, lines: [], manualPending: manualPending(text) };
  const worst = all.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a));
  return { verdict: worst, lines: all, manualPending: manualPending(text) };
}

// Items of every `## <heading>` / `### <heading>` section (multi-stack
// reviews nest them under `## Reviewer: x`); a section ends at the next heading.
function itemsOf(text, heading) {
  const out = [];
  const re = new RegExp(`^#{2,4} ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,4} |(?![\\s\\S]))`, 'gm');
  for (const m of text.matchAll(re)) {
    for (const l of m[1].split('\n')) {
      if (!/^\s{0,3}([-*]|\d+\.) /.test(l)) continue;
      const t = l.trim();
      if (/^([-*]|\d+\.) (\(?none\)?\.?|_\(none\)_|nenhum\.?|—|-)$/i.test(t)) continue;
      out.push(t);
    }
  }
  return out;
}

// [defect] / [hollow DoD N] tags written by the reviewer (and the critic).
function classify(line) {
  const h = /\[hollow(?:-proof)?(?:\s+DoD\s*(\d+))?\]/i.exec(line);
  if (h) return { kind: 'hollow', row: h[1] ? Number(h[1]) : null };
  return { kind: 'defect', row: null };
}

function findings(text) {
  return {
    blockers: itemsOf(text, 'Blockers').map((l) => ({ text: l, ...classify(l) })),
    warnings: itemsOf(text, 'Warnings').map((l) => ({ text: l, ...classify(l) })),
  };
}

function reviewText(phase) {
  const f = path.join(phase.absDir, 'REVIEW.md');
  if (!fs.existsSync(f)) throw new core.JdiError(`${phase.dir}/REVIEW.md not found — run /jdi-verify`, 2);
  return fs.readFileSync(f, 'utf8');
}

function main(argv) {
  const [sub, ...rest] = argv;
  const json = rest.includes('--json');
  const mi = rest.indexOf('--max-chars');
  const maxChars = mi === -1 ? 4000 : Number(rest[mi + 1]);
  const id = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--max-chars');
  if (!id) throw new core.JdiError('usage: jdi review <verdict|blockers> <phase> [--json]', 1);
  const phase = core.resolvePhase(id);
  const text = reviewText(phase);
  if (sub === 'verdict') {
    const v = verdictOf(text);
    if (!v.verdict) {
      console.error('REVIEW.md has no verdict line — malformed review (never ship on silence)');
      return 2;
    }
    process.stdout.write(json ? JSON.stringify(v) + '\n' : `${v.verdict}\n`);
    return 0;
  }
  if (sub === 'blockers') {
    const f = findings(text);
    if (json) {
      process.stdout.write(JSON.stringify(f, null, 2) + '\n');
      return 0;
    }
    const out = [];
    let used = 0;
    let cut = 0;
    for (const [title, list] of [['Blockers', f.blockers], ['Warnings', f.warnings]]) {
      if (!list.length) continue;
      out.push(`## ${title}`);
      for (const it of list) {
        if (used + it.text.length > maxChars) {
          cut++;
          continue;
        }
        out.push(it.text);
        used += it.text.length;
      }
    }
    if (cut) out.push(`(${cut} more — ${phase.dir}/REVIEW.md)`);
    process.stdout.write(out.join('\n') + (out.length ? '\n' : 'no blockers or warnings\n'));
    return 0;
  }
  throw new core.JdiError('usage: jdi review <verdict|blockers> <phase>', 1);
}

module.exports = { main, verdictOf, manualPending, findings, classify, RANK };
