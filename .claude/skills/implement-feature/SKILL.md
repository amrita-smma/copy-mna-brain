---
name: implement-feature
description: "Implement or extend a backend feature in mna-brain (Next.js App Router + Drizzle + vitest, repositories → services → routes). Operates exclusively within src/, drizzle/migrations/, and scripts/seed.ts. Idempotent: detects what already exists, then additively scaffolds a Drizzle table + migration, a workspace-scoped repository, a service wired into createContainer, an API route, an optional agent tool / client wrapper, and matching vitest unit tests — without overwriting manual edits."
---

# Implement Feature — Layered Backend Scaffolding (Next.js / Drizzle / vitest)

> **Path discipline (mna-brain, layered architecture):**
>
> This skill writes ONLY to the paths below. Everything else is read-only context.
> - Schema: `src/lib/db/schema.ts` (append a `pgTable` block; never rewrite one)
> - Migrations: `drizzle/migrations/` (generated — never hand-named), `data-pipeline/migrations/` for pipeline tables
> - Repositories: `src/lib/repositories/<entity>Repository.ts` + `.test.ts`, `src/lib/repositories/index.ts` (append an `export *` line)
> - Services: `src/lib/services/<entity>Service.ts` + `.test.ts`
> - Composition root: `src/lib/services/container.ts` (three additive edits — see step 10)
> - Routes: `src/app/api/<path>/route.ts` + `route.test.ts`; admin routes at `src/app/api/auth/<route>/route.ts` + the `ADMIN_ROUTES` set in `src/proxy.ts`
> - Client wrappers (only if a React view calls it): `src/lib/api/<feature>.ts`
> - Agent tools (only if requested): `src/lib/agents/<agent>/tools/<tool>.ts` + `.test.ts` + `tools/index.ts`
> - Seeds: `scripts/seed.ts` ONLY — never a new `scripts/seed-<entity>.ts`
> - Docs: `README.md` when the change is architectural
>
> DO NOT touch anything outside these paths without being asked.

Goal: take a plain-language feature description — this repo has no PRD/spec-artifact
pipeline; the conversation *is* the spec — and produce the full
repository → service → route stack for it, shaped exactly like the code already in the
repo, not like a generic template.

**Reference implementation to mirror:** `src/lib/repositories/feedbackRepository.ts` +
`src/lib/repositories/feedbackRepository.test.ts` + `src/lib/services/feedbackService.ts` +
`src/app/api/feedback/route.ts` is a complete, current, in-repo example of this exact stack
(workspace-scoped create, a scoped update, validation split between route and service,
best-effort side effects). Read that quartet before inventing any convention. For batched
reads, mirror `fundAssetTransactionRepository.ts` + `fundPortfolioService.ts` instead.

## Hard Gate

- **Additive only.** Never rewrite an existing method body, an existing `pgTable` block, or
  an existing line in `container.ts` / `repositories/index.ts` / `schema.ts`. Append.
- **Never delete** a column, method, route, or export — even if asked to "clean up" or
  "simplify" as part of this scaffold. Removal is a separate, explicitly reviewed action.
- **Never hand-craft a migration filename or edit `meta/_journal.json`.** Always go through
  `pnpm db:migration:new <slug>` (see the `new-migration` skill).
- **Never add a standalone seed script.** New seed data extends `scripts/seed.ts`.
- **No N+1s.** Every per-id repository method that a service could call per-collection ships
  with a `findByXIds(ids: string[])` counterpart. This is a correctness gate, not a
  performance nicety — see the N+1 section below.
- **Every `src/lib` file gets a vitest test.** No exceptions carved out for "simple" code.
- **Never commit or push.** Leave the diff for the user.

## Inputs

Ask for whatever isn't already stated, before writing any file. Do not guess on 1–3.

1. **Entity name** (singular camelCase, e.g. `dealTag`) — drives `dealTagRepository.ts`,
   `DealTagRepository`, the schema export `dealTags`, and the table `deal_tags`.
2. **Fields** — name + type + nullability per column (`label: text, required`).
3. **Workspace-scoped?** Almost everything here is: a `workspace_id uuid` FK to `workspaces`
   with `onDelete: 'cascade'`, plus an index, plus every query filtered by it. Only genuinely
   global tables skip it. **Ask if unsure — wrong scoping is a cross-tenant data leak.**
4. **Operations** — which of create / read / update / delete / list, and which need a bulk
   `...ByIds` variant (anything a service will call once per row of a collection does).
