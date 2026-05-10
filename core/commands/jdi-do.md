---
name: jdi-do
description: Executa phase. Routing automatico pro doer specialist do projeto. Wave-based parallel se phase tem >=3 tasks independentes.
argument_hint: "<phase_number> [--sequential]"
runtime_intent:
  invokes_agent: dynamic
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, edit, grep, glob, terminal]
  opencode:
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-do"
      - "executar phase {N}"
---

<objective>
Executa todas as tasks da phase informada. Le PLAN.md, agrupa em waves, dispara doer specialist (jdi-doer-{slug}). Paralelismo wave-based, sequential dispatch (um Agent por message com `run_in_background`).
</objective>

<arguments>
- `phase_number` (obrigatorio)
- `--sequential` (opcional): forca execucao sequencial mesmo se waves permitirem paralelo. Util pra debug.
</arguments>

<process>

### Passo 1: Validacao
```bash
test -d .jdi/ || { echo "Nao eh projeto JDI. /jdi-new."; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md ausente."; exit 1; }

# Verifica specialist existe
ls .jdi/agents/jdi-doer-*.md 2>/dev/null | head -1 || {
  echo "Specialist doer ausente. Rode /jdi-bootstrap."
  exit 1
}

# Verifica PLAN.md existe pra phase
ls .jdi/phases/{NN}*/PLAN.md 2>/dev/null || {
  echo "PLAN.md ausente pra phase {N}. Rode /jdi-plan {N}."
  exit 1
}
```

### Passo 2: Resolve doer specialist do projeto

Le `.jdi/specialists.md`. Pega primeiro `jdi-doer-*` listado.

```bash
DOER=$(grep -oE 'jdi-doer-[a-z0-9-]+' .jdi/specialists.md | head -1)
echo "Doer: $DOER"
```

Se vazio -> aborta: "Nenhum doer registrado. /jdi-bootstrap."

### Passo 3: Le PLAN.md, agrupa waves

Parse PLAN.md, extrai:
- Lista de tasks pendentes (`status: pending`)
- Wave de cada task
- Files_modified

Se `--sequential` ou phase tem <3 tasks paralelas: usa execucao sequencial (1 doer por vez).

Senao: wave-based parallel.

### Passo 4: Intra-wave overlap check (safety)

Pra cada wave:
- Pega lista de files_modified de cada task
- Checa par-a-par: 2 tasks compartilham file?
- Se sim -> override pra sequencial nessa wave (warn user)

### Passo 5: Executa waves

**Pra cada wave em ordem:**

```
[wave {W}/{total}] starting, {N} tasks
```

**Se paralelo (>=2 tasks na wave + sem overlap + nao --sequential):**

Sequential dispatch — UM `Agent()` por message com `run_in_background: true`:

```
Agent(
  subagent_type="{DOER}",
  description="Execute T-{X}.{Y} of phase {N}",
  prompt="
    Execute task T-{X}.{Y} from .jdi/phases/{NN-slug}/PLAN.md.
    Le PLAN.md, le PROJECT.md, executa task isolada, commita atomico, atualiza status.
    Nao modifica files fora de files_modified da task.
  ",
  run_in_background: true
)
```

Aguarda todos retornarem antes da proxima wave.

**Se sequencial:** dispara um doer por task, espera, dispara proximo.

### Passo 6: Apos cada wave

Le PLAN.md atualizado (doer atualiza status). Conta:
- completed
- blocked
- pending

Se algum task `blocked` em wave critica -> para execucao, marca phase `partial`, pula pra Passo 8.

### Passo 7: Apos todas waves

Verifica SUMMARY.md foi criado:
```bash
test -f .jdi/phases/{NN}*/SUMMARY.md || { echo "warn: SUMMARY ausente"; }
```

### Passo 8: Atualiza STATE

```markdown
current_phase: {N}
phase_status: {executed|partial}
next_step: /jdi-verify {N}
```

```bash
git add .jdi/STATE.md
git commit -m "chore(state): phase {N} executed"
```

### Passo 9: Confirma

```
Phase {N} executed:
- Tasks: {done}/{total} completed, {blocked} blocked
- Waves rodadas: {W}
- Files modified: {count}

SUMMARY: .jdi/phases/{NN-slug}/SUMMARY.md

Proximo: /jdi-verify {N}
```

</process>

<gates>
- pre: PLAN.md existe + doer specialist registrado em .jdi/specialists.md
- post: tasks executadas (parcial ou total), SUMMARY.md criado, STATE atualizado
</gates>

<errors>
- Doer ausente -> /jdi-bootstrap
- PLAN ausente -> /jdi-plan
- Doer falha em task -> task fica `blocked`, segue proximas (nao aborta tudo)
- Wave inteira blocked -> aborta phase, marca `partial`
</errors>

<runtime_notes>

**Claude Code:**
- Sequential dispatch real funciona via `run_in_background: true` em Agent calls separados
- Aguarda completion via tool result notifications

**Copilot:**
- Subagent spawning nao retorna sinal confiavel
- Default = `--sequential` automatico em Copilot
- Loop foreach task, dispara um por vez

**OpenCode/Antigravity:**
- Usa Task/spawn nativo do runtime
- Paralelismo se runtime suporta
</runtime_notes>
