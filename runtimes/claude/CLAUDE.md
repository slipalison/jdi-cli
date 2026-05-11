# JDI — Instrucoes Claude Code

Este projeto usa o JDI (Just Do It) como workflow de desenvolvimento. JDI eh um workflow enxuto: 6 comandos no loop principal, 5 agents core + 2 per-project specialists.

## Loop canonico

```
/jdi-new "<descricao>"   -> research + PROJECT.md + ROADMAP.md
/jdi-bootstrap           -> cria specialists per-project (doer + reviewer)
/jdi-discuss <N>         -> captura decisoes locked da phase
/jdi-plan <N>            -> decompoe em tasks com waves
/jdi-do <N>              -> executa via doer specialist
/jdi-verify <N>          -> gates de qualidade via reviewer specialist
/jdi-ship <N>            -> finaliza phase + avanca pra proxima

# Roadmap mutation (qualquer hora)
/jdi-add-phase "<name>" [--goal "<t>"] [--at <pos>]   -> adiciona phase
/jdi-remove-phase <N> [--force]                        -> remove future/pending phase
```

`/jdi-create [desc]` gera novos agents/skills genericos no `core/` (rodado dentro do repo JDI, nao de projetos consumindo).

## Agents core (em `.claude/agents/`)

Genericos, shipped pelo JDI:

| Agent | Modelo | Funcao |
|---|---|---|
| `jdi-researcher` | Opus | Research pre-roadmap. Le ideia, pergunta, gera PROJECT.md + ROADMAP.md |
| `jdi-bootstrap` | Sonnet | Dispara architect modo specialist pra gerar per-project doer + reviewer |
| `jdi-asker` | Sonnet | Loop adaptativo de perguntas pra capturar decisoes locked (CONTEXT.md) |
| `jdi-planner` | Opus | Decompoe phase em tasks, agrupa em waves de paralelismo (PLAN.md) |
| `jdi-architect` | Opus | Meta-agent. 2 modos: cria agents/skills genericos no core/ OU cria specialists per-project |

## Specialists per-project (em `.jdi/agents/`)

Gerados pelo `/jdi-bootstrap` baseado em PROJECT.md:

| Agent | Funcao |
|---|---|
| `jdi-doer-{slug}` | Executor que ja conhece stack/code-design/conventions do projeto. Sem descoberta, ja sabe |
| `jdi-reviewer-{slug}` | Roda gates de qualidade definidos pra stack: build, tests, coverage, lint, security |

Routing em `.jdi/specialists.md` e `.jdi/reviewers.md`.

## Memoria — files em `.jdi/`

```
.jdi/
  PROJECT.md          <- visao + stack + code-design locked
  ROADMAP.md          <- phases + status
  DECISIONS.md        <- D-XX append-only (decisoes locked)
  STATE.md            <- current_phase + next_step
  specialists.md      <- routing pro doer
  reviewers.md        <- routing pro reviewer
  registry.md         <- audit trail dos specialists criados
  agents/             <- per-project specialists
    jdi-doer-{slug}.md
    jdi-reviewer-{slug}.md
  phases/{NN-slug}/
    CONTEXT.md        <- output do asker
    PLAN.md           <- output do planner
    SUMMARY.md        <- output do doer
    REVIEW.md         <- output do reviewer
```

## Convencoes

- Conventional Commits — scope = phase slug, ex: `feat(01-setup-api): ...`
- Atomic commits — 1 task = 1 commit
- 80% cobertura minima (overridable via PROJECT.md)
- Code design locked uma vez no `/jdi-new`, nunca muda
- D-XX referenciado em commit message quando aplicavel

## Idioma

- Codigo, commits, PRs: ingles
- Discussao, docs em `.jdi/`: pt-BR
- i18n no frontend: nunca string hardcoded em pt-BR no JSX

## Prioridade quando conflita

1. Seguranca
2. Performance
3. Boas praticas

## Hooks (opcional)

`.githooks/pre-commit` e `post-commit` shipped. Pra ativar:

```bash
git config core.hooksPath .githooks
```

Windows: hooks rodam via Git Bash (vem com Git for Windows). Sem ele, hooks sao silenciosamente ignorados.