5. **Exposed how** — session-authenticated route (`src/app/api/**`), admin route
   (`src/app/api/auth/**`, secret-gated), agent tool, or service-only/internal.
6. **Extras** — feature flag? seed fixture rows? long-running work (→ `jobs` table)?
   client wrapper in `src/lib/api/`?

## Process Checklist

> **Anti-loop guard:** this skill's content is already loaded — do NOT re-invoke
> `implement-feature`. Invoking the other skills named in the steps below
> (`superpowers:test-driven-development`, `new-migration`, `add-feature-flag`,
> `write-unit-tests`, `review-implementation`, `superpowers:systematic-debugging`,
> `superpowers:verification-before-completion`) is required where the steps say so.

Use TodoWrite to track each item. Steps 5–13 only run for the pieces actually requested.

### 1. Load conventions

Read, and apply for the rest of the session:
- `.claude/CLAUDE.md` — layering, N+1 rules, migrations, seeding, agent pattern, flags
- `.claude/rules/repositories.md`, `.claude/rules/services.md`, `.claude/rules/api-routes.md`,
  `.claude/rules/drizzle-migrations.md`
- The feedback quartet above (the live example of all four rules at once)

> **Knowledge source precedence.** Repo conventions (`.claude/rules/*`, CLAUDE.md, existing
> code) always win on structure, naming, layering, and test style — never consult external
> docs for those. Reach for context7 only for a third-party library API signature you're
> unsure of (Drizzle operator, `flags/next`, `@langchain/*`, `next/server`), and only after
> checking how the repo already calls it. Best-effort: if context7 fails, continue.

### 2. Detect what already exists (change detection)

```bash
grep -rl "<Entity>Repository\|<Entity>Service" src/lib src/app/api
grep -n "<entity_table_name>" src/lib/db/schema.ts src/lib/repositories/types.ts
ls src/app/api/<path>/ 2>/dev/null
```

Classify every planned artifact into one of three states:

- **NEW** — nothing exists → generate from the patterns below.
- **EXTEND** — file exists, requested method/column does not → append only that method or
  column; leave every existing line byte-identical.
- **PRESENT** — file and symbol already exist → **skip silently**. Running this skill twice
  with no new request must produce a zero-line diff.

Apply the PRESENT check per *symbol*, not per file: per repository method, per service
method, per route HTTP verb, per `pgTable` column, per `container.ts` line, per
`index.ts` export, per `TableMap` entry.

### 3. Build and print the execution plan

Group by confidence and print before touching anything:

```
HIGH (auto-execute):
• schema.ts: + deal_tags table (4 cols, workspace_id index)
• migration: add_deal_tags
• repositories/: dealTagRepository.ts (create, findByIds, listByWorkspace) + test
• services/: dealTagService.ts (create, list) + test
• container.ts: 3 additive edits
• app/api/deal-tags/route.ts (POST, GET) + test

MEDIUM (auto-execute, marked with // TODO:):
• dealTagService.archive — business rule for "in use" tags not specified

LOW (HUMAN ACTION REQUIRED — not generated):
• whether tags are workspace-scoped or global  → blocking, ask
• existing dealNoteService.attachTag may need to call this — review manually
```

If invoked interactively, ask **"Proceed? (yes / show-diff / cancel)"** and wait. If invoked
from a sub-agent or an already-approved plan, skip the prompt and proceed to step 4.

### 4. TDD gate — REQUIRED before any production code

Invoke `superpowers:test-driven-development` and follow RED → GREEN → REFACTOR per
operation (not per file):

- **RED** — write the vitest test first, then run it and confirm it **FAILS**:
  ```bash
  pnpm test src/lib/repositories/dealTagRepository.test.ts
  ```
  A test that passes before the code exists is a broken test — fix it, don't proceed.
- **GREEN** — write the minimum code to pass; re-run the same command and confirm PASS.
- **REFACTOR** — clean up naming/duplication; re-run to confirm still green.

Writing production code before a failing test exists means the scaffold is rejected — redo
that operation.

### 5. Schema (`src/lib/db/schema.ts`)

Append a new `pgTable` block near related tables (see pattern below), then add the table to
the `TableMap` in `src/lib/repositories/types.ts` so `Tables<'deal_tags'>` /
`TablesInsert<'deal_tags'>` resolve. Skip entirely in EXTEND mode unless new columns were
requested.

### 6. Migration

```bash
pnpm db:migration:new add_deal_tags
```

