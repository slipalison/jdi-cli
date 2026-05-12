# JDI — Commands

11 comandos. 7 no loop principal + roadmap mutation (2) + ralph mode (1) + migration (1) + meta (1).

Todo comando que toma uma phase aceita **slug** (`auth-flow`, canonical) OU **posição inteira** (`2`, display). Slug é estável entre branches; posição renumera no insert/remove. Schema v2 usa slug-as-ID; projetos legacy v1 (numeric) continuam funcionando até rodar `/jdi-migrate-phases`.

## Loop principal

### `/jdi-new "<descricao>"`

**Entry point.** Cria projeto JDI do zero.

```
/jdi-new "TODO app .NET 10 + React 19"
```

Faz:
1. Validacao: `.jdi/` nao existe (ou `--reset`)
2. Spawn `jdi-researcher`:
   - 4 perguntas chave (visao, stack, code-design, MVP features)
   - Research focado opcional via ctx7 (max 2 lookups)
   - Gera `PROJECT.md` (visao + stack + code-design LOCKED)
   - Gera `ROADMAP.md` (1 phase por feature do MVP)
   - Gera `STATE.md` + `DECISIONS.md` (D-1: code design)
   - Cria `.gitattributes` (normaliza CRLF)
3. Commit inicial: `chore(jdi): initialize <project_name>`

**Proximo:** `/jdi-bootstrap`

### `/jdi-bootstrap`

Cria specialists per-project (doer + reviewer).

Faz:
1. Le `.jdi/PROJECT.md`
2. Spawn `jdi-architect` em modo `specialist`:
   - 6 perguntas focadas (test framework, build/test commands, coverage min, lint, conventions)
   - Gera `.jdi/agents/jdi-doer-{slug}.md` (de `core/templates/doer-specialist.md`)
   - Gera `.jdi/agents/jdi-reviewer-{slug}.md` (de `core/templates/reviewer-specialist.md`)
   - Atualiza `.jdi/specialists.md` + `.jdi/reviewers.md` + `.jdi/registry.md`
3. Commit: `chore(jdi): bootstrap specialists for <project_name>`
4. Atualiza STATE.md: `specialists_ready: true`

**Proximo:** `/jdi-discuss 1`

### `/jdi-discuss <slug|position> [--auto]`

Captura decisoes locked da phase.

```
/jdi-discuss auth-flow
/jdi-discuss 2                       # também aceita posição (legacy/conveniência)
/jdi-discuss auth-flow --auto        # asker decide tudo, sem perguntar
```

Faz:
1. Validacao: phase existe em ROADMAP.md
2. Spawn `jdi-asker`:
   - Identifica 3-5 gray areas especificas da phase
   - Pergunta uma por vez (max 5 D-XX por sessao)
   - Captura cada resposta como D-XX em DECISIONS.md
   - Scope creep -> `.jdi/todos.md`
   - Escreve `.jdi/phases/{phase_dir}/CONTEXT.md`
3. Commit: `docs({phase_dir}): capture phase context`

**Proximo:** `/jdi-plan <slug>`

### `/jdi-plan <slug|position> [--review]`

Decompoe phase em tasks executaveis.

```
/jdi-plan 2
/jdi-plan 2 --review     # mostra preview, pede approve
```

Faz:
1. Validacao: CONTEXT.md existe
2. Spawn `jdi-planner`:
   - Le PROJECT.md + ROADMAP.md + DECISIONS.md + CONTEXT.md
   - Decompoe em tasks (max 8) com `files_modified` + `acceptance` + `dependencies` + `test`
   - Agrupa em waves (paralelo dentro, sequencial entre)
   - Self-check (toda task tem files_modified? wave grouping respeita deps?)
   - Escreve `.jdi/phases/{phase_dir}/PLAN.md`
3. Commit: `docs({phase_dir}): generate plan ({M} tasks, {W} waves)`

**Proximo:** `/jdi-do <slug>`

### `/jdi-do <slug|position> [--sequential]`

Executa tasks da phase via doer specialist do projeto.

```
/jdi-do 2
/jdi-do 2 --sequential   # forca sequencial, mesmo se waves permitem paralelo
```

Faz:
1. Validacao: PLAN.md existe + doer registrado em `.jdi/specialists.md`
2. Resolve doer specialist (`jdi-doer-{slug}`)
3. Le PLAN.md, identifica tasks pendentes, agrupa waves
4. Pra cada wave:
   - Intra-wave overlap check (files_modified disjoint?)
   - Se paralelo: sequential dispatch (1 Agent por message com `run_in_background:true`)
   - Se sequencial: 1 doer por task em sequencia
