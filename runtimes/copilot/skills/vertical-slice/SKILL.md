---
name: vertical-slice
description: Vertical Slice Architecture (Jimmy Bogard). Organize by feature, not by technical layer. Each feature owns its full request-to-response path with minimal sharing. Language-agnostic rigid rules. Mutually exclusive with The Method, DDD, Clean Architecture, Hexagonal, Onion.
---

# Skill: Vertical Slice Architecture

Rigid, inviolable rules from Jimmy Bogard's Vertical Slice Architecture. The system is organized by **feature**, not by technical layer. Each slice owns the full path from external request to external response.

Vertical Slice is the ONLY allowed design when PROJECT.md `Code Design: LOCKED: Vertical Slice`. Do not impose Clean Architecture's 4-layer structure, Onion shells, Hexagonal core/ports/adapters, DDD aggregates as primary structure, or The Method's universal hierarchy on top.

## Mandatory structure

1. **Each feature is one slice.** A feature is a single user-facing capability (e.g., `RegisterCustomer`, `CancelOrder`, `RenewSubscription`).
2. **A slice owns its full pipeline:** input contract, validator, handler, business logic, persistence access, output contract, and slice-specific tests.
3. **Slices live in feature folders / packages.** The primary code organization is `features/{feature-name}/` (or equivalent in the language). Technical-layer folders (`controllers/`, `services/`, `repositories/`, `models/`) as the primary structure are forbidden.
4. **Each feature folder is self-contained.** Inside a folder live only the artifacts that serve that feature.
5. **No shared "Service" layer, no shared "Repository" layer, no shared "Manager" layer across slices.** Each slice has its own.

## Slice isolation rules (inviolable)

1. **Slices do not call each other directly.** If slice A needs work done by slice B, slice A either duplicates the minimum needed code OR they both publish/subscribe to a shared event bus. Direct invocation of slice B's handler from slice A is forbidden.
2. **No shared mutable state across slices.** A slice never mutates state owned by another slice except through the shared persistence boundary, and never through another slice's handler.
3. **DRY applies inside a slice, not across slices.** Two slices that look similar today are still allowed to diverge tomorrow. Forced sharing is the enemy.
4. **Cross-slice abstractions are introduced only when 3+ slices need the exact same behavior with the exact same shape, and that behavior is stable.** Premature shared abstractions are violations.

## Slice composition (mandatory contents)

Each slice MUST contain:

1. **Request / Command / Query contract** — a structure describing the input.
2. **Handler** — receives the request, executes the logic, returns the response.
3. **Validator** (if input requires validation) — slice-local validation rules.
4. **Response contract** — the output shape returned to the caller.
5. **Slice-local types** — any DTOs, view models, or projections the slice needs.
6. **Slice-local tests** — integration tests that exercise the slice end-to-end.

A slice MAY contain:

- A slice-specific persistence access path (raw query, ORM query, projection, command-side persistence).
- A slice-specific external system call.
- Slice-local pre/post processing.

A slice MUST NOT contain:

- References to another slice's handler, request, or response types.
- References to a shared "Service" abstracting multiple slices.
- A "Manager" coordinating multiple slices.

## Cross-cutting concerns (inviolable)

1. Cross-cutting concerns (logging, authentication, authorization, transactions, validation pipeline, error handling) are applied as **pipeline behaviors / middleware** that wrap the handler, never as shared services injected into the handler.
2. Authentication and authorization decisions may use shared types (claims, principals) but are enforced at the pipeline level, not inside the handler.
3. Validation runs as a pipeline step before the handler executes. The handler assumes valid input.
4. Logging, tracing, metrics: pipeline behaviors. The handler does not invoke logging libraries for cross-cutting purposes.

## Persistence rules

1. **No generic repository spanning slices.** A slice that needs persistence either uses the ORM/database client directly within the slice OR has its own slice-local repository.
2. **Reads and writes may diverge structurally.** A slice that reads may use a different model than a slice that writes; this is encouraged.
3. **No "Domain Model" required to be shared across slices.** Each slice models the data it needs in the shape it needs.
4. **A shared schema (database) is acceptable; a shared in-code model abstraction is not.**

## Forbidden patterns (inviolable)

- **Technical-layer primary folders** (`controllers/`, `services/`, `repositories/`, `models/`) used as the system's primary organization.
- **A handler calling another handler.**
- **A "Service" class injected into multiple handlers** to provide their business logic.
- **A "Manager" class coordinating multiple slices.**
- **A shared "Repository" abstraction** consumed by 5+ slices.
- **Cross-slice imports of internal slice types.** Slice A importing `B.HandleQuery` or `B.RequestDto` is forbidden.
- **Slice A invoking slice B via an internal interface** instead of via the public boundary (HTTP, queue, event).
- **DRY refactoring that merges 2 slices into 1 because they share 80% of the code.** Slices stay separate until 3+ identical use cases exist with stable shape.
- **Forcing all slices through a shared base handler class** that contains business logic.
- **A shared "Domain Model" referenced by all slices** as the primary modeling element.

## Naming conventions

- Feature folders: feature name in domain language (`RegisterCustomer/`, `CancelOrder/`, `ViewCustomerDashboard/`).
- Request types: domain operation name (`RegisterCustomerCommand`, `CancelOrderCommand`, `ViewCustomerDashboardQuery`).
- Handler types: paired with request (`RegisterCustomerHandler`).
- Validator types: paired with request (`RegisterCustomerValidator`).
- Response types: domain output name (`RegisterCustomerResponse`).
- Internal slice types: prefixed by feature name when shared inside the slice (`RegisterCustomerEmailTemplate`).

## Reviewer enforcement (gate 5)

Reviewer rejects (BLOCKED) when:
- The codebase is primarily organized by technical layer instead of by feature.
- A handler invokes another slice's handler, request, or response type.
- A new "Service" / "Manager" / "Coordinator" class is introduced that spans multiple slices and carries business logic.
- A shared generic repository is introduced and consumed by multiple slices.
- Cross-cutting concerns are injected into handlers as shared services instead of applied as pipeline behaviors.
- Slice A imports types from slice B's internal folder.

Reviewer warns (APPROVED_WITH_WARNINGS) when:
- Two slices share an identical small helper that has been duplicated 3+ times (candidate for extraction, not required).
- A slice contains logic that appears to belong to a different slice.
- A slice handler is long enough to suggest splitting into pipeline behaviors.
- A slice references a "Domain Service" or "Aggregate" terminology that may indicate a different design creeping in.

## Anti-patterns

- "Vertical slices" implemented inside an MVC controllers/services/repositories folder structure (the folders betray the layer-primary structure)
- A "Domain" project that all slices reference, containing entities + services + repositories — that is layered or Onion in disguise
- Cross-slice "Coordinator" classes that orchestrate two handlers
- A shared "BaseHandler" that contains transaction management AND business logic
- A slice handler that delegates 90% of its work to a shared service (the slice is hollow)
- Premature "DRY" extraction that merges slices into a generic handler with strategy patterns

## Outputs

Does NOT produce own files. Modifies parent agent's structural decisions during code authoring and review.
