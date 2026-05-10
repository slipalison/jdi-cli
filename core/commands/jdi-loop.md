---
name: jdi-loop
description: Ralph loop — orquestra dev↔review automatico ate veredicto APPROVED. Cap de 5 iter, human gate + reset (max 3 resets = 15 iter absoluto). Oscillation detection corta loop morto cedo.
argument_hint: "<phase_number> [--max-iter=5] [--max-resets=3]"
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
      - "/jdi-loop"
      - "ralph loop phase {N}"
      - "auto review phase {N}"
---

<objective>
Roda o ciclo `/jdi-do {N}` -> `/jdi-verify {N}` em loop ate veredicto APPROVED ou APPROVED_WITH_WARNINGS, sem acao humana entre iter. Cap absoluto: 5 iter por round + max 3 resets (15 iter total). Pergunta o user antes de resetar.

Padrao Ralph (Huntley + ASDLC):
- Generator/Judge separation (doer escreve, reviewer le)
- Bounded iteration (cap explicito)
- Objective exit criteria (veredicto APPROVED do REVIEW.md)
- Context rotation (cada Agent spawn = contexto fresco)
- State persistence (LOOP.md + git commits)
- Oscillation detection (finding hash compare)
</objective>

<arguments>
- `phase_number` (obrigatorio)
- `--max-iter=N` (opcional, default 5): quantas iter por round antes de pedir human gate
- `--max-resets=N` (opcional, default 3): quantos rounds de reset antes do kill switch
</arguments>

<process>

### Passo 1: Validacao

```bash
test -d .jdi/ || { echo "Nao eh projeto JDI. /jdi-new."; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md ausente."; exit 1; }

# Specialists registrados
ls .jdi/agents/jdi-doer-*.md 2>/dev/null | head -1 || {
  echo "Doer ausente. /jdi-bootstrap."; exit 1;
}
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || {
  echo "Reviewer ausente. /jdi-bootstrap."; exit 1;
}

# PLAN existe
ls .jdi/phases/{NN}*/PLAN.md 2>/dev/null || {
  echo "PLAN ausente pra phase {N}. /jdi-plan {N}."; exit 1;
}
```

### Passo 2: Inicializa ou retoma LOOP.md

Path: `.jdi/phases/{NN-slug}/LOOP.md`

```bash
LOOP_FILE=".jdi/phases/{NN-slug}/LOOP.md"

if [ ! -f "$LOOP_FILE" ]; then
  cat > "$LOOP_FILE" <<EOF
---
phase: {N}
iter: 0
total_resets: 0
status: running
max_iter_per_round: ${MAX_ITER:-5}
max_resets: ${MAX_RESETS:-3}
created_at: $(date -Iseconds)
---

## History

EOF
fi
```

Se ja existe:
- Le `iter`, `total_resets`, `status` do frontmatter
- Estados terminais (abortam):
  - `status == converged` -> aborta: "Phase ja convergiu. /jdi-ship {N}"
  - `status == killed` -> aborta: "Hard cap atingido. Plano precisa revisao humana."
- Estados retomaveis (continuam — vira running):
  - `status == escalated` -> reseta `iter: 0`, `status: running`, `total_resets` preservado, append marker `--- RESUMED de escalated em {ts} ---` em history. Continua loop.
  - `status == paused` -> reseta `iter: 0`, `status: running`, `total_resets` preservado, append marker `--- RESUMED de paused em {ts} ---` em history. Continua loop.
- Estado ativo:
  - `status == running` -> retoma do iter atual (caso de crash de sessao no meio do loop)

### Passo 3: Loop principal

