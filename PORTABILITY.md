# JDI — Portability

JDI roda em 4 runtimes: **Claude Code**, **GitHub Copilot**, **Google Antigravity**, **OpenCode**.

Estrategia: 1 fonte de verdade (`core/`) + adapters por runtime (`runtimes/<name>/`). 1 script que sincroniza.

## Mapeamento dos 4 runtimes

| Conceito JDI | Claude Code | GitHub Copilot | Antigravity | OpenCode |
|---|---|---|---|---|
| Comando | `.claude/commands/<n>.md` | `.github/prompts/<n>.prompt.md` | `skills/<n>/SKILL.md` | `.opencode/commands/<n>.md` |
| Agente | `.claude/agents/<n>.md` | `.github/agents/<n>.agent.md` | `skills/<n>/SKILL.md` | `.opencode/agents/<n>.md` |
| Skill | `.claude/skills/<n>/SKILL.md` | n/a | `skills/<n>/` | `.opencode/skills/<n>/SKILL.md` (le tambem `.claude/skills/`) |
| Instrucao global | `CLAUDE.md` | `.github/copilot-instructions.md` | `agents.md` | `AGENTS.md` |
| Hook | `settings.json` `hooks` | nao tem | nao tem | `opencode.jsonc` `permission` |
| Invocacao | `/jdi-discuss` | `/jdi-discuss` ou `@jdi-asker` | discovery por trigger | `/jdi-discuss` ou `@jdi-asker` |
| Tools restritas | frontmatter `tools:` | frontmatter `tools:` | sem restricao formal | frontmatter `permission:` |
| Modelo escolhido | `model: opus|sonnet|haiku` | `model: gpt-5|...` | nao expoe | `model: anthropic/claude-...|openai/...` |
| Subagent flag | implicit (Agent tool spawn) | `@<name>` referenciado | discovery | `mode: subagent` + `subtask: true` |

