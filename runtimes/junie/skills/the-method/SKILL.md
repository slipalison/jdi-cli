---
name: the-method
description: The Method (Juval Löwy, "Righting Software"). Volatility-based decomposition with universal hierarchy (Clients, Managers, Engines, ResourceAccess, Resources, Utilities). Strict communication rules. Language-agnostic. Mutually exclusive with DDD, Clean Architecture, Hexagonal, Onion, Vertical Slice.
---

# Skill: The Method (Juval Löwy)

Rigid, inviolable design rules from Juval Löwy's *Righting Software*. Decompose by **volatility**, not functionality. Single architecture in the system — do not mix with any other code design.

The Method is the ONLY allowed design when PROJECT.md `Code Design: LOCKED: The Method`. Do not introduce DDD aggregates, Clean Architecture use cases, Hexagonal ports, Onion shells, or Vertical Slice handlers. Do not invent a hybrid.

## Core principle (inviolable)

**Decompose the system by axes of volatility, never by functionality.**

A component is justified only when it encapsulates an independent reason to change. Two pieces of code that change for the same reason belong together. Two pieces that change for different reasons must be separated even if they currently look identical.

If a component has no clear volatility it encapsulates, it must not exist.

## The Universal Hierarchy (mandatory)

Every system has exactly these 5 architectural categories plus 1 cross-cutting category. No other category may be invented.

1. **Clients** — entry points. UI, CLI, public API endpoints, scheduled triggers, test harnesses. Volatility: presentation, protocol, channel.
2. **Managers** — own a use case end-to-end. Sequence the work. Hold the workflow. Volatility: business workflow, use case orchestration.
3. **Engines** — stateless business algorithms. Pure rules, calculations, validation logic. Volatility: business algorithm, formula, policy.
4. **ResourceAccess** — only path to a Resource. Hides the technology of the data store. Volatility: data access technology.
5. **Resources** — the actual data store / external system / queue / cache. Volatility: storage technology, vendor, schema.

Cross-cutting (callable from any layer):

6. **Utilities** — Security, Logging, Diagnostics, Hosting, Configuration, Localization, Pub/Sub bus, Identity. Stateless cross-cutting concerns. Volatility: infrastructure technology.

Every code unit produced MUST belong to exactly one of these categories. If you cannot decide its category, the unit is wrong and must be redesigned.

## Communication rules (inviolable)

The hierarchy is strictly directed. Communication that violates these rules is a defect, regardless of how convenient it appears.

1. **Clients call Managers only.** Clients do not call Engines, ResourceAccess, Resources, or other Clients.
2. **Managers call Engines and ResourceAccess.** Managers may also call Utilities.
3. **Managers do not call Managers directly.** Manager-to-Manager communication, when required, goes through a **Queue** (publish/subscribe via the Utility bus). Never synchronous Manager-to-Manager.
4. **Engines do not call Engines.** Composition of engines happens in the Manager.
5. **Engines do not call ResourceAccess.** The Manager pulls data via ResourceAccess and passes it into the Engine.
6. **Engines and ResourceAccess do not call Clients.** No upward calls.
7. **ResourceAccess is the only component allowed to touch a Resource.** Nothing else (no Manager, no Engine, no Client, no Utility) touches a Resource directly.
8. **Resources do not call anything.** They are passive.
9. **Utilities are callable by any layer, but do not contain business logic.** Utilities never call Managers, Engines, or ResourceAccess.
10. **No skip-level calls upward.** Lower layers never call higher layers synchronously.
11. **Calls fan out, never fan in across the same layer synchronously.** No sideways synchronous calls within Managers or within Engines.

## Volatility rules (inviolable)

1. A component exists only to **encapsulate one axis of volatility**. State it explicitly.
2. The component's public surface must change only when its encapsulated volatility changes. If a change to an unrelated axis requires editing the component, the decomposition is wrong.
3. The more volatile the area, the deeper inside the architecture it lives. The more stable, the closer to the edges.
4. **Functional decomposition is forbidden.** Naming components after features ("OrderManager", "CustomerEngine") is allowed only when the feature itself is a volatility boundary. Naming components after operations ("CreateOrder", "ValidateCustomer") is forbidden.
5. **Naming after volatility, not noun.** Prefer `PricingEngine` (algorithm volatility) over `OrderService` (feature). Prefer `OrderRepository` only if data-access technology is the encapsulated volatility.

