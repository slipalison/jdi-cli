# JDI — Create Mechanism

Como criar **agents** e **skills** novos pro JDI core sem inflar o sistema.

Comando: `/jdi-create`. Agent: `jdi-architect` modo `create`.

Fluxo paralelo do mesmo architect: `/jdi-bootstrap` invoca `jdi-architect` modo `specialist` pra criar doer/reviewer per-project. Veja [EXTENSION.md](EXTENSION.md).

## Quando usar `/jdi-create`

Use quando:
- Voce eh contributor do JDI fonte (nao usuario consumindo)
- Quer adicionar agent generico que TODOS projetos JDI vao usar
- Quer adicionar skill reusavel carregada por multiplos agents

NAO use quando:
- Quer specialist pro SEU projeto especifico — use `/jdi-bootstrap`
- Quer config local — edite `.jdi/` direto
- Esta dentro de projeto consumindo JDI (sem `core/` no diretorio)

## Pre-requisitos

```bash
test -d core/ && test -d .jdi/      # esta no repo JDI fonte
git status --porcelain | wc -l      # working tree limpo (recomendado)
```

## Fluxo passo-a-passo

### 1. Invoca

```
/jdi-create "specialist pra Rust com cargo + clippy"
/jdi-create "skill com convencoes EF Core 9"
/jdi-create
```

Argumento livre (opcional) acelera Q1.

### 2. Architect carrega contexto

```bash
ls core/agents/         # agents existentes
ls core/skills/         # skills existentes
cat .jdi/specialists.md # routing
cat .jdi/reviewers.md
cat .jdi/registry.md    # historia de criacoes
```

Acumula em memoria pra evitar duplicacao.

### 3. Loop de 8 perguntas

AskUserQuestion uma por vez:

| # | Pergunta | Tipo |
|---|---|---|
| Q1 | Que problema resolve? | texto livre |
| Q2 | Quando deve rodar? | multipla escolha |
| Q3 | O que precisa pra rodar? (input) | multipla escolha |
| Q4 | O que produz? (output) | multipla escolha |
| Q5 | Quantos callers vao usar? | 1 caller / varios / nao sei |
| Q6 | Tem decision loop com retry/branches? | sim / nao |
| Q7 | Custo de execucao? | cheap / medium / deep / N/A |
| Q8 | Tools necessarios? | multipla (Read/Write/Edit/Bash/Web/AskUser/Agent) |

### 4. Classificacao automatica

```
Q5 = varios callers + Q6 = sem loop          -> SKILL puro
Q5 = 1 caller + Q6 = com loop + output file  -> AGENT puro
Q5 = varios + Q6 = com loop                  -> COMPOSITE (agent + skill)
Q5 = nao sei + tiebreaker via Q6
```

### 5. Anti-pattern check

- Nome generico ("review-code") -> pede foco
- Specialist por feature ("auth") -> redireciona pra phase
- Skill > 500 linhas estimado -> sugere agent
- Agent sem decision loop -> sugere skill
- Soft cap (>15 agents / >25 skills) -> avisa
- Nome colide -> obriga renomear

### 6. Draft plan (preview)

Mostra YAML pro user:

```yaml
proposed:
  type: agent
  name: jdi-rust-specialist
  description: Specialist Rust com cargo + clippy + rustfmt
  triggers: [executar phase rust, rust files]
  tools: [Read, Write, Edit, Bash]
  model_intent: medium

inputs: [phase_number, .jdi/phases/{NN}/PLAN.md, src/**/*.rs]
outputs: [.jdi/phases/{NN}/SUMMARY.md, codigo Rust + tests]

files_to_create:
  - core/agents/jdi-rust-specialist.md

integration_points:
  - update .jdi/specialists.md (Rust -> jdi-rust-specialist)

validation_checks:
  - nome unico
  - frontmatter conforme template
  - triggers nao colidem
```

### 7. Validacao com user

AskUserQuestion:
- **Approve** — confirma, vai pra geracao
- **Edit** — qual campo mudar?
- **Cancel** — sai sem criar nada

### 8. Geracao dos arquivos

#### Agent

Le `core/templates/agent.md`. Substitui placeholders:
- `{NOME}`, `{DESCRICAO_1_LINHA}`, `{ROLE}`, `{LISTA_TOOLS}`, `{LISTA_TRIGGERS}`
- `{MODELO_CLAUDE}`, `{TOOLS_CLAUDE}`, `{MODELO_COPILOT}`, etc.

Write em `core/agents/jdi-{nome}.md`.

#### Skill

Le `core/templates/skill.md`. Substitui placeholders.
mkdir + Write em `core/skills/{nome}/SKILL.md`.

