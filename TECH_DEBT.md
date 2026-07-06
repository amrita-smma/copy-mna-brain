# Tech Debt

A running log of known, accepted shortcuts and the conditions under which they
should be paid down. Each entry: what the shortcut is, why we took it, the
trigger to revisit, and the intended fix.

---

## In-memory Levenshtein for ingest company dedup

**Area:** `src/lib/fuzzySearch.ts`, `CompanyService.findBestFuzzyMatch`
(`src/lib/services/companyService.ts`), wired into the AI File Dump ingest
dedup gate in `src/lib/services/fileService.ts`.

**What it is:**
The ingest dedup gate matches an extracted company name against existing
companies in two passes:
1. A fast SQL substring match (`CompanyRepository.findByNameFuzzy`, `LIKE '%…%'`
   after stripping legal suffixes).
2. A Levenshtein fallback (`findBestFuzzyMatch`) that pulls **every** company's
   `id`/`target`/`project_name` via `findAllIdAndTarget()` and computes
   relative edit distance **in application memory** (threshold 0.3 → accept at
   ≥ 0.7 similarity).

So the fallback is `O(N)` per ingest call and re-fetches the whole company table
on every call, with no caching.

**Why we took it:**
- The Levenshtein path only fires when the cheap substring gate misses, so it is
  not on the hot path for most files.
- The extracted matcher (`bestFuzzyMatch`) is pure and preserves exact
  edit-distance ranking semantics, which is what we want for typo/OCR dedup.
- At the current scale (an M&A deal tracker — companies number in the thousands,
  not consumer scale) the cost is negligible and not worth a schema change yet.

**Current state of the DB (as of this entry):**
- No `pg_trgm` extension installed; only `uuid-ossp`.
- The only index on the name column is a plain **B-tree** `idx_companies_target`,
  which cannot serve a leading-wildcard `LIKE '%…%'` or fuzzy matching. The
  substring gate is therefore already a sequential scan in Postgres.

**Rough cost model (per fallback call):**

| Companies | Fetch + deserialize all rows | In-mem Levenshtein scan | Per-call total |
|-----------|------------------------------|-------------------------|----------------|
| 1k        | <1–3 ms                      | ~2–6 ms                 | negligible |
| 10k       | ~5–20 ms                     | ~20–60 ms               | fine |
| 50k       | ~30–100 ms (~5 MB)           | ~100–300 ms             | **yellow** |
| 100k      | ~100–250 ms (~10 MB)         | ~200–600 ms             | ~0.5–1 s → **red** |
| 1M        | multi-second (~100 MB, GC)   | 2–10 s                  | not viable |

The row fetch + JS object materialization + GC usually dominates over the
Levenshtein math (names are short, ~20 chars) once the table is large.

**Trigger to revisit:**
- Companies cross **~10k** (start planning), or
- **> ~50k** (migrate — per-call latency crosses ~0.5 s and grows linearly), or
- Ingest latency is observably dominated by dedup regardless of count.

Effective load is `N × ingest_rate × targets_per_file × fallback_hit_rate`.
Ingest here is human/email-driven (low QPS) and the fallback only fires on the
substring-miss path, so we may stay green/yellow well beyond these row counts.

**Intended fix (preferred → fallback):**
1. **Trigram prefilter + in-memory Levenshtein (sweet spot).**
   `CREATE EXTENSION pg_trgm` + a GIN trigram index on `target`/`project_name`.
   Replace `findAllIdAndTarget()` in `findBestFuzzyMatch` with a candidate query
   (`WHERE target % $name OR project_name % $name`) that returns ~10–200
   index-backed rows, then run the **existing** `bestFuzzyMatch` Levenshtein
   ranking on that small set. Fetch becomes sublinear; match semantics are
   unchanged. The pure `bestFuzzyMatch` function already accepts an arbitrary
   candidate list, so only the candidate query changes.
2. **Fully DB-side (only at millions of rows).**
   `ORDER BY target <-> $name LIMIT 1` (trigram distance) or a `similarity()`
   threshold entirely in SQL. Fastest at extreme scale but changes ranking
   semantics — trigram similarity ≠ edit distance (differs on short names and
   transpositions), so thresholds must be re-tuned.

**Notes / gotchas:**
- `levenshtein()` from `fuzzystrmatch` is **not indexable**, so exact Levenshtein
  cannot be pushed into an indexed query — indexed fuzzy matching means trigram.
  That is why option 1 (trigram to narrow, Levenshtein to rank) is preferred.
- A short-TTL in-memory cache of `findAllIdAndTarget()` is a cheaper stopgap for
  bursty uploads, but adds staleness risk; prefer the trigram prefilter.
- Names shorter than 5 chars are intentionally excluded from the Levenshtein
  fallback (relative-distance matching is too aggressive on short acronyms); the
  exact substring gate already handles those.
