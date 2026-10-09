'use strict';

// `jdi-cli dod bait <phase> [--rows 1,2] [--all] [--json]`
//
// Mechanical proof that a DoD `Verify:` is not hollow. A row may carry
//
//   **Bait:** `sed -i 's/return total/return 0/' src/cart.rs`
//
// — a mutation that breaks the criterion. In a throwaway git worktree at HEAD
// the runner (1) runs the Verify and expects exit 0 (baseline: the proof
// works in a clean checkout), (2) applies the Bait and checks it changed a
// file, (3) runs the Verify again and expects it to FAIL:
//
//   CAUGHT        the Verify failed on the mutated code — the proof is real
//   HOLLOW        the Verify still passed with the criterion broken (objective)
//   INCONCLUSIVE  baseline failed in the clean checkout, or the Bait changed nothing
//
// Results go to .jdi/cache/gates/<slug>/bait.json, keyed by the row's hash
// (criterion + Verify + Bait + script). A CAUGHT row is not re-run until its
// hash changes; the DoD critic skips rows with a bait result.
//
// The worktree lives in .jdi/cache/bait/ (gitignored, removed after each row)
// — never in /tmp, which is memory on small dev boxes. Untracked dependency
// dirs are linked into it (config `dod.bait_links`, default: every
// node_modules up to depth 3), and the stack env/path_prepend applies, so a
// clean checkout can build without a reinstall.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const dod = require('./dod');
const gates = require('./gates');

function baitFile(root, phase) {
  return path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, 'bait.json');
}

function readResults(root, phase) {
  return core.readJson(baitFile(root, phase), null) || { rows: {} };
}

function findLinks(root, config) {
  if (Array.isArray(config.dod?.bait_links)) return config.dod.bait_links;
  const out = [];
  const walk = (rel, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name === '.jdi') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') out.push(r);
      else if (!e.name.startsWith('.')) walk(r, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

function addWorktree(root, dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = core.git(['worktree', 'add', '--detach', '--quiet', dir, 'HEAD'], root);
  if (r.code !== 0) throw new core.JdiError(`git worktree add failed: ${r.stderr}`, 1);
}

function removeWorktree(root, dir) {
  core.git(['worktree', 'remove', '--force', dir], root);
  fs.rmSync(dir, { recursive: true, force: true });
  core.git(['worktree', 'prune'], root);
}

function contextItems(root, phase) {
  const file = path.join(phase.absDir, 'CONTEXT.md');
  if (!fs.existsSync(file)) return [];
  return dod.parse(fs.readFileSync(file, 'utf8'), file).items;
}

function runBait(phase, opts = {}, root = process.cwd()) {
  const config = core.loadConfig(root);
  const stacks = gates.loadStacks(root);
  const env = gates.envFor(stacks);
  const shell = gates.shellFor(stacks[0]);
  const timeoutMin = (stacks[0] || {}).timeout_min || 30;
  const wanted = opts.rows ? new Set(opts.rows) : null;
  const prev = readResults(root, phase);
  const head = core.git(['rev-parse', 'HEAD'], root).stdout || null;
  const results = { head, rows: { ...prev.rows } };
  const report = [];
  const links = findLinks(root, config);
  const logDir = path.join(root, core.JDI_DIR, 'cache', 'gates', phase.slug, 'bait');

  for (const it of contextItems(root, phase)) {
    if (it.type !== 'auto' || !it.bait || !it.verify || it.evidence) continue;
    if (wanted && !wanted.has(it.id)) continue;
    const hash = dod.rowHash(it, root);
    const last = prev.rows[it.id];
    if (!opts.all && last && last.hash === hash && last.status === 'CAUGHT') {
      report.push({ id: it.id, status: 'CAUGHT', cached: true });
      continue;
    }
    const wt = path.join(root, core.JDI_DIR, 'cache', 'bait', `wt-${it.id}`);
    if (fs.existsSync(wt)) removeWorktree(root, wt);
    addWorktree(root, wt);
    let res;
    try {
      for (const l of links) {
        const src = path.join(root, l);
        const dst = path.join(wt, l);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
        }
      }
      const exec = (cmd, name) => gates.run(cmd, { root, cwd: wt, env, shell, timeoutMin, log: path.join(logDir, `dod-${it.id}-${name}.log`) });
      const base = exec(it.verify.command, 'baseline');
      if (base.exit !== 0) {
        res = { status: 'INCONCLUSIVE', reason: `baseline: the Verify exits ${base.exit} in a clean checkout (missing dependency? set dod.bait_links or the stack env)`, excerpt: gates.tail(base.out, 8) };
      } else {
        const mut = exec(it.bait, 'bait');
        const changed = core.git(['status', '--porcelain', '--untracked-files=no'], wt).stdout;
        if (!changed) res = { status: 'INCONCLUSIVE', reason: `the Bait changed no tracked file (exit ${mut.exit})` };
        else {
          const after = exec(it.verify.command, 'after-bait');
          res = after.exit !== 0 ? { status: 'CAUGHT' } : { status: 'HOLLOW', reason: 'the Verify still exits 0 with the criterion broken by the Bait' };
        }
      }
    } finally {
      removeWorktree(root, wt);
    }
    results.rows[it.id] = { hash, ...res, bait: it.bait, at: new Date().toISOString() };
    report.push({ id: it.id, ...res });
  }
  core.writeFileEnsured(baitFile(root, phase), JSON.stringify(results, null, 2) + '\n', root);
  return report;
}

function main(argv) {
  const opts = {};
  let id = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rows') opts.rows = argv[++i].split(',').map((x) => Number(x.trim())).filter(Boolean);
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) throw new core.JdiError(`unknown flag: ${a}`, 1);
    else id = a;
  }
  if (!id) throw new core.JdiError('usage: jdi dod bait <phase> [--rows 1,2] [--all] [--json]', 1);
  const root = process.cwd();
  const phase = core.resolvePhase(id, root);
  const report = runBait(phase, opts, root);
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (!report.length) console.log(`dod bait ${phase.slug}: no row with a Bait`);
  else for (const r of report) console.log(`  DoD ${r.id}: ${r.status}${r.cached ? ' (unchanged since the last run)' : ''}${r.reason ? ` — ${r.reason}` : ''}`);
  return report.some((r) => r.status === 'HOLLOW') ? 2 : 0;
}

module.exports = { main, runBait, readResults };
