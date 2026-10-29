---
globs: src/app/api/**/*.ts
---

# API Route Handlers

Every route handler in `src/app/api/` must follow this structure:

```ts
export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { someService } = createContainer(db);
    // ... parse params, call service, return NextResponse.json({ data })
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

Rules:
- Always call `createDb()` and `createContainer(db)` inside the handler — never at module scope.
- Return `NextResponse.json({ data: ... })` for success and `NextResponse.json({ error: ... }, { status: N })` for errors. Never return raw objects.
- Wrap the entire body in `try/catch` and return a 500 on unexpected errors.
- Parse query params from `req.nextUrl.searchParams`; parse body with `req.json()`.
- Do not write business logic in route files — delegate entirely to a service from the container.
- **No SQL in a route.** Never call `db.execute(...)`, `db.select/insert/update/delete`, write a `sql\`...\`` template, or import from `drizzle-orm` in `src/app/`. Never construct a repository (`new XRepository(db)`) in a route either — add a repository method, call it from a service, and call the service. The `db` a route creates exists only to pass to `createContainer`.
- Authentication/authorization checks belong in middleware or at the top of the handler before any service call.

## Reviewing a diff

Reject a route diff that:

- imports from `drizzle-orm` or runs any query on `db` directly
- constructs a repository instead of calling a service
- puts business logic (branching on data, computing derived values) in the handler
