# Definition of Done — Schema

Canonical specification for DoD blocks in `PROJECT.md` and `CONTEXT.md`. Used by:

- `jdi-researcher` (Stage 2 of `/jdi-new`) → writes `PROJECT.md § Definition of Done` (LOCKED with PROJECT)
- `jdi-asker` (Stage 2 of `/jdi-discuss`) → writes `CONTEXT.md § Definition of Done` (LOCKED with CONTEXT)
- `jdi-reviewer-{slug}` (Gate 7 of `/jdi-verify`) → reads both blocks, runs verification, writes `REVIEW.md § DoD Checklist`
- `/jdi-ship` → blocks if any DoD item not satisfied (auto or manually confirmed)

## Block format (canonical)

```markdown
## Definition of Done

### Auto-verifiable
- [ ] {criterion text}
      **Verify:** {executable check}
      **Source:** {PROJECT | CONTEXT}

### Manual
- [ ] {criterion text}
      **Verify:** human confirmation required
      **Evidence:** {expected artifact}
      **Source:** {PROJECT | CONTEXT}
```

Each item is one bullet with REQUIRED sub-fields.

### Field contract

| Field | Required | Format | Notes |
|---|---|---|---|
| Criterion text | yes | imperative or assertive sentence | What must be true |
| `Verify:` | yes | shell command OR grep pattern OR file assertion OR `human confirmation required` | Mechanical check or explicit manual marker |
| `Evidence:` | only if Manual | path / URL / sha / artifact description | What confirms it for human review |
| `Source:` | yes | `PROJECT` or `CONTEXT` | Inheritance audit trail |

Items without `Verify:` are INVALID and must be rejected at capture time.

## Classification rules (auto vs manual)

When the asker/researcher receives or proposes an item, classify automatically using these signals:

| Signal in criterion text | Classify as |
|---|---|
| Contains shell command: `npm test`, `npm run lint`, `pytest`, `dotnet test`, `cargo test`, etc | Auto-verifiable |
| Contains file path + verifiable action: `X.md modified`, `Y.json contains`, `Z file exists` | Auto-verifiable |
| Contains coverage threshold: `coverage >= N%`, `≥ N%` | Auto-verifiable |
| Contains grep-able pattern: `no TODO without issue`, `no console.log`, `no secrets` | Auto-verifiable |
| Mentions endpoint + status + DB state: `POST /x returns 201 and inserts row` | Auto-verifiable (integration test referenced) |
| Mentions user action, staging, browser flow, peer review, UX, documentation review | Manual |
| Mentions rollback plan, runbook, smoke in staging | Manual |
| Mentions architecture diagram, design doc, ADR | Manual |
| Ambiguous after analysis | Ask user: `auto-verifiable or manual?` |

## Vague-rejection rules (asker/researcher MUST enforce)

Reject any candidate or user-supplied item that matches any of these patterns:

| Pattern (forbidden) | Reason | Suggested rewrite |
|---|---|---|
| `código limpo` / `clean code` | No measurable criterion | `lint passes with zero errors` (Auto) |
| `performance OK` / `boa performance` | No threshold | `response p95 < 200ms in load test` (Auto) |
| `bem documentado` / `well documented` | No artifact | `docs/{area}.md updated and reviewed` (Manual) |
| `qualidade alta` / `high quality` | Subjective | Split into concrete items (lint, coverage, review) |
| `testes ok` / `tests work` | No spec | `npm test exits 0` + `coverage >= 80%` (Auto) |
| Item without `Verify:` | Missing contract | Force user to declare verification |

When rejecting, asker/researcher offers the user three options:

```
Item "{vague text}" is not verifiable. How to proceed?
  • Reformulate — you write a measurable version
  • Drop — remove this item
  • Convert to D-XX — make it a locked decision instead (DECISIONS.md)
```

## Candidate generation (Stage 2 entry)

When entering Stage 2 (DoD loop), the asker/researcher proposes exactly **5 candidates** as starting point. Candidates come from 3 sources, in priority order:

### Priority 1 — Baseline inheritance (PROJECT § DoD)

