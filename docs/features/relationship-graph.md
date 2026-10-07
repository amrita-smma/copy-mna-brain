# Relationship graph (Neo4j)

The relationship graph (`/graph`, served by `GET /api/graph`) is backed by
Neo4j and visualizes companies as nodes with `INVESTED_IN` / `PARTNER` /
`SUPPLIER` edges. **Postgres `companies` is the source of truth; Neo4j follows
it.**

- **Write-through mirror (repository layer).** `CompanyRepository` takes an
  optional `CompanyGraphMirror` (the `CompanyRelationRepository`, wired in
  `container.ts`). Every company write — `insert`, `insertMany`, `update`,
  `updateMany`, `delete` — mirrors to the graph: writes `MERGE` a node
  (mapping `target`→`name`, plus `segment`/`geography`/`ownership`/
  `pipeline_stage`→`pipelineStage`/`status`), deletes
  `DETACH DELETE` it. The mirror is **best-effort**: a Neo4j failure is logged
  and never fails the Postgres write. Repos constructed without a mirror (e.g.
  inside job handlers) simply skip it.
- **Full reconciliation.** `POST /api/graph/sync` dispatches a `graph_sync`
  background job (`CompanyGraphService.dispatchSync` → `runGraphSync`) that
  `MERGE`s a node for every company and prunes any graph node whose Postgres
  row no longer exists. Use it to repair drift (e.g. after writes that bypassed
  the mirror). Like all async work it reports lifecycle through `jobs` /
  `job_logs`.
- **Agent-authored relationships.** Linking logic lives in
  `CompanyRelationshipService.linkByName` (services layer): it records a directed
  edge between two companies (`source --[INVESTED_IN|PARTNER|SUPPLIER]--> target`)
  via `CompanyGraphService.relateCompanies`. Each side is matched by name
  (`CompanyRepository.findByNameFuzzy`); a company with no match is auto-created
  in Postgres at the **`discovered`** pipeline stage — a stage reserved for
  companies that surface only through a relationship, not through the L0–L5 deal
  pipeline. Discovered companies get their own section in the Master Data view
  (`src/views/MasterData.tsx`). `relateCompanies` upserts both nodes before the
  edge so the relation always attaches. Two workforce-only tools drive this:
  `update_company_relationship` (a single explicit edge) and
  `generate_company_card` (one edge per related company a Company Card surfaces).
- **Agent-read relationships.** The read-only `read_relationship_graph` tool
  (base tool, available to chat and workforce) queries existing edges without
  mutating anything. Given one company it lists every company that company is
  directly connected to (relation type + direction); given a list of companies
  it checks every unordered pair for a direct connection. Names are resolved
  with `CompanyRepository.findByNameFuzzy`; the graph reads go through
  `CompanyGraphService.getConnectedCompanies` / `getConnectionsAmong`
  (`CompanyRelationRepository` in the repository layer).
- **Combining companies (workspace admins only).** `POST /api/graph/combine`
  merges several companies into one surviving "main" company. Backed by
  `CompanyRelationshipService.combineCompanies`, it (1) records each absorbed
  company's display name and existing aliases on the main company's
  `companies.aliases` column, (2) reroutes every graph edge to/from the absorbed
  companies onto the main company via
  `CompanyGraphService.reassignAndDeleteNode` (preserving edge notes/evidence/
  date), and (3) deletes the absorbed Postgres rows (cascading their related
  data). Aliases are persisted first so the main node is mirrored into Neo4j
  before edges are rerouted onto it. The route is gated by
  `WorkspaceService.isWorkspaceAdmin` (platform superadmin or the `admin` role in
  the active workspace); the edit-mode "Combine companies" panel in
  `CompanyGraph.tsx` only renders for admins.
- **Aliases-aware matching.** `companies.aliases` (a `jsonb` string array) is
  consulted by `CompanyRepository.findByNameFuzzy` alongside `target` /
  `project_name`, so a relationship edge or ingest naming an absorbed company
  resolves to the surviving main company instead of spawning a duplicate
  `discovered` row. This applies automatically to the `generate_relationship_graph`
  and `update_company_relationship` tools, which resolve names through
  `findByNameFuzzy`.

