---
name: dry
description: DRY (Don't Repeat Yourself). 1 source of truth per piece of knowledge. Detects real duplication (same decision in 2+ places) and separates from apparent duplication (same code, different reasons). Applies in any language.
---

# Skill: DRY

> Every piece of knowledge has **one** authoritative, unambiguous representation in the system.

DRY is not about copying code. It's about **duplicated knowledge** — business rule, formula, format, decision, present in 2+ places and that change **together** when the requirement changes.

## Rules

### 1. Knowledge duplication != code coincidence

**Knowledge duplication (violates DRY):**
- Tax calculation in 2 places
- CPF validation in 3 services
- Date format schema scattered across the app
- Same timeout constant in 4 files

When the rule changes, you change in N places — miss one, system becomes inconsistent.

**Code coincidence (does NOT violate DRY):**
- 2 functions with 5 identical lines but different domains
- Framework boilerplate repeated (every controller has `[Authorize]`)
- Similar iteration loop in 2 unrelated contexts

Forcing abstraction here couples things that shouldn't be coupled.

### 2. Rule of 3

- 1 occurrence: leave it
- 2 occurrences: pay attention, but don't abstract yet
- 3 occurrences: abstract (probably real knowledge duplication)

Skipping this rule produces **premature abstraction** — worse than duplication because callers are already coupled to the wrong interface.

### 3. Types of DRY

**Code DRY:** reusable functions/classes for repeated logic
**Data DRY:** 1 source schema (generates DTO + validator + DB + docs)
**Process DRY:** 1 build script that serves dev + CI + prod
**Documentation DRY:** docs generated from code, not written in parallel

### 4. Single Source of Truth (SSoT)

For each piece of knowledge, identify:
- **Where the truth lives** (DB schema, env config, business rule)
- **Who derives from it** (DTOs, types, docs, UI)
- **Derivation tool** (codegen, schema migration, type inference)

Never: manually edit both the source and the derived.

### 5. When NOT to apply DRY

- **Premature abstraction**: 2 similar callers but with diverging future evolutions -> leave duplicated
- **Cross-boundary**: duplicating across microservices > coupling via shared lib
- **Test setup**: readable redundant tests > shared magical helpers
- **Wrong abstraction**: better duplicate than extract wrong (Sandi Metz: "duplication is far cheaper than the wrong abstraction")

## Anti-patterns

| Anti-pattern | Why it violates |
|---|---|
| Copy-paste without extraction after 3rd occurrence | Duplicated knowledge, each caller silently diverges |
| Utility helper with 15 unrelated functions | "DRY" became ball of mud — bundles unrelated things |
| Abstraction after 2nd duplication with extension hooks "just in case" | Premature abstraction + YAGNI violated together |
| Same constant hardcoded in 4 files | Single source of truth absent — extract to config |
| Validation logic duplicated client + server | Code OK, but should share schema (Zod, Pydantic, JSON Schema) |
| Comment explaining what code does | Doc duplicates code, will go out of sync |

## Procedure

### Doer (before writing)

1. Is there an identical rule/calculation/constant elsewhere in the codebase? If so, refer/import. Don't duplicate.
2. Going to create the 2nd occurrence? OK, but mentally mark it.
3. Going to create the 3rd? Stop. Refactor first into abstraction, then use.

### Reviewer (gate 5)

Per-language specific greps (examples):

```bash
# Duplicated magic constants
grep -RnE '\b86400\b|\b3600\b|\b1024\b' src/

# Same string in 3+ places
sort src/ | uniq -c | sort -rn | head -20  # coarse heuristic

# Duplicated email/CPF/etc validation
grep -RnE 'regex.*@|EmailRegex|CpfValidator|cpf_pattern' src/

# Hardcoded URLs/endpoints
grep -RnE 'https?://[a-z0-9.-]+\.[a-z]{2,}' src/ --include='*.ts' --include='*.cs' --include='*.py'
```

3+ matches of the same pattern in different files -> WARN.

## Inputs

- Diff or content of the modified file
- Context: project stack for adapted greps

## Outputs

Does NOT produce a file. Modifies judgement:
- Doer chooses to reuse/extract
- Reviewer marks WARN with pointer to refactor

## Examples

### Example 1: 3 services calculating tax

Wrong:
```
service A: total * 0.18
service B: amount * 0.18
service C: value * 0.18
```

Right: extract `TaxCalculator.applyVat(amount)` or `const VAT_RATE = 0.18` in shared config.

Reviewer marks WARN: "tax 0.18 hardcoded in 3 services. Extract to `config/tax.{ts,cs,py}`."

### Example 2: Code coincidence (does NOT violate DRY)

```
function findUser(id) { return db.query(...) }
function findOrder(id) { return db.query(...) }
```

Same structure, different domains. **Don't** extract `findEntity(id, table)` — will force abstraction that will diverge (user has soft-delete, order has cache, etc).

Reviewer ignores — code coincidence is OK.