`jdi-asker` ONLY. Filter `PROJECT.md § DoD` items whose `Source: PROJECT` block applies to the current phase. Strategy:

- ALL items from PROJECT are inherited by default (no filter) — they are project-wide invariants
- They are NOT re-proposed as candidates (already locked at project level)
- Reviewer applies them automatically in Gate 7

`jdi-researcher` skips this priority (PROJECT § DoD is being created).

### Priority 2 — Derived from D-XX (this phase)

`jdi-asker` ONLY. For each `D-XX` locked in current phase:

- Stack decision (`D-N: stack = X`) → propose `npm test exits 0` (Auto) and `X-specific lint passes` (Auto) if not already in baseline
- Endpoint decision (`D-N: POST /api/x returns 201`) → propose `Integration test in tests/{slug}.spec.ts covers POST /api/x → 201` (Auto)
- External service (`D-N: uses SendGrid`) → propose `SendGrid integration mockable in test mode` (Auto)
- Schema/migration (`D-N: adds table users`) → propose `Migration runs and is reverse-tested in dev` (Manual)

### Priority 3 — Phase-type templates

Phase-type inferred from ROADMAP goal verb:

| Phase-type | Default candidates (max 5 total) |
|---|---|
| `feature` (new functionality) | smoke test E2E covers happy path (Manual); CHANGELOG entry added (Auto); new public API documented (Manual) |
| `refactor` | no regression in existing test suite (Auto); no public API contract change OR documented in CHANGELOG (Manual); coverage not reduced (Auto) |
| `infra` (CI/CD/tooling) | rollback plan documented (Manual); pipeline green on main (Auto); runbook updated (Manual) |
| `docs` | links valid (`linkchecker`, Auto); reviewed by author + 1 (Manual); rendered correctly in target platform (Manual) |
| `bugfix` | regression test added that fails on old code (Auto); root cause documented in commit (Manual); no recurrence in 1 sprint (Manual — deferred) |
| `unknown` | npm test exits 0 (Auto); CHANGELOG entry added (Auto); peer review approved (Manual) |

For `/jdi-new` (researcher), phase-type is irrelevant — propose universal project baselines:

```
1. `{test_command} exits 0` (Auto, Source: PROJECT)
2. `Coverage >= 80%` (Auto, Source: PROJECT) — value from PROJECT.md global_constraints
3. `No TODO/FIXME without linked issue` (Auto, grep pattern)
4. `CHANGELOG.md updated with entry per release` (Manual)
5. `README accurately describes current behavior` (Manual)
```

User adjusts via the loop (keep/edit/drop/replace).

## Loop protocol (Stage 2)

Both asker and researcher follow this exact protocol after Stage 1 completes:

```
1. Build candidate list (5 items, from sources above)
2. For each candidate in order:
   a. Run `AskUserQuestion`:
      question: "DoD {N}/5: '{text}' | Verify: {check}"
      options:
        - "keep — accept as-is"
        - "edit — modify text or verify criterion"
        - "drop — exclude from DoD"
        - "replace — replace with a new criterion"
   b. Apply choice:
      - keep   → append to DoD output
      - edit   → sub-prompt for new text + new verify, re-validate vague, classify, append
      - drop   → discard
      - replace → sub-prompt for new full criterion, re-validate vague, classify, append
3. Free addition loop:
   a. Run `AskUserQuestion`:
      question: "DoD has {N} items. Add more? Or done?"
      options:
        - "add — add a new item"
        - "done — close DoD and write the file"
   b. If add:
      sub-prompt: free input → classify (auto/manual) → validate vague → append → loop
      Hard cap: 10 total items. If reached, force done with warning: "DoD cap reached. Split phase if more needed."
   c. If done: write block to file
4. Write `## Definition of Done` section into the target file (PROJECT.md or CONTEXT.md).
```

When sub-prompt for `edit`/`replace`/`add` produces a vague item:

```
Show rejection box (see "Vague-rejection rules" above)
Options: Reformulate | Drop | Convert to D-XX
On Reformulate: re-run sub-prompt with hint "make it measurable"
On Drop: discard this addition, continue loop
On Convert to D-XX: write to DECISIONS.md as new D-{date}-{slug}-{seq} (asker only — researcher has no D-XX context yet)
```

## Output examples

### PROJECT.md example block

```markdown
## Definition of Done

