---
name: solid
description: SOLID. Robert C. Martin's 5 OO design principles - SRP, OCP, LSP, ISP, DIP. Applicable in any language with types/classes/interfaces (C#, Java, TS, Python, Go, Rust, Kotlin, Swift, etc). Direct summary + anti-patterns + detection heuristics.
---

# Skill: SOLID

5 design principles — **S**ingle Responsibility, **O**pen/Closed, **L**iskov Substitution, **I**nterface Segregation, **D**ependency Inversion.

Applicable in any language with classes or interfaces. In FP/procedural, principles map to modules and functions (SRP: 1 function 1 responsibility; ISP: minimal parameters; DIP: dependency injection via parameter).

## S - Single Responsibility Principle (SRP)

> A class/module must have **1 reason to change**.

**1 reason = 1 stakeholder or 1 axis of change**, not "1 action".

`UserService` that does auth + persistence + sends email violates — there are 3 reasons to change (security team changes auth, DBA changes persistence, marketing changes email).

### Violation symptoms
- Class with generic name (`Manager`, `Helper`, `Service`, `Util`)
- Methods without thematic coherence
- Multiple imports of unrelated libraries (DB + email + crypto in the same class)
- Diff of one class affects separate domains in different sprints

### Fix
Extract responsibilities into separate classes:
- `UserAuthenticator` (auth)
- `UserRepository` (persistence)
- `UserNotifier` (email)

Compose in a coordinator if needed, but each piece has 1 reason.

## O - Open/Closed Principle (OCP)

> Open for **extension**, closed for **modification**.

Adding new behavior shouldn't require editing tested code. Use polymorphism, strategy, plugins, or config — not infinite if/else.

### Violation symptoms
- `switch (type)` that grows with every new feature
- `if (provider === "x") ... else if ... else if ...`
- Each new feature edits N existing classes instead of adding 1 new one

### Fix
- **Strategy pattern**: each case becomes an impl of an interface
- **Polymorphism**: subclass override instead of external switch
- **Registry**: `registry.register("x", handler)` — new feature just adds
- **Visitor**: for closed type hierarchies

### When to ignore
OCP is aspirational, not absolute. Apply at points of **known** variation (payment strategies are multiple), don't speculate (KISS + YAGNI).

## L - Liskov Substitution Principle (LSP)

> Subtype must be **substitutable** for the supertype without breaking behavior.

If `Bird` has method `fly()`, `Penguin extends Bird` violates LSP — penguin doesn't fly. Caller receiving `Bird` breaks when it receives `Penguin`.

