# JDI — `/jdi-create` Walkthrough

Exemplos concretos do fluxo `/jdi-create` (modo create do architect — agents/skills genericos no core).

Pra fluxo per-project (`/jdi-bootstrap` modo specialist), veja [EXTENSION.md](EXTENSION.md).

## Caso 1 — Agent puro: specialist Rust

Voce contribui pro JDI fonte e quer adicionar suporte pra projetos Rust (existe demanda real entre users).

### Invocacao

```
$ cd /path/to/jdi-source
$ /jdi-create "specialist pra Rust com cargo + clippy + rustfmt"
```

### Q&A

**Architect:** Q1 — Em 1 frase, que problema esse novo agent resolve?

**User:** Executor Rust que sabe cargo build/test/clippy/fmt sem precisar redescobrir a cada projeto.

**Q2 — Quando rodar?**
- [x] Outro agent o invoca (jdi-do via routing)

**Q3 — O que precisa pra rodar?**
- [x] Files do projeto (`src/**/*.rs`, `Cargo.toml`)
- [x] Output de outro agent (PLAN.md)

**Q4 — O que produz?**
- [x] Codigo modificado
- [x] SUMMARY.md em `.jdi/phases/{NN}/`

**Q5 — Quantos callers?**
- [x] 1 caller principal (jdi-do via routing por linguagem Rust)

**Q6 — Tem decision loop?**
- [x] Sim — task -> implement -> test -> retry on failure -> commit -> next task

**Q7 — Custo?**
- [x] Medium (Sonnet, 30-90s por task)

**Q8 — Tools?**
- [x] Read, Write, Edit, Bash

### Classificacao automatica

```
Q5 = 1 caller + Q6 = com loop + Q4 contem "arquivo" -> AGENT puro
```

### Anti-pattern check

- Nome `jdi-rust-specialist` — OK (especifico)
- Nao eh feature-based — OK
- Tamanho estimado: 200-300 linhas (template doer-specialist + Rust convencoes) — OK pra agent
- Total agents core apos criacao: 6 — abaixo do soft cap 15 — OK

### Draft plan

```yaml
proposed:
  type: agent
  name: jdi-rust-specialist
  description: Specialist Rust com cargo + clippy + rustfmt + Testcontainers se DB
  triggers:
    - "executar phase rust"
    - "/jdi-do rust"
    - "rust files in plan"
  tools: [Read, Write, Edit, Bash]
  model_intent: medium

inputs:
  - phase_number
  - .jdi/PROJECT.md
  - .jdi/phases/{NN}/PLAN.md
  - src/**/*.rs, Cargo.toml

outputs:
  - codigo Rust modificado
  - .jdi/phases/{NN}/SUMMARY.md
  - .jdi/phases/{NN}/PLAN.md (status atualizado)

files_to_create:
  - core/agents/jdi-rust-specialist.md

integration_points:
  - .jdi/specialists.md: "Rust | jdi-rust-specialist | files *.rs"

validation_checks:
  - nome unico (jdi-rust-specialist nao existe)
  - frontmatter conforme template/agent.md
  - triggers nao colidem com agents existentes
```

### Approve / Edit / Cancel?

**User:** Approve

### Geracao

Architect le `core/templates/agent.md`. Substitui placeholders. Write em:

```
core/agents/jdi-rust-specialist.md
```

Append em `.jdi/specialists.md`:
```markdown
| Rust | jdi-rust-specialist | files com extensao .rs |
```

Append em `.jdi/registry.md`:
```markdown
## R-2 (2026-05-09)
**Tipo:** agent
**Nome:** jdi-rust-specialist
**Criado por:** /jdi-create
**Por que:** Demanda real de users com projetos Rust. Generic doer nao sabe cargo workflow.
**Files:** core/agents/jdi-rust-specialist.md
**Integration:** .jdi/specialists.md
```

### Build + install

```bash
$ ./bin/jdi-build.sh
JDI build - gerando runtimes a partir de core/

claude:
  claude/agents/jdi-architect.md
  claude/agents/jdi-asker.md
  claude/agents/jdi-bootstrap.md
  claude/agents/jdi-planner.md
  claude/agents/jdi-researcher.md
  claude/agents/jdi-rust-specialist.md   <- NEW
... (idem pra copilot, antigravity, opencode)

$ ./bin/jdi-install.sh claude --scope user
Claude Code instalado em: ~/.claude (scope=user)
```

### Smoke test

```
Criado: jdi-rust-specialist (agent)

Como invocar:
- Claude Code: Spawn via Agent tool com subagent_type=jdi-rust-specialist
- Copilot:     @jdi-rust-specialist no chat
- Antigravity: descobre por trigger "executar phase rust"
- OpenCode:    @jdi-rust-specialist no TUI

Audit: .jdi/registry.md (R-2)
```

### Commit

```bash
$ git add core/ .jdi/specialists.md .jdi/registry.md runtimes/
$ git commit -m "feat(jdi-create): add agent jdi-rust-specialist"
```

---

## Caso 2 — Skill: convencoes EF Core 9

Voce nota que multiplos doers (.NET specialist, generic, etc) repetem regras de EF Core 9. Vira skill compartilhada.

### Invocacao

```
$ /jdi-create "skill com convencoes EF Core 9 pra reuso entre doers .NET"
```

### Q&A

**Q1 — Problema?** Multiplos doers .NET repetem regras EF Core 9 (Include with Split, AsNoTracking, scaffolding). DRY.

**Q2 — Quando rodar?** Carregada inline pelo agent pai quando phase toca EF Core.

