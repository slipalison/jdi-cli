---
name: clean-code
description: Clean Code. Human-readable code, optimized for reading (read 10x more than written). Names reveal intent, small functions, no redundant comments, explicit error handling, no magic numbers. Applies in any language.
---

# Skill: Clean Code

> Code is read 10x more than written. Optimize for reading.

Not about pretty style. About **making reader understand in 1 pass**, without mentally simulating execution.

## Rules

### 1. Names reveal intent

- **Variable**: what it **is**, not how it's stored (`elapsedSeconds` > `t` > `time`)
- **Function**: what it **does**, verb + object (`calculateTax(order)`, not `tax(order)`)
- **Boolean**: yes/no question (`isActive`, `hasPermission`, `canSubmit`)
- **Class/module**: noun (`OrderRepository`, `EmailValidator`)
- **Interface**: role/capability (`Repository`, `Cacheable`) — no `I`/`Abstract` prefix if language doesn't require

### Anti-names

| Wrong | Right |
|---|---|
| `data`, `info`, `value`, `temp`, `result` | something descriptive of the context |
| `processData()` | `parseUserPayload()`, `applyDiscount()`, etc |
| `Manager`, `Helper`, `Util` | name of the real responsibility |
| `flag`, `status` | `isComplete`, `paymentStatus` |
| `obj`, `item`, `thing` | actual type |
| Abbreviations: `usr`, `ctx`, `mgr`, `cfg` | `user`, `context` (exception: well-established domain convention) |
| Variables with `_2`, `_new`, `_old` | refactor until 1 remains |

### 2. Small functions

- **Size**: ideally < 20 lines. If over 50, almost certainly doing too much.
- **1 abstraction level**: inside function, all operations at same level. Mixing "open connection" + "calculate tax" = no.
- **3-4 params max**: more than that signals either missing object or too much responsibility.
- **1 logical exit**: early return is OK; multiple returns mid-complex-logic is bad.

### 3. Functions do **one** thing

If you describe function as "does X **and** Y", split into two. Function name must be precise.

Exception: orchestrators (controllers, command handlers) coordinate — OK to describe as "validates, saves, notifies" if each step is a call to another function.

### 4. Comments

**Default: DON'T write**.

Well-named code doesn't need to explain **what** it does. If you feel like writing a comment, first attempt: rename function/variable.

### Comments OK when:

- **Why** non-obvious: workaround for specific bug, surprising design decision, external constraint
- **Critical invariant**: "this array MUST be sorted for binary search to work"
- **TODO/FIXME marker** with ticket link: `// TODO(#1234): handle UTF-16 surrogate`
- **Pitfall warning**: "// don't call this in a loop, O(n^2)"
- **Public API doc**: contract for caller (params, returns, exceptions)

### Comments bad when:

- Explain **what** (code already says)
- Repeat the function name in English
- Comment goes stale relative to code
- "// removed on XX/YY" left in the tree
- "// hack" without explanation
- "// not sure why this works" — investigate, don't guess

### 5. Explicit error handling

- **Never silence exception**: `try { ... } catch {}` is **latent bug**
- **Explicit handling**: structured log + rethrow OR return Result/Either
- **Errors are part of the contract**: document what can fail
- **Boundary**: handle error at the boundary (controller, top-level handler), not at every internal call
- **Validation**: at the entry (boundary), not scattered

### 6. No magic numbers/strings

- Number or string with meaning becomes a **named constant**
- `if (status === 3)` becomes `if (status === OrderStatus.Shipped)`
- `setTimeout(fn, 86400000)` becomes `setTimeout(fn, MS_PER_DAY)`
- Exception: 0, 1, -1, universally clear cases

### 7. Command-Query Separation (CQS)

- **Query**: returns info, does **not** mutate state
- **Command**: mutates state, does **not** return (or returns void/minimal ack)

`function getUser(id)` that **also** updates last_access violates CQS — caller doesn't expect side-effect. Split.

### 8. Boy Scout Rule

> Leave the campground cleaner than you found it.

Touched a file? Small cleanness improvement is OK in the same commit:
- Rename obscure variable
- Split giant function you already had to read
- Remove stale comment
- Delete dead code

No heavy unrelated refactor — atomic commit still rules.

### 9. Formatting

- **Auto-format**: linter/formatter on the project (prettier, dotnet format, ruff format, gofmt) — no human decisions
- **Member order**: consistent convention (publics before privates, or group by feature)
- **Blank line**: separates logical blocks. Function all glued together is hard to scan.
- **Consistent indentation**: respect project convention