Refs:
- [Claude Code agents docs](https://docs.claude.com/en/docs/claude-code/sub-agents)
- [GitHub Copilot custom agents](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents)
- [Antigravity skills](https://antigravity.google/docs/skills)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [OpenCode commands](https://opencode.ai/docs/commands/)
- [OpenCode skills](https://opencode.ai/docs/skills/)

## Diferencas chave

### Hooks
**Limitacao:** so Claude Code suporta hooks de runtime nativos (pre-commit, post-commit, etc).

**Workaround multi-runtime:**
- Hook `pre-commit` e `post-commit` em `.githooks/` sao **no-op por padrao**
- Reviewer (`/jdi-verify`) cobre validacao de qualidade — sem necessidade de doc-bot pre-commit
- User pode customizar `.githooks/` pra:
  - Lint rapido pre-commit
  - Notificacao Slack pos-commit
  - Etc.
- Pra ativar: `git config core.hooksPath .githooks`

JDI documenta os 4 caminhos. User ativa o que tem.

OpenCode tem `permission:` por agent no frontmatter — nao eh hook, mas controla edit/bash/write granular.

### Tools restritas
**Claude Code:** frontmatter `tools: [Read, Write, Edit, Bash, Grep, Glob]` aplica least-privilege.

**Copilot:** mesma sintaxe, mas suporte limitado a algumas tools.

**Antigravity:** SKILL.md nao restringe tools. Restricao via convencao na prosa do skill.

**OpenCode:** frontmatter `permission:` granular por verbo:
```yaml
permission:
  edit: deny       # nao edita arquivos do projeto
  bash:
    "*": ask       # pergunta antes de qq comando shell
    "git status": allow
    "git diff": allow
  write: allow     # pode criar arquivos novos
  skill: allow     # pode carregar skills
```

### Modelo
**Claude:** `model: opus` / `sonnet` / `haiku` no frontmatter.

**Copilot:** `model: gpt-5` / `claude-opus-4-7` / etc — depende da config da org.

**Antigravity:** transparente. Usa o modelo ativo no IDE.

**OpenCode:** `model: <provider>/<id>` exato. Exemplos:
- `anthropic/claude-sonnet-4-20250514`
- `anthropic/claude-opus-4-7`
- `openai/gpt-5`
- `google/gemini-2.5-flash`

JDI core declara intent (`reasoning: medium`) — adapter traduz pra modelo concreto por runtime.

### Discovery
**Claude:** comando precisa estar em `commands/`. Agente precisa estar em `agents/`. Listado por nome.

**Copilot:** prompts em `.github/prompts/` listados via `/`. Agents auto-descobertos quando referenciado por `@`.

**Antigravity:** descoberta por **descricao + triggers**. SKILL.md frontmatter precisa ter `triggers:` claros. Agent escolhe skill automaticamente quando match.

**OpenCode:** comandos em `.opencode/commands/` listados via `/`. Agents em `.opencode/agents/` invocados via `@<name>` ou pelo `agent:` field do command. Skills descobertas via walk-up do cwd ate git worktree, lendo `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`.

JDI core formata pra atender o pior caso (Antigravity precisa triggers fortes) — outros runtimes ignoram o campo extra.

## Estrutura de pastas

```
jdi/
+-- core/                          source of truth
|   +-- agents/
|   |   +-- jdi-researcher.md     Opus  - upfront discovery
|   |   +-- jdi-bootstrap.md      Sonnet - dispara architect modo specialist
|   |   +-- jdi-asker.md          Sonnet - loop de perguntas
|   |   +-- jdi-planner.md        Opus  - decompose phase
|   |   +-- jdi-architect.md      Opus  - meta (modo create + specialist)
|   +-- commands/
|   |   +-- jdi-new.md
|   |   +-- jdi-bootstrap.md
|   |   +-- jdi-discuss.md
|   |   +-- jdi-plan.md
|   |   +-- jdi-do.md
|   |   +-- jdi-verify.md
|   |   +-- jdi-loop.md           ralph loop, dev<->review automatico
|   |   +-- jdi-ship.md
|   |   +-- jdi-create.md         (so contributors)
|   +-- templates/
|       +-- agent.md              base pra agent generico
|       +-- skill.md              base pra skill
|       +-- doer-specialist.md    usado pelo architect modo specialist
|       +-- reviewer-specialist.md idem
|
+-- runtimes/                      gerados, nao editar a mao
|   +-- claude/
|   |   +-- agents/
|   |   +-- commands/
|   |   +-- CLAUDE.md
|   |   +-- settings.example.json
|   +-- copilot/
|   |   +-- agents/                .github/agents/<n>.agent.md
|   |   +-- prompts/               .github/prompts/<n>.prompt.md
|   |   +-- copilot-instructions.md
|   +-- antigravity/
|   |   +-- skills/                cada agente vira <name>/SKILL.md
|   |   +-- agents.md
|   +-- opencode/
|   |   +-- agents/                .opencode/agents/<n>.md
|   |   +-- commands/              .opencode/commands/<n>.md
|   |   +-- skills/                .opencode/skills/<n>/SKILL.md
|   |   +-- AGENTS.md
|   |   +-- opencode.example.jsonc
|
+-- bin/
|   +-- jdi-build                  builda runtimes/ a partir de core/
|   +-- jdi-install                instala em ~/.claude, .github/, ~/.gemini/
|
+-- README.md
+-- ARCHITECTURE.md
+-- AGENTS.md
+-- COMMANDS.md
+-- MEMORY.md             (state schema dos files .jdi/)
+-- EXTENSION.md
+-- CREATE.md
+-- CREATE-EXAMPLE.md
+-- PORTABILITY.md
```

## Formato do source-of-truth (`core/agents/<n>.md`)

```yaml
---
name: jdi-asker
description: Loop adaptativo de perguntas. Vira CONTEXT.md.
runtime_intent:
  role: discover_decisions
  reasoning: medium      # cheap | medium | deep
  privileges: read+write
tools_canonical:
  - read
  - write
  - grep
  - glob
  - ask_user_question
triggers:                # usado pelo Antigravity discovery
  - "discutir phase"
  - "context para phase"
  - "decisoes para phase"
runtime_overrides:
  claude:
    model: sonnet
    tools: [Read, Write, Grep, Glob, AskUserQuestion]
  copilot:
    model: gpt-5
    tools: [read, write, grep, glob]
  antigravity:
    triggers_extra:
      - "iniciar discuss"
      - "/jdi-discuss"
---

<role>
... corpo do agente em markdown comum ...
</role>

<process>
... fluxo ...
</process>

<output>
... saida esperada ...
</output>
```

## Build script (`bin/jdi-build`)

Pseudocode:

```bash
#!/usr/bin/env bash
# Le core/, gera runtimes/

for agent in core/agents/*.md; do
  name=$(basename "$agent" .md)
  
  # Claude
  jq-md remap-frontmatter "$agent" \
    --map "tools_canonical -> tools" \
    --map "runtime_overrides.claude.model -> model" \
    --strip "runtime_intent,triggers,runtime_overrides" \
    > "runtimes/claude/agents/$name.md"
  
  # Copilot
  jq-md remap-frontmatter "$agent" \
    --map "tools_canonical -> tools" \
    --map "runtime_overrides.copilot.model -> model" \
    --strip "runtime_intent,triggers,runtime_overrides" \
    --rename-ext ".agent.md" \
    > "runtimes/copilot/agents/$name.agent.md"
  
  # Antigravity
  mkdir -p "runtimes/antigravity/skills/$name"
  jq-md to-skill-format "$agent" \
    --strip "runtime_overrides,tools_canonical" \
    --merge-triggers "runtime_overrides.antigravity.triggers_extra" \
    > "runtimes/antigravity/skills/$name/SKILL.md"
done

# Comandos seguem o mesmo padrao
for cmd in core/commands/*.md; do
  name=$(basename "$cmd" .md)
  
  cp "$cmd" "runtimes/claude/commands/$name.md"
  
  # Copilot: vira prompt file
  cp "$cmd" "runtimes/copilot/prompts/$name.prompt.md"
  
  # Antigravity: vira skill (comando = skill com trigger forte)
  mkdir -p "runtimes/antigravity/skills/$name"
  cp "$cmd" "runtimes/antigravity/skills/$name/SKILL.md"
done
```

Implementacao real: bash + yq + sed (atual). Reescreve em ts se virar projeto serio.

## Install script (`bin/jdi-install`)

```bash
#!/usr/bin/env bash
# Uso: ./jdi-install <runtime> [--scope user|project]
#
# runtimes: claude | copilot | antigravity | all
# scope:    user (global) | project (default)

RUNTIME="${1:-all}"
SCOPE="${2:---scope project}"

install_claude() {
  if [[ "$SCOPE" == *"user"* ]]; then
    DEST="$HOME/.claude"
  else
    DEST="$PWD/.claude"
  fi
  mkdir -p "$DEST/agents" "$DEST/commands"
  cp -r runtimes/claude/agents/* "$DEST/agents/"
  cp -r runtimes/claude/commands/* "$DEST/commands/"
  cp runtimes/claude/CLAUDE.md "$PWD/CLAUDE.md"
  echo "Claude Code: instalado em $DEST"
}

install_copilot() {
  DEST="$PWD/.github"
  mkdir -p "$DEST/agents" "$DEST/prompts"
  cp -r runtimes/copilot/agents/* "$DEST/agents/"
  cp -r runtimes/copilot/prompts/* "$DEST/prompts/"
  cp runtimes/copilot/copilot-instructions.md "$DEST/copilot-instructions.md"
  echo "Copilot: instalado em $DEST"
}

install_antigravity() {
  if [[ "$SCOPE" == *"user"* ]]; then
    DEST="$HOME/.gemini/antigravity"
  else
    DEST="$PWD/.gemini/antigravity"
  fi
  mkdir -p "$DEST/skills"
  cp -r runtimes/antigravity/skills/* "$DEST/skills/"
  cp runtimes/antigravity/agents.md "$PWD/agents.md"
  echo "Antigravity: instalado em $DEST"
}

case "$RUNTIME" in
  claude)      install_claude ;;
  copilot)     install_copilot ;;
  antigravity) install_antigravity ;;
  all)         install_claude && install_copilot && install_antigravity ;;
  *)           echo "runtime invalido: $RUNTIME"; exit 1 ;;
esac
```

## Diferencas que precisam de attention

### 1. AskUserQuestion
- **Claude:** tool nativo
- **Copilot:** `vscode_askquestions` (equivalente)
- **Antigravity:** sem equivalente formal — skill instrui agente a fazer pergunta em chat normal

JDI core escreve abstracao "ASK_USER" no prompt. Adapter substitui.

### 2. Bash execution
- **Claude:** tool `Bash` com sandbox/permissions
- **Copilot:** tool execute_shell limitado
- **Antigravity:** scripts em `scripts/` invocaveis via path

JDI core usa pseudocode bash. Adapter envolve no formato certo.

### 3. Web access
- **Claude:** WebSearch + WebFetch
- **Copilot:** acesso via plugin/MCP
- **Antigravity:** acesso direto, ferramentas variam

JDI core usa "WEB_FETCH(<url>)" e "WEB_SEARCH(<query>)". Adapter mapeia.

### 4. MCP / ctx7
**Claude e Copilot suportam MCP nativamente.** Antigravity tem suporte parcial.

JDI usa `ctx7` como fallback CLI universal — funciona em todos. Os agentes preferem ctx7 quando MCP nao disponivel.

## Comportamento minimo garantido

Cada agente JDI **deve** funcionar com:
- Read, Write, Edit, Bash (qualquer subset)
- Sem MCP
- Sem hooks
- Sem AskUserQuestion (degrada pra prompt textual)

Isso garante que mesmo no runtime mais restrito (Antigravity sem MCP, ou Copilot CLI), o agente roda.

Fallbacks documentados em cada agente em `core/agents/<n>.md`:

```markdown
<fallbacks>
- Sem AskUserQuestion -> imprime opcoes numeradas, espera resposta de texto
- Sem ctx7 -> WebSearch oficial docs como fallback
- Sem WebSearch -> usa training knowledge tagged [ASSUMED]
</fallbacks>
```

## Sequencia de install

**Linux / macOS / WSL:**

```bash
# Clone JDI
git clone https://github.com/<user>/jdi.git
cd jdi

# Build adapters
./bin/jdi-build.sh

# Instala no(s) runtime(s) que voce usa
./bin/jdi-install.sh claude --scope user
./bin/jdi-install.sh copilot --scope project
./bin/jdi-install.sh antigravity --scope user
./bin/jdi-install.sh opencode --scope user
```

**Windows (PowerShell nativo):**

```powershell
git clone https://github.com/<user>/jdi.git
cd jdi

# Build adapters
.\bin\jdi-build.ps1

# Instala no(s) runtime(s) que voce usa
.\bin\jdi-install.ps1 -Runtime claude -Scope user
.\bin\jdi-install.ps1 -Runtime copilot -Scope project
.\bin\jdi-install.ps1 -Runtime antigravity -Scope user
.\bin\jdi-install.ps1 -Runtime opencode -Scope user
```

Pra projetos novos: `jdi-install.sh all --scope project` (ou `.ps1 -Runtime all -Scope project`) deixa todos os 4 runtimes prontos no projeto.

### Equivalencia entre `.sh` e `.ps1`

| Bash (Linux/Mac/WSL) | PowerShell (Windows) |
|---|---|
| `./bin/jdi-build.sh [runtime]` | `.\bin\jdi-build.ps1 [-Target runtime]` |
| `./bin/jdi-install.sh <runtime> --scope <s>` | `.\bin\jdi-install.ps1 -Runtime <runtime> -Scope <s>` |
| `./bin/jdi-doctor.sh [--verbose]` | `.\bin\jdi-doctor.ps1 [-Verbose]` |

Os scripts geram exatamente os mesmos arquivos em `runtimes/`. Voce pode rodar `.sh` em uma maquina e `.ps1` em outra — output identico.

## Limitacoes conhecidas

| Limitacao | Workaround |
|---|---|
| Copilot/Antigravity sem hooks de runtime | git hooks em `.githooks/` |
| Antigravity sem restricao de tools | convencao via prosa no SKILL.md |
| Copilot prompts file invocados manualmente, nao auto | usuario tem que digitar `/jdi-discuss` — sem auto-advance |
| OpenCode model id verboso | runtime_overrides.opencode.model declara explicito |
| OpenCode permission por verbo (edit/bash/write) | mapeia 1:1 — sem perda de granularidade |
| Antigravity discovery por trigger -> falsos positivos | triggers especificos com prefixo `jdi-` |
| Modelos diferentes por runtime | `runtime_overrides` no frontmatter declara intent |
| Tools com nomes diferentes (Read vs read_file) | adapter normaliza por runtime |

## Sources

- [GitHub Copilot custom agents docs](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents)
- [Custom agents in VS Code](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [Antigravity skills](https://antigravity.google/docs/skills)
- [Authoring Antigravity skills (codelab)](https://codelabs.developers.google.com/getting-started-with-antigravity-skills)
- [Awesome Copilot (community)](https://github.com/github/awesome-copilot)
- [Antigravity awesome skills (community)](https://github.com/sickn33/antigravity-awesome-skills)
