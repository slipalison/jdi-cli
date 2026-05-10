---
name: kiss
description: KISS (Keep It Simple, Stupid). The simplest solution that solves the problem wins. Complexity only justified by real measured pain. Each layer/abstraction must pay its own cost. Applies in any language.
---

# Skill: KISS

> Simplicity is the best design. Every complexity must pay its own cost.

KISS is not "dumb code". It's **rejecting unjustified complexity**. Every interface, every layer, every abstraction has maintenance cost — only worth it if it solves real pain.

## Rules

### 1. Default is the simplest

Ask before adding:
- **Function** vs class vs framework?
- **Variable** vs config vs feature flag?
- **If/else** vs strategy pattern vs plugin system?
- **Sync** vs async vs queue vs event bus?
- **Inline** vs helper vs lib?

Start with the leftmost. Only step up if there is a real requirement.

### 2. Complexity must justify pain

**Allowed:**
- New pattern if it has 3+ real cases using it
- Abstraction layer if it has 2+ implementations that exist today
- Cache if measurement shows hot path
- Async if there's unacceptable latency synchronous
- Plugin system if there are confirmed external extenders

**Forbidden:**
- "Will scale later" without current requirement
- "Other people might need it" without other people
- "To make it generic" without 2nd use case
- "Will look cleaner" trading 5 clear lines for 50 elegant ones
- Enterprise pattern in small codebase (Repository + UoW + Mediator + CQRS for 10-controller app)

### 3. Cognitive load is a real metric

Code you read 10x and write 1x. Optimize for reading:
- **Named variables** > composite expression
- **Early return** > nested if/else
- **Linear function** > jumps between callbacks
- **Explicit types** > magical inference in large codebase
- **Simple procedural code** > fancy OOP for 50 lines

Rule: code that needs a comment explaining "why so complex" is too complex.

### 4. Indicators of over-engineering

Signs the code went over the line:

- Interface with 1 implementation
- Factory/Builder for something instantiated 1x
- Generic <T> only used with 1 type
- Config with a key that never changed
- Abstraction layer that only encapsulates a call to another layer (pass-through)
- Inheritance hierarchy > 2 levels
- File with more setup than logic
- Test that needs 30 lines of mock to run 5 lines of logic

### 5. Refactor is the opposite direction

Natural tendency: code grows in complexity. Refactoring = REMOVE complexity that no longer pays.

Ask:
- Does this layer still exist to solve a problem, or did it become tradition?
- Does this abstraction have 2+ implementations today?
- If I delete this, what breaks?
- Can I solve it with 5 lines instead of 50?

## Anti-patterns

| Anti-pattern | Symptom |
|---|---|
| Interface + 1 implementation | `IUserService` + `UserService` (only 1) — delete the interface, use the class |
| Generic `<T>` used with 1 type | `Repository<User>` but never `Repository<Order>` — concretize |
| Factory for new() | `UserFactory.create()` that only does `return new User()` |
| Config string that never changed | `MAX_RETRIES: 3` in config + nobody ever changed it — hardcode |
| Inheritance > 2 levels | `BaseEntity -> AuditableEntity -> SoftDeletableEntity -> User` — flatten via composition |
| Pass-through layer | `Controller -> Service -> Repository -> DbContext` where Service only calls Repository without logic — delete Service |
| Enterprise pattern without demand | Mediator/CQRS in small app — replace with direct call |
| Comment explaining "why so complex" | Code lost the war — refactor |
| Mock setup > logic test | Test gets fragile; code under test is over-coupled |
| Unused future-proof params | `(opts?: { future?: boolean })` without caller passing — remove |

## Procedure

### Doer (before writing)

1. Ask: "What is the **simplest** version that meets the current requirement?"
2. Write that version.
3. Only step up complexity if you hit real pain.
4. After writing, ask: "Can I delete any layer/parameter/abstraction without losing functionality?"

### Reviewer (gate 5)

Over-engineering heuristics:

```bash
# Interfaces with 1 implementation
grep -RnE '^(public |export )?interface I?[A-Z]\w+' src/ | while read iface; do
  name=$(echo "$iface" | grep -oE '[A-Z]\w+\b' | head -1)
  count=$(grep -RnE "class \w+\s*:\s*$name|implements $name" src/ | wc -l)
  [[ $count -eq 1 ]] && echo "WARN: $iface has only 1 implementation"
done

# Deep inheritance (> 2 levels)
# (depends on stack — specific heuristic)

# Very large or nested functions
grep -cE '^\s{20,}\S' src/**/*  # lines with 20+ spaces = deep nesting
```

Match -> WARN with suggestion to simplify.

## Inputs

- Diff/content of the file
- Context: codebase size (over-engineering is relative)

## Outputs

Does NOT produce a file. Modifies judgement.

## Examples

### Example 1: Interface with 1 impl

Wrong:
```typescript
interface ILogger { log(msg: string): void }
class ConsoleLogger implements ILogger { log(msg) { console.log(msg) } }
const logger: ILogger = new ConsoleLogger()
```

Right (KISS):
```typescript
function log(msg: string) { console.log(msg) }
// or
class Logger { static log(msg: string) { console.log(msg) } }
```

Add interface when 2nd impl arrives, not before.

### Example 2: Pass-through service

Wrong:
```csharp
public class UserService {
  public User GetById(int id) => _repo.GetById(id);  // only calls repo
}
```

Right: use `_repo` directly in the controller. Add Service when there is real logic (validation, multi-step, transaction, event).

### Example 3: Hardcodable config

Wrong: `appsettings.json -> "MaxItemsPerPage": 50` that nobody ever changed in 2 years.

Right: `const MAX_ITEMS_PER_PAGE = 50` in the code. Move back to config if some client actually needs to customize.
