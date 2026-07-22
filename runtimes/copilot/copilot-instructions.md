# JDI — Instrucoes GitHub Copilot

Este projeto usa **JDI (Just Do It)** como workflow de desenvolvimento. JDI eh um workflow enxuto: 6 comandos no loop + 5 agents core + 2 per-project specialists.

## Loop canonico

```
/jdi-new "<descricao>"   -> research + PROJECT.md + ROADMAP.md
/jdi-bootstrap           -> cria specialists per-project
/jdi-discuss <N>         -> captura decisoes locked
/jdi-plan <N>            -> decompoe em tasks com waves
/jdi-do <N>              -> executa via doer specialist
/jdi-verify <N>          -> gates via reviewer specialist
/jdi-ship <N>            -> finaliza phase

# Roadmap mutation (qualquer hora)
/jdi-add-phase "<name>" [--goal "<t>"] [--at <pos>]   -> adiciona phase
/jdi-remove-phase <N> [--force]                        -> remove future/pending phase

# Continuidade / snapshot
/jdi-status                                            -> resumo: phase atual + ultima acao + proximo comando
```

`/jdi-create [desc]` cria agents/skills genericos no `core/` (so dentro do repo JDI).

## Comandos (prompts)

Em `.github/prompts/` (VS Code: invoque via `/` no chat) e em `.github/skills/`
(Copilot CLI + coding agent do github.com: descoberta semantica — digite o
comando na mensagem, ex. "/jdi-status"; na CLI, `/skills reload` recarrega).

## Agentes (referencie via `@`)

Em `.github/agents/`:

| Agent | Funcao |
|---|---|
| `@jdi-researcher` | Research pre-roadmap |
| `@jdi-bootstrap` | Cria per-project specialists |
| `@jdi-asker` | Loop de perguntas |
| `@jdi-planner` | Gera PLAN.md com waves |
| `@jdi-architect` | Meta-agent |
| `@jdi-solo` | Executor solo end-to-end (sessoes delegadas/headless) |

Agentes usam o modelo configurado no seu Copilot (JDI nao pina modelo).

## Specialists per-project

Apos `/jdi-bootstrap`, gerados em `.jdi/agents/jdi-doer-{slug}.md` e `.jdi/agents/jdi-reviewer-{slug}.md`.

Pra Copilot reconhecer, copie pra `.github/agents/` (ou rode `jdi-install.sh copilot` apos bootstrap).

## Memoria — files em `.jdi/`

```
.jdi/
  PROJECT.md, ROADMAP.md, DECISIONS.md, STATE.md
  specialists.md, reviewers.md, registry.md
  agents/         <- per-project specialists
  phases/{NN-slug}/{CONTEXT,PLAN,SUMMARY,REVIEW}.md
```

Trate como source of truth.

## Issues delegadas (coding agent do github.com)

Quando uma issue/card eh delegada ao Copilot (GitHub Issues, Linear, etc.), a
sessao roda headless com UMA persona — sem humano e sem spawn de subagentes.
Regras NAO negociaveis dessa superficie:

1. **Persona**: a sessao delegada usa o agent `jdi-solo`
   (`.github/agents/jdi-solo.agent.md`) — o executor solo do fluxo completo.
   Os demais `jdi-*` sao sub-agents internos da orquestracao interativa e nao
   devem conduzir sessao delegada (varios nao tem terminal de proposito).
2. **Artefatos ANTES de codigo**: CONTEXT.md e PLAN.md escritos, `git add`,
   commitados — so entao comeca a implementacao. Budget apertou? O que falta
   eh codigo (retomavel), nunca o protocolo.
3. **Gates executados, nunca narrados**: todo `Verify:`/test roda no terminal
   e o exit code real decide.
4. **Persistencia explicita**: todo arquivo `.jdi/` criado recebe `git add`
   imediato (harness de agente descarta untracked em auto-commit).
5. **Completo = mecanico**: `npx -y jdi-cli validate-phase <slug> --for-pr`
   verde antes de abrir o PR. Nunca mergear.

Enforcement instalado (nao depende de boa vontade):
- `.githooks/pre-commit` — bloqueia commit de codigo sem artefatos da phase
  no index (ativado na sessao via `copilot-setup-steps.yml`).
- `.github/workflows/jdi-artifacts-gate.yml` — PR de branch `copilot/*`
  tocando codigo sem a cadeia completa (5 artefatos + verdict != BLOCKED)
  fica vermelho. Lembre de clicar "Approve and run workflows" em PR de agente.

## Limitacoes Copilot vs Claude

- **Sem hooks runtime**: pre/post-commit em `.githooks/`. Ativar:
  ```bash
  git config core.hooksPath .githooks
  ```
- **Spawn de subagentes via `@`**: usuario invoca explicitamente. Sem auto-spawn transparente. Sessao delegada: `jdi-solo` roda tudo inline.
- **AskUserQuestion**: substituido pela interacao normal de chat.
- **Subagent paralelismo**: nao retorna sinal confiavel. `/jdi-do` defaulta sequencial em Copilot.

## Convencoes

- Conventional Commits — scope = phase slug
- Atomic commits — 1 task = 1 commit
- 80% cobertura minima
- Code design locked no `/jdi-new`
- D-XX referenciado em commit message quando aplicavel

## Idioma

- Codigo/commits/PRs: ingles
- Discussao/docs em `.jdi/`: pt-BR

## Prioridade quando conflita

1. Seguranca
2. Performance
3. Boas praticas