Write `CREATE TABLE` + indexes + FKs into the generated stub so it matches `schema.ts`
exactly in column names, types, nullability, and defaults. Never pick the counter yourself;
never edit an already-applied migration — correct it with a new one. If this branch's
migration now sorts before something on `main`, use the `migration-rebase` skill.

### 7. Repository + test

Pattern below. Rules from `.claude/rules/repositories.md`: class, constructor-injected
`DbClient`, no `createDb()`, Drizzle only, pure data access, empty-array guard on every
`inArray`, export from `repositories/index.ts` (append the line, don't reorder).

### 8. Service + test

Pattern below. Rules from `.claude/rules/services.md`: constructor injection only, no
`createDb()`/`createContainer()`, no `src/app/` imports, typed `Error` subclasses for domain
violations, long-running work dispatched through `JobDispatcher` (`jobs` + `job_logs`) rather
than awaited inline.

### 9. Route + test

Pattern below. Rules from `.claude/rules/api-routes.md`: `createDb()`/`createContainer()`
*inside* the handler, whole body in `try/catch`, always `NextResponse.json({ data })` /
`({ error }, { status })`, params from `req.nextUrl.searchParams`, body from `req.json()`,
zero business logic. Admin routes additionally require an `ADMIN_ROUTES` entry in
`src/proxy.ts` — see the admin pattern below.

### 10. Wire into `src/lib/services/container.ts` — three additive edits, in order

1. Add `DealTagRepository` to the existing `@/lib/repositories` import list.
2. Add `import { DealTagService } from './dealTagService';`.
3. Inside `createContainer(db, workspaceId)`, after the other instantiations:
   ```ts
   const dealTagRepo = new DealTagRepository(db, workspaceId);
   const dealTagService = new DealTagService(dealTagRepo);
   ```
   then add `dealTagService: DealTagService;` to the `Container` interface and
   `dealTagService,` to the returned object.

Pre-check each of the five insertion points for an existing occurrence; skip any that's
already there.

### 11. Optional: client wrapper, agent tool, flag, seed

- **Client wrapper** — if a React view consumes this, add `src/lib/api/<feature>.ts` with one
  function per endpoint. **Never** call it once per row from a view; add a batched endpoint
  instead (see `src/lib/api/funds.ts` + `GET /api/funds/portfolio`).
- **Agent tool** — `src/lib/agents/<agent>/tools/<tool>.ts` (one tool per file) + `.test.ts`,
  registered in `tools/index.ts`. Tools call the **service**, never the repository.
- **Feature flag** — use the `add-feature-flag` skill; don't duplicate its steps here.
- **Seed rows** — extend `scripts/seed.ts` via its existing fixtures/helpers.

### 12. N+1 sweep — REQUIRED before declaring done

Re-read every file you touched and confirm:
- No repository call inside `.map` / `for` / `forEach` / `Promise.all` over a collection.
- Every per-id method that a service calls per-collection has a `findByXIds` counterpart
  that guards `ids.length === 0` and `orderBy`s the grouping key first.
- Grouping happens in memory via a `Map` (mirror `groupByAssetId` in `fundPortfolioService.ts`).
- Unbounded list queries are paginated or explicitly bounded.
- Every column used in a `where`/join has an index in both `schema.ts` and the migration.

### 13. Verification gate — REQUIRED (`superpowers:verification-before-completion`)

```bash
pnpm exec tsc --noEmit
pnpm test src/lib/repositories/dealTagRepository.test.ts src/lib/services/dealTagService.test.ts src/app/api/deal-tags/route.test.ts
pnpm lint
```

Capture output verbatim; never claim "all pass" from memory or partial output. On failure,
invoke `superpowers:systematic-debugging` before proposing a fix. Run the full `pnpm test`
once at the end if `container.ts` or `schema.ts` changed.

### 14. Report

```
✓ 1 table, 1 migration, 1 repository (3 methods), 1 service (2 methods), 1 route (POST/GET)
✓ tsc clean · 14 tests passed · lint clean
⚠️  Manual review: <count> LOW items (listed above)
⚠️  README.md not updated — this change is not architectural (or: updated §Backend)

Next steps:
1. Search `// TODO:` in src/lib/services/dealTagService.ts for unspecified business rules
2. pnpm db:migrate to apply locally
3. /review-implementation before pushing, then git diff and commit
```

## File Generation Patterns

| Layer | Path | Responsibility |
|---|---|---|
| **Schema** | `src/lib/db/schema.ts` | `pgTable` definition + indexes; mirrored into `TableMap` in `repositories/types.ts` |
| **Repository** | `src/lib/repositories/<entity>Repository.ts` | Workspace-scoped Drizzle data access; class + injected `DbClient`; no business rules |
| **Service** | `src/lib/services/<entity>Service.ts` | Business logic; constructor-injected repos/services; typed domain errors; `JobDispatcher` for async |
| **Composition root** | `src/lib/services/container.ts` | `createContainer(db, workspaceId)` wiring; additive only |
| **Route** | `src/app/api/**/route.ts` | Auth + input validation + `NextResponse.json` envelope; delegates to a service |
| **Client** | `src/lib/api/<feature>.ts` | Typed fetch wrappers for React views; batched, never per-row |

### Schema block

```ts
/** One row per tag applied to a deal; owned by DealTagRepository. */
export const dealTags = pgTable(
  "deal_tags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text().notNull(),
    color: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    idxDealTagsWorkspaceId: index("idx_deal_tags_workspace_id").using(
      "btree",
      table.workspace_id.asc().nullsLast().op("uuid_ops"),
    ),
  }),
);
```

Table name is snake_case plural. Every workspace-scoped table gets the `workspace_id` index —
every query filters on it. FKs always declare an explicit `onDelete`.

### Repository

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { dealTags } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export interface CreateDealTagInput {
  label: string;
  color?: string | null;
}

/** Workspace-scoped data access for deal tags. */
export class DealTagRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async create(input: CreateDealTagInput): Promise<Tables<'deal_tags'>> {
    const [row] = await this.db
      .insert(dealTags)
      .values({
        workspace_id: this.workspaceId,
        label: input.label,
        color: input.color ?? null,
      } satisfies TablesInsert<'deal_tags'>)
      .returning();
    return row;
  }

  /** Batched counterpart to findById — ordered by id so callers can group in one pass. */
  async findByIds(ids: string[]): Promise<Tables<'deal_tags'>[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(dealTags)
      .where(and(inArray(dealTags.id, ids), eq(dealTags.workspace_id, this.workspaceId)))
      .orderBy(dealTags.id);
  }

  async setColor(id: string, color: string): Promise<void> {
    await this.db
      .update(dealTags)
      .set({ color })
      .where(and(eq(dealTags.id, id), eq(dealTags.workspace_id, this.workspaceId)));
  }
}
```

