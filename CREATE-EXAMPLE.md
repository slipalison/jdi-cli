# JDI — `/jdi-create` Walkthrough

Concrete examples of the `/jdi-create` flow (architect create mode — generic agents/skills in core).

For the per-project flow (`/jdi-bootstrap`, specialist mode), see [EXTENSION.md](EXTENSION.md).

## Case 1 — Pure agent: Rust specialist

You contribute to the JDI source and want to add support for Rust projects (real demand among users).

### Invocation

```
$ cd /path/to/jdi-source
$ /jdi-create "specialist for Rust with cargo + clippy + rustfmt"
```

### Q&A

**Architect:** Q1 — In 1 sentence, what problem does this new agent solve?

**User:** Rust executor that knows cargo build/test/clippy/fmt without rediscovering it per project.

**Q2 — When does it run?**
- [x] Another agent invokes it (jdi-do via routing)

**Q3 — What does it need to run?**
- [x] Project files (`src/**/*.rs`, `Cargo.toml`)
- [x] Output of another agent (PLAN.md)

**Q4 — What does it produce?**
- [x] Modified code
- [x] SUMMARY.md in `.jdi/phases/<slug>/`

**Q5 — How many callers?**
- [x] 1 main caller (jdi-do via Rust language routing)

**Q6 — Decision loop?**
- [x] Yes — task -> implement -> test -> retry on failure -> commit -> next task

**Q7 — Cost?**
- [x] Medium (Sonnet, 30-90s per task)

**Q8 — Tools?**
- [x] Read, Write, Edit, Bash

### Automatic classification

```
Q5 = 1 caller + Q6 = loop + Q4 contains "file" -> pure AGENT
```

### Anti-pattern check

- Name `jdi-rust-specialist` — OK (specific)
- Not feature-based — OK
- Estimated size: 200-300 lines (doer-specialist template + Rust conventions) — OK for an agent
- Total core agents after creation: 7 (6 shipped today + this one) — below the soft cap of 15 — OK

### Draft plan

```yaml
proposed:
  type: agent
  name: jdi-rust-specialist
  description: Rust specialist with cargo + clippy + rustfmt + Testcontainers if DB
  triggers:
    - "execute rust phase"
    - "/jdi-do rust"
    - "rust files in plan"
  tools: [Read, Write, Edit, Bash]
  model_intent: medium

inputs:
  - phase_id
  - .jdi/PROJECT.md
  - .jdi/phases/<slug>/PLAN.md
  - src/**/*.rs, Cargo.toml

outputs:
  - modified Rust code
  - .jdi/phases/<slug>/SUMMARY.md
  - .jdi/phases/<slug>/PLAN.md (status updated)

files_to_create:
  - core/agents/jdi-rust-specialist.md

integration_points:
  - .jdi/specialists.md: "Rust | jdi-rust-specialist | files *.rs"

validation_checks:
  - unique name (jdi-rust-specialist does not exist)
  - frontmatter matches template/agent.md
  - triggers do not collide with existing agents
```

### Approve / Edit / Cancel?

**User:** Approve

### Generation

Architect reads `core/templates/agent.md`. Substitutes placeholders. Writes to:

```
core/agents/jdi-rust-specialist.md
```

Appends to `.jdi/specialists.md`:
```markdown
| Rust | jdi-rust-specialist | files with .rs extension |
```

Appends to `.jdi/registry.md`:
```markdown
## R-2 (2026-05-09)
**Type:** agent
**Name:** jdi-rust-specialist
**Created by:** /jdi-create
**Why:** Real demand from users with Rust projects. Generic doer does not know the cargo workflow.
**Files:** core/agents/jdi-rust-specialist.md
**Integration:** .jdi/specialists.md
```

### Build + install

```bash
$ ./bin/jdi-build.sh
JDI build - generating runtimes from core/

claude:
  claude/agents/jdi-adopter.md
  claude/agents/jdi-architect.md
  claude/agents/jdi-asker.md
  claude/agents/jdi-bootstrap.md
  claude/agents/jdi-planner.md
  claude/agents/jdi-researcher.md
  claude/agents/jdi-rust-specialist.md   <- NEW
... (same for copilot, antigravity, opencode)

$ ./bin/jdi-install.sh claude --scope user
Claude Code installed in: ~/.claude (scope=user)
```

### Smoke test

```
Created: jdi-rust-specialist (agent)

How to invoke:
- Claude Code: spawn via Agent tool with subagent_type=jdi-rust-specialist
- Copilot:     @jdi-rust-specialist in chat
- Antigravity: discovered by trigger "execute rust phase"
- OpenCode:    @jdi-rust-specialist in the TUI

Audit: .jdi/registry.md (R-2)
```

### Commit

```bash
$ git add core/ .jdi/specialists.md .jdi/registry.md runtimes/
$ git commit -m "feat(jdi-create): add agent jdi-rust-specialist"
```

---

## Case 2 — Skill: EF Core 9 conventions

You notice multiple doers (.NET specialist, generic, etc) repeat EF Core 9 rules. It becomes a shared skill.

### Invocation

```
$ /jdi-create "skill with EF Core 9 conventions for reuse across .NET doers"
```

