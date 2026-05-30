---
name: yagni
description: YAGNI (You Aren't Gonna Need It). Build only what the current requirement asks for. Generalize after the 3rd real case, never before. Code not written is code with no bug, no maintenance cost, no pending test. Applies in any language.
---

# Skill: YAGNI

> You aren't gonna need it.

YAGNI is discipline against **speculative code**: features, abstractions, parameters, hooks, layers, configs that exist "in case it's needed". In 90% of cases, never needed — and when needed, the requirement is different from what you imagined.

## Rules

### 1. Build only what the current requirement asks

Ask of every new line of code:
- **Does this functionality have a requirement today?**
- **Who is the caller that needs this NOW?**

If there's no real caller, don't write it. Dead code is **net negative**: latent bug, maintenance cost, distraction in review, hinders refactor.

### 2. Generalize after the 3rd real case

Sandi Metz: "Duplication is far cheaper than the wrong abstraction."

- 1 case: implement specific
- 2 cases: copy or minimally parameterize
- 3 cases: now extract real pattern (one you **saw** happen, not imagined)

Generalizing earlier couples callers to the wrong interface. Refactoring later to the right interface is cheap; breaking callers to swap a wrong generic interface is expensive.

### 3. Costs of speculative code

Every "in case it's needed" line costs:

- **Maintenance**: someone will touch it when refactoring the neighborhood
- **Confusion**: reader thinks "this is being used, must be important"
- **Tests**: untested code becomes a bomb; tested, wasted time
- **Coupling**: callers will couple to the speculative interface, making it hard to remove
- **Scope creep**: simple feature becomes complex feature
- **Bug surface**: a line that doesn't exist has no bug

### 4. What YAGNI is NOT

YAGNI is not an excuse to:
- **Hardcoded everywhere**: some extension points are real requirements (i18n, logging, auth)
- **Cut real requirement**: if ticket asks for X, deliver X complete, not half
- **Skip security/error handling**: these are universal requirements, not speculative
- **Raw illegible code**: clarity is a requirement, not speculation
- **Skip tests**: coverage is a contract

### 5. Symptoms of violation

Code smells of broken YAGNI if:

- Optional parameters never passed (`fn(a, b, opts?: {...})` with opts always `undefined`)
- Hooks/events without subscribers
- Plugin system without plugins
- Config "in case we want to change" that nobody ever changed
- Interface with 1 impl (overlap with KISS)
- Generic `<T>` used with only 1 type
- "Future-proof" architecture written to scale 100x before validating current requirement
- Branches in code for scenarios nobody can describe

### 6. How to remove

After discovering speculative code:
1. Confirm nobody calls (`grep` callers)
2. Delete. Yes, delete directly. Git keeps history.
3. Don't leave "// removed on XX/YY" — more trash.
4. If you find out later you need it, add it when you need it (safe bet: later you know the real requirement, not imagined).

## Anti-patterns

| Anti-pattern | Why it violates |
|---|---|
| Optional parameter never used | Adds surface area without benefit |
| "Generic" function used by 1 caller | Generalized too early |
| Plugin/extension point without extenders | Dead code carries maintenance |
| "Configurable" config nobody changes | False flexibility — becomes hardcode later |
| Try/catch for impossible exception | Indicates fear, not requirement |
| Defensive validation for value coming from a safe type | TypeScript/C#/Python types already guarantee |
| `for/while` instead of direct return for "future looping" | Invents speculative repetition |
| Layer "to make it generic" without 2nd impl | Speculation with pass-through cost |
| Comment "TODO: extend to X later" without ticket | Message to nobody |
| Abstraction with 1 concrete implementation | Generic abstraction without second case |
| `enum` with 1 value "will grow" | Add value when it appears |

## Procedure

### Doer (before/during implementation)

Before adding:

1. **Is there a current requirement?** (ticket, conversation, explicit business rule) Otherwise, don't add.
2. **Who calls this today?** If nobody, don't add.
3. **When will I use that flexibility?** If "don't know", don't add.

After writing, ask:
- Is there a parameter/config/branch that could disappear without losing requirement?

### Reviewer (gate 5)

Heuristics:

```bash
# Optional parameters never passed
# (depends on stack — examples)
grep -RnE 'function \w+\([^)]*opts\?:' src/  # TS
grep -RnE '\([^)]*=\s*null\)' src/            # optional default null

# "TODO: extend" code
grep -RnE 'TODO.*(extend|future|reserved|placeholder|in case)' src/

# Try/catch without clear reason
grep -RnA3 'try\s*{' src/ | grep -B1 'catch.*:.*ignore'

# Declared and unused variables
# (linter already catches — confirm in review)

# Plugin/extension points
grep -RnE 'register|registerPlugin|EventEmitter|hook(' src/
# Cross-check: are there actually callers?
```

3+ matches without real caller -> WARN.

## Inputs

- File diff (focus on additions)
- List of callers if any

## Outputs

Does NOT produce a file. Modifies judgement — doer avoids writing, reviewer marks WARN.

## Examples

### Example 1: Speculative optional param

Wrong:
```python
def send_email(to: str, subject: str, body: str,
               cc: list[str] = None,
               bcc: list[str] = None,
               attachments: list[Path] = None,
               priority: str = "normal",
               retry_count: int = 3,
               on_failure: Callable = None):
    ...
```

Current requirement is to send simple email (`to, subject, body`). The other 5 params are speculative.

Right:
```python
def send_email(to: str, subject: str, body: str):
    ...
```

Add `cc`, `bcc` etc **when** real requirement arrives, not before.

### Example 2: Plugin system without plugins

Wrong:
```typescript
class PaymentProcessor {
  private plugins: Plugin[] = []
  registerPlugin(p: Plugin) { this.plugins.push(p) }
  process(...) {
    this.plugins.forEach(p => p.beforeProcess())
    // logic
    this.plugins.forEach(p => p.afterProcess())
  }
}
```

Has 0 plugins registered. Whole plugin system is dead code.

Right:
```typescript
class PaymentProcessor {
  process(...) { /* logic */ }
}
```

When the 1st real plugin appears, then yes. Not before.

### Example 3: Unused config string

Wrong: `config.json -> "DEFAULT_LANGUAGE": "pt-BR"` but nobody reads it. Code uses `"pt-BR"` directly.

Right: delete the config. Add it when the multi-language feature is actually implemented.