- **Visualizer (`src/views/CompanyGraph.tsx`).** The `/graph` canvas
  (`react-force-graph-2d`) supports client-side filtering on company metadata
  (ownership, geography, **pipeline stage**, **status** — active vs dropped) and
  on edges (relationship type, has-evidence, date range). **Right-clicking a
  node** opens a context menu with *"Display only connected companies"*, which
  pins that node and restricts the graph to it plus its direct neighbours
  (companies sharing an edge in either direction); a chip in the filter sidebar
  clears the pin.

  The sidebar also has a **Highlight** combobox: selecting companies pins the
  graph to exactly that selection plus the companies on the connection paths
  between each highlighted pair (up to 5 alternative paths per pair, ≤ 5 hops,
  mirroring the Neo4j `MATCH path = (a)-[*1..5]-(b)` traversal), bypassing the
  other filters. Beneath it, the **"Show connected companies"** checkbox widens
  that view to also include every company with a direct edge to a highlighted one
  (and the edges attaching them), so a highlight can be read in the context of its
  immediate neighbourhood. The shared `neighborIds` helper in
  `src/lib/graph/nodeStyle.ts` computes that neighbour set (also used by the
  right-click pin) from the *unfiltered* edge set, so it stays an intrinsic
  relation rather than a product of the active edge filters.

- **Shareable filter URLs (`src/lib/graph/graphFilterParams.ts`).** Every graph
  filter is mirrored into the query string, so a filtered view can be shared as a
  plain link: `q` (the sidebar search term), `highlight` (repeated, company ids),
  `connected=1` ("show connected companies"), `connectedTo` (the right-click pin),
  `ownership`, `geography`, `sector`, `stage`, `status`, `rel` (enabled
  relationship types), `evidence=1`, `from`, `to`. `q` is the odd one out: it
  doesn't filter the node set, it centres and zooms the canvas on the matching
  company, and it's applied on `onEngineStop` (in place of the default
  fit-to-screen) because it needs the force layout to have settled before nodes
  have coordinates to centre on. Multi-value filters use repeated params rather than a
  delimiter so values containing commas survive a round trip, and defaults are
  omitted so an unfiltered graph keeps a clean `/graph` URL. Unknown or malformed
  values fall back to their default, so a hand-edited link can't wedge the view;
  the one non-obvious encoding is a blank `rel=`, which carries "every
  relationship type de-selected" (an omitted `rel` means the opposite, all
  enabled). `CompanyGraph` decodes the query string once on mount to seed its
  filter state and thereafter writes the URL itself via `history.replaceState`
  (not `router.replace`, which would re-run the server component and remount the
  canvas mid-filtering).

  `connectedTo` is the exception to decode-once: the company detail dialog the
  graph itself renders embeds the relationship snippet, whose "Show in
  relationship graph" button links back to `/graph?connectedTo=<companyId>` — a
  soft navigation on the *same* route, which leaves the view mounted and only
  updates `useSearchParams()`. So that param is read live, and the URL sync keeps
  it until the id has been consumed (resolved to its node, or found to be absent
  once the graph has loaded), so a pending deep link is never stripped before it
  applies.
- **Company detail snippet (`src/components/pipeline/CompanyRelationshipGraph.tsx`).**
  Both the company detail page (`CompanyDetail.tsx`) and the company detail
  dialog (`CompanyDetailDialog.tsx`, opened from Master Data, Dashboard
  insights, market-screening results and the graph itself) embed a filter-free
  miniature of the graph on their Details tab, showing just that company and the
  companies directly connected to it, plus a **"Show in relationship graph"**
  button that deep-links to
  `/graph?connectedTo=<companyId>`. It is served by `GET /api/graph/connections?companyId=`
  → `CompanyGraphService.getCompanyNeighbourhood`, which fetches the focal node,
  its direct neighbours and every edge among that set in a fixed handful of
  queries (no per-neighbour fan-out). Company nodes carry no `workspace_id`, so
  the route scopes both the focal company and its neighbours through
  `CompanyService.findExistingIds` (one batched Postgres lookup). The canvas is
  read-only: node drag, panning and zooming are all disabled, it is sized from
  its container via a `ResizeObserver` (rather than force-graph's 800×600
  default, which would overflow the card), and it re-runs `zoomToFit` on every
  simulation tick and on resize so the neighbourhood stays centred and fully in
  frame. Nodes are drawn at `NODE_SCALE` (circle *and* label metrics scale
  together) so a handful of companies fit without scrolling.
- **Shared canvas styling (`src/lib/graph/nodeStyle.ts`).** Relation colours and
  labels, stage-based node colour, EV-derived node sizing, label wrapping and the
  node canvas painter live in one module used by both the full graph page and the
  detail-page snippet, so the two canvases always read identically.

Connection is configured via `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD`
(see `src/lib/neo4j.ts`).

The Neo4j server itself is provisioned by `terraform/ec2/neo4j`, which also
manages an S3 backup bucket (`mna-neo4j-backups-<env>-<account_id>`). The
instance runs a systemd timer that dumps the database and uploads it to S3
daily; `/usr/local/bin/neo4j-restore.sh` on the instance restores the latest
dump (installed by the module's user-data, not a file in this repo). See
`terraform/ec2/neo4j/README.md` for the backup/restore workflow and the
data-preserving migration procedure.
