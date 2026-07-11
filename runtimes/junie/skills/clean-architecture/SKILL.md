---
name: clean-architecture
description: Clean Architecture (Robert C. Martin). 4 concentric layers - Entities, Use Cases, Interface Adapters, Frameworks & Drivers. The Dependency Rule points strictly inward. Language-agnostic rigid rules. Mutually exclusive with The Method, DDD, Hexagonal, Onion, Vertical Slice.
---

# Skill: Clean Architecture

Rigid, inviolable rules from Robert C. Martin's *Clean Architecture*. The system is organized as **concentric layers**, and source-code dependencies point only **inward**.

Clean Architecture is the ONLY allowed design when PROJECT.md `Code Design: LOCKED: Clean Architecture`. Do not mix with The Method, DDD aggregates as a primary structure, Hexagonal terminology as the primary structure, Onion shells, or Vertical Slice feature folders as the primary structure.

## The 4 layers (mandatory)

From innermost to outermost:

1. **Entities (Enterprise Business Rules)** — the most general and high-level rules. Reusable across applications in the enterprise. Pure data + behavior. No knowledge of any other layer.
2. **Use Cases (Application Business Rules)** — application-specific business rules. Orchestrate the dance of Entities to satisfy a use case. No knowledge of UI, DB, frameworks, devices, or external systems.
3. **Interface Adapters** — convert data between the form most convenient for use cases/entities and the form most convenient for external agents. Controllers, Presenters, Gateways, ViewModels live here. No knowledge of frameworks beyond what is necessary to expose adapter contracts.
4. **Frameworks & Drivers** — the outermost layer. Web framework, database, UI framework, file system, devices, external APIs. Glue code only — minimal logic.

Every code unit belongs to exactly one of these 4 layers. A unit that does not fit must be redesigned.

## The Dependency Rule (inviolable)

**Source-code dependencies point only inward. Nothing in an inner circle may know anything at all about something in an outer circle.**

1. Entities depend on nothing outside the Entities layer.
2. Use Cases depend on Entities only. Use Cases do not import, reference, or know the names of anything in Interface Adapters or Frameworks & Drivers.
3. Interface Adapters depend on Use Cases and Entities only. They do not depend on Frameworks & Drivers code directly — they depend on framework abstractions only where unavoidable, and never let framework types cross into the inner circles.
4. Frameworks & Drivers depend on whatever is convenient (Adapters, libraries, vendor SDKs).
5. Names defined in outer circles (e.g., entity names from a DB schema, DTOs from a controller, framework annotations) must not appear in inner-circle code.

## Boundary Crossing rules (inviolable)

1. **Cross boundaries via interfaces owned by the inner side.** Inputs into Use Cases are defined by interfaces in the Use Cases layer; implementations live in Interface Adapters.
2. **Cross boundaries via Data Transfer Objects (DTOs) that are simple structures.** No framework objects, no ORM entities, no HTTP request objects cross a boundary.
3. **Use Cases never receive framework-specific types** (HTTP request, ORM entity, file handle, socket). The Adapter translates these into the Use Case's input DTOs.
4. **Use Cases return DTOs / output ports.** They never return entities directly to outer layers.
5. **The Use Case interactor invokes an output port (interface) to deliver results.** The Presenter implements the output port. Use Cases never call presenters or controllers directly.

## Layer purity rules (inviolable)

### Entities

1. Entities are pure. No imports from any other layer.
2. Entities encapsulate enterprise-wide business rules; if a rule is application-specific, it does not belong here.
3. Entities are not Database records, ORM models, JSON shapes, or API DTOs. If a class plays one of those roles, it is not an Entity.
4. Entities have no annotations from persistence, serialization, or web frameworks.
5. Entities are not anemic. Behavior lives with data.

### Use Cases

6. Each Use Case has a single, application-specific purpose stated by its name (verb-noun: e.g., `RegisterCustomer`, `RenewSubscription`).
7. A Use Case owns its input port (input boundary) and output port (output boundary) as interfaces in the Use Cases layer.
8. A Use Case does not import any framework, ORM, HTTP, file-system, or external-API type.
9. A Use Case is testable without any infrastructure. If it cannot be tested without spinning up DB / HTTP / queue, the design is wrong.
10. A Use Case orchestrates Entities. It does not duplicate enterprise rules that already live in Entities.

### Interface Adapters

11. Controllers translate external input (HTTP request, CLI args, message payload) into Use Case input DTOs and invoke the Use Case.
12. Presenters convert Use Case output DTOs into a form suitable for delivery (ViewModel, response body).
13. Gateways implement the persistence interfaces declared by the Use Cases.
14. Adapters never contain business rules.
15. Adapters depend inward on Use Cases / Entities, never outward on Frameworks.

### Frameworks & Drivers

16. Framework code is glue only. It wires Adapters to the framework runtime.
17. Web framework controllers in the Frameworks layer call Adapters, not Use Cases directly.
18. ORM-mapped models, framework annotations, configuration code, dependency injection wiring live here.

## Composition rules

1. **Composition Root is in the outermost layer.** The main / startup / DI container assembles all components.
2. **Inner layers never construct outer layer types.** Dependencies are injected through interfaces defined by the inner layer.
3. **Plug-in architecture.** A change in framework, DB, or UI must require changes only in the outer layers. Inner layers stay untouched.

## Forbidden patterns (inviolable)

- **Use Cases referencing framework types** (HTTP request, ORM entity, file handle, vendor SDK type).
- **Entities referencing persistence frameworks** (ORM annotations, database column attributes that encode behavior).
- **Anemic Entities.** Behavior must accompany data.
- **Skipping a layer for convenience** (Controller calling a repository directly, Presenter calling the database).
- **Returning framework / ORM types from a Use Case.**
- **Use Case knowing the concrete Adapter** (e.g., calling a specific HTTP client class). Use Cases declare interfaces; Adapters implement.
- **Shared "Util" / "Helper" classes spanning layers** with hidden business rules.
- **Database-driven design** where the schema dictates Entity shape.
- **Cross-layer reach-around** (Framework code calling Use Cases bypassing Adapters, Adapters calling Frameworks bypassing the Composition Root).
- **Concentric layers reorganized as feature folders** that hide which layer a unit belongs to.

## Reviewer enforcement (gate 5)

Reviewer rejects (BLOCKED) when:
- An Entity or Use Case imports a framework, ORM, HTTP, or vendor SDK type.
- A Use Case returns a framework / ORM / DTO defined in an outer layer.
- A Controller invokes persistence directly instead of going through a Use Case.
- An Adapter contains a business rule.
- An inner-layer file imports an outer-layer file (direct dependency violation).
- Boundary crossings carry framework-specific types instead of plain DTOs.
- Use Cases or Entities are not testable without infrastructure.

Reviewer warns (APPROVED_WITH_WARNINGS) when:
- A Use Case is named after a CRUD verb without application semantics.
- An Entity has only getters/setters (anemic).
- An Adapter file leaks framework annotations into its public interface.
- The Composition Root is split across layers instead of living in the outermost layer.

## Anti-patterns

- "Service" layer mixing Use Cases with Adapter responsibilities
- DTOs leaking into Entities
- ORM entities serving as both Entity and persistence model
- Controller-with-business-logic
- Use Case classes that depend on framework annotations
- Hexagonal-style port terminology used to disguise a violation (the rule is the Dependency Rule, not the port naming)

## Outputs

Does NOT produce own files. Modifies parent agent's structural decisions during code authoring and review.
