---
globs: drizzle/migrations/**
---

# Drizzle Migrations

When adding a migration file under `drizzle/migrations/`:

1. **Filename format:** `YYYYMMDDHHMMSS_<snake_case_description>.sql` — the timestamp must be unique and monotonically increasing.
2. **Journal entry:** Every new `.sql` file must have a matching entry added to `drizzle/migrations/meta/_journal.json`:
   ```json
   {
     "idx": <next integer>,
     "version": "7",
     "when": <Unix ms timestamp matching the filename>,
     "tag": "<filename without .sql>",
     "breakpoints": true
   }
   ```
   Drizzle silently ignores migrations that are not in the journal.
3. **Non-destructive by default:** Prefer additive changes (new columns, new tables). Column drops or type changes require a two-phase migration.
4. **Never edit an existing migration** that has been applied to any environment. Create a new migration to correct it instead.
5. Use `pnpm run db:migration:new` (via `scripts/new-migration.ts`) to generate the file and journal entry automatically when possible.
