# JDI — State Schema

State em arquivo plano. Sem DB. Sem servidor. Markdown + YAML frontmatter quando precisa.

Decisoes locked ficam em `DECISIONS.md`. Audit trail dos specialists/agents criados ficam em `registry.md`. Aprendizado de phase fica em `SUMMARY.md` e `REVIEW.md` por phase.

## Arvore completa

```
.jdi/
+-- PROJECT.md           visao + stack + code-design LOCKED. Imutavel apos /jdi-new
+-- ROADMAP.md           phases sequencial, status por linha
+-- STATE.md             current_phase + next_step + flags. Atualizado por comandos
+-- DECISIONS.md         append-only. ADR mini. D-1, D-2, ...
+-- specialists.md       routing per-project (gerado por /jdi-bootstrap)
+-- reviewers.md         routing per-project
+-- registry.md          audit trail (R-1, R-2, ...) — tudo que /jdi-create ou /jdi-bootstrap criou
+-- todos.md             scope creep capturado pelo asker (opcional)
+-- agents/              per-project specialists
|   +-- jdi-doer-{slug}.md
|   +-- jdi-reviewer-{slug}.md
+-- phases/
|   +-- 01-setup-api/
|   |   +-- CONTEXT.md   saida do /jdi-discuss (asker)
|   |   +-- PLAN.md      saida do /jdi-plan (planner)
|   |   +-- SUMMARY.md   saida do /jdi-do (doer)
|   |   +-- REVIEW.md    saida do /jdi-verify (reviewer)
|   +-- 02-...
+-- archive/             phases antigas movidas (opcional)
```

