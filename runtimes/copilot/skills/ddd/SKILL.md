---
name: ddd
description: Domain-Driven Design (Eric Evans). Strategic patterns (Bounded Context, Ubiquitous Language, Context Map) plus tactical patterns (Aggregates, Entities, Value Objects, Domain Services, Repositories, Domain Events). Language-agnostic rigid rules. Mutually exclusive with The Method, Clean Architecture, Hexagonal, Onion, Vertical Slice.
---

# Skill: Domain-Driven Design (DDD)

Rigid, inviolable rules from Eric Evans's *Domain-Driven Design* and Vaughn Vernon's *Implementing DDD*. The domain is the center of the system. Persistence, UI, frameworks, and external integrations are peripheral details.

DDD is the ONLY allowed design when PROJECT.md `Code Design: LOCKED: DDD`. Do not introduce The Method's Managers/Engines/ResourceAccess, Clean Architecture's concentric layers as a structural primary, Hexagonal port terminology as the primary structure, Onion shells, or Vertical Slice handlers as the primary structure.

## Strategic rules (inviolable)

1. **Bounded Context (BC) is the unit of model isolation.** Every BC owns its own model, its own ubiquitous language, its own database schema, and its own deployment unit (where feasible). A model is meaningful only inside its BC.
2. **Each BC must be named.** Anonymous BCs do not exist. The name appears in the codebase (folder, namespace, module, package).
3. **Ubiquitous Language (UL) is contractual within a BC.** The same word means exactly one thing inside the BC. Synonyms are forbidden. Code, tests, docs, conversations, and database column names share the UL terminology.
4. **No shared model across BCs.** When two BCs reference the same real-world concept, each has its own model class for it. Cross-BC reuse of classes is forbidden.
5. **Cross-BC interaction follows a Context Map relationship.** Every integration between BCs is explicitly typed as exactly one of: Shared Kernel, Customer/Supplier, Conformist, Anticorruption Layer (ACL), Open Host Service (OHS), Published Language (PL), Partnership, Separate Ways. Undeclared integration is forbidden.
6. **Anticorruption Layer (ACL) is required when integrating with a legacy or external model.** Foreign models do not leak into a BC.
7. **Core Domain is identified explicitly.** Other BCs are classified as Supporting Subdomain or Generic Subdomain. The Core Domain receives the highest engineering investment and is never outsourced or replaced by a generic library.
8. **Domain knowledge does not leak into Generic Subdomains.** Generic Subdomain code (Identity, Logging, Notification) must be reusable across projects without domain assumptions.

## Tactical rules (inviolable)

### Aggregate

1. **An Aggregate has exactly one Root.** All external access goes through the Root. References to inner entities from outside the Aggregate are forbidden.
2. **The Aggregate Root enforces all invariants of the Aggregate.** No partial state may be observed by other Aggregates or by Application Services.
3. **One transaction modifies at most one Aggregate instance.** Multi-aggregate consistency is achieved by Domain Events, not by enclosing transactions.
4. **Aggregates reference other Aggregates only by identifier (ID), never by direct object reference.** Cross-aggregate navigation through references is forbidden.
5. **Aggregate boundaries are designed around invariants and transactional consistency, never around UI screens or convenience.**
6. **Aggregates must be small.** If an Aggregate contains a collection that grows unbounded, the design is wrong and must be split.

### Entity vs Value Object

7. **An Entity has identity that persists across state changes.** Equality is by identity, never by attributes.
8. **A Value Object is immutable and identity-less.** Equality is by attributes. Mutating a Value Object is forbidden — replace, do not modify.
9. **Prefer Value Objects.** When a concept has no identity, model it as a Value Object. Default to Value Object; promote to Entity only when identity is required.
10. **Value Objects must be self-validating.** Construction of a Value Object with invalid state must fail at construction time.

### Domain Service

11. **A Domain Service exists only when an operation does not belong to any Entity or Value Object.** If the operation can fit on an Entity/VO, it must live there.
12. **Domain Services are stateless and named with a Ubiquitous Language verb-noun expressing a domain operation, not a technical action.**
13. **Domain Services contain domain logic only.** Persistence, transactions, messaging, and orchestration of use cases live in Application Services.

### Repository