## Composability rules

1. Every Manager must be composable. Adding a new Client (new UI, new API) must not require touching the Manager.
2. Engines and ResourceAccess components must be reusable across Managers. If they cannot be reused, the volatility encapsulation is wrong.
3. The system must support adding a new use case by adding 1 Manager (and possibly 1 Client method) without modifying any Engine, ResourceAccess, Resource, or Utility.

## Forbidden patterns (inviolable)

- **No domain-driven aggregates, anti-corruption layers, or bounded contexts** — that is DDD.
- **No use cases as a separate layer** — Managers ARE the use cases. Do not create a "UseCase" layer on top of Managers.
- **No ports & adapters / hexagonal terminology** — ResourceAccess plays the role of adapter for Resources. Do not introduce additional port/adapter layers.
- **No vertical slices** — code is organized by category, never by feature folder.
- **No Onion shells.** No "domain core" layer above Engines.
- **No Repository pattern named after entities** ("UserRepository", "OrderRepository"). ResourceAccess is named after the **resource technology and its volatility**, not after a domain entity. Acceptable: `BillingDataAccess`, `CatalogStore`. Forbidden: `OrderRepository` if "Order" is not a volatility boundary.
- **No anemic Engine** — an Engine without business logic is forbidden. An Engine with only getters/setters is a defect.
- **No business logic in Clients.** Clients only translate input to a Manager call and present a Manager response.
- **No business logic in ResourceAccess.** ResourceAccess maps technology to in-memory representations and nothing more.
- **No business logic in Resources.** Stored procedures, triggers, or business-logic-bearing schemas are violations.
- **No business logic in Utilities.** Utilities are infrastructure.
- **No bypassing ResourceAccess** to touch a Resource (no ORM call in a Manager, no raw SQL in an Engine).
- **No shared mutable state across components.** Engines are stateless. Managers hold transient workflow state only.

## Mandatory acceptance per code unit

Before any Manager / Engine / ResourceAccess / Client / Utility is committed, the author must be able to answer:

1. Which one of the 6 categories does this belong to? (must be exactly one)
2. What single axis of volatility does it encapsulate? (must be statable in 1 sentence)
3. Which categories does it call? (must comply with the communication rules above)
4. What change in the system would cause it to be edited? (must be the volatility it encapsulates, nothing else)
5. Is it composable: can another Manager / Client be added without modifying this unit? (must be yes for non-Client units)

A unit failing any answer must be redesigned before it ships.

## Reviewer enforcement (gate 5)

Reviewer rejects (BLOCKED) when:
- A Client calls Engine / ResourceAccess / Resource directly.
- A Manager calls another Manager synchronously.
- An Engine calls another Engine.
- An Engine calls ResourceAccess.
- Any code outside ResourceAccess touches a Resource.
- A Utility contains business logic.
- A Repository / Service / Manager is named after a noun-entity instead of a volatility axis (warn first, block on second occurrence in the same PR).
- The PR adds a new top-level category not in the universal hierarchy.
- The PR splits code by feature folders instead of by category.

Reviewer warns (APPROVED_WITH_WARNINGS) when:
- A component's encapsulated volatility is not declared (missing 1-line statement at top of file or class).
- An Engine has no behavior (anemic).
- A new Manager was added without a Client-level entry point.

## Anti-patterns

- "Service layer" with mixed Manager + Engine responsibilities
- "Helper" / "Util" classes containing business logic
- Domain entity classes with both data and behavior bound to persistence
- "Facade" components that hide multiple Managers behind a single class
- ResourceAccess methods that return business-decided values instead of raw data
- Cross-Manager transactions implemented via direct calls
- Synchronous chains crossing 3+ layers

## Outputs

Does NOT produce own files. Modifies parent agent's structural decisions during code authoring and review.