Every `where` includes `eq(<table>.workspace_id, this.workspaceId)` — a missing scope is a
cross-tenant leak, not a bug.

### Repository test

Mirror `feedbackRepository.test.ts` exactly: module-level chain mocks built with
`vi.fn().mockReturnThis()`, a `resetDb()` helper called in `beforeEach`, and
`describe('DealTagRepository.<method>', ...)`.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { dealTags } from '@/lib/db/schema';
import { DealTagRepository } from './dealTagRepository';

const insertChain = { values: vi.fn().mockReturnThis(), returning: vi.fn() };
const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
};

const mockDb = {
  insert: vi.fn().mockReturnValue(insertChain),
  select: vi.fn().mockReturnValue(selectChain),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.insert.mockReturnValue(insertChain);
  mockDb.select.mockReturnValue(selectChain);
  insertChain.values.mockReturnThis();
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
}

describe('DealTagRepository.findByIds', () => {
  let repo: DealTagRepository;

  beforeEach(() => {
    resetDb();
    repo = new DealTagRepository(mockDb as never, 'workspace-1');
  });

  it('returns [] without hitting the DB when the id list is empty', async () => {
    await expect(repo.findByIds([])).resolves.toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the repo workspace and orders by id', async () => {
    selectChain.orderBy.mockResolvedValue([]);
    await repo.findByIds(['t1', 't2']);
    expect(selectChain.where).toHaveBeenCalledWith(
      and(inArray(dealTags.id, ['t1', 't2']), eq(dealTags.workspace_id, 'workspace-1')),
    );
    expect(selectChain.orderBy).toHaveBeenCalledWith(dealTags.id);
  });
});
```

The empty-array test is mandatory for every `findByXIds`.

### Service

```ts
import type { DealTagRepository, Tables } from '@/lib/repositories';

/** Thrown when a tag operation targets a tag that isn't in this workspace. */
export class DealTagNotFoundError extends Error {
  constructor(id: string) {
    super(`Deal tag not found: ${id}`);
    this.name = 'DealTagNotFoundError';
  }
}

