# CRM banker matching ("which banker can help me close this deal?")

The `lookup_crm` agent tool has two modes. The original one takes a name and
returns a firm profile. The second one takes a **deal** and returns a ranked
list of **bankers**, which is what this document covers.

## The problem it solves

A user describes a deal the way deals are described:

> Project Atlas is a US company we're looking to LBO — which banker can help?

The CRM stores something else entirely. On `correspondents` (the banker
records, read through the per-workspace `correspondent_workspace_effective` view):

| Column | Example value |
|---|---|
| `department` | `Leveraged Finance`, `DCM`, `M&A`, `ECM` |
| `coverage_region` | `North America`, `Southeast Asia`, `Greater China`, `Global` |
| `specialization` | `Sponsor-backed LBO financing`, `Industrials, specialty chemicals` |
| `seniority` | `Managing Director`, `Vice President` |

Neither of the two things the user actually said appears in those columns.
"United States" is not a substring of "North America", and "LBO" is not a
substring of "Leveraged Finance". A literal search finds nothing — so the tool
translates before it searches.

## The translation

Two pure modules do the translation; both are unit-tested and have no DB access.

**`src/lib/crm/geoExpansion.ts`** — `expandGeography(place)` resolves a country
name to its ISO alpha-2 code (via `country-to-iso`, per the Country Codes rule
in `CLAUDE.md`), then maps the code onto the coverage labels that contain it.
Results come back in two tiers so a precise cover can outrank an umbrella one:

```
expandGeography("United States")
  exact: ["United States", "USA", "U.S.", "US", "North America"]
  broad: ["Americas", "Global", "Worldwide", "International"]
```

Aliases are chosen for word-boundary matching: bare `America` is deliberately
absent, because `\yAmerica\y` also matches a **Latin America** desk. Where a
country has an alias list, that list *replaces* the input — `country-to-iso`
resolves loose names like "America" to `US`, and echoing the input back would
reintroduce the same false match.

A region works too, and expands *downward* as well — a Greater China desk
counts as a precise cover for an APAC ask. Input that names neither a country
nor a region is matched literally — both tiers, including the global one, stay
empty so an unrecognised place cannot quietly return every globally-covering
banker — and the tool says so in its answer.

Only the code → region grouping is hand-maintained here (no dependency in this
repo provides one). A country missing from the grouping still works; it just
gets no regional expansion.

**`src/lib/crm/dealExpertise.ts`** — `expandDealType(mandate)` maps the mandate
onto the desks that run it and the terms those bankers describe themselves
with:

```
expandDealType("LBO")
  departments: ["Leveraged Finance", "LevFin", "Debt Capital Markets", "DCM",
                "Financial Sponsors", "Sponsor Coverage", …]
  keywords:    ["LBO", "leveraged", "buyout", "sponsor", "acquisition financing", …]
```

Triggers are matched as word prefixes against the whole phrase, so
"we're refinancing before the carve-out" pulls in both the debt and the M&A
desks. Unrecognised input passes through literally rather than being dropped,
and `recognized: false` lets the tool flag that in its answer.
`expandDepartment` ("DCM" ≡ "Debt Capital Markets") and `expandSeniority`
("MD" ≡ "Managing Director") have their own, deliberately narrow tables: a
`department` ask names a desk, so it expands only to other spellings of that
same desk. Routing it through the playbook would turn `department: "DCM"` into
the whole debt union and rank Private Credit equally with the desk asked for.

## The search

`CorrespondentRepository.search(filters, workspaceId)` runs the match. One
query, whatever the result count: the firm's name and industry come from the
join on `employer_workspace_effective` (same workspace), and last-contact/email-count from the
precomputed `analytics.mart_crm` (keyed by `(workspace_id, employer_id)`).

**It is scored-OR, not filtered-AND.** A banker is returned if it matches *any*
facet; `match_score` is the weighted sum of the facets it matched, and
`matched` names them. This is deliberate — requiring every facet would return
nothing for most real asks, and the second-best banker is exactly what the user
needs to see. For "US LBO":

| Banker | Desk | Covers | Score |
|---|---|---|---|
| Jane Doe | Leveraged Finance | North America | 10 |
| Bob Lim | Leveraged Finance | Greater China | 5 |
| Ann Ray | Sector Coverage | North America | 3 |

Facet weights: `banker`/`firm` 4, `departments`/`regions` 3,
`expertise`/`topics`/`industries`/`keyword` 2, `seniorities`/`broadRegions` 1.
Ties break on most recent contact, so an equally-qualified banker we actually
talk to outranks a dormant one.

Matching rules, by facet kind:

- **Term lists** (desk, coverage, expertise, seniority, industry, topic) match
  on a **word boundary** (`~*` with `\y`). This is what keeps `US` from
  matching `Russia` while leaving the short desk abbreviations (`DCM`, `ECM`,
  `M&A`) usable. The anchor is applied per term and only on a side ending in a
  word character — `U.S.` has no boundary after its trailing dot.
- **Names** (banker, firm, free-text keyword) match on **substring** (`ILIKE`),
  so a partial name still finds its owner. `%` and `_` in the input are escaped
  — unescaped, `banker: "%"` would match every row in the workspace.

Visibility is the standard CRM rule: correspondents this workspace can see
(`workspace_correspondents` membership, no mailbox-sync gate) at firms with
`curation_status = 'published'`.

## The tool

`lookup_crm` switches into banker-match mode when any of `geography`,
`deal_type`, `department`, `specialization`, `seniority`, `industry` or `topic`
is passed, or when more than one of `query` / `firm` / `banker` is — firm-profile
mode searches a single string, so "Jane Doe" at "Evercore" would otherwise lose
the firm. With a single bare name it stays in firm-profile mode and returns the
full relationship card per firm (bankers, topics, team coverage, recent emails,
notes, linked companies).

The answer opens with a **Read as:** line spelling out how the query was
translated, including any term that had to be taken literally, so a wrong guess
is visible rather than silent. Each banker is then rendered with why it matched,
its firm, our last contact with that firm, the firm's topics and who covers the
relationship internally.

Firm topics and internal coverage are fetched with one batched call each
(`TopicRepository.listForEmployers`, `EmployerTeamRepository.listForEmployers`)
across every matched firm — a per-banker lookup here would be an N+1.

## Adding to the vocabulary

- A new mandate type → a `PLAYBOOK` entry in `dealExpertise.ts` (triggers +
  departments + keywords). Another spelling of an existing desk →
  `DEPARTMENT_SYNONYMS` in the same file.
- A new coverage region or a country in the wrong bucket → `REGION_MEMBERS` /
  `REGION_PARENTS` / `REGION_ALIASES` in `geoExpansion.ts`.
- A new banker attribute to search on → a facet in
  `CorrespondentRepository.searchFacets` plus a weight in `FACET_WEIGHTS`, then
  an argument on the tool.

Do not add a name → ISO code map; `country-to-iso` already does that.