**Q3 — Input?** Output do agent pai (codigo .NET sendo escrito).

**Q4 — Output?** Modifica codigo do agent pai (sem file proprio).

**Q5 — Quantos callers?** Varios — qualquer doer .NET (csharp, csharp-react, etc).

**Q6 — Decision loop?** Nao — procedimento fixo.

**Q7 — Custo?** N/A (skill puro, herda).

**Q8 — Tools?** Nao tem proprios — herda do agent pai.

### Classificacao

```
Q5 = varios + Q6 = sem loop -> SKILL puro
```

### Draft plan

```yaml
proposed:
  type: skill
  name: ef-core-9-conventions
  description: Convencoes EF Core 9 (Include splits, AsNoTracking, scaffolding seguro)
  applies_to:
    - codigo C# usa EF Core 9
    - phase tocando DbContext / migrations / queries
  loaded_by:
    - jdi-doer-* (qualquer .NET)

files_to_create:
  - core/skills/ef-core-9-conventions/SKILL.md
  - core/skills/ef-core-9-conventions/references/include-split.md
  - core/skills/ef-core-9-conventions/references/no-tracking.md

integration_points:
  - .jdi/skills-registry.md: nova entrada
```

### Geracao

Le `core/templates/skill.md`. Substitui. mkdir + Write:

```
core/skills/ef-core-9-conventions/
  SKILL.md
  references/
    include-split.md      (placeholder pra preencher)
    no-tracking.md        (placeholder pra preencher)
```

Append em `.jdi/skills-registry.md`:
```markdown
| ef-core-9-conventions | core/skills/ef-core-9-conventions/ | EF Core 9 + .NET projects | jdi-doer-* (.NET) |
```

### Resultado

Doers .NET com `<skills_to_load>` listando essa skill carregam automaticamente. Sem duplicacao.

---

## Caso 3 — Composite: reviewer customizado pra payments

Phase de pagamento precisa de gates extras (PCI, idempotency, retries). Cria composite: reviewer focado + skill de checks.

### Invocacao

```
$ /jdi-create "reviewer focado em payments com PCI checks + idempotency rules"
```

### Q&A resumido

- Q1: Garantir que phases de payment passem PCI/idempotency antes de ship
- Q2: Trigger por phase com files em `Features/Payments/**`
- Q5: 1 caller (jdi-verify) + skill reusavel por outros reviewers
- Q6: Com loop (multiplos checks)

### Classificacao

```
Q5 = 1 + skill reusavel + Q6 = com loop -> COMPOSITE
```

### Draft plan

```yaml
proposed:
  type: composite
  name: jdi-payment-reviewer
  components:
    agent:
      file: core/agents/jdi-payment-reviewer.md
      tools: [Read, Bash, Grep]
      model: sonnet
    skill:
      file: core/skills/payment-checks/SKILL.md
      loaded_by: [jdi-payment-reviewer, jdi-reviewer-* (any with payments)]

integration_points:
  - .jdi/reviewers.md: "jdi-payment-reviewer | files Features/Payments/** | bloqueia ship"
  - .jdi/skills-registry.md: "payment-checks"
```

### Geracao

Cria os 2 files. Agent referencia skill em `<skills_to_load>`. Reviewer-{slug} per-project podem opcionalmente carregar tambem (via append no `<skills_to_load>` do reviewer customizado).

---

## Anti-pattern: nome generico

```
$ /jdi-create "review-code"
```

Architect detecta nome generico. Resposta:

```
Anti-pattern: nome "review-code" muito generico.

Sugestoes:
- jdi-payment-reviewer (focado em payments)
- jdi-csharp-reviewer (focado em .NET, mas reviewer per-project ja faz isso)
- jdi-architecture-reviewer (focado em arch decisions)

Refazer? (sim / cancel)
```

User refaz com nome especifico, ou cancela.

---

## Anti-pattern: specialist por feature

```
$ /jdi-create "specialist pra auth"
```

Architect:

```
Anti-pattern: specialist por feature ("auth"), nao por linguagem/stack.

Auth eh feature -> phase normal cobre.
Voce quer:
- (a) Phase de auth via /jdi-discuss + /jdi-plan + /jdi-do (specialist do projeto ja sabe)
- (b) Skill de auth conventions (httpOnly cookies, PKCE, etc) carregada por reviewers
- (c) Cancelar

Escolha?
```

---

## Anti-pattern: skill grande

Q estimou skill com 800 linhas. Architect:

```
Anti-pattern: skill estimado em 800 linhas.

Skills devem ser <500 linhas (procedimento focado, nao manual completo).

Opcoes:
- (a) Virar agent (com decision loop) — agent pode ser maior
- (b) Quebrar em 2-3 skills menores (ex: payment-validation, payment-idempotency, payment-retry)
- (c) Cancelar

Escolha?
```

---

## Anti-pattern: nome colide

```
$ /jdi-create "specialist pra TypeScript"
```

Architect detecta `core/agents/jdi-typescript-specialist.md` ja existe.

```
Conflito: jdi-typescript-specialist ja existe (R-3 em registry.md).

Voce quer:
- (a) Atualizar o existente (edit manual depois)
- (b) Criar variante (jdi-typescript-strict-specialist, jdi-typescript-react-specialist)
- (c) Cancelar

Escolha?
```

---

## Veja tambem

- [CREATE.md](CREATE.md) — mecanica detalhada do fluxo
- [EXTENSION.md](EXTENSION.md) — create vs bootstrap (per-project)
- [AGENTS.md](AGENTS.md) — agents existentes
- [ARCHITECTURE.md](ARCHITECTURE.md) — visao geral
