---
name: jdi-ship
description: Finaliza phase apos verify. Atualiza ROADMAP.md, marca phase como done, avanca ponteiro pra proxima.
argument_hint: "<phase_number>"
runtime_intent:
  invokes_agent: none
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion]
  copilot:
    tools: [read, write, edit, grep, glob, terminal]
  opencode:
    subtask: true
  antigravity:
    triggers:
      - "/jdi-ship"
      - "finalizar phase {N}"
---

<objective>
Finaliza phase apos /jdi-verify aprovar. Atualiza ROADMAP.md (phase: done), avanca STATE pra proxima phase, commit final.
</objective>

<arguments>
- `phase_number` (obrigatorio)
</arguments>

<process>

### Passo 1: Validacao
```bash
test -d .jdi/ || { echo "Nao eh projeto JDI."; exit 1; }

# Verifica REVIEW.md existe
ls .jdi/phases/{NN}*/REVIEW.md 2>/dev/null || {
  echo "REVIEW.md ausente. /jdi-verify {N}."
  exit 1
}

# Le veredicto
VERDICT=$(grep -oE 'Veredicto:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' .jdi/phases/{NN}*/REVIEW.md | awk '{print $2}')

if [ "$VERDICT" = "BLOCKED" ]; then
  echo "Phase {N} BLOCKED. Corrige antes de ship."
  exit 1
fi
```

### Passo 2: Confirma com user (so se WITH_WARNINGS)

Se `VERDICT=APPROVED_WITH_WARNINGS`:
```
Phase {N} tem warnings nao corrigidos. Ship mesmo assim?
- Sim, ship (warnings ficam em REVIEW.md)
- Nao, corrige primeiro
```

Se "Nao" -> sai limpo.

### Passo 3: Atualiza ROADMAP.md

Edit `.jdi/ROADMAP.md`:
- Phase {N}: `status: done`
- Phase {N+1}: `status: ready` (se existe)

Se nao tem phase {N+1}:
```
Todas phases concluidas.
Projeto entregue.
```

### Passo 4: Atualiza STATE.md

```markdown
current_phase: {N+1 ou done}
phase_status: ready (se {N+1} existe) ou complete
next_step: /jdi-discuss {N+1} ou done
```

### Passo 5: Commit final

```bash
git add .jdi/ROADMAP.md .jdi/STATE.md
git commit -m "feat({NN-slug}): ship phase {N} ({VERDICT})"
```

Tag opcional (se PROJECT.md tem `tag_phases: true`):
```bash
git tag "phase-{N}-{slug}"
```

### Passo 6: Confirma

```
Phase {N} shipped.

ROADMAP atualizado.
{Se mais phases:}
  Proximo: /jdi-discuss {N+1}
{Se ultima:}
  Projeto entregue. Tag final: phase-{N}-{slug}.
```

</process>

<gates>
- pre: REVIEW.md existe + veredicto != BLOCKED
- post: ROADMAP.md + STATE.md atualizados + commit (+ tag opcional)
</gates>

<errors>
- REVIEW ausente -> /jdi-verify
- Veredicto BLOCKED -> aborta
- Ja shipado -> aborta com warning
</errors>
