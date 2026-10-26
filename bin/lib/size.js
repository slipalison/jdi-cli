'use strict';

// `jdi-cli size <phase> [--json]` — lite or full, from the plan.
// `jdi-cli size <phase> --intake [--json]` — split or single, from CONTEXT.md.
// `jdi-cli size <phase> --direct [--json]` — direct or planned, from CONTEXT.md.
//
// Every agent spawn pays its system prompt, the specialist and its brief
// before doing anything; for a small phase, that fixed cost dominates. A phase
// is LITE when all of these hold (config `sizing`):
//   - tasks        <= lite_max_tasks     (default 3)
//   - files        <= lite_max_files     (default 6, union of `Files modified`)
//   - auto DoD rows <= lite_max_dod_rows (default 6, CONTEXT.md)
//   - one stack: every file routes to the same doer
//   - no file matches `sizing.sensitive_globs` (auth, migrations, payments...)
// and `economy.sizing` is not false. Lite changes HOW the work is dispatched,
// never what is checked: /jdi-do runs all tasks in ONE doer spawn, in order;
// /jdi-verify skips the DoD critic unless it was forced (/jdi-issue). Gates,
// reviewers and the DoD run exactly as in a full phase.
//
// --intake (#72), right after /jdi-discuss and before any plan: every DoD row
// is a proof that can come back hollow, and each finding costs a verify round
// — two big cards in one phase took 6 h where small ones converged in one or
// two rounds. The phase should be SPLIT when, in CONTEXT.md:
//   - DoD rows (automatic + evidence)  > sizing.split_max_dod_rows (12)
//   - areas touched                    > sizing.split_max_areas (3): the
//     stacks whose globs match a path named in the DoD or the acceptance
//     criteria, plus `e2e` for evidence rows
//   - acceptance criteria              > sizing.split_max_criteria (8)
// It only measures; where to cut is the asker's call (`mode=split`).
//
// --direct (0.21), at the same point: a card this narrow does not need a
// planner spawn — the orchestrator writes a one-task PLAN.md itself and every
// gate runs as usual. Direct when, in CONTEXT.md:
//   - automatic DoD rows <= sizing.direct_max_dod_rows (3), no evidence row
//   - acceptance criteria <= sizing.direct_max_criteria (3)
//   - at most one area: the paths it names route to one stack
//   - no path it names matches sizing.sensitive_globs

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const dod = require('./dod');
const brief = require('./brief');

function doerGlobs(root) {
  const d = path.join(root, core.JDI_DIR, 'agents');
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => /^jdi-doer-.*\.md$/.test(f))
    .sort()
    .map((f) => {
      const g = core.readFrontmatter(path.join(d, f)).scope?.file_glob;
      const globs = !g || g === '**/*' ? ['**/*'] : String(g).split(/[,\s]+/).filter(Boolean);
      return { name: f.slice(0, -3), globs };
    });
}

// The doers the plan routes to: its own `**Specialist:**` fields first (set by
// the planner); without them, the files by the doers' globs. Files no doer
// owns (docs, root config) do not make a second stack.
function routedDoers(root, tasks, files) {
  const doers = doerGlobs(root);
  const routed = new Set(tasks.map((t) => t.specialist).filter((x) => x.startsWith('jdi-doer-')));
  if (routed.size) return routed;
  for (const f of files) {
    const d = doers.find((x) => !x.globs.includes('**/*') && core.matchesAny(f, x.globs)) || doers.find((x) => x.globs.includes('**/*'));
    if (d) routed.add(d.name);
  }
  if (!routed.size && doers.length === 1) routed.add(doers[0].name);
  return routed;
}

function fullReasons(m, limits, sizingOff) {
  return [
    [sizingOff, 'economy.sizing is false'],
    [m.tasks.length > limits.lite_max_tasks, `${m.tasks.length} tasks > ${limits.lite_max_tasks}`],
    [m.files.length > limits.lite_max_files, `${m.files.length} files > ${limits.lite_max_files}`],
    [m.autoRows > limits.lite_max_dod_rows, `${m.autoRows} automatic DoD rows > ${limits.lite_max_dod_rows}`],
    [m.routed.size > 1, `${m.routed.size} stacks (${[...m.routed].join(', ')})`],
    [m.sensitive.length > 0, 'sensitive files: ' + m.sensitive.join(', ')],
    [!m.tasks.length, 'no task parsed from PLAN.md'],
  ]
    .filter(([hit]) => hit)
    .map(([, why]) => why);
}

function size(phase, root = process.cwd()) {
  const config = core.loadConfig(root);
  const limits = { lite_max_tasks: 3, lite_max_files: 6, lite_max_dod_rows: 6, sensitive_globs: [], ...config.sizing };
  const planText = core.readIf(path.join(phase.absDir, 'PLAN.md'));
  if (!planText) throw new core.JdiError(`${phase.dir}/PLAN.md not found — size is decided from the plan`, 2);
  const tasks = brief.parseTasks(planText);
  const files = [...new Set(tasks.flatMap((t) => t.files))];
  const ctxFile = path.join(phase.absDir, 'CONTEXT.md');
  const items = fs.existsSync(ctxFile) ? dod.parse(fs.readFileSync(ctxFile, 'utf8'), ctxFile).items : [];
  const m = {
    tasks,
    files,
    autoRows: items.filter((it) => it.type === 'auto').length,
    routed: routedDoers(root, tasks, files),
    sensitive: files.filter((f) => core.matchesAny(f, limits.sensitive_globs || [])),
  };
  const reasons = fullReasons(m, limits, config.economy?.sizing === false);
  return {
    phase: phase.slug,
    size: reasons.length ? 'full' : 'lite',
    reasons,
    tasks: tasks.map((t) => t.id),
    files: files.length,
    dod_rows: m.autoRows,
    doer: m.routed.size === 1 ? [...m.routed][0] : null,
  };
}

