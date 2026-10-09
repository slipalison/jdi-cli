'use strict';

// `jdi-cli specialists <lint|upgrade> [--write] [--adopt]`
//
// The specialists in .jdi/agents/ are generated once by /jdi-bootstrap and then
// customized by the project — so template fixes never reached existing
// projects. Since 0.17.0 the JDI-owned parts of the templates are MANAGED
// BLOCKS:
//
//   <!-- jdi:managed id=inputs --> ... <!-- jdi:/managed -->
//
// `upgrade` replaces the content of each block with the current template's
// (everything outside the markers is the project's and stays byte for byte).
// `--adopt` handles specialists generated before 0.17 (no markers): the
// `<inputs>` / `<return_contract>` elements are replaced by the managed blocks
// and missing blocks are inserted after `</role>`. Without `--write` it only
// prints what would change. After writing, run `jdi-cli sync-specialists`.
//
// `lint` reports what makes every task pay twice or read garbage: unresolved
// placeholders, dead brownfield text, instructions to re-read injected files,
// `<skills_to_load>`, missing return contract / managed blocks, size.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const template = require('./template');

const BLOCK_RE = /<!-- jdi:managed id=([a-z_]+) -->\n([\s\S]*?)\n<!-- jdi:\/managed -->/g;
const RUNTIME_PLACEHOLDERS = new Set(['PHASE_DIR', 'PHASE_SLUG', 'N', 'X', 'Y', 'Z']);
const ARCHITECT_PLACEHOLDERS = new Set(['BOUNDARY_COMMIT', 'PROJECT_NAME', 'FILE_GLOB', 'STACK_LABEL', 'PROJECT_SLUG', 'COVERAGE_MIN', 'TEST_FRAMEWORK', 'STACK', 'TEST_COMMAND', 'LLM_OPENCODE_MODEL', 'LINT_COMMAND', 'CODE_DESIGN', 'TEST_COMMAND_PS', 'STACK_SPECIFIC_CHECKS', 'SECURITY_RULES', 'PROJECT_CONVENTIONS', 'LINT_COMMAND_PS', 'LINTER', 'FRAMEWORKS', 'COVERAGE_COMMAND', 'COVERAGE_COMMAND_PS', 'COMMIT_PREFIX', 'BUILD_COMMAND', 'BUILD_COMMAND_PS', 'ADOPTED']);
const REREAD_RE = /(subagente n[aã]o herda|subagent does not inherit|ler com Read ANTES|read with Read BEFORE|(leia|ler|read)[^.\n]{0,40}\.claude\/rules|\.claude\/rules\/[^\n]{0,12}\((leia|read))/i;

function blocks(text) {
  const out = new Map();
  for (const m of text.matchAll(BLOCK_RE)) out.set(m[1], m[2]);
  return out;
}

function roleOf(file) {
  const b = path.basename(file);
  if (b.startsWith('jdi-doer-')) return 'doer';
  if (b.startsWith('jdi-reviewer-')) return 'reviewer';
  return null;
}

function templateBlocks(role) {
  return blocks(template.render(role === 'doer' ? 'doer-specialist' : 'reviewer-specialist'));
}

const wrap = (id, body) => `<!-- jdi:managed id=${id} -->\n${body}\n<!-- jdi:/managed -->`;

// Replace the first `open ... close` span (both included) found at or after
// `from`; null when there is none. Plain index search, no regex.
function replaceSpan(text, open, close, replacement) {
  const i = text.indexOf(open);
  if (i === -1) return null;
  const j = text.indexOf(close, i + open.length);
  if (j === -1) return null;
  return text.slice(0, i) + replacement + text.slice(j + close.length);
}

// adopt: replace the legacy element with the same tag, or insert after </role>
function adoptBlock(out, id, body) {
  const tag = /^<([a-z_]+)>/.exec(body)?.[1];
  const replaced = tag ? replaceSpan(out, `<${tag}>`, `</${tag}>`, wrap(id, body)) : null;
  if (replaced !== null) return { text: replaced, change: `replaced <${tag}> with managed ${id}` };
  const r = out.indexOf('</role>');
  if (r !== -1) {
    const end = out[r + 7] === '\n' ? r + 8 : r + 7;
    return { text: `${out.slice(0, r)}</role>\n\n${wrap(id, body)}\n${out.slice(end)}`, change: `inserted managed ${id}` };
  }
  return { text: out.trimEnd() + `\n\n${wrap(id, body)}\n`, change: `appended managed ${id}` };
}

function upgradeText(text, role, { adopt = false } = {}) {
  const tpl = templateBlocks(role);
  let out = text;
  const changes = [];
  const have = blocks(text);
  if (have.size === 0 && !adopt) return { text, changes: [], needsAdopt: true };
  for (const [id, body] of tpl) {
    if (!have.has(id)) {
      const r = adoptBlock(out, id, body);
      out = r.text;
      changes.push(r.change);
    } else if (have.get(id) !== body) {
      out = replaceSpan(out, `<!-- jdi:managed id=${id} -->\n`, '\n<!-- jdi:/managed -->', wrap(id, body));
      changes.push(`updated ${id}`);
    }
  }
  return { text: out, changes, needsAdopt: false };
}

function lintText(text, file) {
  const findings = [];
  const add = (level, msg) => findings.push({ file, level, msg });
  const seen = new Set();
  for (const m of text.matchAll(/\{([A-Z][A-Z_]{2,})\}/g)) {
    if (RUNTIME_PLACEHOLDERS.has(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    // the architect's placeholders must never survive generation; anything
    // else uppercase may be the project's own notation
    if (ARCHITECT_PLACEHOLDERS.has(m[1])) add('ERROR', `placeholder do template nao resolvido {${m[1]}}`);
  }
  if (/If false=true|If \{ADOPTED\}|\(created after \)|\{BOUNDARY_COMMIT\}\.\.HEAD/.test(text) && !/<!-- jdi:adopted -->/.test(text)) {
    add('WARN', 'texto de projeto adotado (brownfield) num specialist greenfield — apague o bloco morto');
  }
  if (REREAD_RE.test(text)) add('WARN', 'manda reler CLAUDE.md/rules que o runtime ja injeta — cada task paga duas vezes');
  if (text.includes('<skills_to_load>')) add('WARN', '<skills_to_load>: o specialist nao tem a ferramenta Skill, a lista nunca carrega');
  if (text.includes('<dod_critic_mode>')) add('WARN', '<dod_critic_mode>: desde a 0.18 o critico do DoD e o agente jdi-dod-critic — o bloco e texto morto em todo spawn; apague-o');
  if (!text.includes('<return_contract>')) add('WARN', 'sem <return_contract>: o resultado volta inteiro para o contexto do orquestrador');
  if (!/<!-- jdi:managed id=/.test(text)) add('NOTE', 'sem blocos gerenciados: `jdi-cli specialists upgrade --adopt` traz as entradas da versao atual');
  const tokens = core.estimateTokens(text, 3.0);
  if (tokens > 8000) add('WARN', `~${tokens} tokens: todo spawn deste agente paga isso em toda chamada`);
  return findings;
}

function files(root) {
  const d = path.join(root, core.JDI_DIR, 'agents');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => /^jdi-(doer|reviewer)-.*\.md$/.test(f)).sort().map((f) => path.join(d, f));
}

function lineDiff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out = [];
  let i = 0;
  while (i < Math.max(al.length, bl.length) && al[i] === bl[i]) i++;
  let ja = al.length - 1;
  let jb = bl.length - 1;
  while (ja >= i && jb >= i && al[ja] === bl[jb]) {
    ja--;
    jb--;
  }
  out.push(`@@ line ${i + 1}`);
  for (let k = i; k <= ja; k++) out.push(`- ${al[k]}`);
  for (let k = i; k <= jb; k++) out.push(`+ ${bl[k]}`);
  return out.join('\n');
}

function lintCmd(root, list) {
  let errors = 0;
  for (const f of list) {
    const fnd = lintText(fs.readFileSync(f, 'utf8'), path.relative(root, f));
    for (const x of fnd) console.log(`[${x.level.toLowerCase()}] ${x.file}: ${x.msg}`);
    errors += fnd.filter((x) => x.level === 'ERROR').length;
    if (!fnd.length) console.log(`[ok] ${path.relative(root, f)}`);
  }
  return errors ? 1 : 0;
}

// One specialist: print what changes; write it when asked. True when changed.
function upgradeFile(root, f, { write, adopt }) {
  const before = fs.readFileSync(f, 'utf8');
  const r = upgradeText(before, roleOf(f), { adopt });
  const rel = path.relative(root, f);
  if (r.needsAdopt) console.log(`${rel}: sem blocos gerenciados (anterior a 0.17) — use --adopt`);
  else if (!r.changes.length) console.log(`${rel}: em dia`);
  else {
    console.log(`${rel}: ${r.changes.join('; ')}`);
    if (write) fs.writeFileSync(f, r.text);
    else console.log(lineDiff(before, r.text).split('\n').slice(0, 60).join('\n'));
    return true;
  }
  return false;
}

function upgradeCmd(root, list, rest) {
  const opts = { write: rest.includes('--write'), adopt: rest.includes('--adopt') };
  const changed = list.filter((f) => upgradeFile(root, f, opts)).length;
  if (changed && opts.write) console.log(`Proximo: \`npx -y jdi-cli@${require('../../package.json').version} sync-specialists\` para atualizar as copias do runtime.`);
  if (changed && !opts.write) console.log('(nada gravado — repita com --write)');
  return 0;
}

function main(argv) {
  const [sub, ...rest] = argv;
  const root = process.cwd();
  const list = files(root);
  if (!list.length) {
    console.log('no specialists in .jdi/agents/ (run /jdi-bootstrap)');
    return 0;
  }
  if (sub === 'lint') return lintCmd(root, list);
  if (sub === 'upgrade') return upgradeCmd(root, list, rest);
  throw new core.JdiError('usage: jdi specialists <lint|upgrade> [--write] [--adopt]', 1);
}

module.exports = { main, upgradeText, lintText, blocks };
