---
name: new-migration
description: Create a new Drizzle migration file using this repo's date+counter naming convention (no wall-clock timestamps) and regenerate the journal. Use when the user asks to "add a migration", "create a new migration", "make a migration for X", or runs `/new-migration <name>`. Works on `drizzle/migrations` (default) and `data-pipeline/migrations`.
---

# New Migration

This repo names migrations `YYYYMMDDXXXXXX_<slug>.sql`, where the first 8
digits are **today's UTC date** and `XXXXXX` is a **per-day zero-padded
sequence counter** — it is *not* a wall-clock time (`HHMMSS`).

- The **first** migration created on a given UTC date gets counter `000000`.
- **Each subsequent** migration created on that *same* date gets the next
  integer: `000001`, `000002`, `000003`, ...
- Because the counter is zero-padded to 6 digits, lexical filename order
  always equals intended apply order.

This matters because `drizzle/migrations/meta/_journal.json` (which Drizzle
actually reads) is **fully derived from the `.sql` filenames** by
`scripts/build-drizzle-journal.ts` — never hand-edited. Get the filename
convention right and the journal takes care of itself.

## How to create a migration

Always go through the generator — do not write the `.sql` file or touch the
journal by hand:

```bash
pnpm db:migration:new <name>                          # drizzle/migrations (default)
pnpm db:migration:new <name> data-pipeline/migrations  # pipeline migrations
```

This is `scripts/new-migration.ts`. It:
1. Slugifies `<name>` into `snake_case`.
2. Computes today's UTC date (`YYYYMMDD`).
3. Scans the target folder for existing files prefixed `YYYYMMDDXXXXXX_` on
   that date and picks `counter = max(existing) + 1`, or `000000` if none
   exist yet for today.
4. Writes an empty stub `drizzle/migrations/<date><counter>_<slug>.sql`
   (or under `data-pipeline/migrations/` when that dir was passed).
5. Runs `pnpm db:journal`-equivalent (`build-drizzle-journal.ts`) for that
   folder so `meta/_journal.json` is immediately correct.

Then fill in the SQL body yourself.

## If you ever create/rename a `.sql` file by hand

Don't edit `meta/_journal.json` directly. Instead just run:

```bash
pnpm db:journal
```

This rescans both `drizzle/migrations` and `data-pipeline/migrations` and
rewrites both journals from the filenames present. It's always safe to re-run
— idempotent, and it's how `migration-rebase` recovers ordering after a
rebase too.

## Worked example

Today is `2026-08-03` (UTC). No migration yet exists for that date.

```bash
pnpm db:migration:new add_feedback
# → drizzle/migrations/20260803000000_add_feedback.sql
```

A second migration created later the same day:

```bash
pnpm db:migration:new add_feedback_notifications
# → drizzle/migrations/20260803000001_add_feedback_notifications.sql
```

## What not to do

- **Don't use the current wall-clock time** (`HHMMSS`) as the counter — the
  counter is a sequence, not a timestamp. Two migrations authored minutes
  apart on the same day should be `000000`/`000001`, not e.g. `023123`.
- **Don't hand-edit `meta/_journal.json`.** It's generated; always regenerate
  with `pnpm db:journal` after touching filenames directly.
- **Don't reuse a counter already present on that date**, and don't skip
  ahead arbitrarily — always `max(existing) + 1`.
- **Don't rename or renumber a migration that's already been applied** to any
  environment (see the `migration-rebase` skill for the one exception: an
  unapplied branch migration that needs to sort after a rebased `main`).
