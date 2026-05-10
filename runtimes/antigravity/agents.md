# agents.md — JDI workflow (Antigravity)

Este projeto usa **JDI (Just Do It)** como workflow de desenvolvimento. JDI eh um workflow enxuto.

## Loop canonico

```
/jdi-new "<descricao>"   -> research + PROJECT.md + ROADMAP.md
/jdi-bootstrap           -> cria specialists per-project
/jdi-discuss <N>         -> captura decisoes locked
/jdi-plan <N>            -> decompoe em tasks com waves
/jdi-do <N>              -> executa via doer specialist
/jdi-verify <N>          -> gates via reviewer specialist
/jdi-ship <N>            -> finaliza phase
```

`/jdi-create [desc]` cria agents/skills no `core/` (so dentro do repo JDI).

## Skills disponiveis

Em `.gemini/antigravity/skills/`. Discovery via triggers.

| Skill | Funcao |
|---|---|
| jdi-researcher | Research pre-roadmap (PROJECT.md + ROADMAP.md) |
| jdi-bootstrap | Cria specialists per-project (doer + reviewer) |
| jdi-asker | Loop de perguntas pra CONTEXT.md |
| jdi-planner | Gera PLAN.md com waves |
| jdi-architect | Meta-skill: cria agents/skills/specialists |

## Specialists per-project

Apos `/jdi-bootstrap`, criados em `.jdi/agents/jdi-doer-{slug}.md` e `.jdi/agents/jdi-reviewer-{slug}.md`.

Pra Antigravity reconhecer, copie pra `.gemini/antigravity/skills/` (ou rode `jdi-install.sh antigravity` apos bootstrap).

## Triggers

Digite `/jdi-discuss N` ou peca em natural — ex: "discutir phase 2", "iniciar phase 1", "executar phase 3", "verificar entrega da phase". Skills tem triggers prefixados `jdi-` pra evitar falsos positivos.

## Memoria — files em `.jdi/`

```
.jdi/
  PROJECT.md, ROADMAP.md, DECISIONS.md, STATE.md
  specialists.md, reviewers.md, registry.md
  agents/         <- per-project specialists
  phases/{NN-slug}/{CONTEXT,PLAN,SUMMARY,REVIEW}.md
```

## Limitacoes Antigravity

- **Sem restricao formal de tools**: cada SKILL.md documenta privilegios via prosa. Confianca via review.
- **Sem hooks runtime**: pre-commit/post-commit ficam em `.githooks/`. Ativar com `git config core.hooksPath .githooks`.
- **Discovery por trigger**: prefixo `jdi-` evita falsos positivos.
- **Subagent spawn limitado**: paralelizacao por default sequential. Use prompts explicitos pra paralelo.

## Convencoes

- Conventional Commits — scope = phase slug
- Atomic commits — 1 task = 1 commit
- 80% cobertura minima
- Code design locked no `/jdi-new`

## Idioma

- Codigo/commits/PRs: ingles
- Discussao/docs em `.jdi/`: pt-BR

## Prioridade quando conflita

1. Seguranca
2. Performance
3. Boas praticas
