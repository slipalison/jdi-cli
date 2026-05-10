# JDI — Extension

Como evoluir o JDI sem inflar. 2 caminhos:

1. **Per-project specialists** (`/jdi-bootstrap`) — gera doer/reviewer customizados pro projeto. Caminho normal.
2. **Agents/skills genericos no core** (`/jdi-create`) — cria agent ou skill novo no `core/`. So contributors do JDI fonte.

## Caminho 1: `/jdi-bootstrap` (per-project)

Roda no projeto consumindo JDI, apos `/jdi-new`.

```
cd meu-projeto
/jdi-new "API REST .NET 10"
/jdi-bootstrap
```

Architect modo specialist:
1. Le `.jdi/PROJECT.md`
2. Faz 6 perguntas (test framework, build/test commands, coverage min, lint, conventions)
3. Gera `.jdi/agents/jdi-doer-{slug}.md` e `.jdi/agents/jdi-reviewer-{slug}.md`
4. Atualiza routing
5. Commit

Doer/reviewer ficam **pequenos** (~150-200 linhas cada) porque so cobrem 1 stack.

### Multi-stack (frontend + backend)

Atualmente `/jdi-bootstrap` cria 1 doer agregado. Pra projetos com backend + frontend:

**Workaround atual:**
- Doer agregado conhece ambas stacks (mais verbose, ainda menor que doer 100% generico)
- OU: rode `/jdi-bootstrap` 2 vezes com slugs distintos (ex: `myapp-backend` + `myapp-frontend`)
- Doer correto invocado por matching de `files_modified` no PLAN.md (futuro: `/jdi-do` faz routing automatico)

**Roadmap:** multi-doer nativo em versao futura.

## Caminho 2: `/jdi-create` (core)

So contributors do JDI fonte usam. Cria agent ou skill GENERICO no `core/`.

```
cd /path/to/jdi-source
/jdi-create "skill com convencoes EF Core 9"
/jdi-create "specialist pra Rust com cargo + clippy"
```

Architect modo create:
1. 8 perguntas (problema, trigger, input, output, reuso, decision-loop, custo, tools)
2. Classificacao automatica:
   - `agent` — tem decision loop proprio
   - `skill` — procedimento reusavel sem loop
   - `composite` — agent + skill
3. Validacao com user (approve / edit / cancel)
4. Geracao em `core/agents/` ou `core/skills/`
5. Build + install
6. Commit + audit em `.jdi/registry.md`

## Anti-padroes

Architect bloqueia ou avisa em:

- **Nome generico** ("review-code", "doer", "checker") — pede foco especifico
- **Specialist por feature** ("auth-specialist") — redireciona pra phase
- **Skill > 500 linhas estimadas** — sugere agent
- **Agent sem decision loop** — sugere skill
- **Soft cap > 15 agents core ou > 25 skills** — avisa, nao bloqueia
- **Nome colide com agent/skill existente** — obriga renomear

## Quando criar agent vs skill

| Pergunta | Agent | Skill |
|---|---|---|
| Tem decision loop? | sim | nao |
| Multiplos callers? | nao (1 caller fica natural) | sim (varios agents reusam) |
| Output proprio (file)? | sim | nao (modifica pai) |
| Privilegios proprios? | sim | herda do pai |
| Tamanho tipico | 100-500 linhas | 50-200 linhas |

Em duvida -> agent. Refatora pra skill depois se virar reusavel.

## Quando criar specialist vs usar generico

| Cenario | Specialist | Doer generico |
|---|---|---|
| Stack conhecida e estavel | x | - |
| Multi-stack mesmo projeto | x (1 por stack) | - |
| Convencoes especificas (naming, error handling) | x | - |
| Codigo legacy com regras unicas | x | - |
| Projeto experimental, nao definido | - | x |
| POC rapido (vai jogar fora) | - | x |

JDI default = specialist. Generico eh fallback.

## Checklist pra novo specialist

Apos `/jdi-bootstrap` rodar, conferir:

- [ ] `.jdi/agents/jdi-doer-{slug}.md` existe e tem regras especificas (nao default genericas)
- [ ] `.jdi/agents/jdi-reviewer-{slug}.md` existe com gates 1-6 customizados
- [ ] `.jdi/specialists.md` tem linha do doer
- [ ] `.jdi/reviewers.md` tem linha do reviewer
- [ ] `.jdi/registry.md` tem entrada R-N audit trail
- [ ] STATE.md tem `specialists_ready: true`

Se algum falta, rode bootstrap de novo (idempotente — pergunta antes de sobrescrever).

## Checklist pra novo agent core

Apos `/jdi-create` rodar, conferir:

- [ ] `core/agents/jdi-{nome}.md` ou `core/skills/{nome}/SKILL.md` existe
- [ ] Frontmatter completo (name, description, runtime_intent, tools_canonical, triggers, runtime_overrides)
- [ ] `<role>`, `<process>`, `<rules>`, `<output>` blocks presentes
- [ ] Build rodou (runtimes/ tem o agent novo nos 4 runtimes)
- [ ] Install rodou (runtime ativo tem o agent)
- [ ] `.jdi/registry.md` tem entrada R-N

## Manutencao

Specialists envelhecem com o projeto (stack muda, conventions evoluem). Pra atualizar:

```
# Edita manual:
edit .jdi/agents/jdi-doer-{slug}.md

# OU: regera (perde customizacoes manuais)
rm .jdi/agents/jdi-doer-{slug}.md
/jdi-bootstrap
```

Recomendacao: edita manual pra mudancas pequenas (novas conventions). Regera so se stack mudou drasticamente.

## Limites duros

- Max 5 agents core (atual: 5)
- Max 4 templates em `core/templates/` (atual: 4)
- Soft cap 25 skills core (atual: 0 — JDI nao usa skills no core ainda)
- Per-project: sem limite formal de specialists (mas projeto realista tem 1-3)

JDI cresce **com cuidado**. Se vai passar dos limites, considera fork dedicado em vez de inflar o core.
