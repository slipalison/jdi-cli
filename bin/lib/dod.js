'use strict';

// `jdi-cli dod <parse|lint|extract>` — the Definition of Done as data.
//
//   dod parse <CONTEXT.md|phase> [--json]        items: id, type, criterion, verify
//   dod lint  <CONTEXT.md|phase> [--json]        a.k.a. validate-dod (exit 1 on ERROR)
//   dod extract <phase> [--dry-run] [--all]      long `Verify:` bodies -> verify/dod-N.sh
//   dod bait <phase> [--rows 1,2] [--all]        mutation check of rows with `Bait:` (bait.js)
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

function parse(text, file = '<CONTEXT.md>') {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Definition of Done');
  if (start === -1) return { found: false, items: [], start: -1, end: -1, file };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const items = [];
  let section = 'auto';
  let cur = null;
  for (let i = start + 1; i < end; i++) {
    const l = lines[i];
    const h = /^###\s+(.*)$/.exec(l);
    if (h) {
      const t = h[1].toLowerCase();
      section = /manual/.test(t) ? 'manual' : /defer/.test(t) ? 'deferred' : 'auto';
      cur = null;
      continue;
    }
    const it = ITEM_RE.exec(l);
    if (it) {
      const num = /^\*\*(\d+)\./.exec(it[2]);
      cur = {
        id: num ? Number(num[1]) : items.length + 1,
        line: i + 1,
        type: section,
        criterion: it[2].replace(/\*\*/g, '').trim(),
        verify: null,
        evidence: false,
        verifyLine: null,
        source: null,
        stack: null,
        bait: null,
        hasEvidenceField: false,
      };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    const v = VERIFY_RE.exec(l);
    if (v && cur.verify === null) {
      const raw = v[3] || '';
      const sv = splitVerify(raw);
      cur.verify = { raw, ...sv, indent: v[1] };
      cur.evidence = Boolean(v[2]);
      cur.verifyLine = i + 1;
      const ref = SCRIPT_REF_RE.exec(sv.command);
      cur.script = ref ? ref[1].replace(/^\.\//, '') : null;
      continue;
    }
    const src = /^\s*\*\*Source:\*\*\s*(.*)$/.exec(l);
    if (src) {
      cur.source = src[1].trim();
      continue;
    }
    const bt = /^\s*\*\*Bait:\*\*\s*(.*)$/.exec(l);
    if (bt) {
      cur.bait = splitVerify(bt[1].trim()).command.trim() || null;
      continue;
    }
    const st = /^\s*\*\*Stack:\*\*\s*(.*)$/.exec(l);
    if (st) {
      cur.stack = st[1].trim();
      continue;
    }
    if (/^\s*\*\*Evidence:\*\*/.test(l)) {
      cur.hasEvidenceField = true;
      continue;
    }
    if (cur.verify === null && l.trim() && !/^\s*- /.test(l)) cur.criterion += ' ' + l.trim().replace(/\*\*/g, '');
  }
  for (const it of items) {
    if (it.verify && /human confirmation required/i.test(it.verify.raw)) it.type = it.type === 'deferred' ? 'deferred' : 'manual';
  }
  return { found: true, items, start: start + 1, end, file };
}

// Identity of a DoD row's proof: the criterion, the Verify, the Bait and the
// verify script's bytes. The critic and the bait runner re-examine a row only
// when this changes (or when its last result was not clean).
function rowHash(item, root = process.cwd()) {
  const crypto = require('node:crypto');
  const h = crypto.createHash('sha256');
  h.update(`${item.criterion}\n${item.verify ? item.verify.raw : ''}\n${item.evidence ? 'evidence' : ''}\n${item.bait || ''}\n`);
  if (item.script) h.update(core.readIf(path.join(root, item.script)) || '');
  return h.digest('hex').slice(0, 16);
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
const COUNT_CHECK_RE = /passed|\.\.\. ok|--- PASS|Total tests|Passed!|Tests?\s+[1-9]|tests? run:|[1-9]\d* tests?\b/i;
const CARGO_VALUE_FLAGS = new Set(['--manifest-path', '--test', '-p', '--package', '--features', '--bin', '--example', '--target', '-j', '--jobs', '--profile']);

function cargoHasFilter(args) {
  const toks = args.replace(/2>&1/g, ' ').split(/\s+/).filter(Boolean);
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
      if (tf.filtered(m[1] || '') && !COUNT_CHECK_RE.test(cmd)) {
        found.push({ level: 'ERROR', rule: 'DOD-L1', msg: `${tf.name} com filtro e sem checar a contagem: sai 0 quando nenhum teste casa — exija "N passed" com N >= 1` });
        break;
      }
    }
  }
  const parts = splitCommands(cmd).filter((p) => !/^\s*\w+=/.test(p) || /\s/.test(p));
  if (parts.length && parts.every((p) => /^grep\b/.test(p))) {
    const weak = parts.some((p) => /\s-[a-zA-Z]*r|\*|\/\s|\/$/.test(p) && !/^!/.test(p));
    if (weak) found.push({ level: 'WARN', rule: 'DOD-L2', msg: 'prova so por grep positivo sobre diretorio/glob: passa se o texto existir em qualquer lugar — ancore no arquivo e na linha' });
  }
  if (/\bnpm run e2e\b|\bplaywright\s+test\b(?![^|&;]*--list)|\bcypress\s+run\b/.test(cmd)) {
    found.push({ level: 'WARN', rule: 'DOD-L3', msg: 'roda E2E/login real dentro de um Verify automatico — marque `**Verify (evidence):**` e julgue pela evidencia registrada' });
  }
  return found;
}

function lint(file, { root = process.cwd(), config = core.loadConfig(root) } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const doc = parse(text, file);
  const findings = [];
  const add = (line, level, rule, msg) => findings.push({ file, line, level, rule, msg });
  if (!doc.found) {
    add(1, 'ERROR', 'DOD-S0', "o arquivo nao tem '## Definition of Done'");
    return findings;
  }
  const limit = config.budgets?.verify_inline_chars ?? 300;
  const strict = config.budgets?.enforce === 'fail';
  for (const it of doc.items) {
    if (it.type === 'auto' && !it.verify) add(it.line, 'ERROR', 'DOD-S1', `item ${it.id} sem \`Verify:\``);
    if (it.type === 'manual' && !it.hasEvidenceField) add(it.line, 'WARN', 'DOD-S1', `item manual ${it.id} sem \`Evidence:\``);
    if (!it.verify || it.type !== 'auto') continue;
    const cmd = it.verify.command;
    if (!it.script && cmd.length > limit) {
      add(it.verifyLine, strict ? 'ERROR' : 'WARN', 'DOD-S2', `Verify do item ${it.id} tem ${cmd.length} caracteres na linha (limite ${limit}) — \`jdi-cli dod extract\` move para verify/dod-${it.id}.sh`);
    }
    let body = cmd;
    if (it.script) {
      const sp = path.join(root, it.script);
      if (!fs.existsSync(sp)) {
        add(it.verifyLine, 'ERROR', 'DOD-S3', `Verify do item ${it.id} chama ${it.script}, que nao existe`);
        continue;
      }
      body = fs.readFileSync(sp, 'utf8');
    }
    if (it.evidence) continue;
    for (const f of lintCommand(body)) add(it.verifyLine, f.level, f.rule, `item ${it.id}: ${f.msg}`);
  }
  const extra = config.dod?.extra_lint;
  if (extra) {
    const cmd = extra.replaceAll('{file}', JSON.stringify(file));
    const r = spawnSync(cmd, { shell: true, cwd: root, encoding: 'utf8' });
    for (const l of (r.stdout || '').split('\n').filter(Boolean)) {
      const m = /^(.*?):(\d+): (ERRO|ERROR|AVISO|WARN|NOTA|NOTE) (\S+) (.*)$/.exec(l);
      if (m) add(Number(m[2]), /ERR/.test(m[3]) ? 'ERROR' : /AVISO|WARN/.test(m[3]) ? 'WARN' : 'NOTE', m[4], m[5]);
      else findings.push({ file, line: 0, level: 'NOTE', rule: 'extra_lint', msg: l });
    }
    if (r.status && r.status !== 0 && !findings.some((f) => f.level === 'ERROR')) {
      add(0, 'ERROR', 'extra_lint', `\`${extra}\` saiu ${r.status}`);
    }
  }
  return findings;
}

// --------------------------------------------------------------------------
// Extract
// --------------------------------------------------------------------------

function bashSyntaxOk(script) {
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  if (r.error) return null; // no bash on this machine: cannot check
  return r.status === 0;
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
  for (const it of doc.items) {
    if (it.type !== 'auto' || !it.verify || it.script) continue;
    if (!all && it.verify.command.length <= limit) continue;
    if (!it.verify.quoted) {
      report.push({ id: it.id, action: 'skipped', reason: 'Verify sem crase: extraia a mao' });
      continue;
    }
    const rel = `${phase.dir}/verify/dod-${it.id}.sh`;
    const scriptPath = path.join(root, rel);
    if (fs.existsSync(scriptPath)) {
      report.push({ id: it.id, action: 'skipped', reason: `${rel} ja existe` });
      continue;
    }
    const header = `#!/usr/bin/env bash\n# DoD ${it.id} (${phase.slug}): ${it.criterion.slice(0, 110)}\n# Extraido do CONTEXT.md por \`jdi-cli dod extract\`: o criterio continua la; aqui fica so o comando, como estava.\n`;
    const script = `${header}${it.verify.command}\n`;
    const ok = bashSyntaxOk(script);
    if (ok === false) {
      report.push({ id: it.id, action: 'skipped', reason: 'o comando extraido nao passa em `bash -n` (corte ambiguo das crases): extraia a mao' });
      continue;
    }
    const newLine = `${it.verify.indent}**Verify:** \`bash ${rel}\`${it.verify.tail}`;
    if (!dryRun) {
      core.writeFileEnsured(scriptPath, script, root);
      try {
        fs.chmodSync(scriptPath, 0o755);
      } catch {
        // Windows: the script is called through `bash <path>`, no exec bit needed
      }
      lines[it.verifyLine - 1] = newLine;
    }
    report.push({ id: it.id, action: dryRun ? 'would-extract' : 'extracted', script: rel, chars: it.verify.command.length, bashChecked: ok === true });
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

function main(argv) {
  const [sub, ...rest] = argv;
  const root = process.cwd();
  const json = rest.includes('--json');
  const args = rest.filter((a) => !a.startsWith('--'));
  if (sub === 'parse') {
    const { file } = targetFile(args[0], root);
    const doc = parse(fs.readFileSync(file, 'utf8'), file);
    process.stdout.write(JSON.stringify(doc, null, json ? 2 : 0) + '\n');
    return doc.found ? 0 : 1;
  }
  if (sub === 'lint') {
    const { file } = targetFile(args[0], root);
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
  if (sub === 'bait') return require('./bait').main(rest);
  if (sub === 'extract') {
    const { phase } = targetFile(args[0], root);
    if (!phase) throw new core.JdiError('dod extract precisa da fase (slug ou posicao), nao de um arquivo', 1);
    const report = extract(phase, { root, dryRun: rest.includes('--dry-run'), all: rest.includes('--all'), force: rest.includes('--force') });
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else {
      for (const r of report) console.log(`  item ${r.id}: ${r.action}${r.script ? ` -> ${r.script} (${r.chars} chars)` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
      if (!report.length) console.log('  nada a extrair');
    }
    return 0;
  }
  throw new core.JdiError('usage: jdi dod <parse|lint|extract|bait> <CONTEXT.md|phase> [--json] [--dry-run] [--all]', 1);
}

module.exports = { main, parse, lint, lintCommand, extract, splitVerify, rowHash };
