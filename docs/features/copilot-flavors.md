# Copilot flavors (M&A, Investment, Combined, VC, Minority Stakes, Crowdfunding)

The in-app Copilot ships in six selectable flavors, chosen per workspace.

**Where the code lives.** `src/lib/agents/analysis/` is laid out in dependency
order — each layer may import the ones above it, never the ones below:

| Module | Holds |
| --- | --- |
| `effort.ts` | the reasoning-effort tiers (model + `output_config.effort`) |
| `guides.ts` | the prompt fragments every chat flavor appends |
| `flavors/` | **one file per flavor**, plus the registry that lists them |
| `workforce.ts` | the Workforce agent's tools, HITL middleware and prompt |
| `runtime.ts` | how an agent is built and driven (`createLocalAgent`, `AgentGraph`) |
| `graphs.ts` | the memoized graphs and the getters routes call |
| `messages.ts` | reading agent output back off a message list |
| `index.ts` | a barrel — consumers still import `@/lib/agents/analysis` |

**Adding a flavor** is a new file in `flavors/` exporting a `CopilotFlavor` (its
tool list and its system prompt), its key in `flavors/keys.ts`, and its line in
`flavors/index.ts`. Build the tool list with `lazyToolList(() => [...])` — never
spread `tools` at module scope. `tools/index.ts` sits in an import cycle with
services and job handlers (a chat tool calls into them, and they import the
agent back), so a flavor module can evaluate while `tools` is still
initializing; reading it then throws `Cannot access '…' before initialization`
during `next build`'s page-data collection. vitest mocks the tools barrel, so
unit tests cannot catch it — `flavors/index.test.ts` pins the invariant instead. `CopilotAgentType` is *derived* from `COPILOT_AGENT_KEYS`
and `COPILOT_FLAVORS` is a `Record<CopilotAgentType, CopilotFlavor>`, so adding
the key fails the build until the flavor exists. `getAgentGraph` resolves
through the registry and does not branch per flavor, and `workspaceService`'s
`COPILOT_AGENTS` / `normalizeCopilotAgent` are derived from the same key list
(via `flavors/keys.ts`, which imports nothing, so validating the column never
drags the LangChain agent stack into a route). What still needs wiring by hand
is the user-facing copy: the admin-portal picker, and the flavor's starting
prompts in the chat's suggestion carousel (`ChatSuggestions.tsx`).

The eight flavors:

- **`mna`** (default) — the M&A / acquisitions assistant: company/CRM tools,
  pipeline analysis, Workforce handoffs, and Valyu/web search
  (`CHAT_SYSTEM_PROMPT` + `defaultChatToolList`).