```
loop:
  iter++

  # --- Step A: dispatch doer ---
  Agent(
    subagent_type=$DOER,
    description="Loop iter {iter} doer phase {N}",
    prompt="phase={N}, mode=ralph_loop, iter={iter}"
  )

  # Doer detecta ralph mode pela presenca de LOOP.md + REVIEW.md (Passo 1 do specialist).
  # Se REVIEW.md veredicto=BLOCKED, foca em corrigir blockers.

  # --- Step B: dispatch reviewer ---
  Agent(
    subagent_type=$REVIEWER,
    description="Loop iter {iter} reviewer phase {N}",
    prompt="phase={N}, mode=verify, iter={iter}"
  )

  # --- Step C: parse veredicto ---
  REVIEW_FILE=".jdi/phases/{NN-slug}/REVIEW.md"
  test -f "$REVIEW_FILE" || { echo "REVIEW.md nao criado em iter {iter}"; exit 1; }

  VERDICT=$(grep -oE 'Veredicto:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' "$REVIEW_FILE" | awk '{print $2}')

  # --- Step D: hash dos findings (oscillation detection) ---
  FINDING_BODY=$(awk '
    /^## Blockers/ { flag=1; next }
    /^## Warnings/ { flag=1; next }
    /^## / { flag=0 }
    flag { print }
  ' "$REVIEW_FILE")

  FINDING_HASH=$(echo "$FINDING_BODY" | sed 's/[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T[^ ]*//g' | tr '[:upper:]' '[:lower:]' | grep -v '^[[:space:]]*$' | sort -u | sha256sum | cut -c1-12)
  [ -z "$FINDING_HASH" ] && FINDING_HASH=$(echo -n "" | sha256sum | cut -c1-12)

  # --- Step E: append history em LOOP.md ---
  # Append linha em ## History do LOOP.md:
  #   - iter {N}: {VERDICT}, hash={HASH}, commit={SHA}, ts={ISO}

  COMMIT_SHA=$(git rev-parse --short HEAD)
  cat >> "$LOOP_FILE" <<EOF
- iter $iter: $VERDICT, hash=$FINDING_HASH, commit=$COMMIT_SHA, ts=$(date -Iseconds)
EOF

  # Atualiza frontmatter (iter, status)
  # ... sed/awk substitui linha "iter:" no frontmatter

  # --- Step F: convergence check ---
  if [ "$VERDICT" = "APPROVED" ] || [ "$VERDICT" = "APPROVED_WITH_WARNINGS" ]; then
    # converged
    Atualiza LOOP.md frontmatter -> status: converged
    Atualiza STATE.md -> phase_status: verified, phase_verdict: $VERDICT, next_step: /jdi-ship {N}
    git add .jdi/phases/{NN-slug}/LOOP.md .jdi/STATE.md
    git commit -m "chore({phase-slug}): loop converged at iter $iter ($VERDICT)"
    echo "Phase {N} convergiu em iter $iter. Veredicto: $VERDICT"
    echo "Proximo: /jdi-ship {N}"
    exit 0
  fi

  # --- Step G: oscillation detection (early-escalate) ---
  # Compara FINDING_HASH com hash do iter anterior
  # Guard: precisa ter >=2 iter lines em LOOP.md history pra comparar
  ITER_COUNT=$(grep -cE '^- iter [0-9]+:' "$LOOP_FILE")
  if [ "$ITER_COUNT" -ge 2 ]; then
    PREV_HASH=$(grep -E '^- iter [0-9]+:' "$LOOP_FILE" | tail -2 | head -1 | grep -oE 'hash=[a-f0-9]+' | cut -d= -f2)
  else
    PREV_HASH=""
  fi

  if [ -n "$PREV_HASH" ] && [ "$FINDING_HASH" = "$PREV_HASH" ]; then
    AskUserQuestion(
      question="Oscilacao detectada na phase {N}. Iter $iter e $((iter-1)) tem MESMO finding hash ($FINDING_HASH). Loop nao esta progredindo. O que fazer?",
      options=[
        "Continuar (reset counter, mais 5 iter)" => continue_with_reset,
        "Abortar loop (status=escalated, fica em REVIEW.md)" => abort,
        "Ajustar plano (status=paused, vc edita PLAN.md/CONTEXT.md, re-roda /jdi-loop {N})" => pause
      ]
    )

    case answer:
      continue_with_reset: goto reset_logic
      abort: goto abort_logic
      pause: goto pause_logic
  fi

  # --- Step H: cap check ---
  if [ "$iter" -ge "${MAX_ITER:-5}" ]; then
    AskUserQuestion(
      question="Phase {N}: $iter iter sem APPROVED. Custo cresce. O que fazer?",
      options=[
        "Continuar (reset counter, mais ${MAX_ITER:-5} iter)" => continue_with_reset,
        "Abortar (status=escalated)" => abort,
        "Ajustar plano (status=paused)" => pause
      ]
    )

    case answer:
      continue_with_reset: goto reset_logic
      abort: goto abort_logic
      pause: goto pause_logic
  fi

  # senao, proxima iter
  continue
```

### Passo 4: Reset logic

