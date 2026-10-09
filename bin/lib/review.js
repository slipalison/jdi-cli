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

// Bodies (as line arrays) of the sections that `isStart` opens; a section
// ends at the first line `isEnd` accepts (which may open the next one).
function sectionBodies(text, isStart, isEnd) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (cur && isEnd(line)) cur = null;
    if (!cur && isStart(line)) {
      cur = [];
      out.push(cur);
    } else if (cur) cur.push(line);
  }
  return out;
}

const isH2 = (line) => line.startsWith('## ');
const headingText = (line) => /^#{1,4} (.*)$/.exec(line)?.[1] ?? null;

// Manual DoD rows still pending = MANUAL_REQUIRED cells inside the
// `## DoD Checklist` section(s) only (the table /jdi-confirm-dod flips).
function manualPending(text) {
  const bodies = sectionBodies(text, (l) => l.startsWith('## DoD Checklist'), isH2);
  return bodies.flat().reduce((n, l) => n + (l.match(/\|\s*MANUAL_REQUIRED\s*\|/g) || []).length, 0);
}

const worse = (a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a);

function verdictOf(text) {
  const all = [...text.matchAll(VERDICT_RE)].map((m) => m[1]);
  if (!all.length) return { verdict: null, lines: [], manualPending: manualPending(text) };
  return { verdict: all.reduce((a, b) => worse(a, b), all[0]), lines: all, manualPending: manualPending(text) };
}

const NONE_ITEM = /^([-*]|\d+\.) (\(?none\)?\.?|_\(none\)_|nenhum\.?|—|-)$/i;

// Items of every `## <heading>` / `### <heading>` section (multi-stack
// reviews nest them under `## Reviewer: x`); a section ends at the next heading.
function itemsOf(text, heading) {
  const isStart = (l) => /^#{2,4} /.test(l) && headingText(l).startsWith(heading);
  const bodies = sectionBodies(text, isStart, (l) => headingText(l) !== null);
  return bodies
    .flat()
    .filter((l) => /^\s{0,3}([-*]|\d+\.) /.test(l))
    .map((l) => l.trim())
    .filter((t) => !NONE_ITEM.test(t));
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

function verdictCmd(phase, json) {
  const v = verdictOf(reviewText(phase));
  if (!v.verdict) {
    console.error('REVIEW.md has no verdict line — malformed review (never ship on silence)');
    return 2;
  }
  process.stdout.write(json ? JSON.stringify(v) + '\n' : `${v.verdict}\n`);
  return 0;
}

// The fix round's work list: blockers then warnings, under a character cap.
function blockersCmd(phase, json, maxChars) {
  const f = findings(reviewText(phase));
  if (json) {
    process.stdout.write(JSON.stringify(f, null, 2) + '\n');
    return 0;
  }
  const out = [];
  let used = 0;
  let cut = 0;
  for (const [title, list] of Object.entries({ Blockers: f.blockers, Warnings: f.warnings })) {
    if (list.length) out.push(`## ${title}`);
    for (const it of list) {
      if (used + it.text.length > maxChars) cut++;
      else {
        out.push(it.text);
        used += it.text.length;
      }
    }
  }
  if (cut) out.push(`(${cut} more — ${phase.dir}/REVIEW.md)`);
  process.stdout.write(out.length ? out.join('\n') + '\n' : 'no blockers or warnings\n');
  return 0;
}

function main(argv) {
  const [sub, ...rest] = argv;
  const json = rest.includes('--json');
  const mi = rest.indexOf('--max-chars');
  const maxChars = mi === -1 ? 4000 : Number(rest[mi + 1]);
  const id = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--max-chars');
  if (!id) throw new core.JdiError('usage: jdi review <verdict|blockers> <phase> [--json]', 1);
  const phase = core.resolvePhase(id);
  if (sub === 'verdict') return verdictCmd(phase, json);
  if (sub === 'blockers') return blockersCmd(phase, json, maxChars);
  throw new core.JdiError('usage: jdi review <verdict|blockers> <phase>', 1);
}

module.exports = { main, verdictOf, manualPending, findings, classify, RANK };