Se tem references, cria placeholders em `core/skills/{nome}/references/`.

#### Composite

Cria os dois. Agent referencia skill em `<skills_to_load>`.

### 9. Atualiza integration points

| Tipo | Update |
|---|---|
| Specialist (linguagem) | append `.jdi/specialists.md` + edit doer routing |
| Reviewer | append `.jdi/reviewers.md` + edit `/jdi-verify` discovery |
| Skill | append `.jdi/registry.md` + edit `<skills_to_load>` dos agents que carregam |

### 10. Audit trail

Append em `.jdi/registry.md`:

```markdown
## R-{N} ({date})
**Tipo:** agent | skill | composite
**Nome:** jdi-{nome}
**Criado por:** /jdi-create
**Por que:** {Q1 resposta}
**Files:** {lista}
**Integration:** {lista}
```

### 11. Build + install

```bash
./bin/jdi-build.sh         # ou .ps1 em Windows
./bin/jdi-install.sh {runtime} --scope {user|project}
```

Detecta runtime ativo automaticamente:
- `~/.claude/` existe? -> claude
- `.github/agents/` existe? -> copilot
- `~/.gemini/antigravity/` -> antigravity
- `~/.config/opencode/` -> opencode
- nenhum -> pergunta

### 12. Smoke test

Mostra ao user **como invocar** o que foi criado:

```
Criado: jdi-rust-specialist (agent)

Como invocar:
- Claude Code: Spawn via Agent tool com subagent_type=jdi-rust-specialist
- Copilot:     @jdi-rust-specialist no chat
- Antigravity: descobre por trigger ou peca explicitamente
- OpenCode:    @jdi-rust-specialist no TUI

Audit: .jdi/registry.md (R-N)
Commit: {sha}
```

### 13. Commit

```bash
git add core/ .jdi/specialists.md .jdi/reviewers.md .jdi/registry.md runtimes/
git commit -m "feat(jdi-create): add agent jdi-rust-specialist"
```

## Templates

```
core/templates/
  agent.md              <- base pra agent generico
  skill.md              <- base pra skill
  doer-specialist.md    <- usado por modo specialist (NAO modo create)
  reviewer-specialist.md <- idem
```

Modo create usa `agent.md` ou `skill.md`. Modo specialist usa `doer-specialist.md` + `reviewer-specialist.md`.

## Estrutura de agent gerado

```yaml
---
name: jdi-{nome}
description: {1 linha}
runtime_intent:
  role: {role}
  reasoning: {cheap|medium|deep}
  privileges: {read|read+write|read+write+edit|read+write+edit+bash}
tools_canonical: [...]
triggers: [...]
runtime_overrides:
  claude:
    model: {opus|sonnet|haiku}
    tools: [...]
  copilot:
    model: gpt-5
    tools: [...]
  opencode:
    mode: subagent
    model: anthropic/claude-sonnet-4-20250514
    permission: { edit, bash, write }
  antigravity:
    triggers_extra: [...]
---

<role>
Voce eh `jdi-{nome}`. ...
</role>

<inputs>
- ...
</inputs>

<process>
### Passo 1: ...
### Passo 2: ...
</process>

<rules>
- ...
</rules>

<fallbacks>
- ...
</fallbacks>

<output>
- ...
</output>
```

## Estrutura de skill gerado

```yaml
---
name: {nome}
description: {1 linha}
type: skill
applies_to: ...
loaded_by: [...]
runtime_overrides:
  antigravity:
    triggers: [...]
---

# Skill: {nome}

## Quando aplicar
...

## Procedure
### Passo 1: ...

## Inputs esperados
...

## Outputs
...

## References
- references/{X}.md
```

## Reverso: deletar

JDI nao tem comando `/jdi-delete`. Manualmente:

1. `git rm core/agents/jdi-{nome}.md` (ou `core/skills/{nome}/`)
2. Edita `.jdi/specialists.md` ou `.jdi/reviewers.md` (remove linha)
3. Append em `.jdi/registry.md`: `R-{N}: removed jdi-{nome} ({razao})`
4. `./bin/jdi-build.sh && ./bin/jdi-install.sh {runtime}`
5. `git commit -m "chore(jdi): remove agent jdi-{nome}"`

Soft delete preferido: marca `deprecated: true` no frontmatter, deixa file. Remove fisicamente so quando 100% certo.

## Veja tambem

- [CREATE-EXAMPLE.md](CREATE-EXAMPLE.md) — walkthrough concreto
- [EXTENSION.md](EXTENSION.md) — quando usar create vs bootstrap
- [AGENTS.md](AGENTS.md) — agents existentes
- [ARCHITECTURE.md](ARCHITECTURE.md) — visao geral
