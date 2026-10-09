'use strict';

// `jdi-cli dod <parse|lint|extract>` — the Definition of Done as data.
//
//   dod parse <CONTEXT.md|phase> [--json]        items: id, type, criterion, verify
//   dod lint  <CONTEXT.md|phase> [--json]        a.k.a. validate-dod (exit 1 on ERROR)
//   dod extract <phase> [--dry-run] [--all]      long `Verify:` bodies -> verify/dod-N.sh
//
// Why: in a real project the DoD was 64-86% of CONTEXT.md and the `Verify:`
// lines alone 48-70% — every agent that read CONTEXT.md paid for scripts only
// the reviewer executes. A `Verify:` that calls `bash .jdi/phases/<slug>/verify/
// dod-N.sh` keeps the criterion in CONTEXT.md and the script out of everyone's
// context. Semantics are preserved: the script holds the command verbatim, with
// no `set -e` added (the exit status is the last command's, as with eval).
//
// lint rules (generic, any stack — project-specific rules plug in through
// config `dod.extra_lint`, e.g. "bash .jdi/scripts/dod-lint.sh {file}"):
//   DOD-S0 ERROR no `## Definition of Done`
//   DOD-S1 ERROR auto item without `Verify:`; WARN manual item without `Evidence:`
//   DOD-S2 WARN/ERROR inline `Verify:` longer than budgets.verify_inline_chars
//   DOD-S3 ERROR `Verify:` calls a verify script that does not exist
//   DOD-L1 ERROR test runner with a name filter and no count check (exit 0 on zero tests)
//   DOD-L2 WARN  positive grep over a directory/glob as the whole proof
//   DOD-L3 WARN  E2E/real-login run inside an auto `Verify:` — mark it `Verify (evidence):`

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('./jdi-core');

const VERIFY_RE = /^(\s*)\*\*Verify( \(evidence\))?:\*\*\s?(.*)$/;
const ITEM_RE = /^(\s{0,3})- \[[ xX]\] (.*)$/;
const SCRIPT_REF_RE = /(?:^|\s)(?:bash|sh)\s+(\S*\.jdi\/phases\/[^\s/]+\/verify\/[^\s`]+\.sh)/;

// --------------------------------------------------------------------------
// Parse
// --------------------------------------------------------------------------

function splitVerify(raw) {
  // `cmd` — tail   |   `cmd`   |   cmd (unquoted)
  if (raw.startsWith('`')) {
    let close = raw.lastIndexOf('` —');
    if (close <= 0) close = raw.lastIndexOf('`');
    if (close > 0) return { command: raw.slice(1, close), tail: raw.slice(close + 1), quoted: true };
    return { command: raw.slice(1), tail: '', quoted: true };
  }
  return { command: raw, tail: '', quoted: false };
}

// `### ...` heading -> the type of the items under it.
function sectionType(heading) {
  const t = heading.toLowerCase();
  if (t.includes('manual')) return 'manual';
  if (t.includes('defer')) return 'deferred';
  return 'auto';
}

// `**Name:** value` (any indentation) -> value, else null.
function fieldOf(line, name) {
  const t = line.trimStart();
  const prefix = `**${name}:**`;
  return t.startsWith(prefix) ? t.slice(prefix.length).trim() : null;
}

function newItem(body, lineNo, type, count) {
  const num = /^\*\*(\d+)\./.exec(body);
  return {
    id: num ? Number(num[1]) : count + 1,
    line: lineNo,
    type,
    criterion: body.replaceAll('**', '').trim(),
    verify: null,
    evidence: false,
    verifyLine: null,
    source: null,
    stack: null,
    hasEvidenceField: false,
  };
}

