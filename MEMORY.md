# JDI — State Schema

State em arquivo plano. Sem DB. Sem servidor. Markdown + YAML frontmatter quando precisa.

Decisoes locked ficam em `DECISIONS.md`. Audit trail dos specialists/agents criados ficam em `registry.md`. Aprendizado de phase fica em `SUMMARY.md` e `REVIEW.md` por phase.

## Schema versions

Field `schema_version` em `STATE.md` indica o modelo de identificação de phases:

| Version | Phase ID | Folder | Multi-dev safe? |
|---|---|---|---|
| 1 (legacy) | numeric position (`current_phase: 5`) | `.jdi/phases/NN-slug/` | NO — numeric positions colidem entre branches |
| 2 (current) | canonical slug (`current_phase_slug: auth-flow`) | `.jdi/phases/<slug>/` | YES — slug é único; colisão de slug surface como conflito git visivel |

Projetos v1 podem migrar via `/jdi-migrate-phases` (non-destructive: nao renomeia folders, apenas adiciona `schema_version: 2` + `phases.json` manifest). Toda command JDI aceita slug OU integer position em v2; resolver lib (`bin/lib/jdi-resolve-phase.{sh,ps1}`) normaliza.

Quando `schema_version` ausente, default = 1 (compatibilidade).

## Arvore completa

```
.jdi/
+-- PROJECT.md           visao + stack + code-design LOCKED. Imutavel apos /jdi-new
+-- ROADMAP.md           phases sequencial, status por linha
+-- STATE.md             current_phase + next_step + flags. Atualizado por comandos
+-- DECISIONS.md         append-only. ADR mini. D-1, D-2, ...
+-- config.json          token/context budget + thresholds. Editavel
+-- specialists.md       routing per-project (gerado por /jdi-bootstrap)
+-- reviewers.md         routing per-project
+-- registry.md          audit trail (R-1, R-2, ...) — tudo que /jdi-create ou /jdi-bootstrap criou
+-- todos.md             scope creep capturado pelo asker (opcional)
+-- agents/              per-project specialists
|   +-- jdi-doer-{slug}.md
|   +-- jdi-reviewer-{slug}.md
+-- phases.json          v2 only: manifest (position <-> slug + legacy flag). Derived state.
+-- phases/
|   +-- setup-api/                  v2 layout: folder = canonical slug
|   |   +-- CONTEXT.md   saida do /jdi-discuss (asker)
|   |   +-- PLAN.md      saida do /jdi-plan (planner)
|   |   +-- SUMMARY.md   saida do /jdi-do (doer)
|   |   +-- REVIEW.md    saida do /jdi-verify (reviewer)
|   |   +-- LOOP.md      audit trail do /jdi-loop (so se ralph mode foi usado)
|   +-- 02-old-phase/               v1 legacy layout preserved post-migration (NUNCA renomeado)
|   +-- ...
+-- archive/             phases antigas movidas (opcional)
```

