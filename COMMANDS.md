# JDI — Commands

8 comandos. 7 no loop principal + 1 meta (`/jdi-create`).

## Loop principal

### `/jdi-new "<descricao>"`

**Entry point.** Cria projeto JDI do zero.

```
/jdi-new "TODO app .NET 10 + React 19"
```

Faz:
1. Validacao: `.jdi/` nao existe (ou `--reset`)
2. Spawn `jdi-researcher`:
   - 4 perguntas chave (visao, stack, code-design, MVP features)
   - Research focado opcional via ctx7 (max 2 lookups)
   - Gera `PROJECT.md` (visao + stack + code-design LOCKED)
   - Gera `ROADMAP.md` (1 phase por feature do MVP)
   - Gera `STATE.md` + `DECISIONS.md` (D-1: code design)
   - Cria `.gitattributes` (normaliza CRLF)
3. Commit inicial: `chore(jdi): initialize <project_name>`

**Proximo:** `/jdi-bootstrap`

### `/jdi-bootstrap`

Cria specialists per-project (doer + reviewer).

Faz:
1. Le `.jdi/PROJECT.md`
2. Spawn `jdi-architect` em modo `specialist`:
   - 6 perguntas focadas (test framework, build/test commands, coverage min, lint, conventions)
   - Gera `.jdi/agents/jdi-doer-{slug}.md` (de `core/templates/doer-specialist.md`)
   - Gera `.jdi/agents/jdi-reviewer-{slug}.md` (de `core/templates/reviewer-specialist.md`)
   - Atualiza `.jdi/specialists.md` + `.jdi/reviewers.md` + `.jdi/registry.md`
3. Commit: `chore(jdi): bootstrap specialists for <project_name>`
4. Atualiza STATE.md: `specialists_ready: true`

**Proximo:** `/jdi-discuss 1`

### `/jdi-discuss <N> [--auto]`

Captura decisoes locked da phase.

```
/jdi-discuss 2
/jdi-discuss 1 --auto    # asker decide tudo, sem perguntar
```

Faz:
1. Validacao: phase existe em ROADMAP.md
2. Spawn `jdi-asker`:
   - Identifica 3-5 gray areas especificas da phase
   - Pergunta uma por vez (max 5 D-XX por sessao)
   - Captura cada resposta como D-XX em DECISIONS.md
   - Scope creep -> `.jdi/todos.md`
   - Escreve `.jdi/phases/{NN-slug}/CONTEXT.md`
3. Commit: `docs({NN-slug}): capture phase context`

**Proximo:** `/jdi-plan N`

### `/jdi-plan <N> [--review]`

Decompoe phase em tasks executaveis.

```
/jdi-plan 2
/jdi-plan 2 --review     # mostra preview, pede approve
```

Faz:
1. Validacao: CONTEXT.md existe
2. Spawn `jdi-planner`:
   - Le PROJECT.md + ROADMAP.md + DECISIONS.md + CONTEXT.md
   - Decompoe em tasks (max 8) com `files_modified` + `acceptance` + `dependencies` + `test`
   - Agrupa em waves (paralelo dentro, sequencial entre)
   - Self-check (toda task tem files_modified? wave grouping respeita deps?)
   - Escreve `.jdi/phases/{NN-slug}/PLAN.md`
3. Commit: `docs({NN-slug}): generate plan ({M} tasks, {W} waves)`

**Proximo:** `/jdi-do N`

### `/jdi-do <N> [--sequential]`

Executa tasks da phase via doer specialist do projeto.

```
/jdi-do 2
/jdi-do 2 --sequential   # forca sequencial, mesmo se waves permitem paralelo
```

Faz:
1. Validacao: PLAN.md existe + doer registrado em `.jdi/specialists.md`
2. Resolve doer specialist (`jdi-doer-{slug}`)
3. Le PLAN.md, identifica tasks pendentes, agrupa waves
4. Pra cada wave:
   - Intra-wave overlap check (files_modified disjoint?)
   - Se paralelo: sequential dispatch (1 Agent por message com `run_in_background:true`)
   - Se sequencial: 1 doer por task em sequencia
5. Doer atualiza status no PLAN.md, commita atomico, escreve SUMMARY.md final
6. Commit final do orchestrator: `chore(state): phase {N} executed`

