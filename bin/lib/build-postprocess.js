#!/usr/bin/env node
'use strict';

// build-postprocess.js — last step of BOTH builders (jdi-build.sh and
// jdi-build.ps1), so the two keep producing byte-identical runtimes/.
//
// For every text file under runtimes/<runtime>/ it:
//   1. keeps the body of `<!-- jdi:only <rt>[,<rt>...] -->` ... `<!-- jdi:end -->`
//      blocks only in the listed runtimes (the marker lines are always
//      dropped). This is how a fact measured on ONE runtime (e.g. "Claude Code
//      already injects CLAUDE.md into sub-agents") is stated only there.
//   2. pins the CLI: `{{JDI_CLI}}` -> `jdi-cli@<version>` and
//      `{{JDI_VERSION}}` -> `<version>`. Installed commands then always call the
//      exact CLI version they were built with — never a stale npx cache and
//      never a newer release with different helpers.
//
// Usage: node bin/lib/build-postprocess.js <runtimes-dir> [--version <v>]
//        node bin/lib/build-postprocess.js --stdin <runtime> [--version <v>]
// Exit: 0 ok, 1 malformed block (unbalanced / nested / unknown runtime).

const fs = require('node:fs');
const path = require('node:path');

const RUNTIMES = ['claude', 'copilot', 'antigravity', 'opencode', 'junie'];
const TEXT_EXT = new Set(['.md', '.yml', '.yaml', '.json', '.jsonc', '.sh', '.ps1', '.txt']);
const OPEN_RE = /^<!-- ?jdi:only ([a-z, ]+)-->$/;
const END_RE = /^<!-- ?jdi:end ?-->$/;

function packageVersion() {
  const pkg = path.resolve(__dirname, '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
}

// Marker lines may carry indentation and trailing blanks; trimmed before the
// (anchored, linear) patterns above are applied.
function openBlock(line, runtime, where, lineNo, block) {
  const open = OPEN_RE.exec(line);
  if (!open) return null;
  if (block) throw new Error(`${where}:${lineNo}: nested jdi:only block (opened at line ${block.line})`);
  const list = open[1].split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = list.find((rt) => !RUNTIMES.includes(rt));
  if (unknown) throw new Error(`${where}:${lineNo}: unknown runtime "${unknown}" in jdi:only`);
  return { keep: list.includes(runtime), line: lineNo };
}

// Pure transform — exported for tests.
function transform(text, runtime, version, where = '<text>') {
  if (!RUNTIMES.includes(runtime)) throw new Error(`unknown runtime: ${runtime}`);
  const out = [];
  let block = null; // { keep, line }
  text.split('\n').forEach((line, i) => {
    const marker = line.trim().replaceAll(/\s+/g, ' ');
    const opened = openBlock(marker, runtime, where, i + 1, block);
    if (opened) {
      block = opened;
      return;
    }
    if (END_RE.test(marker)) {
      if (!block) throw new Error(`${where}:${i + 1}: jdi:end without jdi:only`);
      block = null;
      return;
    }
    if (!block || block.keep) out.push(line);
  });
  if (block) throw new Error(`${where}:${block.line}: jdi:only block never closed`);
  return out
    .join('\n')
    .replaceAll('{{JDI_CLI}}', `jdi-cli@${version}`)
    .replaceAll('{{JDI_VERSION}}', version);
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, visit);
    else if (entry.isFile() && TEXT_EXT.has(path.extname(entry.name))) visit(p);
  }
}

// Project instruction files are generated from ONE source
// (core/templates/instructions.md, #54): they used to be five hand-kept files
// that drifted from the real command/agent set.
const INSTRUCTION_FILES = {
  claude: 'CLAUDE.md',
  copilot: 'copilot-instructions.md',
  opencode: 'AGENTS.md',
  junie: 'AGENTS.md',
  antigravity: 'agents.md',
};

function writeInstructionFiles(runtimesDir) {
  const src = path.join(runtimesDir, '..', 'core', 'templates', 'instructions.md');
  if (!fs.existsSync(src)) return;
  const text = fs.readFileSync(src, 'utf8');
  for (const [rt, name] of Object.entries(INSTRUCTION_FILES)) {
    const dir = path.join(runtimesDir, rt);
    if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, name), text);
  }
}

function processTree(runtimesDir, version) {
  writeInstructionFiles(runtimesDir);
  let changed = 0;
  for (const rt of RUNTIMES) {
    const root = path.join(runtimesDir, rt);
    if (!fs.existsSync(root)) continue;
    walk(root, (file) => {
      const before = fs.readFileSync(file, 'utf8');
      const after = transform(before, rt, version, path.relative(runtimesDir, file));
      if (after !== before) {
        fs.writeFileSync(file, after);
        changed++;
      }
    });
  }
  return changed;
}

function main(argv) {
  const args = argv.slice(2);
  let version = null;
  const vi = args.indexOf('--version');
  if (vi !== -1) {
    version = args[vi + 1];
    args.splice(vi, 2);
  }
  version = version || packageVersion();

  if (args[0] === '--stdin') {
    const runtime = args[1];
    const input = fs.readFileSync(0, 'utf8');
    process.stdout.write(transform(input, runtime, version, '<stdin>'));
    return 0;
  }
  const dir = args[0];
  if (!dir) {
    console.error('usage: build-postprocess.js <runtimes-dir> [--version <v>] | --stdin <runtime> [--version <v>]');
    return 1;
  }
  const n = processTree(path.resolve(dir), version);
  console.log(`  postprocess: ${n} arquivo(s) com bloco de runtime ou versao fixada (jdi-cli@${version})`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv);
  } catch (err) {
    console.error(`build-postprocess: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { transform, processTree, RUNTIMES, INSTRUCTION_FILES };