const ACCEPTANCE_RE = /^#{2,4}\s+(acceptance|crit[eé]rios? de aceite|done when)/i;

function acceptanceCriteria(text) {
  let inSec = false;
  let n = 0;
  for (const l of text.split('\n')) {
    if (/^#{2,4}\s/.test(l)) inSec = ACCEPTANCE_RE.test(l);
    else if (inSec && /^([-*]|\d+\.)\s/.test(l)) n++; // top-level items only
  }
  return n;
}

// The repository paths a text names.
function pathsIn(text) {
  return text.split(/[\s`'"(),;]+/).filter((t) => t.includes('/') && !t.startsWith('http') && !t.startsWith('.jdi/'));
}

// Stacks named by the paths in the DoD rows and the criteria.
function areasOf(root, items, text) {
  const paths = pathsIn(text);
  const areas = new Set();
  for (const d of doerGlobs(root).filter((x) => !x.globs.includes('**/*'))) {
    if (paths.some((p) => core.matchesAny(p.replace(/^\.\//, ''), d.globs) || d.globs.some((g) => g.split('*')[0] && p.startsWith(g.split('*')[0])))) areas.add(d.name.replace(/^jdi-doer-/, ''));
  }
  if (items.some((it) => it.evidence)) areas.add('e2e');
  return areas;
}

function readContext(phase, flag) {
  const ctxFile = path.join(phase.absDir, 'CONTEXT.md');
  const text = core.readIf(ctxFile);
  if (text === null) throw new core.JdiError(`${phase.dir}/CONTEXT.md not found — ${flag} measures the discussed phase`, 2);
  return { text, items: dod.parse(text, ctxFile).items.filter((it) => it.type === 'auto') };
}

function direct(phase, root = process.cwd()) {
  const config = core.loadConfig(root);
  const limits = { direct_max_dod_rows: 3, direct_max_criteria: 3, sensitive_globs: [], ...config.sizing };
  const { text, items } = readContext(phase, '--direct');
  const areas = areasOf(root, items, text);
  const criteria = acceptanceCriteria(text);
  const evidence = items.filter((it) => it.evidence).length;
  const sensitive = pathsIn(text).filter((p) => core.matchesAny(p.replace(/^\.\//, ''), limits.sensitive_globs || []));
  const reasons = [
    [items.length > limits.direct_max_dod_rows, `${items.length} DoD rows > ${limits.direct_max_dod_rows}`],
    [evidence > 0, `${evidence} evidence row(s)`],
    [criteria > limits.direct_max_criteria, `${criteria} acceptance criteria > ${limits.direct_max_criteria}`],
    [areas.size > 1, `${areas.size} areas (${[...areas].join(', ')})`],
    [sensitive.length > 0, 'sensitive paths: ' + [...new Set(sensitive)].join(', ')],
  ]
    .filter(([hit]) => hit)
    .map(([, why]) => why);
  return { phase: phase.slug, path: reasons.length ? 'planned' : 'direct', reasons, dod_rows: items.length, areas: [...areas], criteria };
}

function intake(phase, root = process.cwd()) {
  const config = core.loadConfig(root);
  const limits = { split_max_dod_rows: 12, split_max_areas: 3, split_max_criteria: 8, ...config.sizing };
  const { text, items } = readContext(phase, '--intake');
  const areas = areasOf(root, items, text);
  const criteria = acceptanceCriteria(text);
  const reasons = [
    [items.length > limits.split_max_dod_rows, `${items.length} DoD rows > ${limits.split_max_dod_rows}`],
    [areas.size > limits.split_max_areas, `${areas.size} areas (${[...areas].join(', ')}) > ${limits.split_max_areas}`],
    [criteria > limits.split_max_criteria, `${criteria} acceptance criteria > ${limits.split_max_criteria}`],
  ]
    .filter(([hit]) => hit)
    .map(([, why]) => why);
  return { phase: phase.slug, intake: reasons.length ? 'split' : 'single', reasons, dod_rows: items.length, areas: [...areas], criteria };
}

// One line (the verdict, then the reasons or the counts), or the JSON.
function report(r, verdict, counts, json) {
  const detail = r.reasons.length ? r.reasons.join('; ') : counts;
  process.stdout.write(json ? JSON.stringify(r) + '\n' : `${verdict} — ${detail}\n`);
  return 0;
}

function main(argv) {
  const id = argv.find((a) => !a.startsWith('--'));
  if (!id) throw new core.JdiError('usage: jdi size <phase> [--intake|--direct] [--json]', 1);
  const root = process.cwd();
  const json = argv.includes('--json');
  const phase = core.resolvePhase(id, root);
  if (argv.includes('--direct')) {
    const r = direct(phase, root);
    return report(r, r.path, `${r.dod_rows} DoD row(s), ${r.criteria} criteria, ${r.areas.length || 'no'} area`, json);
  }
  if (argv.includes('--intake')) {
    const r = intake(phase, root);
    return report(r, r.intake, `${r.dod_rows} DoD row(s), ${r.areas.length} area(s), ${r.criteria} criteria`, json);
  }
  const r = size(phase, root);
  return report(r, r.size, `${r.tasks.length} task(s), ${r.files} file(s), ${r.dod_rows} DoD row(s), ${r.doer}`, json);
}

module.exports = { main, size, intake, direct };
