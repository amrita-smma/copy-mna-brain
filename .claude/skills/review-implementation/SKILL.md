---
name: review-implementation
description: "Use post-implementation, pre-PR, to validate a branch's diff against this repo's own architecture rules: repository/service/route layering, N+1 query rules, Drizzle migration/seed conventions, admin-route secret gate, agent design pattern, feature flags, and test coverage. Produces `.review-implementation.md` with a PASS/WARN/NEEDS_FIX verdict. Local, pre-push gate — distinct from /pr-review, which is a conversational review of an already-open PR."
---

# Review Implementation — Pre-PR Convention Compliance

Goal: catch violations of this repo's own layering and convention rules — before pushing,
while the change is still local and cheap to fix. Runs entirely against `git diff`; never
touches GitHub. Checks are drawn straight from `.claude/rules/*.md` and `CLAUDE.md` — this
is a compliance pass against documented rules, not a general code review.

**When to reach for this vs `/pr-review`:** `/pr-review` reviews a specific PR/branch and
returns a conversational verdict — good for a one-time human-in-the-loop check. This skill
is meant to be re-run repeatedly on an uncommitted/unpushed branch while you fix things; it
writes a durable, category-scored report instead of a chat message.

## Hard Gate

- **Read-only.** Never edit source, migrations, schema, or tests to "fix" a finding —
  report it and let the developer fix it.
- **Never auto-commit, stage, or push.** The report file is written but not `git add`-ed.
- **No spec-ID framework.** This repo has no PRD/FR/ticket system for feature code — tie
  findings to `file:line`, not to invented requirement IDs.
- **Degrade uncertain judgment.** If you can't confidently tell whether a business-logic
  change actually does what it looks like it's supposed to, that's **Important**, never
  **Critical**. Critical is reserved for a rule you can point to a specific line for.

## Inputs

- `<base-ref>` — optional, defaults to `main`. Diff scope is `origin/<base-ref>...HEAD`.
- `--verbose` — optional. Print per-finding reasoning to stdout in addition to the report.

## Process

Use TodoWrite to track each layer below.

### Layer 1 — scope the diff

1. `git rev-parse --show-toplevel` — confirm we're inside the repo. Not a git repo → fail.
2. `git fetch origin <base-ref>`, then:
   - `git diff --stat origin/<base-ref>...HEAD` for touched paths
   - `git diff origin/<base-ref>...HEAD` for content
   Don't re-read files already fully visible in the diff output.
3. Bucket touched files by convention area — **a category with an empty bucket is skipped
   entirely** and reported as N/A, not run against unrelated files:

   | Bucket | Path glob |
   |---|---|
   | Repositories | `src/lib/repositories/**` |
   | Services | `src/lib/services/**` |
   | Routes | `src/app/api/**/route.ts` |
   | Admin routes | `src/app/api/auth/**`, `src/proxy.ts` |
   | Migrations | `drizzle/migrations/**`, `data-pipeline/migrations/**` |
   | Seeds | `scripts/seed.ts`, any other `scripts/*seed*.ts` |
   | Agents | `src/lib/agents/**` |
   | Flags / layout | `src/lib/flags.ts`, `src/components/layout/DashboardLayout.tsx`, `src/app/**/page.tsx` |
   | Tests | any `*.test.ts` in the diff |

4. If the diff is empty against `<base-ref>` → stop, print `Nothing to review — branch matches <base-ref>.`

### Layer 2 — run the categories that apply

For each category, classify findings **Critical** (blocks push), **Important** (fix in same
PR), or **Minor** (nit / follow-up). Only run a category if its bucket is non-empty.

**1. Repository layer** (`.claude/rules/repositories.md`) — bucket: Repositories
- Critical: not a class, or constructor param isn't typed `DbClient`; `createDb()` called
  inside a repository file; raw SQL string concatenation instead of Drizzle / a `sql`
  tagged template; `inArray(...)` called without an empty-array guard before it.
- Important: schema imported from anywhere other than `@/lib/db/schema`, or Drizzle helpers
  imported from anywhere other than `drizzle-orm`; conditional business logic (not query
  shaping) inside a repository method; a new repository class/type not exported from
  `src/lib/repositories/index.ts`.