### 10. Symmetry and consistency

- Functions at same "level" have similar signature
- `getUserById, getUserByEmail` — consistent param order
- Exceptions "as is" vs "throws" vs Result — pick **one** style in the project
- `null` vs `undefined` vs `Option` — pick **one**
- Consistent naming convention (camelCase, PascalCase, snake_case) following the language

## Classic code smells

| Smell | Symptom |
|---|---|
| **Long function** | > 50 lines |
| **Long parameter list** | > 4 params |
| **God class** | 1 class does everything |
| **Feature envy** | method uses more data from **another** class than its own |
| **Data clump** | same 3-4 params bundled in multiple places -> object |
| **Primitive obsession** | everything is string/int, no value objects |
| **Scattered switch statements** | OCP violated |
| **Shotgun surgery** | simple change touches N files |
| **Divergent change** | 1 class changes for 5 different reasons (SRP) |
| **Dead code** | function/parameter/var never used |
| **Speculative generality** | flexibility without caller (YAGNI) |
| **Comments compensating bad code** | refactor code, delete comment |
| **Magic numbers** | 86400, 1024 with no name |
| **Silenced exceptions** | `catch {}`, `catch (Exception _) { }` |
| **Long if/else chains** | use polymorphism/strategy |
| **Inconsistent naming** | `getUser` here, `fetchAccount` there, `loadOrder` over there |
| **Boolean parameter** | `fn(true)` at caller — nobody knows what `true` means |

## Procedure

### Doer

After writing:
1. **Name review**: does each variable/function have a name that stands without a comment? Rename if not.
2. **Size**: any function > 30 lines? Split.
3. **Magic**: any number/string without obvious meaning? Constant.
4. **Redundant comments**: any comment that just repeats the code? Delete.
5. **Error handling**: any silent `catch {}`? Log or rethrow.

### Reviewer (gate 5)

```bash
# Long functions
awk '/^(function|def|public |private |protected |async )/ { start=NR; name=$0 }
     /^}$|^\s{0,2}}\s*$/ { if (NR-start > 50) print FILENAME":"start": function with "(NR-start)" lines: "name }' src/**/*.{ts,cs,py,go,java}

# Magic numbers (typical suspects)
grep -RnE '\b(86400|3600|1024|65535|1000000)\b' src/

# Silent catch
grep -RnE 'catch\s*(\([^)]*\))?\s*\{\s*\}' src/
grep -RnE 'except.*:\s*pass\s*$' src/
grep -RnE 'catch.*:.*ignore' src/

# TODO without ticket
grep -RnE 'TODO(?!.*#\d+)|FIXME(?!.*#\d+)' src/

# Suspect boolean params
grep -RnE 'function \w+\([^)]*: bool|: boolean' src/

# Generic name
grep -RnE '\b(data|info|value|temp|tmp|result|obj|item|thing)\b\s*[:=]' src/ | head -20

# Dead code (linter catches — confirm)

# Obvious comments
grep -RnE '^\s*//\s*(get|set|return|increment|decrement|loop|iterate)\b' src/
```

Relevant match -> WARN or BLOCK depending on severity.

## Inputs

- Diff/content of the file
- Project convention (linter config, naming convention from PROJECT.md)

## Outputs

Does NOT produce a file. Modifies judgement.

## Examples

### Example 1: bad names

Wrong:
```python
def calc(d, t):
    r = d * t * 0.18
    return r
```

Right:
```python
VAT_RATE = 0.18

def calculate_vat(amount: Decimal, qty: int) -> Decimal:
    return amount * qty * VAT_RATE
```

### Example 2: giant function

Wrong: 1 function of 120 lines validating, saving, sending email, logging.

Right: 4 functions of 20 lines each + 1 orchestrator of 15 lines that coordinates.

### Example 3: silenced exception

Wrong:
```typescript
try {
  await sendNotification(user)
} catch {}
```

Latent bug — notification failure disappears.

Right:
```typescript
try {
  await sendNotification(user)
} catch (err) {
  logger.error("notification failed", { userId: user.id, err })
  // intentional: notification is best-effort, doesn't block flow
}
```

Comment here justifies the "why" of the no-rethrow.

### Example 4: boolean param

Wrong: `createUser("alice", "alice@x.com", true, false)`

Right: `createUser({ name: "alice", email: "alice@x.com", admin: true, sendWelcome: false })`

Caller becomes self-documented.