function setVerify(cur, v, lineNo) {
  const raw = v[3] || '';
  const sv = splitVerify(raw);
  cur.verify = { raw, ...sv, indent: v[1] };
  cur.evidence = Boolean(v[2]);
  cur.verifyLine = lineNo;
  const ref = SCRIPT_REF_RE.exec(sv.command);
  cur.script = ref ? ref[1].replace(/^\.\//, '') : null;
}

// One line under the current item: a field, or more criterion text.
function itemLine(cur, l, lineNo) {
  const v = VERIFY_RE.exec(l);
  if (v && cur.verify === null) return setVerify(cur, v, lineNo);
  const source = fieldOf(l, 'Source');
  if (source !== null) {
    cur.source = source;
    return;
  }
  const stack = fieldOf(l, 'Stack');
  if (stack !== null) {
    cur.stack = stack;
    return;
  }
  if (fieldOf(l, 'Evidence') !== null) {
    cur.hasEvidenceField = true;
    return;
  }
  if (cur.verify === null && l.trim() && !l.trimStart().startsWith('- ')) cur.criterion += ' ' + l.trim().replaceAll('**', '');
}

function parse(text, file = '<CONTEXT.md>') {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Definition of Done');
  if (start === -1) return { found: false, items: [], start: -1, end: -1, file };
  const after = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const end = after === -1 ? lines.length : after;
  const items = [];
  let section = 'auto';
  let cur = null;
  for (let i = start + 1; i < end; i++) {
    const l = lines[i];
    const it = /^###\s/.test(l) ? null : ITEM_RE.exec(l);
    if (/^###\s/.test(l)) {
      section = sectionType(l.slice(3).trim());
      cur = null;
    } else if (it) {
      cur = newItem(it[2], i + 1, section, items.length);
      items.push(cur);
    } else if (cur) itemLine(cur, l, i + 1);
  }
  for (const it of items) {
    if (it.verify && /human confirmation required/i.test(it.verify.raw) && it.type !== 'deferred') it.type = 'manual';
  }
  return { found: true, items, start: start + 1, end, file };
}

// --------------------------------------------------------------------------
// Lint
// --------------------------------------------------------------------------

const TEST_FILTERS = [
  { name: 'cargo test', re: /\bcargo\s+(?:\+\S+\s+)?(?:test|nextest\s+run)\b([^|&;)]*)/g, filtered: (args) => cargoHasFilter(args) },
  { name: 'vitest/jest -t', re: /\b(?:vitest|jest)\b([^|&;)]*)/g, filtered: (args) => /(^|\s)(-t|--testNamePattern)(=|\s)/.test(args) },
  { name: 'go test -run', re: /\bgo\s+test\b([^|&;)]*)/g, filtered: (args) => /(^|\s)-run(=|\s)/.test(args) },
  { name: 'dotnet test --filter', re: /\bdotnet\s+test\b([^|&;)]*)/g, filtered: (args) => /(^|\s)--filter(=|\s)/.test(args) },
];
// Evidence that a test command checks how many tests ran.
const COUNT_CHECKS = [/passed/i, /\.\.\. ok/i, /--- PASS/i, /Total tests/i, /Passed!/i, /Tests?\s{1,20}[1-9]/i, /tests? run:/i, /[1-9]\d{0,9} tests?\b/i];
const hasCountCheck = (cmd) => COUNT_CHECKS.some((re) => re.test(cmd));
const CARGO_VALUE_FLAGS = new Set(['--manifest-path', '--test', '-p', '--package', '--features', '--bin', '--example', '--target', '-j', '--jobs', '--profile']);

function cargoHasFilter(args) {
  const toks = args.replaceAll('2>&1', ' ').split(/[ \t]/).filter(Boolean);
  let skip = false;
  for (const t of toks) {
    if (skip) {
      skip = false;
      continue;
    }
    if (t === '--') break;
    if (CARGO_VALUE_FLAGS.has(t)) {
      skip = true;
      continue;
    }
    if (t.startsWith('-')) continue;
    return true;
  }
  return false;
}

function splitCommands(cmd) {
  // Good-enough split on && || ; | outside quotes (for classification only).
  const out = [];
  let buf = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      buf += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      buf += c;
      continue;
    }
    if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function lintCommand(cmd) {
  const found = [];
  for (const tf of TEST_FILTERS) {
    tf.re.lastIndex = 0;
    let m;
    while ((m = tf.re.exec(cmd)) !== null) {
      if (tf.filtered(m[1] || '') && !hasCountCheck(cmd)) {
        found.push({ level: 'ERROR', rule: 'DOD-L1', msg: `${tf.name} com filtro e sem checar a contagem: sai 0 quando nenhum teste casa — exija "N passed" com N >= 1` });
        break;
      }
    }
  }
  const parts = splitCommands(cmd).filter((p) => !/^\s*\w+=/.test(p) || /\s/.test(p));
  if (parts.length && parts.every((p) => /^grep\b/.test(p))) {
    // recursive flag, a glob, or a directory argument (`dir/ ` or ending in `/`)
    const overDir = (p) => /\s-[a-zA-Z]*r/.test(p) || p.includes('*') || /\/\s/.test(p) || p.endsWith('/');
    const weak = parts.some((p) => overDir(p) && !p.startsWith('!'));
    if (weak) found.push({ level: 'WARN', rule: 'DOD-L2', msg: 'prova so por grep positivo sobre diretorio/glob: passa se o texto existir em qualquer lugar — ancore no arquivo e na linha' });
  }
  if (/\bnpm run e2e\b|\bplaywright\s+test\b(?![^|&;]*--list)|\bcypress\s+run\b/.test(cmd)) {
    found.push({ level: 'WARN', rule: 'DOD-L3', msg: 'roda E2E/login real dentro de um Verify automatico — marque `**Verify (evidence):**` e julgue pela evidencia registrada' });
  }
  return found;
}