### Auto-verifiable
- [ ] `npm test` exits 0
      **Verify:** `npm test && echo OK`
      **Source:** PROJECT
- [ ] Coverage >= 80% of lines
      **Verify:** parse `coverage/lcov.info`, line percentage >= 80
      **Source:** PROJECT
- [ ] No `TODO` without linked issue reference
      **Verify:** `! grep -RInE 'TODO(?!.*#[0-9]+)' src/`
      **Source:** PROJECT

### Manual
- [ ] CHANGELOG.md updated with entry per release
      **Verify:** human confirmation required
      **Evidence:** new `## [version]` heading in CHANGELOG.md for current release
      **Source:** PROJECT
- [ ] README reflects current behavior
      **Verify:** human confirmation required
      **Evidence:** README diff reviewed in PR
      **Source:** PROJECT
```

### CONTEXT.md example block (phase `signup-flow`)

```markdown
## Definition of Done

### Auto-verifiable
- [ ] Integration test covers POST /api/users → 201
      **Verify:** `npm test -- tests/users.spec.ts`
      **Source:** CONTEXT
- [ ] CHANGELOG entry for 0.3.0 includes signup endpoint
      **Verify:** `grep -E '0\.3\.0.*signup' CHANGELOG.md`
      **Source:** CONTEXT

### Manual
- [ ] Email confirmation flow validated in staging
      **Verify:** human confirmation required
      **Evidence:** staging URL + signup attempt screenshot
      **Source:** CONTEXT
- [ ] Docs at docs/auth.md updated with new endpoint
      **Verify:** human confirmation required
      **Evidence:** docs/auth.md diff in PR
      **Source:** CONTEXT
```

## Reviewer consumption (Gate 7)

`jdi-reviewer-{slug}` reads both blocks and produces this section in `REVIEW.md`:

```markdown
## DoD Checklist

| # | Criterion | Source | Type | Status | Evidence |
|---|---|---|---|---|---|
| 1 | `npm test` exits 0 | PROJECT | Auto | PASS | exit 0 |
| 2 | Coverage >= 80% | PROJECT | Auto | PASS | 84.2% |
| 3 | No `TODO` without issue | PROJECT | Auto | FAIL | `src/auth.ts:42` |
| 4 | CHANGELOG updated | PROJECT | Manual | MANUAL_REQUIRED | — |
| 5 | Integration test POST /users | CONTEXT | Auto | PASS | tests/users.spec.ts |
| 6 | Email flow validated | CONTEXT | Manual | MANUAL_REQUIRED | — |

DoD totals: 6 items | Auto: 4 (3 PASS, 1 FAIL) | Manual: 2 (pending)
```

### Verdict mapping

| State | Verdict |
|---|---|
| All Auto PASS + Manual all confirmed | `APPROVED` |
| All Auto PASS + Manual pending | `APPROVED_PENDING_MANUAL` |
| Any Auto FAIL | `BLOCKED` |
| Existing technical gates (1-6) fail | `BLOCKED` (overrides DoD result) |

`APPROVED_PENDING_MANUAL` is a new verdict introduced by this DoD layer. `/jdi-ship` rejects it until manual items are explicitly confirmed via `/jdi-confirm-dod {slug}`.

## Hard rules

1. Every DoD item MUST have `Verify:` — no exceptions.
2. Vague items are rejected at capture — never make it to file.
3. Cap: 10 DoD items per phase CONTEXT (split phase if exceeded).
4. Cap: 8 DoD items in PROJECT (project-wide invariants only).
5. PROJECT § DoD is LOCKED after `/jdi-new` — change via `D-XX` decision + manual edit (asker/researcher do not re-touch it).
6. CONTEXT § DoD is LOCKED after `/jdi-discuss` — change via `D-XX` decision in same phase.
7. Reviewer NEVER modifies DoD blocks — read-only by design.
