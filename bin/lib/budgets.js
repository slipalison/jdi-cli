'use strict';

// `jdi-cli budgets <phase> [--json]` (also `validate-phase <id> --budgets`):
// measures the phase artifacts against `.jdi/config.json` `budgets` (tokens,
// estimated with `chars_per_token` for the project language).
//
// Enforcement applies to phases created with jdi-cli >= 0.17.0 (the roadmap
// entry carries `created_with:`); older phases get NOTE lines only — budgets
// are never applied retroactively to history.
//
// Exit: 0 ok / warnings, 1 when `budgets.enforce` is `fail` and a new phase is
// over budget.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./jdi-core');
const dod = require('./dod');

const ARTIFACT_BUDGET = {
  'CONTEXT.md': 'context_tokens',
  'PLAN.md': 'plan_tokens',
  'SUMMARY.md': 'summary_tokens',
};
const KNOWN_FILES = new Set(['CONTEXT.md', 'PLAN.md', 'SUMMARY.md', 'REVIEW.md', 'SHIPPED.md', 'LOOP.md', 'HANDOFF.md']);

function semverGte(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
}

function createdWith(root, slug) {
  const f = path.join(root, core.JDI_DIR, 'roadmap', `${slug}.md`);
  if (!fs.existsSync(f)) return null;
  const v = core.readFrontmatter(f).created_with;
  return v === undefined || v === null ? null : String(v);
}

function check(phase, root = process.cwd(), config = core.loadConfig(root)) {
  const ratio = core.charsPerToken(config, core.projectLang(root));
  const b = config.budgets || {};
  const created = createdWith(root, phase.slug);
  const enforced = created !== null && semverGte(created, '0.17.0');
  const over = (b.enforce === 'fail' && enforced) ? 'ERROR' : enforced ? 'WARN' : 'NOTE';
  const findings = [];
  const add = (level, file, msg) => findings.push({ level, file, msg });

  for (const [name, key] of Object.entries(ARTIFACT_BUDGET)) {
    const f = path.join(phase.absDir, name);
    if (!fs.existsSync(f)) continue;
    const tokens = core.estimateTokens(fs.readFileSync(f, 'utf8'), ratio);
    const max = b[key];
    if (max && tokens > max) add(over, name, `~${tokens} tokens (limite ${key}=${max}) — cada agente que le este arquivo paga isso em toda chamada`);
  }
  const review = path.join(phase.absDir, 'REVIEW.md');
  if (fs.existsSync(review) && b.review_segment_tokens) {
    const segs = fs.readFileSync(review, 'utf8').split(/\n(?=## Reviewer: )/);
    segs.forEach((seg, i) => {
      const tokens = core.estimateTokens(seg, ratio);
      if (tokens > b.review_segment_tokens) add(over, 'REVIEW.md', `segmento ${i + 1}: ~${tokens} tokens (limite review_segment_tokens=${b.review_segment_tokens})`);
    });
  }
  const ctx = path.join(phase.absDir, 'CONTEXT.md');
  if (fs.existsSync(ctx)) {
    const limit = b.verify_inline_chars ?? 300;
    for (const it of dod.parse(fs.readFileSync(ctx, 'utf8'), ctx).items) {
      if (it.verify && !it.script && it.verify.command.length > limit) {
        add(over, 'CONTEXT.md', `Verify do item ${it.id}: ${it.verify.command.length} caracteres na linha (limite ${limit}) — \`jdi-cli dod extract ${phase.slug}\``);
      }
    }
  }
  const extraKb = b.phase_extra_file_kb ?? 50;
  const walk = (dir, relBase = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (rel === 'verify') continue;
        walk(p, rel);
      } else if (!KNOWN_FILES.has(rel) && fs.statSync(p).size > extraKb * 1024) {
        add(over === 'NOTE' ? 'NOTE' : 'WARN', rel, `${Math.round(fs.statSync(p).size / 1024)} KB fora dos artefatos conhecidos — saida de ferramenta vai para .jdi/cache/, nao para a fase`);
      }
    }
  };
  if (fs.existsSync(phase.absDir)) walk(phase.absDir);
  return { phase: phase.slug, created_with: created, enforced, ratio, findings };
}

function main(argv) {
  const json = argv.includes('--json');
  const id = argv.find((a) => !a.startsWith('--'));
  if (!id) throw new core.JdiError('usage: jdi budgets <slug|position> [--json]', 1);
  const phase = core.resolvePhase(id);
  const r = check(phase);
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    for (const f of r.findings) console.log(`[${f.level.toLowerCase()}] ${f.file}: ${f.msg}`);
    console.log(`budgets ${r.phase}: ${r.findings.filter((f) => f.level !== 'NOTE').length} acima do limite${r.enforced ? '' : ' (fase anterior a 0.17: so informativo)'}`);
  }
  return r.findings.some((f) => f.level === 'ERROR') ? 1 : 0;
}

module.exports = { main, check, semverGte };
