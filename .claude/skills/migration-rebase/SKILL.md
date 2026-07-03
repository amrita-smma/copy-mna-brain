---
name: migration-rebase
description: Renumber this branch's Drizzle migrations so they sort AFTER everything on main, as if they were authored after the rebase. Use when the user asks to "rebase migrations", "renumber migrations", "fix migration ordering after rebase", "my migration timestamp collides with main", or runs `/migration-rebase`. Works on `drizzle/migrations` (default) and `data-pipeline/migrations`.
---

# Migration Rebase

When a feature branch is rebased onto `main`, its migrations may carry timestamps that are **older** than migrations that landed on `main` in the meantime. Drizzle applies migrations in filename order, so an out-of-order branch migration would try to run *before* a `main` migration it actually depends on.

This skill renames the branch's migration files so they sort **after every migration on `main`**, then regenerates the journal.

## How ordering works in this repo (read first)

- `drizzle/migrations/meta/_journal.json` is **not hand-edited** — it is fully regenerated from the `.sql` filenames by `scripts/build-drizzle-journal.ts` (run via `pnpm db:journal`). It sorts files lexically and derives `idx`/`when` automatically.
- Therefore **ordering is determined entirely by the 14-digit filename prefix.** To make a migration "happen after" another, its prefix must be lexically greater.
- Migration filenames use the form `YYYYMMDDXXXXXX_<slug>.sql` where the first 8 digits are the date and the last 6 (`XXXXXX`) are a **per-day sequence counter**, starting at `000001` and ascending. Because the counter is zero-padded to 6 digits, lexical order equals numeric order.

The job of this skill is: pick a target date, assign the branch's migrations the next free sequence numbers on that date, `git mv` them, and rerun `pnpm db:journal`.

## Inputs

- **Base branch** — defaults to `main`. Only override if the user names a different base.
- **Migrations dir** — defaults to `drizzle/migrations`. If the branch's added migrations live under `data-pipeline/migrations`, operate on that folder instead (the same steps apply; regenerate with `pnpm db:journal`, which rebuilds both folders).

## Steps

1. **Sync the base ref.**
   ```bash
   git fetch origin main
   ```
   Use `origin/main` as the base in the commands below (fall back to local `main` if there is no `origin`).

2. **Identify the branch's migrations** — the files added on this branch relative to the merge-base with the base. These are the ONLY files you may rename.
   ```bash
   git diff --diff-filter=A --name-only origin/main...HEAD -- 'drizzle/migrations/*.sql' | sort
   ```
   The sorted result is the branch's migrations **in their intended apply order**. Preserve this order — the new sequence numbers must be assigned in the same order so any inter-migration dependencies still hold.
   - If this returns nothing, there is nothing to rebase — tell the user and stop.
   - Never rename a file that also exists on the base; those are already-applied `main` migrations.

3. **Find the base's latest prefix and the target date's current max counter.** List the base's migration files:
   ```bash
   git ls-tree -r --name-only origin/main -- drizzle/migrations | grep '\.sql$'
   ```
   From these basenames, compute:
   - `baseLatestDate` = the 8-digit date of the largest 14-digit prefix on the base.
   - Pick the **target date `D`** = today's UTC date (`YYYYMMDD`). If today is earlier than `baseLatestDate` (clock skew / future-dated base migration), use `baseLatestDate` instead so the branch still sorts after.
   - `maxCounter` = the largest 6-digit counter among base migrations whose date equals `D` (treat "none on that date" as no counter yet).
   - `startCounter` = `maxCounter + 1` if any base migration is dated `D`, otherwise `1`.

   > Rationale: continuing the counter past the base's last migration on date `D` guarantees every renamed file sorts after all base migrations, while honoring the "from 000001 ascending" per-day rule when `D` is a fresh day.

4. **Compute the new names.** For each branch migration (in the order from step 2), assign `counter = startCounter, startCounter+1, …`. Build the new filename:
   - `slug` = original basename with the leading `\d{14}_` prefix stripped (e.g. `20260630024450_add_is_deal_related_to_topics.sql` → `add_is_deal_related_to_topics`).
   - `newName` = `${D}${counter padded to 6 digits}_${slug}.sql`.
   - Sanity-check `newName` does not already exist and does not collide with another new name in this batch.

5. **Rename with git** (skip any file whose new name equals its current name):
   ```bash
   git mv drizzle/migrations/<oldName> drizzle/migrations/<newName>
   ```

6. **Regenerate the journal** — do NOT hand-edit `_journal.json`:
   ```bash
   pnpm db:journal
   ```
   This rescans the folder and rewrites `meta/_journal.json` with correct `idx`/`when`/`tag` from the new filenames.

7. **Verify.**
   - `git status` — confirm only the intended renames plus the regenerated `_journal.json` changed.
   - Confirm the branch's new prefixes are all lexically greater than `baseLatestDate`'s largest prefix (i.e. they sort last):
     ```bash
     ls drizzle/migrations/*.sql | sort | tail -n $((<count> + 3))
     ```
   - Optionally run `pnpm db:migrate:status` to sanity-check the ordering resolves.

8. **Report** which files were renamed (old → new) and remind the user to commit both the renames and `_journal.json` together.

## Worked example

Base `main` ends at `20260703000001_add_is_live_to_companies.sql`. Today is `2026-07-03`. The branch added two migrations:

```
20260702090000_add_widget_table.sql
20260702093000_backfill_widgets.sql
```

Target date `D = 20260703`; `main` already has counters `000000` and `000001` on that date, so `startCounter = 2`. Result:

```
20260702090000_add_widget_table.sql   → 20260703000002_add_widget_table.sql
20260702093000_backfill_widgets.sql   → 20260703000003_backfill_widgets.sql
```

After `pnpm db:journal`, both appear at the end of the journal, in order, after all of `main`.

## What not to do

- **Never rename a base (`main`) migration.** Only files added on this branch. Renaming an already-applied migration breaks every environment that has run it.
- **Never hand-edit `_journal.json`.** It is generated — run `pnpm db:journal`.
- **Don't reorder the branch's migrations among themselves.** Keep their relative apply order; only shift them as a block to after `main`.
- **Don't edit the SQL contents.** This is a rename-only operation (a leading `-- <name>` comment may now be stale; leave it unless the user asks).
- **Don't collapse the counter below 6 digits** or reuse a counter already present on the target date.
