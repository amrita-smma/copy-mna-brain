# Data Navigator (RSS news lake)

A global, cross-workspace news lake ingested from a curated catalog of RSS
feeds across five categories (`expert_insights`, `market_assessment`,
`new_funding`, `ma_partnerships`, `industry_reports` —
`RSS_CATEGORIES` in `src/lib/db/schema.ts`). The checked-in catalog
(`data-pipeline/fixtures/rss-feeds.csv`) has 263 rows but only 256 distinct
`feed_url`s (6 duplicates); the import upsert is keyed on `feed_url`, so a
clean import reports **256 imported**, not 263.

- **Schema:** `rss` (pipeline-owned, no `workspace_id` anywhere — the catalog
  and the ingested news are shared by every workspace by design; migrations
  live in `data-pipeline/migrations`). `rss.feeds` is the runtime-editable
  catalog; `rss.items` holds metadata for every ingested item (plus the
  original *and* English text of anything translated); `rss.item_chunks`
  holds 1024-dim pgvector embeddings for the LLM-selected subset; `rss.ingest_runs`
  records each poll/enrich run's stats and error.
- **Ingest:** two scheduled Lambdas in `data-pipeline` (`data-pipeline/src/lambda/`) —
  `rss-poll` (`rate(30 minutes)`) conditional-GETs every `status = 'active'` feed,
  normalizes and inserts genuinely-new entries into `rss.items`, archives them as
  NDJSON to the S3 bronze bucket, and updates per-feed health; a feed retires
  itself to `dead` after **10** consecutive failures
  (`MAX_CONSECUTIVE_FAILURES` in `rssRepository.ts`) rather than waiting for a
  human to notice — the PoC found ~35% of a raw seed catalog was already
  rotten. `rss-enrich` (`rate(10 minutes)`) drains four bounded, sequentially-run
  queues: Haiku relevance classification (capped per category per UTC day),
  full-article extraction for selected items (3 attempts,
  `MAX_CONTENT_ATTEMPTS`), Haiku translation of non-English items (see below),
  and Bedrock Titan embeddings into `rss.item_chunks`.
  Both Lambdas are idempotent — status columns and the unique `item_hash` index
  make a crashed/re-run invocation a no-op rather than a duplicate.
- **Translation (non-English items).** The catalog spans several regions, so a
  real slice of the lake arrives in Japanese, Korean, German, Spanish and so
  on. The translate stage (`data-pipeline/src/handlers/rssTranslate.ts`) detects
  the language **locally** first — `rssLanguage.ts` is a dependency-free
  script-census + stopword heuristic — so the English majority never costs a
  model call; only what it flags goes to Haiku, one bounded plain-text call per
  field and per ~6 KB body chunk (JSON would let one `max_tokens` cutoff make a
  200 KB body unparseable). Results land in parallel `language` /
  `title_en` / `summary_en` / `content_text_en` columns: the original is
  **never** overwritten, because the reading pane offers a "display in original
  language" toggle. Three attempts (`MAX_TRANSLATION_ATTEMPTS`), then the item
  goes `failed` and stays fully usable in its own language.
  - **Two limits, not one.** The stage examines `DETECT_LIMIT` (200) rows per
    run but translates at most `TRANSLATE_LIMIT` (15), settling every English
    row in a single batched `UPDATE`. Keeping them separate is load-bearing:
    embedding waits on translation resolving, so if English rows counted
    against the model budget a backlog of them would starve the embed queue
    with work that never needed a model. The overflow is reported as
    `translation_deferred` rather than silently dropped. For the same reason,
    the migration backfills every already-embedded row to `not_needed` — the
    default `'none'` would otherwise make the whole historical corpus
    simultaneously unembeddable and queued for re-examination.
  - **Order matters:** embedding is gated on `translation_status` having
    resolved, because *both* halves of hybrid search are English (an English
    query embedding, and a trigram `ILIKE` over English words) — indexing a
    Japanese body would leave the item unreachable by any query a user would
    actually type. `runEmbedding` therefore embeds `title_en`/`content_text_en`
    whenever they exist. Same reason the lexical half now ILIKEs `title_en`
    alongside `title` (with a matching `gin_trgm_ops` index).
  - **Surfaces:** the news list always renders the English headline plus a
    language badge — a foreign headline is unreadable to someone scanning the
    feed — while the reading pane adds the per-article toggle and a
    machine-translation notice. The single
    shared answer to "which text do I show" lives in
    `src/views/dataNavigator/translation.ts`.
  - **Detection bias:** the heuristic answers "English" when unsure (including
    for text below `MIN_WORDS_FOR_DETECTION`, e.g. a bare headline on an item
    whose content fetch failed). A false "English" costs a slightly-awkward
    card; a false "non-English" wastes a call and round-trips real English
    prose through a translator.