**Proximo:** `/jdi-verify N`

### `/jdi-verify <N>`

Roda gates de qualidade via reviewer specialist.

Faz:
1. Validacao: SUMMARY.md existe + reviewer registrado em `.jdi/reviewers.md`
2. Resolve reviewer specialist (`jdi-reviewer-{slug}`)
3. Spawn reviewer:
   - Gate 1: Build
   - Gate 2: Tests
   - Gate 3: Coverage (>= threshold)
   - Gate 4: Lint/Format
   - Gate 5: Security/Perf rules da stack
   - Gate 6: Plan consistency (commits batem com files_modified)
4. Reviewer escreve `.jdi/phases/{NN-slug}/REVIEW.md` com veredicto:
   - APPROVED — todos gates PASS
   - APPROVED_WITH_WARNINGS — sem blockers, alguns warns
   - BLOCKED — gate 1-3 falhou OU gate 5 critical
5. Commit: `docs({NN-slug}): verify phase ({VERDICT})`

**Proximo:** `/jdi-ship N` (se nao BLOCKED)

### `/jdi-ship <N>`

Finaliza phase, avanca pra proxima.

Faz:
1. Validacao: REVIEW.md existe + veredicto != BLOCKED
2. Se WITH_WARNINGS: pergunta "ship mesmo assim?"
3. Atualiza ROADMAP.md (phase {N}: status `done`, phase {N+1}: status `ready`)
4. Atualiza STATE.md (current_phase: {N+1})
5. Commit: `feat({NN-slug}): ship phase {N} ({VERDICT})`
6. Tag opcional: `phase-{N}-{slug}` (se PROJECT.md tem `tag_phases: true`)

**Proximo:** `/jdi-discuss <N+1>` (ou done)

## Comando meta

### `/jdi-create [descricao]`

Cria novo agent ou skill GENERICO no `core/`. So roda dentro do repo JDI fonte.

```
/jdi-create "specialist pra Rust com cargo + clippy"
/jdi-create "skill com convencoes EF Core 9"
/jdi-create
```

Faz:
1. Validacao: esta no repo JDI (`core/` existe)
2. Spawn `jdi-architect` modo `create`:
   - 8 perguntas (problema, trigger, input, output, reuso, decision-loop, custo, tools)
   - Classificacao automatica (agent / skill / composite)
   - Validacao com user (approve / edit / cancel)
   - Geracao de files em `core/agents/` ou `core/skills/`
   - Update de routing
3. Build + install pro runtime ativo
4. Commit + audit em `.jdi/registry.md`

**NAO usado em projetos consumindo JDI.** So pra contributors estendendo o core.

## Resumo visual

```
/jdi-new        --> .jdi/{PROJECT,ROADMAP,STATE,DECISIONS}.md + .gitattributes
/jdi-bootstrap  --> .jdi/agents/{jdi-doer-{slug},jdi-reviewer-{slug}}.md + routing
/jdi-discuss N  --> .jdi/phases/{NN}/CONTEXT.md
/jdi-plan N     --> .jdi/phases/{NN}/PLAN.md
/jdi-do N       --> commits atomicos + .jdi/phases/{NN}/SUMMARY.md
/jdi-verify N   --> .jdi/phases/{NN}/REVIEW.md
/jdi-ship N     --> ROADMAP advance + tag (opcional)

/jdi-create     --> [internal] core/agents/* ou core/skills/* (so no repo JDI)
```

## Flags globais

- `--auto` (em `/jdi-discuss`): asker decide tudo, sem pergunta
- `--review` (em `/jdi-plan`): mostra preview do PLAN, pede approve
- `--sequential` (em `/jdi-do`): forca execucao sequencial mesmo se waves permitem paralelo
- `--reset` (em `/jdi-new`): apaga `.jdi/` antes de iniciar (CUIDADO)

## Idempotencia

Todos os comandos sao idempotentes pra rerun:
- `/jdi-discuss` ja com CONTEXT.md -> pergunta overwrite/skip
- `/jdi-plan` ja com PLAN.md -> regera (warn)
- `/jdi-do` ja com tasks completed -> pula
- `/jdi-verify` ja com REVIEW.md -> regera
- `/jdi-ship` ja shipped -> warn