### Q&A

**Q1 — Problem?** Multiple .NET doers repeat EF Core 9 rules (Include with Split, AsNoTracking, scaffolding). DRY.

**Q2 — When does it run?** Loaded inline by the parent agent when the phase touches EF Core.

**Q3 — Input?** Output of the parent agent (the .NET code being written).

**Q4 — Output?** Modifies the parent agent's code (no file of its own).

**Q5 — How many callers?** Several — any .NET doer (csharp, csharp-react, etc).

**Q6 — Decision loop?** No — fixed procedure.

**Q7 — Cost?** N/A (pure skill, inherits).

**Q8 — Tools?** None of its own — inherits from the parent agent.

### Classification

```
Q5 = several + Q6 = no loop -> pure SKILL
```

### Draft plan

```yaml
proposed:
  type: skill
  name: ef-core-9-conventions
  description: EF Core 9 conventions (Include splits, AsNoTracking, safe scaffolding)
  applies_to:
    - C# code using EF Core 9
    - phase touching DbContext / migrations / queries
  loaded_by:
    - jdi-doer-* (any .NET)

files_to_create:
  - core/skills/ef-core-9-conventions/SKILL.md
  - core/skills/ef-core-9-conventions/references/include-split.md
  - core/skills/ef-core-9-conventions/references/no-tracking.md

integration_points:
  - .jdi/skills-registry.md: new entry
```

### Generation

Reads `core/templates/skill.md`. Substitutes. mkdir + Write:

```
core/skills/ef-core-9-conventions/
  SKILL.md
  references/
    include-split.md      (placeholder to fill in)
    no-tracking.md        (placeholder to fill in)
```

Appends to `.jdi/skills-registry.md`:
```markdown
| ef-core-9-conventions | core/skills/ef-core-9-conventions/ | EF Core 9 + .NET projects | jdi-doer-* (.NET) |
```

### Result

.NET doers whose `<skills_to_load>` lists this skill load it automatically. No duplication.

---

## Case 3 — Composite: custom reviewer for payments

A payments phase needs extra gates (PCI, idempotency, retries). Create a composite: focused reviewer + checks skill.

### Invocation

```
$ /jdi-create "reviewer focused on payments with PCI checks + idempotency rules"
```

### Summarized Q&A

- Q1: Ensure payment phases pass PCI/idempotency before ship
- Q2: Trigger on phases with files in `Features/Payments/**`
- Q5: 1 caller (jdi-verify) + skill reusable by other reviewers
- Q6: With loop (multiple checks)

### Classification

```
Q5 = 1 + reusable skill + Q6 = loop -> COMPOSITE
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
  - .jdi/reviewers.md: "jdi-payment-reviewer | files Features/Payments/** | blocks ship"
  - .jdi/skills-registry.md: "payment-checks"
```

### Generation

Creates both files. The agent references the skill in `<skills_to_load>`. Per-project reviewer-{slug} can optionally load it too (via append in the custom reviewer's `<skills_to_load>`).

---

## Anti-pattern: generic name

```
$ /jdi-create "review-code"
```

Architect detects a generic name. Response:

```
Anti-pattern: name "review-code" too generic.

Suggestions:
- jdi-payment-reviewer (focused on payments)
- jdi-csharp-reviewer (focused on .NET, but the per-project reviewer already does this)
- jdi-architecture-reviewer (focused on arch decisions)

Redo? (yes / cancel)
```

The user redoes with a specific name, or cancels.

---

## Anti-pattern: specialist per feature

```
$ /jdi-create "specialist for auth"
```

Architect:

```
Anti-pattern: specialist per feature ("auth"), not per language/stack.

Auth is a feature -> a normal phase covers it.
Do you want:
- (a) An auth phase via /jdi-discuss + /jdi-plan + /jdi-do (the project's specialist already knows)
- (b) A skill of auth conventions (httpOnly cookies, PKCE, etc) loaded by reviewers
- (c) Cancel

Choice?
```

---

## Anti-pattern: large skill

Q&A estimated a 800-line skill. Architect:

```
Anti-pattern: skill estimated at 800 lines.

Skills should be <500 lines (a focused procedure, not a full manual).

Options:
- (a) Become an agent (with a decision loop) — agents can be larger
- (b) Split into 2-3 smaller skills (e.g. payment-validation, payment-idempotency, payment-retry)
- (c) Cancel

Choice?
```

---

## Anti-pattern: name collides

```
$ /jdi-create "specialist for TypeScript"
```

Architect detects `core/agents/jdi-typescript-specialist.md` already exists.

```
Conflict: jdi-typescript-specialist already exists (R-3 in registry.md).

Do you want:
- (a) Update the existing one (manual edit afterwards)
- (b) Create a variant (jdi-typescript-strict-specialist, jdi-typescript-react-specialist)
- (c) Cancel

Choice?
```

---

## See also

- [CREATE.md](CREATE.md) — detailed flow mechanics
- [EXTENSION.md](EXTENSION.md) — create vs bootstrap (per-project)
- [AGENTS.md](AGENTS.md) — existing agents
- [ARCHITECTURE.md](ARCHITECTURE.md) — overview
