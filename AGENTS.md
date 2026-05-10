# JDI — Agents

5 agents core (shipped) + 2 specialists per-project (gerados).

## Core (em `core/agents/`)

### `jdi-researcher` (Opus)

**Funcao:** Discover do projeto antes do roadmap.

**Spawned por:** `/jdi-new`

**Filosofia:** 1 agent unico em vez de varios researchers paralelos. Mais barato, suficiente pra projetos pequenos/medios.

**Inputs:**
- Argumento livre: ideia do projeto
- Read em diretorio atual

**Outputs:**
- `.jdi/PROJECT.md` (visao + stack + code-design LOCKED)
- `.jdi/ROADMAP.md` (1 phase por feature MVP)
- `.jdi/STATE.md`
- `.jdi/DECISIONS.md` (com D-1)
- `.gitattributes` (normaliza line endings)

**Permissoes:** Read, Write, WebSearch (max 2 lookups via ctx7), AskUserQuestion.

### `jdi-bootstrap` (Sonnet)

**Funcao:** Wrapper que dispara `jdi-architect` em modo specialist pra gerar doer + reviewer per-project.

**Spawned por:** `/jdi-bootstrap`

**Inputs:**
- Read em `.jdi/PROJECT.md`

**Outputs:**
- `.jdi/agents/jdi-doer-{slug}.md`
- `.jdi/agents/jdi-reviewer-{slug}.md`
- `.jdi/specialists.md` + `.jdi/reviewers.md` (routing)
- `.jdi/registry.md` (R-1 audit trail)
- `.jdi/STATE.md` atualizado (`specialists_ready: true`)

**Permissoes:** Read, Write, Edit, Bash, AskUserQuestion, Agent (spawn architect).

### `jdi-asker` (Sonnet)

**Funcao:** Loop adaptativo de perguntas pra capturar decisoes locked.

**Spawned por:** `/jdi-discuss <N>`

**Inputs:**
- `phase_number`
- Read em PROJECT.md, ROADMAP.md, DECISIONS.md, ate 2 CONTEXT.md anteriores

**Outputs:**
- `.jdi/phases/{NN-slug}/CONTEXT.md`
- `.jdi/DECISIONS.md` (append D-XX)
- `.jdi/todos.md` (se scope creep)

**Regras:**
- Max 5 perguntas por sessao
- Max 5 D-XX por sessao
- Identifica gray areas especificas (nao categorias genericas)
- Para quando user diz "chega" / "go" / 5 perguntas

**Permissoes:** Read, Write, AskUserQuestion.

### `jdi-planner` (Opus)

**Funcao:** Decompoe phase em tasks com waves de paralelismo.

**Spawned por:** `/jdi-plan <N>`

**Inputs:**
- `phase_number`
- Read em PROJECT.md, ROADMAP.md, DECISIONS.md, CONTEXT.md, doer specialist
- Read no codigo existente (mapeamento de files_modified)

**Outputs:**
- `.jdi/phases/{NN-slug}/PLAN.md`

**Regras:**
- Max 8 tasks por phase (split se passar)
- Cada task tem: `files_modified`, `acceptance` mensuravel, `dependencies`, `test`
- Wave grouping: paralelo dentro, sequencial entre
- Files_modified disjoint dentro da mesma wave (overlap = sequencial automatico)
- Self-check antes de salvar (checklist 5 itens)

**Permissoes:** Read, Write, AskUserQuestion (so se ambiguo).

### `jdi-architect` (Opus)

**Funcao:** Meta-agent. 2 modos.

**Modo `create` (spawned por `/jdi-create`):**
- Cria agent ou skill GENERICO em `core/agents/` ou `core/skills/`
- 8 perguntas pra classificar (agent / skill / composite)
- Validacao com user (approve / edit / cancel)
- Build + install pro runtime

**Modo `specialist` (spawned por `/jdi-bootstrap`):**
- Cria doer + reviewer PER-PROJECT em `.jdi/agents/`
- 6 perguntas focadas (test framework, build/test commands, coverage min, lint, conventions)
- Substitui placeholders nos templates `core/templates/{doer,reviewer}-specialist.md`
- Mapeia bash<->PowerShell pros gates do reviewer

**Inputs:**
- Modo `create`: argumento livre opcional
- Modo `specialist`: `.jdi/PROJECT.md` obrigatorio
- Read em todos os files de routing