5. Doer atualiza status no PLAN.md, commita atomico, escreve SUMMARY.md final
6. Commit final do orchestrator: `chore(state): phase <slug> executed`

**Proximo:** `/jdi-verify <slug>`

### `/jdi-verify <slug|position>`

Roda gates de qualidade via reviewer specialist.

Faz:
1. Validacao: SUMMARY.md existe + reviewer registrado em `.jdi/reviewers.md`
2. Resolve reviewer specialist (`jdi-reviewer-{slug}`)
3. Spawn reviewer:
   - Gate 1: Build
   - Gate 2: Tests
   - Gate 3: Coverage (>= threshold)
   - Gate 4: Lint/Format
   - Gate 5: Security/Perf rules da stack
   - Gate 6: Plan consistency (commits batem com files_modified)
4. Reviewer escreve `.jdi/phases/{phase_dir}/REVIEW.md` com veredicto:
   - APPROVED — todos gates PASS
   - APPROVED_WITH_WARNINGS — sem blockers, alguns warns
   - BLOCKED — gate 1-3 falhou OU gate 5 critical
5. Commit: `docs({phase_dir}): verify phase ({VERDICT})`

**Proximo:** `/jdi-ship <slug>` (se nao BLOCKED) — ou `/jdi-loop <slug>` se quiser auto-fix loop

### `/jdi-loop <slug|position> [--max-iter=5] [--max-resets=3]`

**Ralph loop mode.** Roda `/jdi-do` -> `/jdi-verify` em ciclo automatico ate veredicto APPROVED. Sem acao humana entre iter. Cap absoluto: 5 iter por round x 3 resets = 15 iter.

```
/jdi-loop 2
/jdi-loop 2 --max-iter=3 --max-resets=2    # cap mais conservador
```

Faz:
1. Validacao: PLAN.md + doer + reviewer registrados
2. Inicializa `.jdi/phases/{phase_dir}/LOOP.md` (ou retoma se existe)
3. Loop:
   - Spawn doer (com last REVIEW.md findings + LOOP history como contexto)
   - Spawn reviewer (read-only, escreve REVIEW.md)
   - Hash dos blockers/warnings -> append em LOOP.md history
   - Se veredicto APPROVED ou APPROVED_WITH_WARNINGS -> converged, exit
   - Se finding hash igual ao iter anterior -> oscillation detected, AskUserQuestion
   - Se iter >= max_iter -> AskUserQuestion (continuar/abortar/ajustar)
4. Human gate options:
   - `Continuar` -> reset counter, novo round (total_resets++)
   - `Abortar` -> status=escalated, exit limpo
   - `Ajustar plano` -> status=paused, exit, user edita PLAN/CONTEXT, re-roda /jdi-loop
5. Hard cap: total_resets >= max_resets -> status=killed, kill switch absoluto
6. Cada iter = doer commit atomico + reviewer commit (audit trail granular em git)

**Generator/Judge separation:** doer escreve, reviewer le (read-only). Invariante Ralph.

**Quando usar:**
- Phase com tests automaticos confiaveis
- Tasks mecanicas (refactor, test coverage, batch fixes)
- Quer "fire and forget" com cap controlado

**Quando NAO usar:**
- Tasks que precisam decisao arquitetural humana
- Phase com gates subjetivos
- Specs vagas (vai oscilar)

**Proximo:** `/jdi-ship <slug>` (se converged) ou revisao humana (se killed/escalated/paused)

### `/jdi-ship <slug|position>`

Finaliza phase, avanca pra proxima.

Faz:
1. Validacao: REVIEW.md existe + veredicto != BLOCKED
2. Se WITH_WARNINGS: pergunta "ship mesmo assim?"
3. Atualiza ROADMAP.md (phase corrente: status `done`, próxima phase: status `ready`)
4. Atualiza STATE.md (`current_phase` + `current_phase_slug` apontam pra próxima)
5. Commit: `feat(<slug>): ship phase ({VERDICT})`
6. Tag opcional: `phase-<slug>` (se PROJECT.md tem `tag_phases: true`)

**Proximo:** `/jdi-discuss <next-slug>` (ou done)

## Roadmap mutation

### `/jdi-add-phase "<name>" [--goal "<text>"] [--slug <slug>] [--before <slug>|--after <slug>] [--reason "<text>"]`

