---
globs: src/lib/services/**/*.ts
---

# Service Layer

Services live in `src/lib/services/` and contain all business logic. Rules:

- Services are **classes** that receive their repository and service dependencies via constructor injection — no `createDb()` or `createContainer()` calls inside a service.
- Each service is registered in `container.ts` via `createContainer`. When adding a new service, wire it there and export it from the `Container` interface.
- Services must not import from `src/app/` or use Next.js APIs (`NextRequest`, `NextResponse`, etc.).
- Async operations that are long-running or should be queued must go through `JobDispatcher` — never block the request with slow I/O.
- Errors that represent domain violations (e.g., acting on a dropped company) should be typed custom `Error` subclasses, not raw `throw new Error('...')`.
- Keep methods focused: one public method = one distinct business operation. Shared internals go in private helpers.