Nada de `templates-jdi-folder/` copiado pra `.jdi/`. Files sao gerados direto pelos comandos:
- `/jdi-new` cria PROJECT, ROADMAP, STATE, DECISIONS, .gitattributes
- `/jdi-bootstrap` cria specialists.md, reviewers.md, registry.md + agents/*

---

## PROJECT.md

```markdown
# {project_name}

## Visao
1-3 linhas. O que o projeto resolve.

## Tipo
web app | cli | api | lib | mobile

## Stack
- Linguagem: {linguagem + versao}
- Framework: {framework + versao}
- Dependencias chave: {lista}

## Code Design
**LOCKED:** {DDD | Vertical Slice | Hexagonal | Clean | The Method}

Decidido em /jdi-new (D-1). Nao mudar.

## Slug
{project_slug}     # usado em commits, branches, specialist names

## Research notes (opcional)
- {fato 1}
- {fato 2}

## Constraints globais
- Coverage minimo 80%
- Conventional Commits
- Atomic commits por task
- Idioma: codigo en, discussao pt-BR
```

**Quem edita:** `/jdi-new` cria. Posterior: edit manual (sem comando dedicado). Agentes nao mexem.

**Tamanho:** max 80 linhas. Conciso.

---

## ROADMAP.md

```markdown
# {project_name} — Roadmap

## Status
current_phase: 1
total_phases: {N}

## Phases

### Phase 1: {nome}
- **Slug:** 01-{slug}
- **Status:** done | ready | pending
- **Goal:** 1 linha
- **Verdict:** APPROVED | APPROVED_WITH_WARNINGS | BLOCKED  (so apos /jdi-verify)
```

**Quem edita:** `/jdi-new` cria. `/jdi-ship` atualiza status. `/jdi-discuss` pode editar pra clarificar goal (raro).

---

## STATE.md

```markdown
# {project_name} — State

project_slug: {slug}
specialists_ready: true | false
current_phase: 1
phase_status: ready | discussed | planned | executed | verified | done
phase_verdict: APPROVED | APPROVED_WITH_WARNINGS | BLOCKED  (apos verify)
next_step: /jdi-discuss 1
```

**Quem edita:** todos os comandos atualizam apos rodar.

**Lifespan:** sobrescreve a cada commit do orchestrator. Sem historico — git log cobre.

---

## DECISIONS.md

```markdown
# {project_name} — Decisoes locked

D-1 (2026-05-09): Code design = Vertical Slice. Justificativa: ...
D-2 (2026-05-09, phase 1): Tests project setup ja na phase 1. Razao: ...
D-3 (2026-05-09, phase 1): Connection string via dotnet user-secrets em dev. ...
D-4 (2026-05-10, phase 2): Validacao via FluentValidation. Razao: ...
```

**Quem edita:** APPEND-ONLY. `/jdi-new` cria com D-1. `/jdi-discuss` adiciona D-XX por phase.

**Regras:**
- D-X nunca volta — decisao locked = imutavel
- Cada D-X tem data + phase (se aplicavel) + justificativa em 1 linha

---

## specialists.md

```markdown
| Stack | Agent | Trigger |
|---|---|---|
| .NET 10 + React 19 (todo-app) | jdi-doer-todo-app | default executor pra phases do todo-app |
| Rust (rust-cli) | jdi-doer-rust-cli | files *.rs |
```

**Quem edita:** `/jdi-bootstrap` cria/append. Ou edit manual pra multi-stack.

**Uso:** `/jdi-do N` consulta pra resolver qual doer invocar.

---

## reviewers.md

```markdown
| Agent | Trigger | Bloqueia ship? |
|---|---|---|
| jdi-reviewer-todo-app | /jdi-verify | sim, se BLOCKED |
```

**Quem edita:** `/jdi-bootstrap` cria/append.

**Uso:** `/jdi-verify N` consulta pra resolver qual reviewer invocar.

---

## registry.md

```markdown
## R-1 (2026-05-09)
**Tipo:** specialist (doer + reviewer)
**Slug:** todo-app
**Stack:** .NET 10 + React 19
**Files:** .jdi/agents/jdi-doer-todo-app.md, .jdi/agents/jdi-reviewer-todo-app.md

## R-2 (2026-05-15)
**Tipo:** agent
**Nome:** jdi-rust-specialist
**Criado por:** /jdi-create (no repo JDI)
**Por que:** demanda real de users com projetos Rust
**Files:** core/agents/jdi-rust-specialist.md
**Integration:** .jdi/specialists.md
```

**Quem edita:** APPEND-ONLY. `/jdi-bootstrap` adiciona R-N. `/jdi-create` adiciona R-N (no repo JDI fonte).

---

## todos.md (opcional)

```markdown
# Scope creep

- [ ] (phase 2) usuario pediu auth — mover pra phase futura
- [ ] (phase 3) refactor de N+1 query no GET /todos — issue #42
```

**Quem edita:** `/jdi-discuss` (asker) append quando user pede coisa fora do escopo.

---

## phases/{NN-slug}/CONTEXT.md

```markdown
# Phase {N}: {nome} — Context

## Goal (do ROADMAP)
{texto}

## Decisoes locked desta phase

### D-X: {titulo curto}
{justificativa 1-3 linhas}

### D-Y: ...

## Canonical refs
- {url ou path}

## Scope creep capturado em todos.md
{lista, ou "(nenhum)"}
```

**Quem edita:** `/jdi-discuss` cria.

**Tamanho:** max 1500 tokens (~80 linhas). Conciso.

---

## phases/{NN-slug}/PLAN.md

```markdown
# Phase {N}: {nome} — Plan

## Goal
{do ROADMAP}

## Decisoes locked (do CONTEXT.md)
- D-X: ...
- D-Y: ...

## Tasks

### Wave 1 (paralelo possivel)

#### T-{N}.1: {objetivo curto}
- **Files modified:** `{path1}`, `{path2}`
- **Acceptance:**
  - {criterio 1}
  - {criterio 2}
- **Dependencies:** none
- **Test:** {qual teste}
- **Status:** pending | completed | blocked

### Wave 2

#### T-{N}.2: ...
  - **Dependencies:** T-{N}.1

## Execution
- Total tasks: {M}
- Waves: {W}

## Files modified (todas tasks)
- {file1}
- {file2}

## Test requirements
- {tipo}: {comando}
- Coverage minimo: {%}
```

**Quem edita:** `/jdi-plan` cria. `/jdi-do` atualiza `Status:` de cada task.

**Tamanho:** max 200 linhas. Conciso.

---

## phases/{NN-slug}/SUMMARY.md

```markdown
# Phase {N}: {nome} — Summary

**Status:** complete | partial
**Tasks:** {done}/{total} completas, {blocked} blocked

## Tasks executadas
- T-{N}.1: ...
- T-{N}.2: ...

## Tasks blocked (se houver)
- T-{N}.X: razao

## Files modified
- ...

## Tests
- Backend: dotnet test - {N} passing
- Frontend: vitest - {N} passing
- Coverage: {%}
```

**Quem edita:** `/jdi-do` cria ao final.

---

## phases/{NN-slug}/REVIEW.md

```markdown
# Phase {N}: Review

**Veredicto:** APPROVED | APPROVED_WITH_WARNINGS | BLOCKED

## Gates
| Gate | Status | Detalhes |
|---|---|---|
| 1. Build | PASS/BLOCK | ... |
| 2. Tests | PASS/BLOCK | {X}/{Y} passing |
| 3. Coverage | PASS/BLOCK | {%}, threshold {COVERAGE_MIN}% |
| 4. Lint | PASS/WARN | ... |
| 5. Security | PASS/WARN/BLOCK | ... |
| 6. Consistency | PASS/WARN | ... |

## Blockers (se houver)
- ...

## Warnings (se houver)
- ...

## Recomendacao
{texto curto sobre o que fazer}
```

**Quem edita:** `/jdi-verify` cria.

---

## Niveis de memoria

| Nivel | Arquivo | Lifespan |
|---|---|---|
| Projeto | `PROJECT.md` | Vida do projeto (immutable apos /jdi-new) |
| Roadmap | `ROADMAP.md` | Vida do projeto (atualiza com /jdi-ship) |
| Decisao | `DECISIONS.md` | Append-only, nunca apaga |
| Routing | `specialists.md`, `reviewers.md` | Append-only |
| Audit | `registry.md` | Append-only |
| Sessao | `STATE.md` | Sobrescreve |
| Phase | `phases/NN/CONTEXT.md`, `PLAN.md`, `SUMMARY.md`, `REVIEW.md` | Vida da phase |
| Backlog | `todos.md` | Append-only, opcional |

**Sem MEMORY.md generico (v1).** Era catch-all que ficava bagunçado. Substituido por:
- DECISIONS.md (decisoes formais)
- registry.md (criacoes de agents/specialists)
- SUMMARY.md por phase (aprendizado de execucao)
- REVIEW.md por phase (warns/blockers como aprendizado)