### Violation symptoms
- Subclass that **throws exception** on inherited method ("not supported")
- Subclass that **strengthens precondition** (`base accepts >= 0`, sub accepts `> 0`)
- Subclass that **weakens postcondition** (base guarantees "sorted", sub doesn't guarantee)
- Caller needs `if (instanceof Subtype)` to handle a special case

### Fix
- Rethink hierarchy: `Penguin` isn't a flying `Bird`, it's a `Bird` that walks. Create `FlyingBird : Bird` and `Penguin : Bird` without fly.
- Composition over inheritance: prefer composed interfaces over deep hierarchies.
- Refactor to capabilities: `Flyable`, `Swimmable`, `Walkable` (overlap with ISP).

## I - Interface Segregation Principle (ISP)

> Clients should not be forced to depend on interfaces they **do not use**.

Big interfaces ("fat interfaces") force impls to stub meaningless methods (throwing NotImplemented), and callers to import broad dependencies.

### Violation symptoms
- Interface with 15 methods, each caller uses 2-3
- Impl with several methods throwing `throw new NotImplementedException()`
- Huge test mock to use 1 method of the interface

### Fix
Split into smaller, cohesive interfaces:
```
IFileReader { read() }
IFileWriter { write() }
// callers pick the subset they need
```

In FP/Go, same principle: minimal parameters, structural typing doesn't force implementing everything.

## D - Dependency Inversion Principle (DIP)

> High-level modules **do not** depend on low-level. Both depend on **abstractions**.

Business logic doesn't care about "PostgreSQL", "AWS S3", "SendGrid". It cares about abstractions (`UserRepository`, `BlobStorage`, `EmailSender`). Concrete implementations live in outer layers.

### Violation symptoms
- Domain class imports `pg`, `aws-sdk`, `sendgrid`, `axios`
- Business logic testable only with real infra (DB up, S3 mocked, etc)
- Swapping provider requires rewriting business logic

### Fix
- **Dependency injection** (constructor / property / parameter)
- Define interfaces in the domain module; impls live in infra/adapter layer (overlap with Hexagonal/Clean Architecture)
- Composition root injects the right impl

### DIP != IoC container
DIP is a principle. IoC container is **one** tool. You can apply DIP with manual constructor, simple factory, or parameter injection — no framework.

## Summary of the 5

| Letter | Focus | Key question |
|---|---|---|
| **S** | Unit cohesion | How many reasons to change this class/module? (>1 = violates) |
| **O** | Stability against extension | Does adding a new feature edit tested code or add new code? |
| **L** | Inheritance contract | Does replacing parent with child break any caller? |
| **I** | Interface size | Does every impl/caller use all methods? |
| **D** | Direction of dependency | Does domain import infra or does infra import domain? |

## General anti-patterns

| Anti-pattern | Principle violated |
|---|---|
| `God class` with 30+ heterogeneous methods | SRP |
| `switch (kind)` in N callers, grows with each feature | OCP |
| Subclass with `throw NotSupportedException()` | LSP |
| `IRepository` with 20 generic methods | ISP |
| Domain service importing concrete ORM | DIP |
| Inheritance > 3 levels | LSP + SRP (usually) |
| Constructor with 8+ parameters | SRP (too many responsibilities) |
| Util class with 50 unrelated functions | SRP |

## Procedure

### Doer

Before creating class/module/interface:
- **SRP**: describe in 1 sentence. If you need "and", split.
- **ISP**: list expected callers. Does each one need **all** methods? If not, split.
- **DIP**: what does this depend on? Concretions (DB, HTTP, FS) -> inject as abstraction.

Before subclassing:
- **LSP**: does substitution by parent work in all callers? If not, wrong hierarchy.

Before adding `if/switch` at a growing point:
- **OCP**: is strategy/registry worth it?

### Reviewer (gate 5)

```bash
# SRP — very large classes
find src/ -name '*.cs' -o -name '*.ts' -o -name '*.py' | while read f; do
  loc=$(wc -l < "$f")
  [[ $loc -gt 400 ]] && echo "WARN SRP: $f has $loc lines, possible god class"
done

# OCP — big switches on hot paths
grep -RnE 'switch\s*\(' src/ | head
# (manually: evaluate if it grows with each feature)

# LSP — NotImplemented in subclass
grep -RnE 'NotImplemented|UnsupportedOperation|throw new.*not (implemented|supported)' src/

# ISP — giant interfaces
grep -RnA50 '^(public |export )?interface' src/ | grep -cE '^\s+\w+\s*\(' | sort -rn
# count > 10 methods -> WARN

# DIP — domain module importing concretions
grep -RnE 'from.*pg|from.*aws-sdk|using Npgsql|using AWSSDK' src/domain/ src/core/
```

Relevant match -> WARN with principle cited.

## Inputs

- Diff/content of the file
- Project structure (to detect domain vs infra)

## Outputs

Does NOT produce a file. Modifies judgement.

## Examples

### Example 1: SRP violated

Wrong:
```csharp
public class OrderService {
  public Order Create(...) { /* validate + save + email + log + audit */ }
}
```

5 reasons to change.

Right:
```csharp
public class OrderValidator { }
public class OrderRepository { }
public class OrderNotifier { }
public class OrderService {
  public Order Create(...) {
    _validator.Validate(...)
    var order = _repo.Save(...)
    _notifier.Notify(order)
    return order;
  }
}
```

### Example 2: OCP violated

Wrong:
```typescript
function calcDiscount(type: string, amount: number) {
  if (type === "vip") return amount * 0.2
  else if (type === "newcomer") return amount * 0.1
  else if (type === "blackfriday") return amount * 0.5
  return 0
}
```

Each new type edits this function.

Right:
```typescript
const strategies: Record<string, (amount: number) => number> = {
  vip: a => a * 0.2,
  newcomer: a => a * 0.1,
  blackfriday: a => a * 0.5,
}
function calcDiscount(type: string, amount: number) {
  return strategies[type]?.(amount) ?? 0
}
```

New type: register in `strategies`, don't touch `calcDiscount`.

### Example 3: DIP violated

Wrong:
```python
# domain/order.py
import psycopg2
class OrderService:
  def get(self, id):
    conn = psycopg2.connect(...)
    ...
```

Domain coupled to Postgres.

Right:
```python
# domain/order.py
class OrderService:
  def __init__(self, repo: OrderRepository):  # abstraction
    self._repo = repo
  def get(self, id): return self._repo.get(id)

# infra/postgres_order_repo.py
class PostgresOrderRepository(OrderRepository):
  def get(self, id): ...  # concrete impl
```

Domain doesn't know Postgres exists.
