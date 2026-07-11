---
name: onion
description: Onion Architecture (Jeffrey Palermo). Concentric shells with the Domain Model at the absolute center. Dependencies invert across shells - outer depends on inner, inner knows nothing of outer. Language-agnostic rigid rules. Mutually exclusive with The Method, DDD, Clean Architecture, Hexagonal, Vertical Slice.
---

# Skill: Onion Architecture

Rigid, inviolable rules from Jeffrey Palermo's Onion Architecture. The system is a series of **concentric shells** with the **Domain Model at the absolute center**. Outer shells depend on inner shells; the inverse is forbidden.

Onion is the ONLY allowed design when PROJECT.md `Code Design: LOCKED: Onion`. Do not use The Method, DDD as primary structure, Clean Architecture's 4-named layers, Hexagonal port/adapter terminology as primary structure, or Vertical Slice feature folders as primary structure.

## The shells (mandatory order from center outward)

1. **Domain Model** — entities and value objects expressing the business state. No behavior dependent on infrastructure. The absolute center.
2. **Domain Services** — domain operations that do not belong to a single entity/value object. Pure domain logic. Stateless.
3. **Application Services** — orchestrate use cases. Coordinate Domain Services and Domain Model. Define interfaces for infrastructure dependencies (repository contracts, external system contracts).
4. **Infrastructure** — persistence implementations, external system clients, UI, tests, framework bindings. The outermost shell.

Every code unit belongs to exactly one of these 4 shells. A unit that does not fit must be redesigned.

## The Dependency Direction (inviolable)

**Dependencies point inward.** Every shell may depend on shells closer to the center; no shell may depend on shells farther from the center.

1. Domain Model depends on nothing else in the system.
2. Domain Services depend on Domain Model only.
3. Application Services depend on Domain Model and Domain Services.
4. Infrastructure depends on Application Services, Domain Services, and Domain Model.
5. Names defined in Infrastructure (ORM types, framework types, vendor SDK types) never appear in any inner shell.

## Inversion across infrastructure (inviolable)

1. **Application Services define the interfaces** (repository contracts, external system contracts) they require. These interfaces live in Application Services or Domain Services — never in Infrastructure.
2. **Infrastructure implements those interfaces.** The implementation class lives in Infrastructure. The interface lives inward.
3. **The Composition Root wires interfaces to implementations.** The Composition Root is part of Infrastructure (or a separate startup module that depends on Infrastructure). Inner shells never construct Infrastructure types.

## Domain Model rules

1. The Domain Model contains only entities and value objects in domain language.
2. The Domain Model has no annotations, no inheritance from framework base classes, no persistence concerns, no serialization concerns.
3. The Domain Model is not anemic. Behavior that belongs to an entity lives on that entity. Behavior that belongs to no single entity lives in Domain Services.
4. Value objects are immutable. Replacing is the only mutation pattern.
5. The Domain Model does not know how it is persisted, displayed, or transmitted.

## Domain Services rules

6. Domain Services are stateless. They contain pure domain logic that does not naturally belong to a single Entity or Value Object.
7. Domain Services depend on the Domain Model only. They never call repositories, infrastructure, or Application Services.
8. Domain Services do not perform I/O.
9. Names of Domain Services are domain operations, not technical operations.

## Application Services rules

10. Application Services orchestrate use cases. One Application Service method = one application-level operation.
11. Application Services declare the interfaces (repository, gateway, sender, publisher) they require. These interfaces live with Application Services (or in Domain Services when their abstraction is purely domain-driven).
12. Application Services do not contain business rules — they coordinate. Business rules live in Domain Model and Domain Services.
13. Application Services do not import any Infrastructure class. They depend on the interfaces they themselves declare.
14. Application Services receive input DTOs and return output DTOs (or void). They do not return Domain Model entities to outer shells when those would leak persistence concerns.

## Infrastructure rules

15. Infrastructure implements interfaces declared by inner shells. It does not introduce interfaces of its own that inner shells consume.
16. Infrastructure contains: persistence (ORM mappings, repositories), HTTP/UI controllers, message bus clients, file system access, vendor SDK calls, scheduled job handlers, and the Composition Root.
17. Infrastructure does not contain business rules.
18. Infrastructure classes are named with their technology when the technology is the encapsulated concern (e.g., `SqlOrderRepository`, `HttpPaymentGateway`).
19. Two infrastructure classes do not call each other to fulfill a use case. Coordination happens via Application Services.

## Forbidden patterns (inviolable)

- **Inner shell referencing outer shell.** Domain Model referencing Application Services or Infrastructure is forbidden. Domain Services referencing Application Services or Infrastructure is forbidden. Application Services referencing Infrastructure (concrete classes) is forbidden.
- **Persistence annotations or framework types in the Domain Model.**
- **Repository interface placed in Infrastructure.** The interface must live inward (Application Services or Domain Services).
- **Domain Services performing I/O.**
- **Application Services containing business rules.**
- **Infrastructure-defined interfaces consumed by inner shells.**
- **Skipping a shell** (Infrastructure code calling Domain Model methods directly when an Application Service exists for that use case; or controller calling repository directly bypassing Application Services).
- **Anemic Domain Model.**
- **CRUD-only Application Services** with no application semantics.
- **Cross-shell reach-around** (Infrastructure A calling Infrastructure B to fulfill a use case without going through an Application Service).

## Naming conventions

- Domain Model classes: domain nouns (`Customer`, `Order`, `Subscription`).
- Domain Services: domain verb-noun (`OrderPricingPolicy`, `SubscriptionRenewalRules`).
- Application Services: application-level operations (`RegisterCustomerService`, `RenewSubscriptionService`).
- Interfaces consumed by Application Services: domain-meaningful (`IOrderRepository`, `IPaymentGateway`, `INotificationSender`).
- Infrastructure classes: technology-qualified (`SqlOrderRepository`, `StripePaymentGateway`, `SmtpNotificationSender`).

## Reviewer enforcement (gate 5)

Reviewer rejects (BLOCKED) when:
- Domain Model, Domain Services, or Application Services import a framework / ORM / HTTP / vendor SDK type.
- A repository or external-system interface is declared in Infrastructure and consumed inward.
- An inner shell file imports an outer shell file.
- Application Services contain business rules that belong on Domain Model or Domain Services.
- Domain Services perform I/O or call a repository.
- Infrastructure classes coordinate use cases instead of being driven by Application Services.
- Infrastructure introduces an interface that inner shells depend on.

Reviewer warns (APPROVED_WITH_WARNINGS) when:
- Domain Model is anemic.
- Application Services are named after CRUD verbs without semantic meaning.
- Composition Root is fragmented across multiple infrastructure modules.
- An entity is mutable in places where a value object would be correct.

## Anti-patterns

- "Service" layer mixing Domain Services with Application Services indistinguishably
- Generic repository (`IRepository<T>`) declared at the Infrastructure level
- Domain Model classes inheriting from an ORM base
- Domain Services calling repositories
- Application Services holding state across calls
- Direct controller-to-repository wiring
- Infrastructure types appearing as parameters to inner-shell methods
- "Onion" framing used to disguise Clean Architecture, Hexagonal, or DDD — the rule is the inward dependency direction and the Domain Model at the absolute center

## Outputs

Does NOT produce own files. Modifies parent agent's structural decisions during code authoring and review.