Nada de `templates-jdi-folder/` copiado pra `.jdi/`. Files sao gerados direto pelos comandos:
- `/jdi-new` cria PROJECT, ROADMAP, STATE, DECISIONS, config.json, .gitattributes
- `/jdi-bootstrap` cria specialists.md, reviewers.md, registry.md + agents/*

Excecao: `config.json` eh copiado direto de `templates-jdi-folder/config.json` (defaults estaveis) — `/jdi-new` so copia se ausente. User edita pra customizar budget.

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

## Definition of Done

**LOCKED — project-wide baseline.** Inherited by every phase's reviewer (Gate 8).

### Auto-verifiable
- [ ] `{test_command}` exits 0
      **Verify:** {executable check}
      **Source:** PROJECT

### Manual
- [ ] CHANGELOG.md updated with entry per release
      **Verify:** human confirmation required
      **Evidence:** new `## [version]` heading in CHANGELOG.md
      **Source:** PROJECT
```

**Quem edita:** `/jdi-new` cria (incluindo `## Definition of Done`). Posterior: edit manual via D-XX em DECISIONS.md (mudar baseline = decisão locked). Agentes nao mexem.

**Tamanho:** max 80 linhas. Conciso. Cap 8 itens em DoD.

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
schema_version: 2
specialists_ready: true | false
current_phase: 1                   # display mirror (legacy v1 readers)
current_phase_slug: setup-api      # v2 canonical phase ID
phase_status: ready | discussed | planned | executed | verified | pending_manual_dod | done | looping | paused | blocked
phase_verdict: APPROVED | APPROVED_WITH_WARNINGS | APPROVED_PENDING_MANUAL | BLOCKED  (apos verify)
next_step: /jdi-discuss setup-api
```

`current_phase_slug` é a fonte da verdade em v2. `current_phase` continua escrito como display/legacy mirror — `/jdi-status` lê preferencialmente o slug, fallback pro integer.

**Quem edita:** todos os comandos atualizam apos rodar.

**Lifespan:** sobrescreve a cada commit do orchestrator. Sem historico — git log cobre.

**Status especificos do `/jdi-loop`:**
- `looping` — `/jdi-loop` em execucao (ralph mode), LOOP.md tem detalhe de iter atual
- `paused` — user escolheu "Ajustar plano" no human gate, edita PLAN.md/CONTEXT.md e re-roda /jdi-loop
- `blocked` — `/jdi-verify` retornou BLOCKED OU `/jdi-loop` foi escalated/killed (revisao humana necessaria)

---

## config.json

```json
{
  "$schema_version": "1.2",
  "context_window": 200000,
  "thresholds": {
    "warn_pct": 60,
    "critical_pct": 70
  },
  "budgets": {
    "max_context_chars": 6000,
    "max_plan_chars": 12000,
    "max_summary_chars": 8192
  },
  "compaction": {
    "keep_phases": 2,
    "archive_after": 5
  },
  "orchestration": {
    "mode": "standard",
    "source": "default"
  },
  "coverage_min": 80
}
```

**Quem edita:** `/jdi-new` escreve direto via Write se ausente (default inline no prompt do comando). `templates-jdi-folder/config.json` eh a referencia canonica do default, shipped pelo pacote npm. User edita manualmente apos. Comandos so leem.

**Campos:**
- `context_window` — janela do model em uso. 200k = default (Claude Sonnet/Opus). 1_000_000 pra 1M-window models.
- `thresholds.warn_pct` — quando orchestrator avisa "context aquecendo". Default 60%.
- `thresholds.critical_pct` — quando orchestrator sugere `/jdi-thread`. Default 70% (zona de fracture, baseado em pesquisa de context rot).
- `budgets.max_*_chars` — caps usados por commands ao truncar artefatos antes de inline. Heuristica: ~4 chars/token.
- `compaction.keep_phases` — quantas phases anteriores ficam ativas em `.jdi/phases/`. Resto vai pra `.jdi/archive/`.
- `compaction.archive_after` — phases acima deste delta movem pra archive (executado por `/jdi-ship`).
- `coverage_min` — overrideavel por PROJECT.md. Reviewer usa.
- `orchestration.mode` — `standard` (default) ou `enhanced`. Flag host-neutra: quando `enhanced` E o host sabe orquestrar sub-agentes, commands PODEM rodar camadas multi-agente opcionais (criticos advisory); senao degradam pro caminho padrao. Off-path byte-identico. Boolean de capability, NAO ledger de tokens.
- `orchestration.source` — `default` | `user` | `detected`. Procedencia/auditoria apenas, nunca dirige comportamento.

**Lifespan:** vida do projeto. Versionado em git.

**Lido por:** `/jdi-do`, `/jdi-plan`, `/jdi-verify`, `/jdi-ship` (para compaction). Specialists (doer/reviewer) leem `coverage_min`. `orchestration.mode` lido por `/jdi-verify` (e futuros consumidores) no turno top-level; sub-agentes so enxergam via este arquivo, nunca via sessao do host.

**Escrito por:** `/jdi-new` e `/jdi-adopt` (Step 4b — opt-in de orchestration, default determinado no turno top-level onde o sinal de capability do host eh visivel).

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
- **v1 format (legacy):** ID sequencial (`D-1`, `D-2`, ...). Racy em multi-dev — dois branches alocam mesmo numero.
- **v2 format (multi-dev safe):** ID deterministico `D-{YYYY-MM-DD}-{phase_slug}-{seq}` (ex: `D-2026-05-09-setup-api-1`). Sem colisao entre branches.
- Projetos migrados aceitam ambos formatos em leitura; escrita nova segue `schema_version`.

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

## phases/<slug>/  (v2; v1 legacy: phases/{NN-slug}/)CONTEXT.md

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

## Definition of Done

### Auto-verifiable
- [ ] {criterion text}
      **Verify:** {executable check}
      **Source:** CONTEXT

### Manual
- [ ] {criterion text}
      **Verify:** human confirmation required
      **Evidence:** {expected artifact}
      **Source:** CONTEXT
```

**Quem edita:** `/jdi-discuss` cria (Stage 1 decisões + Stage 2 DoD).

**Tamanho:** max 1500 tokens (~80 linhas). Conciso. Cap 10 itens em DoD.

**LOCKED após `/jdi-discuss`:** DoD e D-XX nunca editados retroativamente. Mudança = nova D-XX que registra o motivo + manual edit.

---

## phases/<slug>/  (v2; v1 legacy: phases/{NN-slug}/)PLAN.md

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

## phases/<slug>/  (v2; v1 legacy: phases/{NN-slug}/)SUMMARY.md

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

## phases/<slug>/  (v2; v1 legacy: phases/{NN-slug}/)REVIEW.md

```markdown
# Phase {N}: Review

**Veredicto:** APPROVED | APPROVED_WITH_WARNINGS | APPROVED_PENDING_MANUAL | BLOCKED

## Gates
| Gate | Status | Detalhes |
|---|---|---|
| 1. Build | PASS/BLOCK | ... |
| 2. Tests | PASS/BLOCK | {X}/{Y} passing |
| 3. Coverage | PASS/BLOCK | {%}, threshold {COVERAGE_MIN}% |
| 4. Lint | PASS/WARN | ... |
| 5. Security | PASS/WARN/BLOCK | ... |
| 6. Consistency | PASS/WARN | ... |
| 7. UI Validation | PASS/WARN/BLOCK/SKIPPED | (só se has_frontend=true) |
| 8. DoD | PASS/PASS_PENDING_MANUAL/BLOCK/INCONCLUSIVE | {N_auto_pass}/{N_auto_total} auto, {N_manual} manual pending |

## Blockers (se houver)
- ...

## Warnings (se houver)
- ...

## DoD Checklist
| # | Criterion | Source | Type | Status | Evidence |
|---|---|---|---|---|---|
| 1 | {criterion text} | PROJECT | Auto | PASS/FAIL | {output} |
| 2 | {criterion text} | CONTEXT | Manual | MANUAL_REQUIRED | — |

## DoD Manual Confirmations (apos /jdi-confirm-dod)
- [x] {criterion text}
      **Confirmed at:** {ISO timestamp}
      **By:** {git user}
      **Evidence:** {user input}

## DoD Rejected (post-hoc, opcional)
- {criterion text}
      **Rejected at:** {ISO timestamp}
      **Reason:** {justification}

## Recomendacao
{texto curto sobre o que fazer}
```

**Quem edita:** `/jdi-verify` cria.

---

## phases/<slug>/  (v2; v1 legacy: phases/{NN-slug}/)LOOP.md (opcional, so com /jdi-loop)

```markdown
---
phase: {N}
iter: 3
total_resets: 1
status: running | converged | escalated | paused | killed
max_iter_per_round: 5
max_resets: 3
created_at: 2026-05-10T10:30:00-03:00
---

## History (append-only)

- iter 1: BLOCKED, hash=abc123def4, commit=f8d2a1, ts=2026-05-10T10:31:00-03:00
- iter 2: BLOCKED, hash=abc123def4, commit=a91c33, ts=2026-05-10T10:33:00-03:00  ← oscillation!
- iter 3: BLOCKED, hash=de45ef9012, commit=2b3d77, ts=2026-05-10T10:36:00-03:00
- iter 4: BLOCKED, hash=de45ef9012, commit=8e1c44, ts=2026-05-10T10:38:00-03:00
- iter 5: BLOCKED, hash=11aa22bb33, commit=4f9e21, ts=2026-05-10T10:40:00-03:00
--- RESET 1 em 2026-05-10T10:42:00-03:00 ---
- iter 1: APPROVED_WITH_WARNINGS, hash=00ff11ee22, commit=c1d2e3, ts=2026-05-10T10:45:00-03:00
```

**Quem edita:** `/jdi-loop` cria/append. Ninguem mais toca.

**Regras:**
- Frontmatter `iter` + `total_resets` + `status` sao MUTAVEIS (sobrescreve)
- Bloco `## History` eh APPEND-ONLY (audit trail completo, oscillation detection precisa)
- `hash` = SHA256 truncado dos blockers/warnings normalizados — pra comparar iter N vs N-1
- `status: converged` => phase pode prosseguir pra `/jdi-ship`
- `status: killed` => hard cap atingido, requer revisao humana de PLAN/CONTEXT
- `status: escalated|paused` => user interveio, re-rodar `/jdi-loop {N}` retoma

**States transitions:**
```
running → converged   (verdict APPROVED ou APPROVED_WITH_WARNINGS)
running → escalated   (user escolheu abort no human gate)
running → paused      (user escolheu ajustar plan no human gate)
running → killed      (total_resets >= max_resets)
escalated|paused → running (re-rodar /jdi-loop retoma)
```

---

## Niveis de memoria

| Nivel | Arquivo | Lifespan |
|---|---|---|
| Projeto | `PROJECT.md` | Vida do projeto (immutable apos /jdi-new) |
| Roadmap | `ROADMAP.md` | Vida do projeto (atualiza com /jdi-ship) |
| Config | `config.json` | Vida do projeto, editavel manual |
| Decisao | `DECISIONS.md` | Append-only, nunca apaga |
| Routing | `specialists.md`, `reviewers.md` | Append-only |
| Audit | `registry.md` | Append-only |
| Sessao | `STATE.md` | Sobrescreve |
| Phase | `phases/<slug>/CONTEXT.md`, `PLAN.md`, `SUMMARY.md`, `REVIEW.md` (v2) ou `phases/NN-slug/` (v1) | Vida da phase |
| Loop | `phases/<slug>/LOOP.md` | Vida da phase, append-only, so com /jdi-loop |
| Backlog | `todos.md` | Append-only, opcional |

**Sem MEMORY.md generico (v1).** Era catch-all que ficava bagunçado. Substituido por:
- DECISIONS.md (decisoes formais)
- registry.md (criacoes de agents/specialists)
- SUMMARY.md por phase (aprendizado de execucao)
- REVIEW.md por phase (warns/blockers como aprendizado)

---

## Read-depth por nivel (token budget)

Regra dura — referencia em `ARCHITECTURE.md > Read-depth scaling`. Resumo aqui pra quem le so MEMORY.md:

| Distancia da phase atual | Read permitido |
|---|---|
| Phase atual (`current_phase`) | Corpo inteiro |
| Phase anterior (`current_phase - 1`) | Frontmatter + veredict do REVIEW apenas |
| `<= current_phase - 2` | Nao ler corpo. Listar/`head` apenas |
| `.jdi/archive/` | Tratar como phase distante. Nao ler corpo |

PROJECT.md, ROADMAP.md, DECISIONS.md, config.json: leitura full **permitida** sempre — sao curtos por design e estaveis (bons candidatos a prompt cache prefix).

Excecoes:
- `jdi-asker` le ate 2 CONTEXT.md anteriores (regra do agent)
- `jdi-verify N` le PLAN.md de phase N-1 se task atual referencia `D-XX` daquela phase (rastreabilidade)