- **`investment`** — the funds & investing assistant: read-only tools to see and
  analyze the workspace's funds, assets/holdings, investors (LPs), and fund
  sources, plus web search and Valyu search (`INVESTMENT_SYSTEM_PROMPT` +
  `INVESTMENT_TOOL_LIST`, backed by the fund tools in
  `src/lib/agents/analysis/tools/`: `get_fund_data_schema`,
  `search_investments`, `query_funds`, `query_fund_assets`,
  `get_fund_asset_details`, `query_investors`, `query_fund_sources`,
  `query_ledger_entries`). `query_ledger_entries` is the movement-level tool —
  it reads the posted ledger rows themselves off the same shared model the
  [Ledger](async-jobs.md#ledger) page renders from, so a figure quoted in chat matches the
  figure on screen; the other fund tools report roll-ups.
- **`combined`** — a single assistant with access to BOTH tool sets, for
  workspaces that want one Copilot spanning the deal pipeline and the fund
  portfolio (`COMBINED_SYSTEM_PROMPT` + `COMBINED_TOOL_LIST`). `combinedTools` is
  the deduplicated union of `DEFAULT_TOOL_LIST` and `investmentTools` — the
  shared read tools (`web_search`, `valyu_search`, `query_files`, `lookup_crm`,
  `crm_insights`, `lookup_user`, `send_email`, `propose_workforce_handoff`)
  appear once. `query_ledger_entries` is in this set too.
- **`vc`** — the Venture Capital & Growth Equity assistant: a flavor of the
  existing Copilot (not a separate agent, graph, or endpoint) powered by
  `VC_SYSTEM_PROMPT` + `VC_TOOL_LIST`. It combines curated fact-retrieval tools
  across pipeline companies, fund portfolios, and CRM context with
  `get_investment_theses` (active/inactive workspace theses/tracks),
  `calculate_investment_returns` (deterministic scenario math for proceeds, MOIC,
  and IRR), and enhanced external research via Valyu (`valyu_search` and
  `valyu_extract_content`, with `web_search` as fallback/corroboration). The model
  dynamically selects tools and owns qualitative synthesis and recommendations
  (`invest` / `pass` / `investigate further`); there is no mandatory module
  sequence or end-of-turn evaluation. External companies and funds not in
  workspace data are researched seamlessly using cited external search. No schema
  migration or new table is required (persisted via `workspaces.copilot_agent = 'vc'`).
- **`minority`** — the **Minority Stakes Portfolio Manager**: the Copilot for a
  firm that holds MANY SMALL, NON-CONTROLLING positions rather than a few control
  deals (`MINORITY_SYSTEM_PROMPT` + `MINORITY_TOOL_LIST`). `MINORITY_TOOL_LIST` is
  `defaultChatToolList()` plus one addition, `financial_equity_analysis`, so it
  reads the same pipeline, CRM, files and research surface as `mna` and owes the
  user the same write discipline (no direct writes; Workforce handoffs and the
  inline bulk cards). The extra tool is there because a non-controlling holder is
  a public-equity-style analyst of a business somebody else runs: the return comes
  from growth, the multiple and the dividend, so that arithmetic is the
  underwriting rather than a side calculation. What differs is the job: every answer is framed by whether the business is one we can hold
  passively, what the position does to portfolio concentration and sizing, what
  minority protections govern it (information and consent rights, tag-along,
  drag-along, pre-emption, preference), and how we ever get liquid. The shared
  pipeline mechanics live in one constant, `MNA_PIPELINE_OPERATIONS_GUIDE`, which
  the `mna` and `minority` prompts both interpolate so the two can't drift;
  `promptStability.test.ts` pins both assembled prompts' hashes. Persisted via
  `workspaces.copilot_agent = 'minority'` — no migration needed.
- **`crowdfunding`** — the **Crowdfunding Agent**: the Copilot for the firm's
  small-ticket book, a position of around **Rp 10bn** into a raise whose whole
  funding need is **under Rp 20bn**, funded through a crowd that may be the
  firm's own employees (`CROWDFUNDING_SYSTEM_PROMPT` +
  `CROWDFUNDING_TOOL_LIST`). The tool list is `defaultChatToolList()` plus five
  read-only additions the mandate needs and `mna` has no use for:
  `calculate_investment_returns` (a raise this size is underwritten on IRR,
  payback and distribution cover off a stated cash-flow schedule, not on an
  entry multiple), `get_regulatory_context`, `get_company_profile` (at this size
  the owner-operator *is* the credit), `get_sector_context`, and
  `valyu_extract_content` (reading a venue listing or an OJK page properly
  rather than off a search snippet). It shares `MNA_PIPELINE_OPERATIONS_GUIDE`
  with `mna` and `minority`, so the write discipline is identical. What differs
  is the job, and four things in the prompt carry it:
  - **A mandate gate checked before any analysis** — a larger raise or ticket is
    named as outside the mandate and pointed at the M&A / VC flavors. Because
    the posture is deliberately high-risk, every recommendation leads with the
    loss case.
  - **A carve-out perimeter check** — what is on offer is often one project,
    outlet, vessel or SPV rather than a company, and it has no separately
    reported financials. Legal perimeter, cash separability, asset title,
    contract perimeter, cost attribution, who is obliged to pay, step-in. A
    project failing cash separability or the obligor test is "an exposure to the
    parent dressed as a project".
  - **A Verified / Sponsor-stated / Modelled label on every figure** — nothing an
    MSME this size reports is corroborated by a public record, so Verified is
    restricted to evidence outside the sponsor's own say-so (a reconciled bank
    statement, a tax filing, a notarial/AHU record, a licence record, an
    executed contract, a court record, a direct counterparty confirmation).
  - **The OJK securities-crowdfunding regime, cited to its instrument** — POJK 17
    Tahun 2025 (in force 25 July 2025, revoking POJK 57/POJK.04/2020 and POJK
    16/POJK.04/2021): the Rp 10bn per-issuer 12-month cap, issuer eligibility,
    the 5% / 10% investor income limits, and the >100-offered / >50-sold
    public-offering threshold that bounds a raise run outside a licensed venue.
    The parameters moved recently, so the prompt makes re-confirming them a hard
    rule rather than baking them in — and it carries a conduct rule for raising
    from the firm's **own employees** (voluntary, unlinked to employment, same
    disclosure as an outside investor, no personal investment advice, legal and
    compliance sign-off first).

  `promptStability.test.ts` pins the assembled prompt's hash. Persisted via
  `workspaces.copilot_agent = 'crowdfunding'` — no migration needed.
