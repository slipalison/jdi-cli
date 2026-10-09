'use strict';

// `jdi-cli template <name> [--out <file>]` — prints a template shipped in the
// npm package, with the CLI pinned to this version. Consumer projects never
// get core/ copied in (no-code-in-consumer-repo), so agents that need a
// template (the architect's specialist mode, the asker's DoD schema) read it
// through here instead of a `core/templates/...` path that does not exist
// there (#37).

const fs = require('node:fs');
const path = require('node:path');
const { transform } = require('./build-postprocess');
const core = require('./jdi-core');

const PKG = path.resolve(__dirname, '..', '..');
const VERSION = require(path.join(PKG, 'package.json')).version;

const TEMPLATES = {
  'dod-schema': 'core/templates/dod-schema.md',
  'doer-specialist': 'core/templates/doer-specialist.md',
  'reviewer-specialist': 'core/templates/reviewer-specialist.md',
  agent: 'core/templates/agent.md',
  skill: 'core/templates/skill.md',
  config: 'templates-jdi-folder/config.json',
  stack: 'templates-jdi-folder/stack.json',
};

function render(name, runtime = 'claude') {
  const rel = TEMPLATES[name];
  if (!rel) throw new core.JdiError(`unknown template '${name}' (available: ${Object.keys(TEMPLATES).join(', ')})`, 1);
  const file = path.join(PKG, rel);
  if (!fs.existsSync(file)) throw new core.JdiError(`template file missing in the package: ${rel}`, 1);
  return transform(fs.readFileSync(file, 'utf8'), runtime, VERSION, rel);
}

function main(argv) {
  let out = null;
  let runtime = 'claude';
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--runtime') runtime = argv[++i];
    else if (argv[i] === '--list') {
      process.stdout.write(Object.keys(TEMPLATES).join('\n') + '\n');
      return 0;
    } else if (argv[i].startsWith('-')) throw new core.JdiError(`unknown flag: ${argv[i]}`, 1);
    else pos.push(argv[i]);
  }
  if (pos.length !== 1) throw new core.JdiError('usage: jdi template <name> [--out <file>] [--runtime <rt>] | --list', 1);
  const text = render(pos[0], runtime);
  if (out) {
    core.writeFileEnsured(path.resolve(out), text);
    console.log(out);
  } else process.stdout.write(text);
  return 0;
}

module.exports = { main, render, TEMPLATES };