Registra nova phase em ROADMAP.md. **Slug-as-ID** — validação rígida + uniqueness antes de qualquer write. Multi-developer safe.

```
/jdi-add-phase "User authentication" --goal "Login + signup + JWT"
/jdi-add-phase "Payments" --slug payments --after auth-flow
/jdi-add-phase "Hotfix" --before payments
```

Faz:
1. Validação: `.jdi/STATE.md` + `.jdi/ROADMAP.md` existem
2. Detecta `schema_version` (em v1 avisa pra rodar `/jdi-migrate-phases`)
3. Deriva slug do `name` (ou usa `--slug` se passado)
4. Valida slug via `bin/lib/jdi-validate-slug.sh --check-unique`:
   - Shape: `[a-z][a-z0-9-]{2,39}`, sem `--`, sem trailing `-`
   - Reserved words: `current`, `all`, `archive`, `removed`, `history`, `latest`, `pending`, `ready`, `done`, `blocked`, `partial`
   - Uniqueness vs `.jdi/phases/` + ROADMAP entries
5. Resolve posição de insert (`--before`/`--after`/append). Recusa `<= current_phase`.
6. Escreve em ROADMAP.md (header + Slug + Status + Goal)
7. Recomputa `total_phases`
8. Regenera `.jdi/phases.json` (v2)
9. Commit: `chore(jdi): add phase <slug>`

Legacy `--at <pos>` (integer) aceito **apenas em v1**; rejeitado em v2 com hint para usar `--before`/`--after` (posições mudam entre branches, slugs não).

**Proximo:** `/jdi-discuss <slug>` (quando pronto pra iniciar)

### `/jdi-remove-phase <slug|position> [--force]`

Remove phase pendente/future de ROADMAP.md. Recusa em current/past/done.

```
/jdi-remove-phase auth-flow
/jdi-remove-phase 4 --force        # com artifacts -> arquiva, não deleta
```

Faz:
1. Resolve phase via `bin/lib/jdi-resolve-phase.sh`
2. Hard refuses:
   - `position < current_phase` → past = history
   - `position == current_phase` → ship/abandona primeiro
   - `status == done` → shipped = history
3. Se artifacts existem: requer `--force` (ou aborta com hint)
4. AskUserQuestion confirma (sempre, mesmo com --force)
5. Move folder pra `.jdi/archive/removed-<slug>/` (preserve history)
6. Remove block do ROADMAP, renumera display headings, recomputa `total_phases`
7. Append em DECISIONS.md (audit trail)
8. Commit: `chore(jdi): remove phase <slug>`

Slugs das phases remanescentes **nunca mudam**.

## Continuity

### `/jdi-status`

Read-only snapshot. Sem agent invoke. Safe anytime.

Imprime:
- Project + schema_version
- Current phase (slug + posição + nome)
- Phase status + verdict
- Último artefato (REVIEW/SUMMARY/PLAN/CONTEXT)
- Último commit + commits hoje
- Next step (exato comando a rodar)

Útil para retomar sessão após break.

## Migration

### `/jdi-migrate-phases [--dry-run] [--force]`

Upgrade non-destructive de v1 (numeric IDs) → v2 (slug-as-ID). Idempotente.

```
/jdi-migrate-phases --dry-run    # mostra plano, escreve nada
/jdi-migrate-phases              # confirma + escreve
```

Faz:
1. Validação: `.jdi/STATE.md` + `.jdi/ROADMAP.md` existem; working tree limpo (ou `--force`)
2. Detecta `schema_version` — se já v2, exit 0 (no-op)
3. **Audit (sempre, mesmo com --force)** antes de qualquer write:
   - **C1** — Folder/ROADMAP parity (folder slug == ROADMAP slug)
   - **C2** — No duplicate canonical slugs (`01-foo/` E `foo/` = corrupt)
   - **C3** — All existing slugs pass shape validation
   - **C4** — Orphan folders sem ROADMAP entry → warn (não bloqueia)
4. Mostra plano (sempre — dry-run ou não):
   - Schema 1 → 2
   - N phases, M folders preservados
   - Manifesto `.jdi/phases.json` (novo)
5. AskUserQuestion confirma (skip se --dry-run)
6. Escreve `.jdi/phases.json` (mapping position ↔ slug, flag `legacy: true` em folders v1)
7. Atualiza STATE.md (`schema_version: 2` + `current_phase_slug: <resolved>`)
8. Commit: `chore(jdi): migrate to schema v2 (slug-as-ID)`