- **Volume control:** `RSS_DAILY_CAP_PER_CATEGORY` (default **25**) caps
  selected items per category per UTC day, shared across every batch in a run
  so a large backlog can't blow through the cap by splitting into batches.
- **Bedrock region.** Bedrock is not offered in `ap-southeast-3`, where the
  pipeline Lambdas run, so embedding calls use `BEDROCK_REGION` (default
  `ap-southeast-2`, see `src/lib/bedrock.ts`) and must **never** fall back to
  `AWS_REGION` — that reserved Lambda env var is `ap-southeast-3` and silently
  falling back to it would break every embed call.
- **Bedrock IAM — two sides, not one.** The pipeline Lambdas embed article
  chunks and get `bedrock:InvokeModel` from
  `data-pipeline/terraform/pipeline-compute/iam.tf`. The **app** separately
  embeds the *search query* in-process — `createContainer` builds a
  `BedrockEmbeddingClient` — under the
  `mna-app` IAM user, which gets `mna-app-bedrock-invoke` from
  `terraform/iam`. Miss the app-side grant and
  `DataNavigatorService.vectorHalf` swallows the `AccessDenied`, logs
  `[data-navigator] vector search unavailable:`, and returns `[]`, so hybrid
  search silently degrades to trigram-only. Both policies scope to a single
  model ARN, so `BEDROCK_REGION` / `BEDROCK_EMBEDDING_MODEL` must match the
  `bedrock_region` / `bedrock_embedding_model` Terraform vars on both sides.
  Model access for Titan Embed v2 must also be enabled in the Bedrock console
  for that region — IAM alone is not enough.
- **Serving:** `DataNavigatorService` → `/api/data-navigator/*`
  (`filters`, `items`, `items/[id]`, `search`) → the `/data-navigator` page,
  gated by the `DATA_NAVIGATOR_ENABLED` runtime feature toggle (see
  [Runtime feature toggles](runtime-feature-toggles.md) — **defaults to
  disabled**, so the feature ships dark until a superadmin turns it on per
  workspace).
- **RAG:** hybrid search (pgvector cosine similarity + trigram `ILIKE`,
  merged and re-ranked in `DataNavigatorService.searchNews`) powers the
  `/api/data-navigator/search` route and the Data Navigator page. The
  `search_news` agent tool that once exposed the lake to the Copilot flavors
  has been removed — agents answer recent-news questions with `web_search`
  on the open web.
- **Feed admin:** `X-Api-Secret`-gated routes under `/api/auth/rss-feeds`
  (list/create, `/:id`, `/import`) — see [Admin routes](admin-routes.md).
  Bulk-import the checked-in catalog with `pnpm rss:import-feeds`.

**Build note.** `canvas` sits in the esbuild `external` list
(`data-pipeline/scripts/build.ts`) solely because `rss-enrich`'s article
extractor (`@extractus/article-extractor`) pulls in `linkedom`, which
`require`s `canvas` inside a try/catch and falls back to a stub when it's
absent — esbuild can't bundle the native `.node` binary anyway, and
`rss-enrich` only strips/parses HTML text, never renders to a real canvas.

**Local invoke:**

```bash
pnpm --filter data-pipeline invoke rssPoll '{}'
pnpm --filter data-pipeline invoke rssEnrich '{}'
```

(Both handler names must be listed in the `HANDLERS` allowlist in
`data-pipeline/scripts/invoke-local.ts` for `invoke <name>` to resolve them.)

**Not yet deployed.** The Terraform for the RSS bronze bucket
(`terraform/s3-rss`) and the two Lambda schedules + Bedrock IAM policy
(`data-pipeline/terraform/pipeline-compute`) is written and passes `fmt`/`validate`,
but has never been `apply`'d to any environment, and no staging feed import
has been run. Separately, the app-side Bedrock policy in `terraform/iam` is an
**incremental** change to a module that is already live in every environment
(`mna-app` is the identity Vercel already uses for S3/SES/RDS) — it needs a
plain `make init-<env> && terraform apply` per account, not a first-time
stand-up. Treat the subsystem as code-complete but operationally
unproven until that happens.

Design: `docs/superpowers/specs/2026-09-02-data-navigator-rss-lake-design.md`.
