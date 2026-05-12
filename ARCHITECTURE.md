# JDI — Architecture

## Principios

1. **Fresh context per agent** — cada spawn tem janela limpa. Anti context-rot
2. **Thin orchestrator** — comando carrega contexto, spawn agente, roteia. Nada mais
3. **File-based state** — `.jdi/` em md/json. Sem DB, sem servidor
4. **Decisao locked = imutavel** — D-XX nunca volta
5. **1 task = 1 commit atomico**
6. **Plano e prompt** — PLAN.md ja eh o input do executor
7. **Per-project specialists** — doer/reviewer customizados por projeto, nao genericos
8. **Wave-based parallelism** — paralelo dentro da wave, sequencial entre waves
9. **Security > Perf > Best Practices** — ordem fixa quando conflita

## Estrutura em camadas

```
core/                    <- shipped, generators (lives in JDI repo)
  agents/                <- 5 agents core
    jdi-researcher.md
    jdi-bootstrap.md
    jdi-asker.md
    jdi-planner.md
    jdi-architect.md
  commands/              <- 8 commands
    jdi-new.md, jdi-bootstrap.md, jdi-discuss.md, jdi-plan.md,
    jdi-do.md, jdi-verify.md, jdi-ship.md, jdi-create.md
  templates/
    agent.md, skill.md
    doer-specialist.md       <- usado pelo architect modo specialist
    reviewer-specialist.md   <- idem

.jdi/                    <- per-project state (gerado por /jdi-new)
  PROJECT.md, ROADMAP.md, DECISIONS.md, STATE.md (schema_version: 2)
  specialists.md, reviewers.md, registry.md
  phases.json            <- v2 only: manifest position <-> slug (derived state)
  agents/                <- per-project specialists (gerado por /jdi-bootstrap)
    jdi-doer-{slug}.md
    jdi-reviewer-{slug}.md
  phases/<slug>/         <- v2 layout (default novo)
    CONTEXT.md, PLAN.md, SUMMARY.md, REVIEW.md
  phases/NN-<slug>/      <- v1 legacy layout (nunca renomeado pós-migração)

bin/lib/                 <- helpers compartilhados (shipped via npm files whitelist)
  jdi-resolve-phase.{sh,ps1}    <- int OR slug → {slug, dir, position, schema, exists}
  jdi-validate-slug.{sh,ps1}    <- shape + reserved + --check-unique
  jdi-monitor.{sh,ps1}          <- context budget warm-up
  jdi-truncate.{sh,ps1}         <- max_chars enforce
```

## Ciclo de vida

```
/jdi-new "<descricao>"          -> PROJECT.md + ROADMAP.md + STATE.md (schema v2) + DECISIONS.md
/jdi-bootstrap                  -> .jdi/agents/jdi-doer-{slug} + jdi-reviewer-{slug}
/jdi-discuss <slug|position>    -> phases/<slug>/CONTEXT.md
/jdi-plan    <slug|position>    -> phases/<slug>/PLAN.md (tasks + waves)
/jdi-do      <slug|position>    -> commits atomicos + phases/<slug>/SUMMARY.md
/jdi-verify  <slug|position>    -> phases/<slug>/REVIEW.md (gates)
/jdi-ship    <slug|position>    -> ROADMAP advance + tag (opcional) + STATE atualizado
```

Phase ID dual: slug (canonical) ou posição int (display/legacy). Resolver (`bin/lib/jdi-resolve-phase.sh|.ps1`) normaliza para `{slug, dir, position, schema_version, folder_exists}`. v1 → v2 via `/jdi-migrate-phases` (non-destructive).

Gates entre etapas:

| De | Para | Gate |
|---|---|---|
| /jdi-new | /jdi-bootstrap | PROJECT.md + ROADMAP.md exist |
| /jdi-bootstrap | /jdi-discuss | .jdi/agents/jdi-doer-* + jdi-reviewer-* exist |
| /jdi-discuss | /jdi-plan | CONTEXT.md exist + decisoes locked claras |
| /jdi-plan | /jdi-do | PLAN.md valido (tasks + acceptance + files_modified) |
| /jdi-do | /jdi-verify | SUMMARY.md exist (todas tasks concluidas ou marcadas blocked) |
| /jdi-verify | /jdi-ship | REVIEW.md verdict != BLOCKED |