function lintItem(it, ctx, add) {
  if (it.type === 'auto' && !it.verify) add(it.line, 'ERROR', 'DOD-S1', `item ${it.id} sem \`Verify:\``);
  if (it.type === 'manual' && !it.hasEvidenceField) add(it.line, 'WARN', 'DOD-S1', `item manual ${it.id} sem \`Evidence:\``);
  if (!it.verify || it.type !== 'auto') return;
  const cmd = it.verify.command;
  if (!it.script && cmd.length > ctx.limit) {
    add(it.verifyLine, ctx.strict ? 'ERROR' : 'WARN', 'DOD-S2', `Verify do item ${it.id} tem ${cmd.length} caracteres na linha (limite ${ctx.limit}) — \`jdi-cli dod extract\` move para verify/dod-${it.id}.sh`);
  }
  let body = cmd;
  if (it.script) {
    const sp = path.join(ctx.root, it.script);
    if (!fs.existsSync(sp)) {
      add(it.verifyLine, 'ERROR', 'DOD-S3', `Verify do item ${it.id} chama ${it.script}, que nao existe`);
      return;
    }
    body = fs.readFileSync(sp, 'utf8');
  }
  if (it.evidence) return;
  for (const f of lintCommand(body)) add(it.verifyLine, f.level, f.rule, `item ${it.id}: ${f.msg}`);
}

const EXTRA_LEVEL = { ERRO: 'ERROR', ERROR: 'ERROR', AVISO: 'WARN', WARN: 'WARN', NOTA: 'NOTE', NOTE: 'NOTE' };

// Project rules: config `dod.extra_lint`, a command printing
// `file:line: ERROR|WARN|NOTE RULE message` lines.
function extraLint(extra, file, root, findings, add) {
  const cmd = extra.replaceAll('{file}', JSON.stringify(file));
  const r = spawnSync(cmd, { shell: true, cwd: root, encoding: 'utf8' });
  for (const l of (r.stdout || '').split('\n').filter(Boolean)) {
    const m = /^(.*?):(\d+): (ERRO|ERROR|AVISO|WARN|NOTA|NOTE) (\S+) (.*)$/.exec(l);
    if (m) add(Number(m[2]), EXTRA_LEVEL[m[3]], m[4], m[5]);
    else findings.push({ file, line: 0, level: 'NOTE', rule: 'extra_lint', msg: l });
  }
  if (r.status && r.status !== 0 && !findings.some((f) => f.level === 'ERROR')) add(0, 'ERROR', 'extra_lint', `\`${extra}\` saiu ${r.status}`);
}

function lint(file, { root = process.cwd(), config = core.loadConfig(root) } = {}) {
  const doc = parse(fs.readFileSync(file, 'utf8'), file);
  const findings = [];
  const add = (line, level, rule, msg) => findings.push({ file, line, level, rule, msg });
  if (!doc.found) {
    add(1, 'ERROR', 'DOD-S0', "o arquivo nao tem '## Definition of Done'");
    return findings;
  }
  const ctx = { root, limit: config.budgets?.verify_inline_chars ?? 300, strict: config.budgets?.enforce === 'fail' };
  for (const it of doc.items) lintItem(it, ctx, add);
  if (config.dod?.extra_lint) extraLint(config.dod.extra_lint, file, root, findings, add);
  return findings;
}

// --------------------------------------------------------------------------
// Extract
// --------------------------------------------------------------------------

function bashSyntaxOk(script) {
  const r = spawnSync(core.program('bash'), ['-n'], { input: script, encoding: 'utf8' });
  if (r.error) return null; // no bash on this machine: cannot check
  return r.status === 0;
}

// One item: the report entry, plus the script and the new Verify line when
// it is extracted.
function extractItem(it, phase, root) {
  if (!it.verify.quoted) return { entry: { id: it.id, action: 'skipped', reason: 'Verify sem crase: extraia a mao' } };
  const rel = `${phase.dir}/verify/dod-${it.id}.sh`;
  if (fs.existsSync(path.join(root, rel))) return { entry: { id: it.id, action: 'skipped', reason: `${rel} ja existe` } };
  const header = `#!/usr/bin/env bash\n# DoD ${it.id} (${phase.slug}): ${it.criterion.slice(0, 110)}\n# Extraido do CONTEXT.md por \`jdi-cli dod extract\`: o criterio continua la; aqui fica so o comando, como estava.\n`;
  const script = `${header}${it.verify.command}\n`;
  const ok = bashSyntaxOk(script);
  if (ok === false) return { entry: { id: it.id, action: 'skipped', reason: 'o comando extraido nao passa em `bash -n` (corte ambiguo das crases): extraia a mao' } };
  return {
    entry: { id: it.id, action: 'extracted', script: rel, chars: it.verify.command.length, bashChecked: ok === true },
    script,
    scriptPath: path.join(root, rel),
    newLine: `${it.verify.indent}**Verify:** \`bash ${rel}\`${it.verify.tail}`,
  };
}

