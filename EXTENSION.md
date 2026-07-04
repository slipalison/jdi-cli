# JDI — Extension

How to evolve JDI without bloating it. 2 paths:

1. **Per-project specialists** (`/jdi-bootstrap`) — generates doer/reviewer customized for the project. The normal path.
2. **Generic agents/skills in core** (`/jdi-create`) — creates a new agent or skill in `core/`. JDI source contributors only.

## Path 1: `/jdi-bootstrap` (per-project)

Runs in the project consuming JDI, after `/jdi-new` (or `/jdi-adopt`).

```
cd my-project
/jdi-new "REST API .NET 10"
/jdi-bootstrap
```

Architect specialist mode:
1. Reads `.jdi/PROJECT.md`
2. Asks 6 questions (test framework, build/test commands, coverage min, lint, conventions)
3. Generates `.jdi/agents/jdi-doer-{slug}.md` and `.jdi/agents/jdi-reviewer-{slug}.md`
4. Updates routing
5. Commit

Doer/reviewer stay **small** (~150-200 lines each) because each covers 1 stack.

### Multi-stack (frontend + backend)

Multi-specialist support is **native**:

- `/jdi-bootstrap` Step 2.7 auto-detects fullstack projects from PROJECT.md and offers N specialist pairs (default suggestion: backend + frontend), each with a `stack_label` + `file_glob` (e.g. `**/*.{cs,csproj,sln}` vs `**/*.{ts,tsx,css}`).
- `/jdi-plan` assigns every task a `**Specialist:**` field via file-glob match against `.jdi/specialists.md`; tasks spanning 2+ specialists are split into per-specialist sub-tasks.
- `/jdi-do` dispatches each task to its own specialist — different specialists can run in parallel within a wave (disjoint `files_modified`).
- `/jdi-verify` chains the reviewers sequentially (build/test commands may conflict on ports/locks); each writes its own REVIEW.md segment, aggregate verdict = worst case.

Single-stack (1 pair) remains the default for ~90% of projects.

## Path 2: `/jdi-create` (core)

JDI source contributors only. Creates a GENERIC agent or skill in `core/`. Guarded: the command refuses to run unless `package.json` has `"name": "jdi-cli"` (i.e. you are inside the jdi-cli source repo).

```
cd /path/to/jdi-source
/jdi-create "skill with EF Core 9 conventions"
/jdi-create "specialist for Rust with cargo + clippy"
```

Architect create mode:
1. 8 questions (problem, trigger, input, output, reuse, decision-loop, cost, tools)
2. Automatic classification:
   - `agent` — has its own decision loop
   - `skill` — reusable procedure without a loop
   - `composite` — agent + skill
3. Validation with user (approve / edit / cancel)
4. Generation in `core/agents/` or `core/skills/`
5. Build + install
6. Commit + audit in `.jdi/registry.md`

## Anti-patterns

The architect blocks or warns on:

- **Generic name** ("review-code", "doer", "checker") — asks for a specific focus
- **Specialist per feature** ("auth-specialist") — redirects to a phase
- **Skill > 500 estimated lines** — suggests an agent
- **Agent without a decision loop** — suggests a skill
- **Soft cap > 15 core agents or > 25 skills** — warns, does not block
- **Name collides with an existing agent/skill** — forces a rename

## When to create an agent vs a skill

| Question | Agent | Skill |
|---|---|---|
| Has a decision loop? | yes | no |
| Multiple callers? | no (1 caller is natural) | yes (several agents reuse it) |
| Own output (file)? | yes | no (modifies the parent's) |
| Own privileges? | yes | inherits from parent |
| Typical size | 100-500 lines | 50-200 lines |

In doubt -> agent. Refactor into a skill later if it becomes reusable.

## When to create a specialist vs use a generic doer

| Scenario | Specialist | Generic doer |
|---|---|---|
| Known, stable stack | x | - |
| Multi-stack in the same project | x (1 per stack) | - |
| Specific conventions (naming, error handling) | x | - |
| Legacy code with unique rules | x | - |
| Experimental, undefined project | - | x |
| Quick throwaway POC | - | x |

JDI default = specialist. Generic is the fallback.

## Checklist for a new specialist

After `/jdi-bootstrap` runs, check:

- [ ] `.jdi/agents/jdi-doer-{slug}.md` exists and has specific rules (not generic defaults)
- [ ] `.jdi/agents/jdi-reviewer-{slug}.md` exists with gates 1-8 customized
- [ ] `.jdi/specialists.md` has the doer row (one per stack if multi-stack)
- [ ] `.jdi/reviewers.md` has the reviewer row
- [ ] `.jdi/registry.md` has the R-N audit entry
- [ ] STATE.md has `specialists_ready: true`

If something is missing, run bootstrap again (idempotent — asks before overwriting).

## Checklist for a new core agent

After `/jdi-create` runs, check:

- [ ] `core/agents/jdi-{name}.md` or `core/skills/{name}/SKILL.md` exists
- [ ] Frontmatter complete (name, description, runtime_intent, tools_canonical, triggers, runtime_overrides)
- [ ] `<role>`, `<process>`, `<rules>`, `<output>` blocks present
- [ ] Build ran (runtimes/ has the new agent in all 4 runtimes)
- [ ] Install ran (active runtime has the agent)
- [ ] `.jdi/registry.md` has the R-N entry

## Maintenance

Specialists age with the project (stack changes, conventions evolve). To update:

```
# Manual edit:
edit .jdi/agents/jdi-doer-{slug}.md

# OR: regenerate (loses manual customizations)
rm .jdi/agents/jdi-doer-{slug}.md
/jdi-bootstrap
```

Recommendation: edit manually for small changes (new conventions). Regenerate only if the stack changed drastically.

## Hard limits

- Soft cap 15 core agents (current: 6) — architect warns above it, does not block
- Max 5 templates in `core/templates/` (current: 5 — agent, skill, doer-specialist, reviewer-specialist, dod-schema)
- Soft cap 25 core skills (current: 13 — code-design enforcement + principles + frontend rules)
- Per-project: no formal limit on specialists (a realistic project has 1-3 pairs)

JDI grows **carefully**. If you are about to exceed the caps, consider a dedicated fork instead of bloating the core.