**Outputs:**
- Modo `create`: `core/agents/jdi-{nome}.md` ou `core/skills/{nome}/`
- Modo `specialist`: `.jdi/agents/jdi-{doer,reviewer}-{slug}.md`
- Em ambos: update de routing + audit em `.jdi/registry.md`

**Permissoes:** Read, Write, Edit, Bash, AskUserQuestion.

## Per-project (em `.jdi/agents/`)

### `jdi-doer-{slug}` (Sonnet)

**Funcao:** Executor que JA SABE stack/code-design/conventions do projeto.

**Spawned por:** `/jdi-do <N>`

**Filosofia:** 1 specialist focado que ja sabe a stack, em vez de executor + code-fixer + doc-writer separados.

**Inputs:**
- `phase_number`
- Read em PROJECT.md, DECISIONS.md, CONTEXT.md, PLAN.md
- Write nos paths em `files_modified` do PLAN

**Outputs:**
- Codigo modificado, commitado atomicamente
- `.jdi/phases/{NN}/PLAN.md` atualizado (status das tasks)
- `.jdi/phases/{NN}/SUMMARY.md` final

**Regras:**
- Sem `--no-verify` em commits (hooks rodam)
- Sem skip de testes — task so completa se test passou
- Atomic commit por task
- Conventional Commits, scope = phase slug
- Max 3 tentativas de correcao por task antes de marcar `blocked`

**Permissoes:** Read, Write, Edit, Bash. Sem Web (deve ja saber stack).

### `jdi-reviewer-{slug}` (Sonnet)

**Funcao:** Roda gates de qualidade definidos pra stack.

**Spawned por:** `/jdi-verify <N>`

**Filosofia:** 1 reviewer focado por stack, em vez de code-reviewer + security-auditor + integration-checker + verifier separados.

**Inputs:**
- `phase_number`
- Read em PROJECT.md, PLAN.md, SUMMARY.md, codigo modificado

**Outputs:**
- `.jdi/phases/{NN}/REVIEW.md` com veredicto

**Gates:**
1. Build
2. Tests
3. Coverage (>= threshold do PROJECT.md, default 80%)
4. Lint/Format
5. Security/Perf rules da stack (sem secrets, sem TODO sem issue, sem localStorage tokens, etc)
6. Plan consistency (commits batem com files_modified)

**Veredictos:**
- APPROVED — todos PASS
- APPROVED_WITH_WARNINGS — sem blockers, com warns
- BLOCKED — gate 1-3 falhou OU gate 5 critical

**Permissoes:** Read-only por design. Read + Bash (so pra rodar comandos de gate). **Sem Write, sem Edit.**

## Resumo visual

```
core/agents/                  <- 5 agents shipped
  jdi-researcher    Opus     pre-roadmap discovery
  jdi-bootstrap     Sonnet   wrapper -> spawn architect specialist
  jdi-asker         Sonnet   loop perguntas
  jdi-planner       Opus     decompose phase
  jdi-architect     Opus     meta (2 modos)

.jdi/agents/                  <- per-project, gerados pelo /jdi-bootstrap
  jdi-doer-{slug}    Sonnet   executor especialista
  jdi-reviewer-{slug} Sonnet  reviewer especialista (read-only)
```

## Modelos por runtime

Cada agent declara `runtime_overrides:` no frontmatter. Build script gera frontmatter especifico:

| Runtime | Field | Exemplo (researcher) |
|---|---|---|
| Claude Code | `model:` | `opus` |
| GitHub Copilot | `model:` | `gpt-5` |
| Antigravity | `triggers:` | discovery automatica via prefixo `jdi-` |
| OpenCode | `mode:`, `model:`, `temperature:`, `permission:` | `subagent`, `anthropic/claude-sonnet-4-20250514`, `0.2`, edit/bash/write rules |

## Estendendo

Pra criar agent novo no core: rode `/jdi-create` dentro do repo JDI. Architect modo create faz tudo.

Pra criar specialists per-project diferentes (ex: multi-stack): atualmente `/jdi-bootstrap` cria 1 doer agregado. Multi-doer eh feature pendente — workaround: edita `.jdi/agents/` manual ou rode bootstrap multiplas vezes com slugs diferentes.
