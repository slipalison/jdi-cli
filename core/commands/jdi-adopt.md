---
name: jdi-adopt
description: Entry point pra projeto brownfield (codigo ja existe). Roda jdi-adopter — scan + analise + confirmacao + gera .jdi/ com flag adopted=true. Substitui /jdi-new pra projetos existentes.
argument_hint: "<descricao curta opcional>"
runtime_intent:
  invokes_agent: jdi-adopter
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Bash, Grep, Glob, AskUserQuestion, WebSearch, WebFetch, Agent]
  copilot:
    tools: [read, write, grep, glob, terminal]
  opencode:
    agent: jdi-adopter
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-adopt"
      - "adotar projeto"
      - "projeto existente"
      - "brownfield"
---

<objective>
Adiciona JDI a projeto que JA TEM CODIGO. Scaneia repo, infere stack/code-design, confirma com user (code-design SEMPRE confirmado), gera PROJECT.md + ROADMAP.md + STATE.md + DECISIONS.md com flag adopted=true.
</objective>

<arguments>
- `descricao` (opcional): texto curto override do que o projeto faz. Se omitido, adopter extrai do README.

Exemplos:
- `/jdi-adopt`
- `/jdi-adopt "API REST de pedidos, legado, queremos adicionar relatorios"`
</arguments>

<process>

### Passo 1: Validacao
```bash
test -d .jdi/ && {
  echo ".jdi/ ja existe. Use /jdi-bootstrap se nao tem specialists, OU edite manual."
  exit 1
}

# diretorio precisa ter codigo (do contrario use /jdi-new)
file_count=$(find . -maxdepth 3 -type f \
  -not -path './.git/*' -not -path './node_modules/*' \
  -not -path './.venv/*' -not -path './venv/*' \
  -not -path './target/*' -not -path './dist/*' -not -path './build/*' \
  -not -path './bin/*' -not -path './obj/*' \
  2>/dev/null | wc -l)

if [ "$file_count" -lt 3 ]; then
  echo "Diretorio quase vazio ($file_count files). Use /jdi-new pra greenfield."
  exit 1
fi
```

PowerShell:
```powershell
if (Test-Path .jdi) {
  Write-Error ".jdi/ ja existe. Use /jdi-bootstrap se nao tem specialists, OU edite manual."
  exit 1
}
$files = Get-ChildItem -Recurse -File -Depth 3 -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(\.git|node_modules|\.venv|venv|target|dist|build|bin|obj)\\' }
if ($files.Count -lt 3) {
  Write-Error "Diretorio quase vazio ($($files.Count) files). Use /jdi-new pra greenfield."
  exit 1
}
```

### Passo 2: Spawn jdi-adopter
Invoca `jdi-adopter` passando descricao (se houve). Aguarda.

Adopter conduz:
- Scan automatico (manifests, layout, git log, README)
- 5 perguntas (stack, code-design, visao, features-novas, LLM)
- Web research opcional (max 2 lookups)
- Geracao de `.jdi/` files
- Commit inicial

### Passo 3: Verifica outputs
```bash
test -f .jdi/PROJECT.md  || { echo "PROJECT.md nao criado"; exit 1; }
test -f .jdi/ROADMAP.md  || { echo "ROADMAP.md nao criado"; exit 1; }
test -f .jdi/STATE.md    || { echo "STATE.md nao criado"; exit 1; }
test -f .jdi/DECISIONS.md|| { echo "DECISIONS.md nao criado"; exit 1; }

grep -q '^adopted: true' .jdi/STATE.md || echo "warn: adopted flag ausente em STATE.md"
grep -q '^D-2 ' .jdi/DECISIONS.md || echo "warn: D-2 (boundary) ausente em DECISIONS.md"
```

PowerShell:
```powershell
foreach ($f in @('PROJECT.md','ROADMAP.md','STATE.md','DECISIONS.md')) {
  if (-not (Test-Path ".jdi/$f")) { Write-Error "$f nao criado"; exit 1 }
}
if (-not (Select-String -Path .jdi/STATE.md -Pattern '^adopted:\s*true' -Quiet)) {
  Write-Warning "adopted flag ausente em STATE.md"
}
if (-not (Select-String -Path .jdi/DECISIONS.md -Pattern '^D-2 ' -Quiet)) {
  Write-Warning "D-2 (boundary) ausente em DECISIONS.md"
}
```

### Passo 4: Cria config.json (token/context budget)

Se `.jdi/config.json` ainda nao existe, escreve default identico ao do `/jdi-new`:

```json
{
  "$schema_version": "1.1",
  "context_window": 200000,
  "thresholds": {
    "warn_pct": 60,
    "critical_pct": 70
  },
  "budgets": {
    "max_context_chars": 6000,
    "max_plan_chars": 12000,
    "max_summary_chars": 8192
  },
  "compaction": {
    "keep_phases": 2,
    "archive_after": 5
  },
  "coverage_min": 80
}
```

### Passo 5: Confirma

```
{project_name} adopted. {N} phases novas planejadas.
Existing assets capturados em .jdi/PROJECT.md (contexto, NAO TODO).
Code design: {design} (LOCKED apos confirm).
Boundary: codigo legado nao enforce 80% coverage (D-2 em DECISIONS.md).
Proximo: /jdi-bootstrap
```

</process>

<gates>
- pre: `.jdi/` ausente + diretorio com >= 3 files de codigo (descontando ignorados)
- post: PROJECT.md (com `## Existing assets`) + ROADMAP.md (adopted=true) + STATE.md (adopted: true) + DECISIONS.md (D-1 code-design, D-2 boundary) + config.json criados, commit feito
</gates>

<errors>
- `.jdi/` ja existe -> sai com instrucao
- Diretorio quase vazio -> sugere `/jdi-new` em vez de adopt
- Adopter cancelou -> sai limpo, sem commit
- Adopter failed -> mostra erro, sem commit, sugere retry manual
- Code design nao confirmado pelo user -> aborta (regra: SEMPRE confirma)
</errors>
