---
name: hexagonal
description: Hexagonal Architecture / Ports and Adapters (Alistair Cockburn). Application core in the center, surrounded by Ports (interfaces owned by the core) and Adapters (implementations). Driving (primary) vs Driven (secondary) sides. Language-agnostic rigid rules. Mutually exclusive with The Method, DDD, Clean Architecture, Onion, Vertical Slice.
---

# Skill: Hexagonal Architecture (Ports and Adapters)

Rigid, inviolable rules from Alistair Cockburn's Ports and Adapters. The application is a **core** isolated from the outside world by **ports** (interfaces) and **adapters** (implementations).

Hexagonal is the ONLY allowed design when PROJECT.md `Code Design: LOCKED: Hexagonal`. Do not use The Method, DDD as primary structure, Clean Architecture's 4-layer terminology as primary structure, Onion shells, or Vertical Slice feature folders as primary structure.

## Mandatory structure

The system consists of exactly three structural elements:

1. **Application Core (the hexagon)** — domain model + application logic. Knows nothing about technology, protocols, or external systems. The core is the only place where business rules exist.
2. **Ports** — interfaces **owned by the core** that declare what the core needs from the outside (driven ports) or what the outside can ask the core to do (driving ports). A port is an abstract contract; it has no implementation in the core.
3. **Adapters** — implementations of ports living outside the core. Adapters translate between the technology-specific outside world (HTTP, DB, queue, file, UI) and the technology-free core.

Every code unit belongs to exactly one of: Core, Port (still inside the core's package), or Adapter. A unit that does not fit must be redesigned.

## Driving vs Driven (mandatory)

1. **Driving (primary) side** — the side that initiates interaction with the core. UI, HTTP controllers, CLI handlers, scheduled job triggers, integration tests. Driving adapters invoke driving ports.
2. **Driven (secondary) side** — the side the core delegates to. Persistence, message bus, external APIs, file system, email, cache. The core invokes driven ports, which are implemented by driven adapters.
3. **Driving port** is an interface that exposes the core's capabilities to the outside. **Driven port** is an interface declared by the core that the outside must satisfy.
4. **Direction of dependency: adapters depend on ports; ports live in the core; the core depends on nothing infrastructural.**

## Inviolable rules

### Core purity

1. The core has zero imports from any framework, ORM, HTTP library, vendor SDK, file system API, or transport library.
2. The core defines its own types for inputs and outputs to ports. Adapter types (HTTP request, ORM model, queue message) do not appear in core code.
3. The core does not know the identity of any adapter. It interacts only with ports.
4. The core does not perform I/O. All I/O happens through driven ports.
5. The core is fully testable without any adapter. If a unit test of the core requires spinning up DB / HTTP / queue, the design is wrong.

### Ports

6. A port is an interface. It has no logic.
7. Ports live in the core's package / module. They are not in an "infrastructure" or "adapters" package.
8. The core defines a port; the adapter implements it. A port defined outside the core, or implemented in the core, is forbidden.
9. Driving ports name capabilities of the core in domain language (e.g., `PlaceOrder`, `RenewSubscription`). Driven ports name dependencies in domain language (e.g., `OrderRepository`, `NotificationSender`).
10. Port methods receive and return only types defined inside the core. They do not receive HTTP requests, ORM entities, or framework-specific types.

### Adapters

11. An adapter implements exactly one port (driving or driven). An adapter that mixes driving and driven roles is forbidden.
12. A driving adapter translates an external trigger (HTTP request, CLI command, message, schedule) into a core-defined input and invokes a driving port.
13. A driven adapter translates a core-defined call into a technology-specific action (SQL query, HTTP call, file write, queue publish) and translates the result back into core-defined output.
14. Adapters contain only translation and I/O. Business rules in an adapter are forbidden — they must move into the core.
15. Adapters never call other adapters directly. Coordination between adapters happens through the core via a driving adapter → core → driven adapter sequence.
16. Adapters never call the core's internal classes directly. They go through ports.

### Composition

17. The Composition Root assembles adapters and injects them into the core at startup. The core does not construct its own adapters.
18. Replacing an adapter (e.g., swapping PostgreSQL for MongoDB, REST for gRPC) must not require changes inside the core. If it does, the port is leaking.
19. Multiple adapters may implement the same port. The core does not know how many.
20. Test adapters (fakes, in-memory implementations) are first-class adapters and must use the same ports as production adapters. The core cannot have a "test-only" code path.

## Forbidden patterns (inviolable)

- **Framework types crossing into the core.** No HTTP request type, no ORM entity, no vendor SDK type referenced in core code.
- **Business rules in adapters.** A driven adapter computing a price, a driving adapter validating a domain rule — both forbidden.
- **Adapters calling adapters.** Adapter coordination outside the core is forbidden.
- **Core code instantiating an adapter.** Construction happens in the Composition Root.
- **Ports defined outside the core.** A port placed in an "infrastructure" module is a violation.
- **Anemic core.** A core without behavior is a violation — adapters become a leak path for rules.
- **A driving port returning a framework-specific type** (a port returning `HttpResponse` is wrong).
- **Driven ports leaking persistence concepts** (a port named `SqlUserRepository` is wrong; it must be domain-named).
- **Mixed-role adapter** (one adapter both responding to HTTP and writing to DB).
- **Bypassing ports** by injecting an adapter directly where a port should appear.
- **Concentric layer terminology** ("Entities layer", "Use Cases layer", "Application Services layer") imposed as the primary structure — Hexagonal organizes by core/ports/adapters, not by concentric layers.

## Naming conventions

- Driving ports: domain capability verbs (`PlaceOrder`, `RegisterCustomer`).
- Driven ports: dependency names in domain language (`OrderRepository`, `EmailSender`, `PaymentGateway`).
- Adapters: technology-qualified (`HttpPlaceOrderAdapter`, `PostgresOrderRepositoryAdapter`, `SmtpEmailSenderAdapter`).
- The core never references a name containing a technology word.

## Reviewer enforcement (gate 5)

Reviewer rejects (BLOCKED) when:
- Core code imports a framework / ORM / HTTP / vendor SDK / file-system type.
- A port is defined outside the core or implemented inside the core.
- A port method's signature mentions a framework-specific type.
- An adapter contains business logic.
- An adapter calls another adapter directly.
- The core instantiates an adapter.
- A driven port name leaks a persistence technology.
- A driving adapter returns the result of a port call without translating from a core type to an external type.

Reviewer warns (APPROVED_WITH_WARNINGS) when:
- An adapter file is doing more translation than necessary (smell: complex mapping suggesting hidden rules).
- A port is implemented by a single adapter and is unlikely ever to vary (still allowed — keep the port).
- A core class has no behavior (anemic).
- Composition wiring is scattered instead of centralized in a Composition Root.

## Anti-patterns

- "Service" layer between core and adapters (no such thing in Hexagonal)
- Repository implemented inside the core (must be a port)
- Use Case classes shaped after Clean Architecture's Use Case layer (the structure is core/ports/adapters)
- Ports tied to a transport (e.g., `RestOrderPort`) — ports are domain-shaped, adapters are transport-shaped
- "Domain Services" terminology imported wholesale from DDD as the primary structure (acceptable internal to the core when meaningful, but does not replace the hexagonal primary structure)

## Outputs

Does NOT produce own files. Modifies parent agent's structural decisions during code authoring and review.