function extract(phase, { root = process.cwd(), dryRun = false, all = false, force = false, config = core.loadConfig(root) } = {}) {
  // A shipped phase is history: its own Verify lines may pin the bytes of its
  // artifacts (sha256/blob), and rewriting CONTEXT.md would break them.
  if (!force && fs.existsSync(path.join(phase.absDir, 'SHIPPED.md'))) {
    throw new core.JdiError(`${phase.slug} ja foi entregue (SHIPPED.md): nao reescrevo historico (use --force so se souber o que faz)`, 1);
  }
  const ctxFile = path.join(phase.absDir, 'CONTEXT.md');
  const text = fs.readFileSync(ctxFile, 'utf8');
  const doc = parse(text, ctxFile);
  if (!doc.found) throw new core.JdiError(`${ctxFile}: sem '## Definition of Done'`, 1);
  const limit = config.budgets?.verify_inline_chars ?? 300;
  const lines = text.split('\n');
  const report = [];
  for (const it of doc.items.filter((x) => x.type === 'auto' && x.verify && !x.script && (all || x.verify.command.length > limit))) {
    const r = extractItem(it, phase, root);
    if (r.newLine && dryRun) r.entry.action = 'would-extract';
    else if (r.newLine) {
      // the script runs as `bash <path>` (no exec bit needed or set)
      core.writeFileEnsured(r.scriptPath, r.script, root);
      lines[it.verifyLine - 1] = r.newLine;
    }
    report.push(r.entry);
  }
  if (!dryRun && report.some((r) => r.action === 'extracted')) fs.writeFileSync(ctxFile, lines.join('\n'));
  return report;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function targetFile(arg, root) {
  if (!arg) throw new core.JdiError('usage: jdi dod <parse|lint|extract> <CONTEXT.md|phase>', 1);
  if (fs.existsSync(arg) && fs.statSync(arg).isFile()) return { file: path.resolve(arg), phase: null };
  const phase = core.resolvePhase(arg, root);
  return { file: path.join(phase.absDir, 'CONTEXT.md'), phase };
}

function lintCmd(file, root, json) {
  const findings = lint(file, { root });
  if (json) process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
  else {
    const relf = (f) => path.relative(root, f) || f;
    for (const f of findings) console.log(`${relf(f.file)}:${f.line}: ${f.level} ${f.rule} ${f.msg}`);
    const e = findings.filter((f) => f.level === 'ERROR').length;
    const w = findings.filter((f) => f.level === 'WARN').length;
    console.log(`dod lint: ${e} ERROR, ${w} WARN`);
  }
  return findings.some((f) => f.level === 'ERROR') ? 1 : 0;
}

function reportLine(r) {
  const where = r.script ? ` -> ${r.script} (${r.chars} chars)` : '';
  const why = r.reason ? ` — ${r.reason}` : '';
  return `  item ${r.id}: ${r.action}${where}${why}`;
}

function extractCmd(phase, root, rest, json) {
  if (!phase) throw new core.JdiError('dod extract precisa da fase (slug ou posicao), nao de um arquivo', 1);
  const report = extract(phase, { root, dryRun: rest.includes('--dry-run'), all: rest.includes('--all'), force: rest.includes('--force') });
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (report.length) for (const r of report) console.log(reportLine(r));
  else console.log('  nada a extrair');
  return 0;
}

function main(argv) {
  const [sub, ...rest] = argv;
  const root = process.cwd();
  const json = rest.includes('--json');
  const target = rest.find((a) => !a.startsWith('--'));
  if (sub === 'parse') {
    const { file } = targetFile(target, root);
    const doc = parse(fs.readFileSync(file, 'utf8'), file);
    process.stdout.write(JSON.stringify(doc, null, json ? 2 : 0) + '\n');
    return doc.found ? 0 : 1;
  }
  if (sub === 'lint') return lintCmd(targetFile(target, root).file, root, json);
  if (sub === 'extract') return extractCmd(targetFile(target, root).phase, root, rest, json);
  throw new core.JdiError('usage: jdi dod <parse|lint|extract> <CONTEXT.md|phase> [--json] [--dry-run] [--all]', 1);
}

module.exports = { main, parse, lint, lintCommand, extract, splitVerify };
