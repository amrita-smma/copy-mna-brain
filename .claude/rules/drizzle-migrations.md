---
globs: drizzle/migrations/**
---

# Drizzle Migrations

When adding a migration file under `drizzle/migrations/` (or `data-pipeline/migrations/`):

1. **Always use the generator — never hand-craft the filename or the journal entry:**
   ```bash
   pnpm db:migration:new <name>                          # drizzle/migrations (default)
   pnpm db:migration:new <name> data-pipeline/migrations  # pipeline migrations
   ```
   This is `scripts/new-migration.ts`. It picks the filename (step 2) and then
   runs `scripts/build-drizzle-journal.ts` for you, so the journal is always
   correct — you never touch it directly.

2. **Filename format:** `YYYYMMDDXXXXXX_<snake_case_description>.sql`, where the
   first 8 digits are **today's UTC date** and `XXXXXX` is a **per-day
   zero-padded sequence counter** — it is *not* a wall-clock time.
   - The first migration created on a given UTC date gets counter `000000`.
   - Each subsequent migration created on that *same* date gets the next
     integer: `000001`, `000002`, ... The generator computes this
     automatically by scanning the folder for the highest existing counter on
     today's date.
   - Because the counter is zero-padded to 6 digits, lexical sort order always
     equals intended apply order — this is what lets migrations from
     different days/branches merge safely. See the `migration-rebase` skill
     for how this convention is preserved across a rebase.
3. **Journal is fully generated, never hand-edited.**
   `drizzle/migrations/meta/_journal.json` is derived entirely from the
   `.sql` filenames by `scripts/build-drizzle-journal.ts` (`pnpm db:journal`
   regenerates both `drizzle/migrations` and `data-pipeline/migrations`).
   Drizzle silently ignores migrations that aren't in the journal, so if you
   ever add/rename a `.sql` file by hand, immediately run `pnpm db:journal`
   afterward instead of editing `_journal.json` yourself.
4. **Non-destructive by default:** Prefer additive changes (new columns, new tables). Column drops or type changes require a two-phase migration.
5. **Never edit an existing migration** that has been applied to any environment. Create a new migration to correct it instead.