**Invariante:** folders existentes nunca são renomeados. Git history references preservadas.

## Comando meta

### `/jdi-create [descricao]`

Cria novo agent ou skill GENERICO no `core/`. So roda dentro do repo JDI fonte.

```
/jdi-create "specialist pra Rust com cargo + clippy"
/jdi-create "skill com convencoes EF Core 9"
/jdi-create
```

Faz:
1. Validacao: esta no repo JDI (`core/` existe)
2. Spawn `jdi-architect` modo `create`:
   - 8 perguntas (problema, trigger, input, output, reuso, decision-loop, custo, tools)
   - Classificacao automatica (agent / skill / composite)
   - Validacao com user (approve / edit / cancel)
   - Geracao de files em `core/agents/` ou `core/skills/`
   - Update de routing
3. Build + install pro runtime ativo
4. Commit + audit em `.jdi/registry.md`

**NAO usado em projetos consumindo JDI.** So pra contributors estendendo o core.

## Resumo visual

```
/jdi-new                  --> .jdi/{PROJECT,ROADMAP,STATE,DECISIONS}.md + .gitattributes (schema v2)
/jdi-bootstrap            --> .jdi/agents/{jdi-doer-{slug},jdi-reviewer-{slug}}.md + routing
/jdi-discuss <slug>       --> .jdi/phases/<slug>/CONTEXT.md
/jdi-plan    <slug>       --> .jdi/phases/<slug>/PLAN.md
/jdi-do      <slug>       --> commits atomicos + .jdi/phases/<slug>/SUMMARY.md
/jdi-verify  <slug>       --> .jdi/phases/<slug>/REVIEW.md
/jdi-loop    <slug>       --> ralph mode: do<->verify auto + .jdi/phases/<slug>/LOOP.md
/jdi-ship    <slug>       --> ROADMAP advance + tag (opcional)

/jdi-add-phase "<name>"   --> registra nova phase (slug-as-ID, multi-dev safe)
/jdi-remove-phase <slug>  --> remove future/pending phase + arquiva artifacts
/jdi-status               --> snapshot read-only (sem agent)
/jdi-migrate-phases       --> v1 → v2 non-destructive upgrade

/jdi-create               --> [internal] core/agents/* ou core/skills/* (so no repo JDI)
```

Em v2 (default novo), folders são `.jdi/phases/<slug>/`. Em v1 legacy preservado, folders ficam `.jdi/phases/NN-<slug>/` — resolver detecta ambos.

## Flags globais

- `--auto` (em `/jdi-discuss`): asker decide tudo, sem pergunta
- `--review` (em `/jdi-plan`): mostra preview do PLAN, pede approve
- `--sequential` (em `/jdi-do`): forca execucao sequencial mesmo se waves permitem paralelo
- `--max-iter=N` (em `/jdi-loop`): max iter por round antes de human gate (default 5)
- `--max-resets=N` (em `/jdi-loop`): max rounds de reset antes do kill switch (default 3)
- `--reset` (em `/jdi-new`): apaga `.jdi/` antes de iniciar (CUIDADO)
- `--slug <slug>` (em `/jdi-add-phase`): override do slug derivado do name
- `--before <slug>` / `--after <slug>` (em `/jdi-add-phase`): insert posicional sem race condition entre branches (substitui `--at <int>` em v2)
- `--reason "<text>"` (em `/jdi-add-phase`): audit em DECISIONS.md
- `--force` (em `/jdi-remove-phase`): permite remoção com artifacts (arquiva)
- `--dry-run` (em `/jdi-migrate-phases`): mostra plano, escreve nada
- `--force` (em `/jdi-migrate-phases`): bypass clean-tree gate (audit C1-C3 sempre roda)

## Idempotencia

Todos os comandos sao idempotentes pra rerun:
- `/jdi-discuss` ja com CONTEXT.md -> pergunta overwrite/skip
- `/jdi-plan` ja com PLAN.md -> regera (warn)
- `/jdi-do` ja com tasks completed -> pula
- `/jdi-verify` ja com REVIEW.md -> regera
- `/jdi-loop` ja com LOOP.md status=converged -> aborta (rode /jdi-ship); status=running -> retoma; status=killed -> aborta (revisao humana); status=escalated/paused -> retoma com novo round
- `/jdi-ship` ja shipped -> warn