## Permissoes (least privilege)

| Agente | Read | Write | Edit | Bash | Web |
|---|:---:|:---:|:---:|:---:|:---:|
| jdi-researcher | x | x | - | - | x |
| jdi-bootstrap | x | x | x | x | - |
| jdi-asker | x | x | - | - | - |
| jdi-planner | x | x | - | - | - |
| jdi-architect | x | x | x | x | - |
| jdi-doer-{slug} | x | x | x | x | - |
| jdi-reviewer-{slug} | x | - | - | x | - |

Reviewer eh **read-only** por design. So roda gates, nao corrige.

## Agents core x specialists per-project

**Core (shipped, em `core/agents/`):**
- `jdi-researcher` — discover do projeto, gera PROJECT.md + ROADMAP.md
- `jdi-bootstrap` — wrapper que dispara architect modo specialist
- `jdi-asker` — loop adaptativo de perguntas (CONTEXT.md)
- `jdi-planner` — decompoe phase em tasks + waves
- `jdi-architect` — meta. 2 modos: `create` (agents/skills no core/) ou `specialist` (doer/reviewer per-project)

**Per-project (gerados, em `.jdi/agents/`):**
- `jdi-doer-{slug}` — executor que JA SABE stack/conventions/code-design. Sem descoberta
- `jdi-reviewer-{slug}` — gates customizados pra stack (build/test/coverage/lint/security)

Specialist routing via `.jdi/specialists.md` e `.jdi/reviewers.md`.

## Wave-based parallelism

`/jdi-do N`:
1. Le PLAN.md, agrupa tasks em waves (wave M = tasks que so dependem de wave M-1)
2. Pra cada wave:
   - Intra-wave overlap check (files_modified disjoint?)
   - Se 2+ tasks paralelas E sem overlap E nao `--sequential`:
     - Sequential dispatch — UM `Agent()` por message com `run_in_background: true`
     - Aguarda wave inteira terminar antes da proxima
   - Senao: executa sequencial, 1 doer por task
3. Apos todas waves: doer escreve SUMMARY.md final

Sequential dispatch evita race em `.git/config.lock` (problema bem documentado em git worktree).

## Loop de perguntas (jdi-asker)

Adaptativo. Regras:

1. Le PROJECT.md, ROADMAP.md, DECISIONS.md
2. Le ate 2 CONTEXT.md anteriores (max)
3. Identifica 3-5 gray areas especificas da phase (nao categorias genericas)
4. Pergunta uma por vez via AskUserQuestion
5. Cada resposta vira D-XX em DECISIONS.md
6. Para quando user diz "chega" / "go" / 5 perguntas atingidas
7. Escreve CONTEXT.md com decisoes + canonical_refs

## Loop de execucao (jdi-doer-{slug})

Por task no PLAN.md:

1. Le task (files_modified, acceptance, dependencies, test)
2. Implementa codigo
3. Roda test command (`{TEST_COMMAND}` definido no specialist)
4. Se falha -> tenta corrigir 1 vez. Falha de novo -> marca `blocked`, segue
5. Commit atomico: `feat({phase-slug}): {task summary}` (Conventional Commits)
6. Append linha em SUMMARY.md
7. Proxima task

## Review pos-execucao (jdi-reviewer-{slug})

`/jdi-verify N` dispara reviewer. 6 gates:
1. Build
2. Tests
3. Coverage (>= threshold do PROJECT.md, default 80%)
4. Lint/Format
5. Security/Perf rules da stack
6. Plan consistency (commits batem com files_modified)

Veredicto: APPROVED / APPROVED_WITH_WARNINGS / BLOCKED. BLOCKED bloqueia /jdi-ship.

