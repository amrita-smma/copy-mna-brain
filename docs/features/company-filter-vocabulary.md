# One company-filter vocabulary across the analysis tools

`src/lib/agents/analysis/tools/companyFilters.ts` owns the single filter
vocabulary shared by every analysis tool that scopes a cohort of companies:
`query_companies`, `get_company_stats`, and `send_email`'s `company_excel` /
`company_card` artifact specs.

Before it, each tool carried a hand-maintained subset of filters. The agent could
narrow a query by a column the matching export then silently ignored, and the
spreadsheet it mailed could disagree with the table it had just shown. Everything
now derives from one place:

- **`companyFilterShape`** — the zod raw shape, one entry per user-meaningful
  `companies` column (identity, classification, pipeline position, deal shape,
  people, narrative text — including the free-form `context` written on the
  Context tab, plus `has_context` — AI Opinion, financial bounds, every lifecycle
  timestamp, housekeeping flags) plus the graph filters below. Tools spread it
  into their own `z.object({ ...companyFilterShape, <tool-specific fields> })`.
  Add a filter once and all three tools accept it.
- **`mapCompanyFilters`** — snake_case tool args → the repository's
  `CompanyAgentFilters`, which `CompanyRepository.buildAgentConditions` turns
  into SQL for both `searchForAgent` (paged read) and `findForAgentStats`
  (full cohort).
- **`COMPANY_FILTER_DOC`** — the filter reference injected verbatim into each
  tool's description, so the model reads one identical list regardless of which
  tool it reaches for. `COMPANY_STAGE_DEFAULT_DOC` is deliberately separate: the
  read tools default to the committed funnel (every workspace stage, excluding
  the pre-pipeline buckets), while the Excel export has
  **no** stage default so "email me the whole pipeline" means the whole pipeline.
- **`resolveCompanyGraphFilter`** — relationship-graph filters (`connected_to`,
  `relation_type`, `has_relationships`) live in Neo4j, not Postgres. This
  resolves them into an id include/exclude list that `mergeGraphFilter` ANDs into
  the column filters, in a fixed number of graph queries regardless of cohort
  size (one neighbour lookup, or one whole-graph read — never one per row). Its
  deps arrive as a factory, so a query with no graph filter never constructs the
  Neo4j-backed services at all.

**Ids are the handoff between listing and exporting.** `query_companies` prints
each row's uuid in an `ID` column, and both `company_excel` and `company_card`
accept `company_ids`. The intended flow is query first, then export those exact
ids — the attachment then contains precisely the rows the user saw instead of a
cohort re-derived from filters. `CompanyAgentFilters.ids` also opts out of the
default `discovered`-stage exclusion (the caller already chose those rows) and
treats an **empty** array as "match nothing" rather than widening to the whole
workspace.
