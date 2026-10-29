---
globs: src/lib/repositories/**/*.ts
---

# Repository Layer

Repositories live in `src/lib/repositories/` and are the only place allowed to touch the database — every query, including one-off raw SQL, goes in a repository method. Routes and services never query `db` directly (see `api-routes.md`). Rules:

- Repositories are **classes** that receive a `DbClient` (typed as `DbClient` from `@/lib/repositories`) via the constructor. No `createDb()` inside a repository.
- Use Drizzle ORM for all queries — no raw SQL strings unless absolutely required (e.g., a complex CTE), and then use `sql` tagged template from `drizzle-orm`.
- Import schema tables from `@/lib/db/schema` and Drizzle helpers (`eq`, `inArray`, `and`, `desc`, etc.) from `drizzle-orm`.
- Repository methods must be pure data access — no business rules, no side effects beyond the DB write.
- Guard against vacuous queries (e.g., `inArray` with an empty array crashes Drizzle — return early with `[]` instead).
- Export the repository class and its filter/input types from `src/lib/repositories/index.ts`.
- A table the app only reads (e.g. a pipeline-owned `analytics.*` table) still gets an entry in `src/lib/db/schema.ts` and a repository — see `VaultExportRepository` for `analytics.vault_exports`.