```
reset_logic:
  total_resets++

  if [ "$total_resets" -ge "${MAX_RESETS:-3}" ]; then
    # Kill switch absoluto
    Atualiza LOOP.md -> status: killed
    Atualiza STATE.md -> phase_status: blocked, phase_verdict: BLOCKED, next_step: revisao humana de PLAN.md/CONTEXT.md (loop killed)
    git add .jdi/phases/{NN-slug}/LOOP.md .jdi/STATE.md
    git commit -m "chore({phase-slug}): loop killed (3 resets, $((iter * total_resets)) iter total)"
    echo "Hard cap atingido (${MAX_RESETS:-3} resets). Loop killed."
    echo "Acao: revisar PLAN.md ou CONTEXT.md manualmente. Talvez fragmentar phase."
    exit 1
  fi

  # Reset counter, history append-only
  iter=0
  Atualiza LOOP.md frontmatter -> iter: 0, total_resets: $total_resets
  Append em LOOP.md history: "--- RESET $total_resets em $(date -Iseconds) ---"
  echo "Reset $total_resets/${MAX_RESETS:-3}. Novo round de ${MAX_ITER:-5} iter."
  goto loop
```

### Passo 5: Abort logic

```
abort_logic:
  Atualiza LOOP.md -> status: escalated
  Atualiza STATE.md -> phase_status: blocked, phase_verdict: BLOCKED, next_step: revisar REVIEW.md, corrigir manual ou /jdi-loop {N} pra retomar
  git add .jdi/phases/{NN-slug}/LOOP.md .jdi/STATE.md
  git commit -m "chore({phase-slug}): loop aborted at iter $iter (user escalated)"
  echo "Loop abortado. REVIEW.md tem ultimos findings."
  echo "Re-rode /jdi-loop {N} pra retomar (status volta a running automaticamente)."
  exit 0
```

### Passo 6: Pause logic

```
pause_logic:
  Atualiza LOOP.md -> status: paused
  Atualiza STATE.md -> phase_status: paused, next_step: editar PLAN.md/CONTEXT.md e re-rodar /jdi-loop {N}
  echo "Loop pausado. Edite PLAN.md ou CONTEXT.md."
  echo "Quando pronto: /jdi-loop {N}. Vai retomar com status=running, iter=0, mesmo total_resets."
  exit 0
```

### Passo 7: Confirmacao final (convergencia)

```
Phase {N}: convergiu em $iter iter (resets: $total_resets). Veredicto: $VERDICT.
LOOP.md + REVIEW.md em .jdi/phases/{NN-slug}/
Proximo: /jdi-ship {N}
```

</process>

<gates>
- pre: PLAN.md + doer + reviewer registrados em specialists.md/reviewers.md
- post: status final em LOOP.md ∈ {converged, escalated, paused, killed} + STATE atualizado
- invariante: cada iter = doer commit + reviewer commit (audit trail granular)
</gates>

<errors>
- Doer/reviewer ausente -> /jdi-bootstrap
- PLAN ausente -> /jdi-plan
- LOOP.md corrompido (frontmatter invalido) -> backup pra LOOP.md.bak, recria do zero
- REVIEW.md nao criado pelo reviewer -> exit 1 com erro
- Sem changes no working dir apos doer iter (doer nao fez nada) -> warn, mas continua (reviewer pode ainda achar issues anteriores nao corrigidas)
</errors>

<runtime_notes>

**Claude Code:**
- AskUserQuestion nativo pro human gate
- Agent dispatch sequencial dentro do loop (nao paraleliza doer+reviewer — sao sequenciais por design)

**Copilot:**
- Sem AskUserQuestion nativo — usa pergunta no chat principal e aguarda resposta antes de prosseguir
- Loop control inline no command body (orchestrator = thread principal do Copilot)

**OpenCode:**
- subtask: true pra subagent dispatch
- Pergunta human gate via prompt principal

**Antigravity:**
- Skill descobre por trigger ("ralph loop phase 2", "auto review phase 2")
- AskUserQuestion via prosa do skill (pergunta + aguarda resposta texto)
- Loop control inline no skill body
</runtime_notes>

<rules>
- NUNCA pula human gate quando iter >= max_iter ou oscillation detectada — custo controlado eh invariante
- NUNCA reseta total_resets — so iter
- LOOP.md history eh APPEND-ONLY (audit trail, nunca apaga)
- Reviewer permanece read-only sempre — doer eh unico writer
- Cada iter gera commits atomicos (granularidade preservada)
- Hard cap absoluto = max_iter * max_resets (default 15) — kill switch nao negociavel
</rules>

<references>
- Ralph Wiggum technique (ghuntley.com/ralph)
- ASDLC Ralph Loop pattern (asdlc.io/patterns/ralph-loop)
- Convergencia: P(C) = 1 - (1 - p_success)^n
</references>