## Read-depth scaling (token budget)

Regra dura: **read-depth escala com distancia da phase atual**. Orchestrator e agentes nao leem corpo de phase qualquer — leem o necessario.

| Distancia | Arquivo | Read permitido |
|---|---|---|
| `current_phase` | CONTEXT, PLAN, SUMMARY, REVIEW da phase | Corpo inteiro (ate budget de `config.json`) |
| `current_phase - 1` | SUMMARY.md, REVIEW.md anterior | **Frontmatter + veredict apenas**. Nunca corpo. |
| `<= current_phase - 2` | Phases antigas | **Nao ler.** Existencia via `ls`. Metadados via `head -10`. |

**Excecoes documentadas:**
- `/jdi-verify N` pode ler `PLAN.md` de phase `N-1` se task atual referencia `D-XX` daquela phase (rastreabilidade)
- `/jdi-discuss N` (asker) le ate **2 CONTEXT.md anteriores** (regra ja vigente em `core/agents/jdi-asker.md`)
- `jdi-researcher` le PROJECT/ROADMAP inteiros — sao curtos por design (PROJECT cap 80 linhas, ROADMAP eh sumario)

**Por que:**
- Phase 8 nao precisa de corpo de SUMMARY phase 1. Frontmatter ja contem `status` + `verdict`.
- Context rot: pesquisa Anthropic/Chroma 2025 confirma — recall degrada com tokens, mesmo dentro do limite.
- Cache hit aumenta: arquivos imutaveis (PROJECT, DECISIONS) viram prefix estavel.

**Como aplicar (orchestrator):**
- Antes de `Read` em arquivo de phase anterior: cheque distancia via STATE.md
- Use `head -20` no lugar de `cat` quando so quer frontmatter
- Phases archived (`.jdi/archive/`): tratar como phase `<= current - 2`. Nao ler corpo.
- Pra arquivos grandes na phase atual, use `bin/lib/jdi-truncate.{sh,ps1}` antes de inline em prompt:
  ```bash
  bash bin/lib/jdi-truncate.sh .jdi/phases/01-x/PLAN.md 12000   # cap em chars
  ```
  Helper preserva frontmatter, headings, 1a linha de cada secao. Resto vira pointer.

## Memoria

| Arquivo | Lifespan | Conteudo |
|---|---|---|
| `PROJECT.md` | Vida do projeto | Visao, stack, code-design locked |
| `ROADMAP.md` | Vida do projeto | Phases + status |
| `DECISIONS.md` | Append-only | D-XX (decisoes locked) |
| `STATE.md` | Sobrescreve | current_phase + next_step |
| `specialists.md`, `reviewers.md` | Append-only | Routing per-project |
| `registry.md` | Append-only | Audit trail dos specialists/agents criados |
| `phases/{NN}/CONTEXT.md` | Vida da phase | Output do asker |
| `phases/{NN}/PLAN.md` | Vida da phase | Output do planner |
| `phases/{NN}/SUMMARY.md` | Vida da phase | Output do doer |
| `phases/{NN}/REVIEW.md` | Vida da phase | Output do reviewer |

Decisoes locked em DECISIONS.md, audit trail em registry.md.

## Hooks

`.githooks/pre-commit` e `post-commit` shipped como **no-op por padrao**. Doer/reviewer cobrem responsabilidades de docs/qualidade dentro do flow normal.

User pode customizar `.githooks/` pra:
- Lint rapido pre-commit
- Notificacao Slack pos-commit
- Etc.

## Codigo nao spec-driven 100%

JDI nao eh Spec-Driven Development puro. Spec ortodoxo exige spec antes de codigo, rastreabilidade ate teste, assinatura de stakeholders.

JDI faz:
- CONTEXT.md = spec lite. Decisao locked, nada mais
- PLAN.md = task list com acceptance. Rastreabilidade via D-XX
- Nada de stakeholder. So user

Quando user precisa de spec formal -> usa ferramenta dedicada de governanca. JDI eh dev workflow, nao governanca.
