---
name: pr-review
description: Review a pull request for this repo. Use when the user asks to review a PR (e.g. "/pr-review 42", "review PR #42", "review this branch"). Fetches the diff, checks it against project conventions (TS strict, jobs/job_logs for async work, Drizzle repo layer, Next.js app router), and returns an actionable review.
---

# PR Review

Review a PR against this repo's conventions. Returns: a verdict (approve / request changes / comment), a short summary, and a grouped list of findings with file:line references.

## Inputs

The user either gives a PR number (`/pr-review 42`) or no argument (review the current branch vs `main`).

## Steps

1. **Gather the diff.**
   - If PR number given: `gh pr view <N> --json title,body,baseRefName,headRefName,author,files`, then `gh pr diff <N>`.
   - If no arg: `git fetch origin main` → `git diff --stat origin/main...HEAD` → `git diff origin/main...HEAD`.
   - Note touched paths; don't re-read files that are fully visible in the diff.

2. **Run structural checks in parallel.**
   - `pnpm lint` (surfaces Next/TS lint errors)
   - `pnpm exec tsc --noEmit` (strict mode is required — see CLAUDE.md)
   - If `e2e/` or handlers changed and the user asked for a full review: `pnpm test:e2e` (skip for speed if they asked for a quick pass).

3. **Review against repo conventions.** Flag any violation:
   - **TypeScript strict.** No `any` in new code, no `!` non-null where a guard would do, no `@ts-ignore` without a reason comment.
   - **Async work → jobs table.** Long-running or background operations must enqueue a row in `jobs` and write state transitions to `job_logs` (see `src/lib/db/schema.ts` and `CLAUDE.md`). Flag in-process `setTimeout`/`setInterval` workers or fire-and-forget promises in handlers.
   - **Data layer.** DB access goes through `src/lib/repositories/*` using Drizzle; handlers in `src/app/api/**` should call a service in `src/lib/services/*`, not query Drizzle directly. Flag handlers that import `@/lib/db/schema` or call `drizzle(...)` inline.
   - **Migrations.** New SQL belongs in `supabase/migrations/` with a `YYYYMMDDHHMMSS_name.sql` prefix. Schema changes in `src/lib/db/schema.ts` without a matching migration is a defect, and vice-versa.
   - **Detail dialog open state.** A record-scoped dialog (`CompanyDetailDialog` and friends) must derive `open` from the selected record, carry `key={record.id}`, null the record in the `onOpenChange` close branch, and guard any async open handler with an `activeRequestIdRef`. A separate `open` boolean is a defect — it leaves the dialog mounted with the previous record's data and flashes it on the next open. See `.claude/rules/dialog-open-state.md`.
   - **Env / secrets.** No hardcoded keys. New `process.env.*` reads should be documented in `.env.example`.
   - **Docs.** Check the change was documented in the right container (CLAUDE.md §Overview):
     a change to system *shape* (new layer, request path, cross-cutting hazard) → `ARCHITECTURE.md`;
     a new route/service/repository/agent tool/job/flag/page → a regenerated `docs/architecture/code-map.md`
     (CI enforces this via `pnpm arch:map:check`); feature detail → `docs/features/<feature>.md`.
     Do NOT ask for a `README.md` update — it is a landing page, not a feature log.
   - **PR template.** Compare the PR body to `.github/PULL_REQUEST_TEMPLATE.md` — flag missing sections (Summary, Changes, Evidence, Related Issues link to MNA-####).

4. **Review the code itself.**
   - Correctness: off-by-ones, unhandled rejections, missing `await`, narrow/widened types.
   - Security: SQL built via string concat (should use Drizzle query builder), XSS in rendered HTML (we use `company_slides.html` — check sanitization), unauthenticated routes under `/api`.
   - N+1 queries in repository methods; missing indexes for new `where` clauses on large tables (`companies`, `company_logs`, `files`).
   - Dead code, TODOs without tickets, commented-out blocks.
   - Tests: new service/repo code without matching tests or Playwright coverage for new user-facing flows.

5. **Write the review.** Format:

   ```
   ## Verdict
   <approve | request changes | comment> — 1 sentence why.

   ## Summary
   <2–3 sentences: what the PR does, scope, risk level.>

   ## Findings
   ### Blocking
   - `path/to/file.ts:42` — <what's wrong, what to do>.
   ### Non-blocking
   - `path/to/file.ts:84` — <suggestion>.
   ### Nits
   - ...

   ## Checklist
   - [x] Lint clean
   - [x] Typecheck clean
   - [ ] Tests added for new behavior
   - [ ] Migration present for schema changes
   - [ ] Docs in the right container (CLAUDE.md §Overview: shape → `ARCHITECTURE.md`, inventory → `pnpm arch:map`, feature → `docs/features/`)
   ```

   Only include sections that have content. If there are no blocking issues, drop the Blocking heading rather than writing "none".

## Posting the review

Only post to GitHub if the user explicitly asks ("post it", "comment on the PR"). Otherwise just return the review text in chat. When posting, use `gh pr review <N> --comment --body-file <tmpfile>` for comments, or `--request-changes` / `--approve` to match the verdict.

## What not to do

- Don't restate the diff — the user can read it. Focus on what's wrong or risky.
- Don't suggest refactors outside the PR's scope unless they block correctness.
- Don't claim a test passed without running it. If you skipped a check, say so in the Checklist.
- Don't push commits or edit the branch. Review only.