14. **One Repository per Aggregate Root.** No repository per Entity that is not a Root. No "generic" repository shared across Aggregates.
15. **Repository interface lives with the domain model, not with persistence.** Persistence implementation lives outside the domain layer.
16. **Repositories return whole Aggregates, never partial state.** A method returning a piece of an Aggregate (single inner entity, partial fields) is forbidden.
17. **Queries that span multiple Aggregates or return projections do not use Repositories.** Use a dedicated Query/ReadModel pattern (CQRS-style). Reads and writes may diverge structurally.

### Domain Event

18. **Domain Events are immutable, past-tense facts.** Names are past tense (e.g., "OrderPlaced", "PaymentRefused"). Mutating a Domain Event is forbidden.
19. **Domain Events are emitted by Aggregates.** Application Services do not invent domain events.
20. **Domain Events carry only the data needed to react to the fact.** Do not embed entire Aggregate state.
21. **Cross-Aggregate consistency uses Domain Events, not synchronous calls between Aggregates.**

### Application Service

22. **Application Services orchestrate use cases.** They load Aggregates via Repositories, invoke domain methods, persist changes, and emit Domain Events. They contain no business rules.
23. **Application Services are thin.** A method longer than orchestration of 5-8 domain calls is a smell; extract domain logic back to the domain.
24. **Application Services do not return domain entities directly to UI.** Return DTOs or projections.

### Domain layer purity

25. **The Domain Layer depends on nothing external.** No framework, ORM, HTTP, file system, or messaging library is referenced from domain code.
26. **Persistence-ignorant domain.** Entities/Aggregates do not inherit from ORM base classes, do not have persistence annotations leaking semantic meaning, and do not know about transactions.
27. **No anemic models.** Entities and Value Objects own their behavior. A class with only getters/setters and no business methods is forbidden in the domain layer.
28. **No "Manager", "Helper", "Util", "Processor" classes in the domain layer.** These names betray missing domain concepts.

## Modeling rules (inviolable)

1. The model in code must match the model in conversation with domain experts. If they diverge, the code is wrong.
2. Names come from the Ubiquitous Language. Technical names ("Data", "Info", "Object", "Item", "Entry") are forbidden in the domain layer.
3. New domain concepts are added to the Ubiquitous Language before they are added to the code.
4. Domain experts must recognize the names, intents, and invariants encoded in the domain layer.

## Forbidden patterns (inviolable)

- **Generic Repository** spanning multiple Aggregates (`Repository<T>`) is forbidden.
- **Lazy-loaded navigation across Aggregates** is forbidden.
- **Transactions spanning multiple Aggregates** are forbidden.
- **Returning Entities from a query that crosses Aggregates** is forbidden — use a read model.
- **CRUD-only Application Services** ("CreateUser", "UpdateUser") with no domain semantics are a smell; reframe as domain operations ("RegisterCustomer", "DeactivateAccount") when meaning exists.
- **Anti-corruption layer absence** when consuming an external/legacy model is a violation.
- **Sharing entities across Bounded Contexts** is forbidden.
- **DTO leaking into the domain layer** is forbidden.

## Reviewer enforcement (gate 5)

Reviewer rejects (BLOCKED) when:
- Domain code references a framework / ORM / HTTP / messaging library.
- An Aggregate is mutated from outside its Root.
- A single transaction modifies more than one Aggregate instance.
- A Repository serves multiple Aggregate Roots, or returns partial state.
- Cross-Aggregate references are by object instead of by ID.
- A Domain Service performs persistence, transactions, or messaging.
- An Application Service contains business rules.
- An Entity / VO has only getters/setters (anemic).
- Two Bounded Contexts share the same model class.
- An integration with an external system has no Anticorruption Layer.

Reviewer warns (APPROVED_WITH_WARNINGS) when:
- A class is named "Manager" / "Helper" / "Util" / "Processor" in the domain layer.
- A Value Object is mutable.
- An Aggregate exposes its internal collections directly.
- A Domain Event is named in present/future tense.
- The Ubiquitous Language used in code disagrees with the language in PROJECT.md or CONTEXT.md.

## Anti-patterns

- Anemic Domain Model
- Generic Repository pattern
- God Aggregate (entire schema under one Root)
- Smart UI bypassing domain
- Domain services that orchestrate use cases (those are Application Services)
- "Service layer" without distinguishing Domain Service vs Application Service
- Database-first design driving Aggregate shape

## Outputs

Does NOT produce own files. Modifies parent agent's structural decisions during code authoring and review.