- **`investment_banking`** — the **Investment Banking Advisory Agent**: the
  Copilot for the firm's advisory desk, which sits on the *sell* side of a
  mandate rather than the principal side (`INVESTMENT_BANKING_SYSTEM_PROMPT` +
  `INVESTMENT_BANKING_TOOL_LIST`). Every other flavor underwrites a position the
  firm takes; this one advises an owner, a founder or a board on **which
  transaction to run**, and its whole value is that it compares the routes to
  each other instead of assuming one. The prompt carries a **route menu** every
  substantive answer has to work through — control sale (M&A), minority/growth
  stake sale, IPO, follow-on/secondary sell-down, bond issuance, leveraged or
  dividend recap, strategic partnership / JV, carve-out / divestiture / spin-off,
  private placement / pre-IPO round, and **doing nothing**, which is always on
  the menu and always priced. Instrument-level structuring and pricing are
  explicitly handed to `capital_markets`. Also in the prompt: an objective-first
  mandate workflow (objective and constraints → readiness → valuation range per
  method with sources and dates → counterparty universe → process and clock →
  deal-breakers → walk from headline EV to the owner's net proceeds), and a
  conflicts/conduct section (advisory fees reward a completed transaction, so
  say so; no MNPI into external search; no legal, tax, accounting or regulatory
  opinions; name the jurisdiction's listing, takeover and merger-control
  regime).
- **`capital_markets`** — the **Capital Markets Agent**: the firm's **DCM +
  ECM** desk (`CAPITAL_MARKETS_SYSTEM_PROMPT` + `CAPITAL_MARKETS_TOOL_LIST`). It
  starts one step after the advisory question — the issuer has decided to raise —
  and works the instrument: what to issue, how much, for how long, at what price,
  on what structure, to whom, and when. The prompt carries a two-sided
  **instrument menu** (DCM: senior unsecured, senior secured, sukuk, high yield,
  convertibles, perps/hybrids, MTN programmes and private placements, syndicated
  and bilateral loans, project finance, securitisation/ABS, and
  green/sustainability-linked; ECM: IPO, follow-on, rights issue, accelerated
  bookbuild / block trade, private placement / PIPE / pre-IPO, dual listings and
  depositary receipts, equity-linked), and three rules that govern every answer:
  **capacity is a fact about the issuer** (leverage, coverage, headroom, existing
  covenants; free float, track record, governance), **price is set by the
  market** (benchmark + comparable recent prints with dates + premium/discount =
  indicative all-in cost; never a spread, coupon or multiple quoted from memory),
  and **a window opens and closes** (a present-tense fact that must be
  researched). Figures are labelled **market-evidenced / issuer-stated /
  assumed**, and the prompt is explicit that it does not set a price or
  underwrite.

  Both advisory flavors are `defaultChatToolList()` plus the **same seven
  read-only research additions** — `calculate_investment_returns`,
  `get_company_profile`, `get_sector_context`, `get_competitor_landscape`,
  `get_regulatory_context`, `get_market_signals` and `valyu_extract_content` —
  so they read the M&A pipeline, CRM, files and news surface and share
  `MNA_PIPELINE_OPERATIONS_GUIDE` (identical write discipline: no direct writes,
  Workforce handoffs and the inline bulk cards). The two desks read the same
  data; what differs is the job. `promptStability.test.ts` pins both assembled
  prompts' hashes. Persisted via `workspaces.copilot_agent =
  'investment_banking'` / `'capital_markets'` — no migration needed.

## Follow-up questions: offer the next action

Every chat flavor and the sector chat agents append `NEXT_ACTION_GUIDE`
(`src/lib/agents/analysis/guides.ts`, "## Offer the Next Action"). When an
answer leaves a step the agent could take with its own tools (an approval
card, a card-section edit, a Workforce handoff, an email or export, an insight,
opening a page, a deeper look at a named company), it closes with one short,
specific question offering that step, e.g. "Want me to put these three stalled
deals on a drop card?". It asks before anything that writes, sends or starts a
long run unless the user already asked for it outright, never closes with a
generic "Anything else?", and skips the question when no action follows.

There is no longer a dedicated, shared external research section in the chat
prompts (the old `buildExternalEvidenceGuide` "Grounding" block was removed).
Each flavor's own prompt still says when to search; the M&A flavor keeps its
"Default Posture: Research First" section.

## Search policy (Workforce)

The Workforce and the sector workforce agents append `WORKFORCE_EVIDENCE_GUIDE`
(`src/lib/agents/analysis/workforce.ts`), which owes a freshness search to
every company a run touches:

- **A company touched is a company searched.** The moment a company appears in
  the instruction, a record read, a file queried or the report being written, it
  owes at least one `web_search` for its latest news before the agent writes
  about it.
- **One angle is the floor.** For a company the verdict turns on, further
  `web_search` calls follow from other angles in the same turn.
- **On bulk runs,** one freshness search per company; extra angles go first
  when a run is tight.

Background prompts carry the same rule where they touch one company:
`aiScreening` searches before evaluating a criterion rather than only when a
field is missing, `companyAnalysis` always includes a latest-news angle, and the
Fund AI Opinion instruction (`fundAiOpinionService`) searches the holding on
every run, in the same pass as the internal lookups rather than after them.

Because the spend now scales with the number of companies in play, `web_search`
carries a `max_uses` of 80 (`tools/server_tools.ts`); exceeding the cap returns
`max_uses_exceeded` as a 200 and the agent silently degrades to `valyu_search`,
losing citations. Wall-clock, not the cap, is the runaway guard (`turnBudgetMs`
in `src/lib/agents/analysis/effort.ts`).

## AlphaSense research (`alphasense_search`)

**Retired — not registered with any agent.** The AlphaSense subscription is no
longer in use, so `alphasense_search` was removed from every tool list (`tools`,
`investmentTools`, `vcTools` in `src/lib/agents/analysis/tools/index.ts`, and the
sector agents' `SECTOR_READ_CORE_TOOLS`) and from every system prompt. No agent
flavor can call it. The implementation below is left in place, exported and
unit-tested, so the tool can be put back in a tool list if the subscription ever
returns; until then it is dead code and the `ALPHASENSE_*` env vars are unused.

`alphasense_search` (`src/lib/agents/analysis/tools/alphasense_search.ts`) asks
the firm's AlphaSense subscription a research question: sell-side / broker
research, SEC and global filings, earnings-call and expert-call transcripts,
company presentations, and licensed news.

The transport is `src/lib/alphasense.ts` (`AlphaSenseClient`), a thin wrapper
over the [AlphaSense Agent API](https://developer.alpha-sense.com/agent-api/quickstart):

1. `POST https://api.alpha-sense.com/auth` — OAuth2 password grant
   (`x-api-key` + client id/secret + user email/password) returns an
   `access_token`. Tokens are cached in-module keyed by api key + username and
   refreshed 60s before `expires_in`, so several tool calls in one chat turn
   authenticate once. A 401/403 on a GraphQL call triggers exactly one forced
   re-auth and retry.
2. `POST https://api.alpha-sense.com/gql` — the `genSearch.auto` mutation starts
   a conversation and returns its id; the `genSearch.conversation` query is then
   polled every 2s until `progress` reaches `1.0` (or `error.code` is set).
   GenSearch is asynchronous and typically takes 20–90s.

Because the run is long, the tool bounds it twice: a 150s poll budget inside
`runGenSearch` (which returns the partial `markdown` flagged `timedOut` rather
than hanging the turn) and a 180s `withToolTimeout` backstop for a hung socket.
The answer is returned as markdown with AlphaSense's inline `[[n • Source]]`
citations preserved.

Configuration is the five `ALPHASENSE_*` env vars in `.env.example`
(`ALPHASENSE_API_KEY`, `ALPHASENSE_CLIENT_ID`, `ALPHASENSE_CLIENT_SECRET`,
`ALPHASENSE_EMAIL`, `ALPHASENSE_PASSWORD`). When any are unset the tool returns a
message naming the missing variables and telling the agent to fall back to
`valyu_search` / `web_search` — it never throws, so an unconfigured environment
degrades instead of breaking a chat turn. With the tool retired, the routing
guidance in each flavor's system prompt now reads: `valyu_search` when the answer
should rest on filings, transcripts, analyst research or proprietary datasets;
`web_search` for everything else — current facts, recent market news, deals and
funding — run aggressively, several calls from different angles per turn. (The
`search_news` lake tool has been removed from the agents; recent-news questions
go straight to the open web.)

Every invocation was logged to the `alphasense_tool_calls` table
(`AlphasenseToolCallRepository` / `AlphasenseToolCallService`, wired into
`createContainer`) for historical lookback: the resolved workspace, the exact
`prompt` sent to GenSearch, the call's `status`
(`success` / `timed_out` / `error` / `not_configured`), the AlphaSense
`conversation_id`, and the returned markdown or error message. Each row also
carries `chat_thread_id` and `original_question` — the LangGraph `thread_id`
and the user's own un-reformulated question for that turn, both of which
travel via the runtime `configurable` (set once in `/api/chat`,
`/api/v1/chat`, and `/api/v1/chat/stream`) rather than as tool arguments, so
the model can't fabricate them. Logging is best-effort: a DB failure is
swallowed and warned, never surfaced as a broken chat turn.

## VC external research architecture (Valyu & Web)

The VC Copilot integrates external research tools for live diligence across companies, sectors, fund managers, exit comps, and integrity checks:

- **Synchronous chat research tools:**
  - `valyu_search`: Primary search engine for financial filings, market research, sector dynamics, news, transcripts, and web sources with clickable markdown citations.
  - `valyu_extract_content`: Targeted factual extractor for deep inspection of 1–3 specific authoritative URLs discovered during research.
  - `web_search`: Fallback search engine for general web queries and cross-source corroboration.
- **Coverage boundaries & factual limits:** Valyu provides strong coverage for public markets, SEC/regulatory filings, industry research, and web sources. Documented sources do not guarantee complete private cap tables, private fund performance/LP data, or undisclosed metrics; these remain gaps when not found. Undisclosed private metrics are explicitly reported as data gaps rather than estimated or guessed.
- **Fast chat vs. deferred DeepResearch/Batch boundary:** Fast synchronous search (`search`) and targeted extraction (`contents`) power interactive chat to keep conversational latency low. Long-running **Valyu DeepResearch** (multi-minute deep investigations) and **Batch** research workflows are **intentionally deferred** to a future AI Workforce background integration and are **not implemented** in the synchronous Copilot chat.
- **Agentic tool use:** The LLM selects tools dynamically based on user intent and evidence needs (no rigid tool sequences or fixed topic pipelines) and owns all investment synthesis and recommendations.

**Name resolution ("how is X doing?").** On the fund side a name the user types
can be a holding, a fund, an investor/LP, or a source of capital, and the user
is not expected to say which. `search_investments` fuzzy-matches the name across
all four entity types in one call (returning type, match strength, headline
metrics, and the `fund_asset_id` for holdings), and both the investment and
combined prompts require it before any single-type lookup. The matching itself
lives in `src/lib/agents/analysis/tools/fuzzySearch.ts` — a dependency-free
scoring ladder (exact → prefix → substring → token overlap → acronym →
Dice/Levenshtein typo fallback) that ignores case, punctuation, and legal
suffixes ("acme" resolves "Acme Holdings Pte Ltd"). `get_fund_asset_details`
(`asset_name`) and `query_fund_assets` (`fund`) use the same matcher.

How it's wired:

- The choice persists on `workspaces.copilot_agent` (a text column, default
  `'mna'`; migration `20260712000000_add_workspace_copilot_agent`).
- A superadmin picks the flavor from the **AI Copilot** dropdown in the workspace
  configuration panel (`/admin-portal`), which `PATCH`es
  `/api/workspaces/{id}` with `{ copilot_agent }`.
- `WorkspaceService.getCopilotAgent` / `updateCopilotAgent` read and write it;
  `COPILOT_AGENTS` / `normalizeCopilotAgent` (in `workspaceService.ts`) are the
  validation source of truth.
- `/api/chat` resolves the active workspace's flavor and calls
  `getAgentGraph(copilotAgent)`; the agent layer memoizes one `AgentGraph`
  singleton per flavor (they share the same checkpointer, so a thread's history
  is readable regardless of the active flavor).