export const MAX_DEAL_TAG_LABEL_LENGTH = 60;

export interface CreateDealTagRequest {
  label: string;
  color?: string | null;
}

export class DealTagService {
  constructor(private readonly dealTagRepo: DealTagRepository) {}

  async create(input: CreateDealTagRequest): Promise<Tables<'deal_tags'>> {
    const label = input.label.trim();
    if (!label) throw new Error('create: label is required');
    if (label.length > MAX_DEAL_TAG_LABEL_LENGTH) {
      throw new Error(`create: label must be ${MAX_DEAL_TAG_LABEL_LENGTH} characters or fewer`);
    }
    return this.dealTagRepo.create({ label, color: input.color ?? null });
  }
}
```

Export shared validation constants/normalizers from the service so the route imports them
rather than duplicating the limits (see `MAX_FEEDBACK_TITLE_LENGTH` /
`normalizeFeedbackTitle`). Long-running or fan-out work goes through `JobDispatcher`, with
state changes recorded in `job_logs` — never inline `setTimeout` or polling.

### Service test

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/lib/repositories', () => ({
  DealTagRepository: class {
    create = create;
  },
}));

import { DealTagRepository } from '@/lib/repositories';
import { DealTagService } from './dealTagService';

describe('DealTagService.create', () => {
  let service: DealTagService;

  beforeEach(() => {
    create.mockReset();
    service = new DealTagService(new DealTagRepository(null as never, 'workspace-1'));
  });

  it('throws when the label is blank', async () => {
    await expect(service.create({ label: '   ' })).rejects.toThrow('label is required');
    expect(create).not.toHaveBeenCalled();
  });

  it('trims the label before persisting', async () => {
    create.mockResolvedValue({ id: 't1' });
    await service.create({ label: '  Priority  ' });
    expect(create).toHaveBeenCalledWith({ label: 'Priority', color: null });
  });
});
```