- Minor: naming/shape deviates from sibling repositories in the same directory.

**2. Service layer** (`.claude/rules/services.md`) — bucket: Services
- Critical: `createDb()` or `createContainer()` called inside a service; a service imports
  from `src/app/` or references `NextRequest`/`NextResponse`.
- Important: a new service not wired into `createContainer` in `container.ts` and not
  exported from the `Container` interface; long-running/slow I/O (polling, batch external
  calls) not routed through `JobDispatcher`; a domain violation thrown as a raw
  `throw new Error('...')` instead of a typed `Error` subclass.
- Minor: a public method visibly doing more than one distinct business operation instead
  of delegating to private helpers.

**3. API routes + admin gate** (`.claude/rules/api-routes.md`, CLAUDE.md "Admin Routes")
— bucket: Routes, Admin routes
- Critical: handler returns a raw object instead of `NextResponse.json(...)`; handler body
  isn't wrapped in `try/catch`; `createDb()`/`createContainer(db)` called at module scope
  instead of inside the handler function; a new route under `src/app/api/auth/<route>/` (or
  a new dynamic segment) whose path isn't added to the `matcher` array in `src/proxy.ts`; a
  per-handler `auth()` session check added to a route under `src/app/api/auth/**` (auth is
  the middleware's job there, not the handler's).
- Important: business logic written directly in the route file instead of delegated to a
  service; query params parsed from something other than `req.nextUrl.searchParams`.
- Minor: error status code choices inconsistent with sibling routes.

**4. N+1 / query performance** (CLAUDE.md "Backend Development & Query Performance")
— bucket: Repositories, Services, Routes
- Critical: a per-id repository method (`findByXId`, `findByFundId`, etc.) called inside a
  `.map`/`for`/`forEach`/`Promise.all` over a collection — this is the pattern that
  exhausted the Postgres pool (`53300`) before; a React view issuing one HTTP request per
  row instead of calling one batched endpoint.
- Important: a new `findByXIds`-style bulk method missing the empty-array early return, or
  missing `orderBy` on the grouping key it's meant to be grouped by; an unbounded/unpaginated
  `SELECT` over a table that can grow large; a new filtered or joined column on a hot query
  path with no corresponding index.
- Minor: the same query issued more than once per request when it could be hoisted or
  batched.

