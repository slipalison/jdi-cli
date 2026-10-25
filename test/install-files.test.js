'use strict';

// #78 — install/update write only the files JDI ships, keep a manifest, never
// touch third-party agents/skills, keep a file the project edited, and never
// recreate the example config files on update. Runs the real installer (.sh,
// or .ps1 on Windows).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir, write, read, jdi } = require('./helpers');

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const MARK = '<!-- jdi:lang-directive -->';

function project() {
  const root = tmpdir('jdi-i78-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  // a third-party kit, installed before JDI
  write(root, '.claude/agents/ux-revisor.md', '---\nname: ux-revisor\ndescription: other kit\n---\nthird-party body\n');
  write(root, '.claude/skills/ux-revisar/SKILL.md', '---\nname: ux-revisar\ndescription: other kit\n---\nthird-party skill\n');
  return root;
}

const env = { JDI_ANIMATE: 'off' };

test('install: only JDI files, with the pt-BR directive; third-party files untouched; manifest written (#78)', () => {
  const root = project();
  const before = read(root, '.claude/agents/ux-revisor.md');
  const r = jdi(root, ['install', 'claude', '--lang', 'pt-BR'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(read(root, '.claude/agents/ux-revisor.md'), before);
  assert.ok(!read(root, '.claude/skills/ux-revisar/SKILL.md').includes(MARK));
  assert.ok(read(root, '.claude/commands/jdi-status.md').includes(MARK));
  const m = JSON.parse(read(root, '.claude/.jdi-installed.json'));
  assert.ok(m.files['commands/jdi-status.md']);
  assert.ok(!m.files['agents/ux-revisor.md']);
  assert.ok(exists(root, '.claude/settings.example.json'), 'offered on a first install');
});

test('update: an edited JDI file is kept (new version in .jdi-new), --force replaces it; examples are not recreated (#78)', () => {
  const root = project();
  jdi(root, ['install', 'claude', '--lang', 'pt-BR'], env);
  write(root, '.jdi/VERSION', '0.0.1');
  write(root, '.jdi/LANG', 'pt-BR');
  fs.rmSync(path.join(root, '.claude/settings.example.json'));
  fs.appendFileSync(path.join(root, '.claude/commands/jdi-status.md'), 'project edit\n');
  // a file JDI wrote and no longer ships (unedited): removed by the update
  const m = JSON.parse(read(root, '.claude/.jdi-installed.json'));
  write(root, '.claude/commands/jdi-gone.md', 'old\n');
  m.files['commands/jdi-gone.md'] = require('node:crypto').createHash('sha256').update('old\n').digest('hex');
  write(root, '.claude/.jdi-installed.json', JSON.stringify(m));
  const thirdParty = read(root, '.claude/skills/ux-revisar/SKILL.md');

  let r = jdi(root, ['update'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(read(root, '.claude/commands/jdi-status.md'), /project edit/);
  assert.ok(exists(root, '.claude/commands/jdi-status.md.jdi-new'));
  assert.match(r.stderr + r.stdout, /jdi-status\.md foi editado no projeto/);
  assert.ok(!exists(root, '.claude/settings.example.json'), 'never recreated by update');
  assert.ok(!exists(root, '.claude/commands/jdi-gone.md'), 'a file JDI no longer ships is removed');
  assert.equal(read(root, '.claude/skills/ux-revisar/SKILL.md'), thirdParty);

  r = jdi(root, ['update', '--force'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(read(root, '.claude/commands/jdi-status.md'), /project edit/);
  assert.ok(!exists(root, '.claude/commands/jdi-status.md.jdi-new'));
});

test('install-files: a pre-manifest install is adopted (JDI files replaced as before)', () => {
  const { install } = require('../bin/lib/install-files');
  const root = tmpdir('jdi-i78-legacy-');
  write(root, 'src/agents/jdi-a.md', '---\nname: a\n---\nnew\n');
  write(root, 'dest/agents/jdi-a.md', 'old, from 0.19\n');
  const r = install(path.join(root, 'src'), path.join(root, 'dest'), { dirs: ['agents'] });
  assert.deepEqual(r.written, ['agents/jdi-a.md']);
  assert.equal(read(root, 'dest/agents/jdi-a.md'), '---\nname: a\n---\nnew\n');
  assert.ok(JSON.parse(read(root, 'dest/.jdi-installed.json')).files['agents/jdi-a.md']);
});

test('injectLang: the same bytes as the shell injector (awk)', () => {
  const { injectLang } = require('../bin/lib/install-files');
  const directive = read(path.join(__dirname, '..'), 'core/templates/lang-directive.pt-BR.md');
  const root = tmpdir('jdi-i78-inj-');
  const cases = ['---\nname: x\n---\nbody\n', '---\nname: x\n---\nno final newline', 'no frontmatter\n', `---\nname: x\n---\n${MARK}\nalready\n`];
  const lib = path.join(__dirname, '..', 'bin', 'lib', 'jdi-agent-emit.sh').split(path.sep).join('/');
  cases.forEach((c, i) => {
    write(root, `c${i}.md`, c);
    const sh = spawnSync('bash', ['-c', `source "${lib}"; inject_lang_directive_file c${i}.md; cat c${i}.md`], { cwd: root, encoding: 'utf8' });
    assert.equal(sh.status, 0, sh.stderr);
    assert.equal(injectLang(c, directive), sh.stdout, `case ${i}`);
  });
});

test('uninstall removes the install manifest (#78)', () => {
  const root = project();
  jdi(root, ['install', 'claude'], env);
  assert.ok(exists(root, '.claude/.jdi-installed.json'));
  const r = jdi(root, ['uninstall', 'claude', '--yes'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!exists(root, '.claude/.jdi-installed.json'));
  assert.ok(exists(root, '.claude/agents/ux-revisor.md'), 'third-party agent stays');
});