### Route — session-authenticated

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { MAX_DEAL_TAG_LABEL_LENGTH } from '@/lib/services/dealTagService';

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!label) {
      return NextResponse.json({ error: 'Missing required field: label' }, { status: 400 });
    }
    if (label.length > MAX_DEAL_TAG_LABEL_LENGTH) {
      return NextResponse.json(
        { error: `label must be ${MAX_DEAL_TAG_LABEL_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }

    const db = createDb();
    const { dealTagService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await dealTagService.create({ label });

    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('POST deal-tags error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
```

### Route — admin (`src/app/api/auth/<route>/route.ts`)

No `auth()` call — the middleware gates it. Go straight to `createDb()` /
`createContainer(db)`. Then register the path in the `ADMIN_ROUTES` set near the top of
`src/proxy.ts` (that set, not the `config.matcher` array, is what demands `X-Api-Secret`):

```ts
// src/proxy.ts
const ADMIN_ROUTES = new Set(['/api/auth/signup', '/api/auth/api-keys', '/api/auth/deal-tags']);
```

For a dynamic segment, also extend the prefix check on the same line as the existing
`pathname.startsWith('/api/auth/api-keys/')` clause.

**This is the security-critical step.** Anything under `/api/auth/` that isn't in
`ADMIN_ROUTES` (or matched by a prefix clause) falls through to the NextAuth passthrough and
is served **completely ungated**. Treat the route as incomplete until the set entry exists.
Callers send `X-Api-Secret: <ADMIN_SECRET>`; server-side calls via `apiRequest` in
`src/lib/api/client.ts` attach it automatically.

### Route test

Mock `@/lib/services` (`createContainer`) and `@/auth`, then exercise every status code the
handler can return — 200, 400 (bad JSON, each missing/oversized field), 401, 403
(`NoActiveWorkspaceError`), 500. Mirror `src/app/api/feedback/route.test.ts`.

## Idempotence Guarantees

- Running this twice with no new fields or operations requested produces a zero-line diff.
- Requesting one new field on an existing entity touches only `schema.ts` (new column),
  `types.ts` if needed, a new migration, and the specific methods that consume it.
- Requesting one new operation adds one repository method, one service method, one route
  verb, and their tests — existing methods and verbs are untouched.
- Existing migrations are never modified; corrections come as a new migration.
- Nothing is ever deleted, including code the new feature appears to supersede.

## Failure Modes

| Situation | Behavior |
|---|---|
| Entity name / fields not given | Ask before writing anything |
| Ambiguous whether workspace-scoped | Ask — never guess; wrong scoping is a cross-tenant leak |
| Repository/service/route already exists | EXTEND mode: add only what's new |
| Admin route added but not in `ADMIN_ROUTES` in `src/proxy.ts` | Incomplete — the endpoint is served ungated; a security hole, not a style nit |
| Migration filename hand-written or `_journal.json` edited | Revert; regenerate via `pnpm db:migration:new` |
| Branch migration sorts before `main`'s | Use the `migration-rebase` skill |
| Per-id repo call inside a loop | Blocking — add the `findByXIds` batch method and group with a `Map` |
| Table added to `schema.ts` but not `TableMap` | `Tables<'x'>` won't resolve — add the entry |
| `pnpm exec tsc --noEmit` / `pnpm test` / `pnpm lint` fails | Invoke `superpowers:systematic-debugging`; never hand off broken |
| Long-running work awaited inline in a route | Move to `JobDispatcher` (`jobs` + `job_logs`) |

## Iteration Examples

### Adding an operation to an existing entity

```
$ implement-feature — "let users archive a deal tag"

Skill: Change detection:
       ✓ dealTagRepository.ts exists (create, findByIds, setColor)
       ✓ dealTagService.ts exists (create)
       ✓ app/api/deal-tags/route.ts exists (POST)

       HIGH: + archived_at column, migration, repo.archive, service.archive, DELETE verb
       MEDIUM: service.archive — "already archived" behavior unspecified → // TODO:
       LOW: (none)

       Proceed?
User:  yes

Skill: RED   src/lib/services/dealTagService.test.ts::archive → FAIL ✓
       GREEN dealTagService.archive → PASS ✓
       + schema.ts: deal_tags.archived_at
       + drizzle/migrations/20260811000000_add_deal_tags_archived_at.sql
       + dealTagRepository.archive (workspace-scoped UPDATE) + test
       + app/api/deal-tags/route.ts: DELETE + test
       container.ts untouched (service already wired)
       tsc ✓ · 9 tests ✓ · lint ✓
```

### Re-running with nothing new

```
$ implement-feature — same request

Skill: Change detection: all artifacts PRESENT. Nothing to generate.
       (0 files changed)
```

### Batched read requested by a view

```
$ implement-feature — "the pipeline table needs each deal's tags"

Skill: LOW → blocking: the view currently would fetch tags per row.
       Not generating a per-deal endpoint. Plan instead:
       • dealTagRepository.findByDealIds(ids) — inArray + orderBy(deal_id), empty guard
       • dealTagService.tagsByDeal(dealIds) — groups with a Map, one query
       • GET /api/deal-tags?dealIds=... returns { data: Record<dealId, Tag[]> }
       • src/lib/api/dealTags.ts — one fetch for the whole page
       Proceed?
```

## File Output Summary

New workspace-scoped entity `dealTag`, exposed via a session-authenticated route:

```
src/lib/db/schema.ts                              (+ dealTags pgTable block)
src/lib/repositories/types.ts                     (+ deal_tags TableMap entry)
drizzle/migrations/<date><counter>_add_deal_tags.sql
src/lib/repositories/
  dealTagRepository.ts
  dealTagRepository.test.ts
  index.ts                                        (+ export * line)
src/lib/services/
  dealTagService.ts
  dealTagService.test.ts
  container.ts                                    (+ 3 additive edits)
src/app/api/deal-tags/
  route.ts
  route.test.ts
```

Optional, only when requested: `src/lib/api/dealTags.ts`,
`src/lib/agents/<agent>/tools/<tool>.ts` (+ test + registration), `src/lib/flags.ts` (via the
`add-feature-flag` skill), `scripts/seed.ts` rows, `README.md`.

## Why This Design

- **Mirrors real code, not a template.** Every pattern above is lifted from the feedback and
  fund-portfolio stacks, so generated code is indistinguishable from what the team writes —
  same constructor shape, same response envelope, same mocking style.
- **Additive + symbol-level idempotence.** Safe to re-run repeatedly as a feature grows across
  a session, without clobbering hand-written changes made in between runs.
- **Confidence tiers.** Separates mechanically-derivable scaffolding from business rules that
  need human judgment, instead of silently guessing at the latter.
- **N+1 sweep as a gate.** This repo has already exhausted its Postgres connection pool
  (`53300`) once from a per-row fan-out. Batching is checked before "done", not in review.
- **TDD + verification gates.** RED-before-GREEN and verbatim command output mean "it works"
  is evidence, not a claim.
```