**5. Drizzle migrations & seeding** (`.claude/rules/drizzle-migrations.md`, CLAUDE.md
"Database Seeding"/"Database Migrations") — bucket: Migrations, Seeds
- Critical: a migration filename that doesn't match `YYYYMMDDXXXXXX_<slug>.sql` with a
  same-day sequence counter (i.e., wasn't produced by `pnpm db:migration:new`); any diff
  touching `meta/_journal.json` by hand; a diff that modifies an existing, previously
  committed migration file instead of adding a new one; a new standalone seed script added
  instead of extending `scripts/seed.ts`.
- Important: a destructive change (column drop, type change) that isn't a two-phase
  migration.
- Minor: migration slug isn't descriptive snake_case.

**6. Agent design pattern** (CLAUDE.md "Agent Design Pattern") — bucket: Agents
- Critical: a new agent folder missing `index.ts`, or `index.ts` doesn't use `createAgent`
  or isn't streaming; a tool implemented inline in `index.ts` instead of its own file under
  `tools/`.
- Important: `tools/index.ts` not updated to register a newly added tool; a new
  `tools/<tool_name>.ts` with no matching `tools/<tool_name>.test.ts`.
- Minor: tool filename doesn't match `<tool_name>.ts`.

**7. Feature flags** (CLAUDE.md "Feature Flags") — bucket: Flags / layout
- Critical: a flag resolved inside a client component or `useEffect` instead of a server
  page; flag resolution happening inside `DashboardLayout` or a view instead of the page
  file.
- Important: a view with multiple render branches (loading/error/empty) that doesn't pass
  the same flag props to every `<DashboardLayout>` it renders (causes nav flicker); a new
  flag defined with `defaultValue: true`.
- Minor: export name doesn't follow `<featureName>Enabled` / prop doesn't follow
  `show<FeatureName>`.

**8. Test coverage** (CLAUDE.md "Overview", "Test Files") — bucket: Tests, plus cross-check
against Repositories/Services buckets
- Critical: a changed file under `src/lib/**` with no corresponding `*.test.ts` addition or
  update anywhere in the diff; a test file importing `jest` or using Jest-only globals.
- Important: mocks not reset with `.mockReset()` in `beforeEach` (or no
  `afterEach(() => vi.clearAllMocks())` when `beforeEach` isn't used); a repository test
  hitting something other than a typed `db as never` mock with chain stubs.
- Minor: `describe` block not named `ClassName.methodName` / `functionName`, or test names
  describe implementation instead of expected behavior.

### Layer 3 — compile, verdict, report

1. Sort findings by severity, then by category order (1→8).
2. Verdict: any Critical → `NEEDS_FIX`; else any Important → `WARN`; else `PASS`. Minor
   findings never change the verdict.
3. Write `.review-implementation.md` at repo root:

   ```markdown
   # Pre-PR Review — <branch> vs <base-ref> — <YYYY-MM-DD>

   **Verdict: <PASS | WARN | NEEDS_FIX>**

   ## Summary
   - 1. Repository layer: <crit>/<imp>/<min> (or N/A)
   - 2. Service layer: ...
   - 3. API routes + admin gate: ...
   - 4. N+1 / query performance: ...
   - 5. Drizzle migrations & seeding: ...
   - 6. Agent design pattern: ...
   - 7. Feature flags: ...
   - 8. Test coverage: ...

   ## Critical (fix before pushing)
   ### C-<n>: <one-line summary>
   - **Location:** `path/to/file.ts:42`
   - **Rule:** <which rule file / CLAUDE.md section>
   - **Observed:** <what the diff does>
   - **Fix:** <concrete next step>

   ## Important (fix in same PR)
   ...

   ## Minor (consider for follow-up)
   ...
   ```
4. Ensure `.review-implementation.md` is gitignored:
   `grep -qF '.review-implementation.md' .gitignore || echo '.review-implementation.md' >> .gitignore`
5. Print a stdout summary table plus verdict-dependent next step:
   - **PASS** → `git push`, then `/pr-review` or open the PR.
   - **WARN** → fix Important findings, re-run.
   - **NEEDS_FIX** → fix Critical findings before pushing; re-run this skill.
6. `--verbose` → also print one-paragraph reasoning per finding to stdout.

## Failure Modes

| Stage | Failure | Behavior |
|---|---|---|
| 1 | Not a git repo | Fail with instruction to `cd` into the repo |
| 1 | `<base-ref>` doesn't exist on origin | Fail, suggest `main` |
| 1 | Empty diff | Stop early, print "nothing to review" |
| 2 | A bucket has files but none match any rule pattern | Report category as PASS with 0 findings, not N/A |
| 2 | Ambiguous business-logic correctness | Degrade to Important per the Hard Gate rule |
| 3 | `.gitignore` write fails | Print a warning, continue — the report is still written |

## What NOT to Do

- Don't flag categories whose bucket is empty — an unrelated pre-existing violation
  elsewhere in the repo is out of scope for this diff's review.
- Don't rewrite the finding's file to fix it — this skill only reports.
- Don't treat this as a substitute for `pnpm lint` / `pnpm exec tsc --noEmit` — those still
  need to pass; this skill checks architecture conventions those tools don't.
- Don't skip Category 8 just because "the logic is simple" — the repo's stated rule is
  every `src/lib` change gets a test, no exceptions carved out here.

## Why This Skill

The repo encodes its architecture as rules the team actually enforces in review — layering
(repositories → services → routes), the N+1 guardrail called out explicitly in CLAUDE.md
after a real pool-exhaustion incident, and narrower per-feature conventions (admin secret
gate, agent folder shape, feature flags). Those are cheap to check mechanically against a
diff and expensive to catch after a PR is already open. Running this locally, repeatedly,
while still iterating turns "reviewer catches it in two days" into "caught in the same
session it was written."
