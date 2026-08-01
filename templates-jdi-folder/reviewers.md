# Reviewers

> **Layout v3 (0.13.0+):** este arquivo eh uma VIEW gerada por `npx -y jdi-cli render` a partir de `.jdi/registry/R-{date}-{slug}.md` (um arquivo por bootstrap//jdi-create, secoes fenced `<!-- jdi:... -->`). Nunca edite a view nem faca append nela — escreva o arquivo per-entry e rode render. Em projetos legados (sem `.jdi/registry/`) o append direto continua valendo.

Per-project reviewer specialists. `/jdi-verify <N>` le esse arquivo.

Veredicto: APPROVED / APPROVED_WITH_WARNINGS / BLOCKED. BLOCKED bloqueia o `/jdi-ship`.

## Format

```markdown
| Agent | Trigger | Bloqueia ship? |
|---|---|---|
| jdi-reviewer-{slug} | /jdi-verify | sim, se BLOCKED |
```

Reviewers ficam em `.jdi/agents/jdi-reviewer-{slug}.md` (per-project).

## Como sao criados

Junto com o doer, via `/jdi-bootstrap` -> `jdi-architect` modo specialist. Template base em `core/templates/reviewer-specialist.md`.

Gates default (cada reviewer customiza):
- Build
- Tests
- Coverage (threshold do PROJECT.md, default 80%)
- Lint/Format
- Security/Perf rules da stack
- Plan consistency

## Entries

| Agent | Trigger | Bloqueia ship? |
|---|---|---|
<!-- Append abaixo via /jdi-bootstrap -->
