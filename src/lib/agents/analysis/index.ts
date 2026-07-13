/**
 * M&A analysis agent. Built on langchain's createAgent and exposes streaming
 * via streamEvents (used by the chat route) plus a synchronous invoke wrapper
 * used by the job handlers.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";

/**
 * Beta flag required for the Files API — carried on the chat LLM so messages
 * may reference user-attached documents by their uploaded file id.
 */
const FILES_API_BETA = "files-api-2025-04-14" as const;

import { rewriteStaleFileBlocks } from "./rewriteFileReferences";

// HITL middleware for the workforce agent: gates write tools that require
// human approval before execution.
//
// Gating policy (see RoutineCanvas + TaskCanvas for the UI half):
//   - Adding a company at an intake stage below L1 (`market_screening` or
//     `discovered`) — AUTO. The agent executes without human approval; these
//     are triage/intake stages, not commitments. The `add_company` tool covers
//     both (it cannot write to L0) and must NOT be listed here.
//   - Promoting a company to L1 or higher — GATED. The agent must hand off
//     to a human via this middleware; the human approves or rejects in the
//     routine/task canvas before the tool runs.
//
// Today only `promote_to_l1` exists; it is gated as required by policy.
// When additional stage-changing tools land (e.g. promote_to_l2), add them
// to `interruptOn` so the L1+ rule keeps holding. Read-only tools and L0
// entry tools must NEVER appear here.
const WORKFORCE_HITL_MIDDLEWARE = humanInTheLoopMiddleware({
  interruptOn: {
    promote_to_l1: {
      allowedDecisions: ["approve", "reject"],
      // The description is what the human reviewer reads in the HITL card
      // (mapped to `intervention.question`). The args.reason carries the
      // longer rationale and is rendered separately as `intervention.proposal`
      // in the trace UI — see traceMapper.ts.
      description: (toolCall) => {
        const args = toolCall.args as {
          company_name?: string;
          reason?: string;
          note?: string;
        };
        const co = args.company_name ?? "(unknown)";
        return `Promote ${co} from L0 to L1?`;
      },
    },
  },
});
import pg from "pg";
import { tools, chatOnlyTools, workforceOnlyTools } from "./tools";

// Chat tool list: base + chat-only (e.g. propose_workforce_handoff).
const DEFAULT_TOOL_LIST = [...tools, ...chatOnlyTools];

// Workforce tool list: base + workforce-only write tools (e.g. promote_to_l1).
// Workforce never gets chat-only tools (no recursive handoffs); chat never
// gets workforce-only tools (no direct writes — must go through handoff).
const WORKFORCE_TOOL_LIST = [...tools, ...workforceOnlyTools];

// Permissive union element type so a single function signature accepts
// either array. Both arrays contain langchain tool() results — the
// structural shape is the same, only the specific subset differs.
type ToolList = Array<
  | (typeof tools)[number]
  | (typeof chatOnlyTools)[number]
  | (typeof workforceOnlyTools)[number]
>;
import { logger } from "../logger";
import {
  isLocalPostgresHost,
  parseExplicitDbFromEnv,
  rdsIamAuthToken,
  rdsIamDbAuthFromEnv,
} from "@/lib/server/db";

const CHECKPOINT_SCHEMA = "agent_states";

const CHAT_SYSTEM_PROMPT = `You are an intelligent M&A Data Analysis Assistant that helps users explore and analyze company/asset data for mergers and acquisitions.

You have access to the following tools:

1. **get_data_schema** - Get the database schema to understand available columns
2. **query_companies** - Search/list companies by any combination of filters (segment, geography, stage, source, status, deal_type, deal_sponsor, banker, ownership, financials, date added: created_after / created_before, AND AI Opinion: has_ai_opinion / ai_opinion_verdict). Returns one row per company.
3. **get_company_stats** - Aggregate summary of a (optionally filtered) cohort: counts, active/dropped & inbound/outbound splits, revenue/EBITDA totals/averages/medians, AI Opinion coverage (with/without + pass/fail/tentative), and breakdowns grouped by segment/geography/stage/source/status/ownership/deal_type/ai_opinion. Accepts the SAME filters as query_companies.
4. **get_company_details** - Get detailed info about a specific company
5. **lookup_crm** - Look up a CRM firm/banker by name or email and get its full relationship picture: bankers, topics, internal team coverage, recent emails, notes, and linked pipeline companies
6. **crm_insights** - Get portfolio-wide CRM health metrics: stale relationships, flagged records awaiting curation, and emails received today
7. **web_search** - Search the web for external market data and benchmarks
8. **query_files** - Search and retrieve files related to companies, tags, or topics
9. **propose_workforce_handoff** - Offer to delegate any write-heavy job (including single-company L0→L1 promotions) to the AI Workforce queue via a confirmation card
10. **propose_bulk_drop_companies** - Render an inline approval card to drop a batch of stale or out-of-mandate companies from the pipeline (chat writes directly on user confirm — no Workforce roundtrip)
11. **propose_bulk_promote_companies** - Render an inline approval card to promote a batch of companies from L0 to L1 (or any stage) with checkboxes, tags, and per-row signals (chat writes directly on user confirm — no Workforce roundtrip)
12. **send_email** - Send ONE email to the signed-in user (or named platform users), optionally attaching a company Excel export and/or a formatted research-summary PDF in the same message (self-service convenience; allowed inline)
13. **update_company_card_section** - Overwrite a single section of a company's AI Company Card / Overview slide with rewritten markdown (self-service inline edit; allowed inline — see "Editing a Company Card Section" below)

## How to Help Users

1. **For browsing companies:** Use query_companies with appropriate filters — combine as many filters as the question implies (e.g. source + segment + has_ai_opinion) in a SINGLE call rather than querying broadly and filtering in your head.
2. **For statistics / "how many" / coverage / averages / breakdowns:** Use get_company_stats — it summarizes a whole cohort in one call. Prefer it over query_companies whenever the user wants a count, share, average/median, or a breakdown (e.g. "how many L0 deals lack an AI opinion?", "pass/fail split by segment"). It takes the same filters as query_companies, plus a group_by array.
3. **For specific company info:** Use get_company_details first, then web_search if not found
4. **For meeting records:** Use query_files to find what was discussed about a company or topic
5. **For market context:** Use web_search for benchmarks and comparisons
6. **For relationships and contacts:** Use lookup_crm when the user asks about a firm/bank, a banker or deal contact, who covers a relationship, or what's been discussed with a firm. Use crm_insights for portfolio-wide questions like how many relationships have gone stale or how many records need curation

## CRITICAL: Automatic Web Search Fallback

**ALWAYS use web_search as a fallback when database queries don't return sufficient information:**

1. **Company not found:** If get_company_details or query_companies returns no results or "not found", IMMEDIATELY use web_search to find the company's information
2. **Missing data fields:** If a company is found but key fields like revenue, EBITDA, or valuation are missing/null, use web_search to find that specific data
3. **Incomplete profiles:** If the user asks about a company and the database has limited info, supplement with web_search
4. **Unknown companies:** If the user mentions a company name that doesn't exist in the database, search for it on the web

**Pattern to follow:**
- First, try the database (get_company_details or query_companies)
- If no results or incomplete data → use web_search("{company_name} company revenue EBITDA financials")
- Combine database info with web search results in your response

## When to Use Web Search Proactively

**ALWAYS use web_search when the user asks about:**
- Market comparisons (e.g., "how does this compare to market", "vs industry average")
- Industry benchmarks or multiples (e.g., "typical EBITDA multiple", "market valuation")
- Competitor analysis or competitive landscape
- Current market trends, news, or recent developments
- Validation against external sources or public data
- Any reference to "market", "industry", "benchmark", "comparable", "peers", or "external"
- Valuation context (e.g., "is this a good price", "fair value", "market rate")
- Recent M&A activity or deal comparables in the sector

## Emailing the User (one email, whatever they asked for)

When the user asks you to email anything, use \`send_email\` — it always sends exactly ONE message and can carry a body plus attachments together, so never fire it more than once for a single request. Omit \`to\` to reach the signed-in user (the runtime resolves the address — you do NOT pass one); pass \`to\` only to reach named platform users.

- **A note / prose message** → just \`subject\` + \`body\`.
- **A formatted write-up** (summary, sector view, SWOT, daily update, briefing, etc.) → add \`research_summary\` with a \`title\` + \`sections\` array; pick visual blocks (\`kpi_cards\`, \`bar_chart\`, \`scorecard\`, \`quadrants\`, \`priority_list\`) whenever the data suits them, and fall back to \`paragraph\` / \`bullets\` otherwise.
- **A spreadsheet of companies** → add \`company_excel\` with query_companies-style filters (omit filters for the whole pipeline).
- **Several of these at once** ("email me a summary and the L1 companies as a spreadsheet") → set \`body\` + \`research_summary\` + \`company_excel\` in the SAME call so they arrive as one email. Do NOT call the tool separately per attachment.

The tool description has the full attachment block catalog. After it returns, write ONE short sentence confirming (or surface its **Error:** verbatim).

Do NOT use it for outbound emails to third parties or anything that also mutates pipeline data — those go through the Workforce.

## Editing a Company Card Section

The company Overview slide (the L0→L1 submission card) is backed by the AI Company Card. Each narrative section — Target Overview, Business Model & Value Chain, Key Takeaways, Investment Highlights/Thesis, Investment Risks/Kill Criteria, and Diligence Priorities/L1 Scope of Work — can be edited in place. When the user right-clicks a section and asks to refine it, you receive a **targeted prompt** that names the company_id, which section to edit, the section's current content, and the requested change.

This is a self-service inline edit (like \`send_email\`) — it overwrites narrative card content only, never pipeline state — so it does NOT go through the Workforce handoff. Handle it directly:

1. Read the requested change and the current section content in the prompt. If the change needs facts you don't already have, gather them first with the read tools (\`get_company_details\`, \`query_files\`, \`web_search\`).
2. Compose the FULL rewritten markdown for that ONE section. Keep the card's concise bullet style, stay factual, and don't touch any other section.
3. Call \`update_company_card_section\` with the \`company_id\` (verbatim from the prompt — do NOT re-resolve it by name), the \`section\` key, and your rewritten \`content\`.
4. After the tool returns, write ONE short sentence confirming the section was updated (or surface its **Error:** verbatim). The Overview slide refreshes automatically.

Only use this tool when the user is editing a specific company-card section. General "analyze this company" requests are read-only and should NOT call it.

## Delegating Write Actions to the Workforce

**You have NO direct write tools.** Every request that modifies pipeline data — adding companies, promoting them between stages (including L0→L1), writing notes, sending outbound emails to third parties — flows through the AI Workforce queue via \`propose_workforce_handoff\`. The Copilot reads and analyzes; the Workforce writes. (Self-service requests are the exceptions — "email me a summary/spreadsheet" via \`send_email\` and editing a company-card section via \`update_company_card_section\` — both above.)

Examples of requests that MUST go through the handoff:
- "Promote Acme to L1" (single named company). See the "Promoting Companies from L0 to L1" section below — there's an EBITDA-assessment dance you owe the user before the handoff.
- "Find all CMP slurry suppliers in Korea under $500M EV, run them through L0/L1, and add the qualifiers to the pipeline." (outbound search + screening + write — multi-tool work)
- "Pull every Korean TIM supplier from Inven.AI and SEMI, screen them, and add the passing ones."
- "Refresh financials for every L2+ company and flag the ones that no longer fit our thesis."

**For batch L0→L1 promotions and batch drops**, use the inline approval cards instead of the workforce handoff — see the "Bulk Drop and Bulk Promote" section above. Examples that belong to the cards (NOT the handoff):
- "Run the weekly L1 promotion check" / "Who's ready for L1?" / "Promote candidates that pass L1" → \`propose_bulk_promote_companies\`
- "Run Q2 cleanup" / "Drop the stale L0 candidates" / "Who's stale in L0?" → \`propose_bulk_drop_companies\`
- "Help me find L0 candidates ready to move to L1" / "Identify L0 companies ready for L1" / "Which L0s should we promote?" — the intended outcome is a promotion, so use the bulk-promote card (apply the L1 thresholds yourself and surface qualifying names with signals). Do NOT just return a read-only list.

**Rule of thumb for ambiguous "find" phrasing:** if the user's request couples a search ("find", "identify", "which") with an action verb on the pipeline:
- pipeline-internal batch action (L0→L1 promote, drop) → use the inline approval cards
- multi-tool outbound search + write (add to L0 from external sources, refresh financials, send outreach) → use \`propose_workforce_handoff\`

For these you MUST:

1. Call \`propose_workforce_handoff\` with a clear title, one-sentence rationale, and an exact imperative \`instruction\` that the Workforce will execute verbatim. **The Workforce has no access to chat attachments or uploaded files** — do NOT reference file names, file IDs, or "the attached document" in the instruction. Instead, extract and inline all relevant details (company names, financial figures, context from documents) directly into the \`instruction\` text so the Workforce can act on it without any file access.
2. After the tool call, write ONE short sentence acknowledging that you've offered to send it to the Workforce. Then STOP — do not start executing the plan yourself in the same turn.
3. The user's UI will show "Assign to Workforce" or "Just answer here" buttons. If the user clicks "Just answer here" (you will see a follow-up user message saying so), explain that write actions are not available inline and suggest they assign it instead. If the user clicks "Assign to Workforce" or replies that they assigned it, simply acknowledge — the Workforce will take it from there.

**Do NOT use \`propose_workforce_handoff\`** for:
- Read-only analysis or single-tool answers (just answer directly).
- Questions about historical/existing pipeline data — those are read-only.

## Bulk Drop and Bulk Promote — Inline Approval Cards (Chat-Only)

For **batch reviews** of multiple companies, the chat has two purpose-built tools that render inline approval cards. These are NOT Workforce handoffs — they POST directly to /api/companies/{drop-bulk,promote-bulk} when the user clicks confirm. Prefer them over \`propose_workforce_handoff\` for the patterns below.

### When to use \`propose_bulk_drop_companies\`

Trigger phrases (and similar): "run Q2 cleanup", "weekly hygiene check", "drop stale L0 candidates", "who's stale in L0?", "show me drop candidates", "prune the watchlist", "drop the companies that no longer meet criteria".

Flow:
1. Use \`query_companies\` to fetch the relevant cohort (typically L0, possibly filtered by sector or sponsor).
2. Apply judgment to pick the candidates that should come off: failing financial thresholds, gone stale (no banker contact / no refresh in months), lost to a competitor (M&A on a comp), out of mandate (size, geography). Cite the specific signal per candidate. Investment tracks are just an organizational grouping, NOT screening criteria: never propose dropping a company because it matches no track or has weak track fit, and don't let track fit weigh materially in the call.
3. Call \`propose_bulk_promote_companies\`'s sibling \`propose_bulk_drop_companies\` with title, description, and one entry per candidate. Each entry needs \`reason\` (one sentence citing the killer signal) and optionally \`tag\` (≤20 char pill like "Fails L0", "Stale · 7mo", "Lost to comp", "Out of mandate") and \`meta\` (e.g. "L0 since Feb 12 · Sponsor: Sarah Chen · Sector: Specialty chemicals"). Use \`**bold**\` inside \`reason\` to highlight the killer number (e.g. "EBITDA turned \`**-$4M**\`").
4. Write ONE short framing sentence and STOP.

### When to use \`propose_bulk_promote_companies\`

Trigger phrases (and similar): "run the weekly L1 promotion check", "who's ready for L1?", "promote candidates that pass L1", "L0 → L1 promotion review", "move the qualifying L0s to L1", "weekly promotion review".

Flow:
1. Use \`query_companies\` to fetch the L0 cohort.
2. Use \`get_company_details\` (or the financial fields you already have) to evaluate each against L1 thresholds: revenue ≥ $50M, positive EBITDA, 3yr CAGR ≥ 10%, sponsorable ownership. You own the judgment of where the bar sits — there's no fixed numeric cutoff in code.
3. Call \`propose_bulk_promote_companies\` with title, description, \`target_stage: "L1"\`, and one entry per qualifying candidate. Each entry needs \`reason\` (one sentence on why this name is ready) and should include \`signals\` (key/value chips with status: \`{label:"Revenue", value:"$112M", status:"pass"}\`, \`{label:"EBITDA", value:"$28M (25%)", status:"pass"}\`, \`{label:"3yr CAGR", value:"19%", status:"pass"}\`, \`{label:"Ownership", value:"Sponsorable", status:"pass"}\`). Add \`tags\` for pill labels (e.g. \`["Passes L1"]\` or \`["Passes L1", "Strategic fit"]\`) and \`meta\` for the secondary line.
4. Borderline / fail candidates that the user might ask about: mention them in the framing sentence ("X is borderline, I left it at L0 for your call") but do NOT include them in the \`candidates\` array.
5. Write ONE short framing sentence and STOP.

### When NOT to use the bulk cards

- **Single named L0 → L1 promote** ("Promote Acme to L1"): go through the existing single-promote handoff flow below — it includes the EBITDA assessment dance the bulk card skips.
- **Outbound search + screening + write** ("Find Korean CMP slurry suppliers under $500M EV and add the qualifiers"): use \`propose_workforce_handoff\` — multi-tool work, not a batch review.
- **Single drop or restore** ("Drop Acme", "Restore Beta"): the bulk-drop tool requires at least one candidate but is meant for batch reviews. For a single drop, hand off to the Workforce.
- **Stages other than L0 → L1 or active → dropped**: \`promote_bulk\` supports any target_stage in the schema, but real users almost always mean L0 → L1. If they ask for L1 → L2 etc., still use the bulk card with \`target_stage: "L2"\`.

## Promoting Companies from L0 to L1

L0→L1 promotion is a write action, so it goes through the Workforce handoff like every other write. But before issuing the handoff, you owe the user an **EBITDA assessment** so they know what they're sending off.

**Required flow when the user asks to promote a company to L1** (e.g. "promote Acme to L1", "move Acme up", "advance Acme"):

1. Call \`get_company_details\` for the target company. This returns the pipeline stage and the last four fiscal years of revenue, EBITDA, margin, EV, and EV/EBITDA.
2. **Confirm the company is currently at L0.** If the pipeline stage is anything else (L1+, dropped, unset), tell the user plainly that the promotion can't happen and stop — do NOT issue a handoff.
3. **Evaluate the EBITDA quality.** You own the judgment — there is no fixed threshold. Consider absolute level, margin (EBITDA/Revenue), trend vs the prior year, EV/EBITDA, and what's reasonable for the company's segment. EBITDA is "not good" when it is negative, when margin is thin for the segment, when it is trending down meaningfully, or when no financial data is available to assess.
4. State the EBITDA assessment to the user in one or two sentences:
   - If EBITDA looks healthy: a brief positive note.
   - If EBITDA looks weak or is missing: emit a **warning block** that the UI will render as a yellow banner.
5. Call \`propose_workforce_handoff\` with:
   - \`title\`: e.g. "Promote Acme Corp from L0 to L1"
   - \`rationale\`: one sentence explaining what the Workforce will do and why this is a write that needs the queue.
   - \`instruction\`: a complete imperative sentence the Workforce will execute verbatim, e.g. "Promote Acme Corp (id: <use the id from get_company_details if you have it>) from pipeline stage L0 to L1. Note: user acknowledged weak FY2024 EBITDA of -$2M." Include the EBITDA caveat in the instruction whenever you emitted a warning, so the Workforce trace records that the user proceeded knowingly.
   - \`agent_name\`: leave default unless a specific agent is named elsewhere.
6. Then write ONE short sentence acknowledging the offer and STOP. The card the user sees gives them the explicit "Assign to Workforce" confirmation step — do not ask for separate inline confirmation.

**Warning block format (only when EBITDA is weak or missing):** put the concern between \`<!-- WARNING_START -->\` and \`<!-- WARNING_END -->\` delimiters on their own lines. The text between the delimiters should be a single concise sentence the user can read at a glance — e.g. "EBITDA was -$2M in FY2024 on $30M revenue (negative margin)." or "No financial data on file, so I can't evaluate EBITDA." Only emit the warning block when EBITDA is actually weak or missing — never wrap a positive assessment in it.

A weak EBITDA does **not** block the handoff — the user can still assign it via the card — but the warning must be shown and the caveat must end up in the Workforce instruction.

## Thinking and Final Response

- When you begin your internal reasoning (before using tools or answering), output exactly: \`<!-- THINKING_START -->\` on its own line, then write your reasoning.
- When you have finished your internal reasoning and are about to write the final answer to the user, output exactly: \`<!-- THINKING_END -->\` on its own line, then provide your response.
- Do not include \`<!-- THINKING_START -->\` or \`<!-- THINKING_END -->\` inside the response text; they are only delimiters. Content between them is shown as "Thinking"; content after \`<!-- THINKING_END -->\` is the final answer.

## Response Guidelines

- Always explain what you found in plain language
- Provide insights and observations about the data
- When combining database data with web search results, clearly distinguish between internal data and external market data
- **NEVER say "company not found" or "no data available" without first trying web_search**
- Be concise but thorough in your analysis
- Format financial numbers clearly (use $M for millions, $B for billions)

## Important Notes

- The data contains company information including financials, segments, geography, and watchlist status
- Key columns include: target (company name), segment, geography, revenue, EBITDA, EV, margins
- Financial values are in USD millions
- When users ask vague questions, clarify what specific data they want
- Before using web_search, translate any internal project codenames (e.g., "Project Sunrise") to the actual company names from past acquisitions (target_co_partner).
- ALWAYS check files (query_files) when a user mentions a specific company name, project name, or deal context. Internal records often contain insights not available in public databases.
- If a user asks about a company, proactively check if there are any related files to provide a more comprehensive answer.
- **NEVER** assume internal knowledge is complete without searching files first.
- **ALWAYS check files** (query_files) when a user asks about discussion history, specific deal context, or what we know about a company's internal strategy or previous meetings.`;

const WORKFORCE_SYSTEM_PROMPT = `You are an AI Workforce agent. You execute a single delegated M&A task end-to-end and return a concise structured report.

A human user has already approved this task via a confirmation card in the AI CoPilot chat. The user input is in your first message as a plain imperative (e.g. "Promote Cinder Foods from L0 to L1. User acknowledged weak FY2024 EBITDA."). Execute it directly — there is NO interactive user to clarify with, ask follow-up questions to, or request confirmation from.

## Your tools

Read tools (use to gather context before writing):
- **get_data_schema**, **query_companies** (filter by segment/geography/stage/source/status/deal_type/sponsor/banker/financials/date added (created_after/created_before)/AI Opinion), **get_company_stats** (aggregate summary of a filtered cohort — counts, financial averages, AI Opinion coverage, breakdowns; excludes "discovered" stubs), **get_company_details**
- **web_search** for external/market data
- **query_files** for internal notes and memos

Write tools (use to actually mutate state — the whole point of this run):
- **add_company** — add a newly surfaced company to the database at an intake stage. Auto-executes (no human approval). Fuzzy-matches against existing companies first; if a match is found, it does NOT insert a duplicate. The \`stage\` arg picks where it lands (see "Choosing the intake stage" below); it defaults to \`market_screening\` (the "AI Screened Companies" bucket) and cannot write to L0. Use this when an instruction tells you to add/scan/discover companies (e.g. "add Acme", "find APAC slurry vendors and add the qualifiers").
- **promote_to_l1** — move a company from pipeline stage L0 to L1. Requires a \`reason\` (the human reviewer sees this in the approval card; cite concrete evidence — financial fit, comparable multiples, screening criteria met) and accepts an optional \`note\` for caveats. Idempotent guard refuses any company not currently at L0. Requires explicit human approval (HITL interrupt) before it executes — wait for the user's approve/reject decision; do not assume it will go through.
- **update_company_relationship** — record a SINGLE directed relationship between two companies in the relationship graph (\`source_company\` --[\`relation_type\`]--> \`target_company\`). Allowed relation_type values: INVESTED_IN, PARTNER, SELLS_TO (preferred for any commercial supply/customer relationship — it is directional, so source SELLS_TO target; use it for both supplier and customer perspectives). SUPPLIER is also accepted for backwards-compatibility. Auto-executes (no human approval). Each side is matched by name; any company not on record is auto-created at the special \`discovered\` stage (outside the L0–L5 pipeline).
- **generate_relationship_graph** — write a BATCH of directed edges to the relationship graph in one call (the bulk counterpart to \`update_company_relationship\`). Auto-executes (no human approval). Pass an \`edges\` array (max 100 per call); each edge: \`source_company\`, \`target_company\`, \`relation_type\` (INVESTED_IN / PARTNER / SELLS_TO — prefer SELLS_TO for commercial relationships), plus optional \`notes\`, \`evidence\`, \`date\`. Same name-matching and \`discovered\` auto-creation rules. Edges are processed independently — a bad edge is skipped and reported, not fatal. When an instruction specifies more than 100 edges, split into multiple calls. The instruction will tell you the exact source_company, target_company, and relation_type to use for each edge.
- **save_ai_opinion** — record a company's AI Opinion: a FIRM verdict (\`pass\` / \`fail\` / \`tentative\`) plus a ≤50-word rationale. Auto-executes (no human approval). This is the final step of an "Analyze AI Opinion" / "Re-evaluate" task: research the company, form a decisive view, then call it exactly once with the \`company_id\` from the instruction. See "Forming an AI Opinion" below.

Trace tools (call on EVERY model turn, in parallel with real tools):
- **narrate_step** — record a structured trace card with \`title\` and \`overview\` for this turn. The user sees these in the Reasoning trace panel. Always include narrate_step in your tool_calls. Calling narrate_step alone (no other tools) is fine when you're pausing to think; calling it alongside real tools is the common case.
  - **On your FIRST turn**, also pass \`plan: [...]\` listing the titles of the steps you intend to execute (this turn's title first). This drives the top progress bar and the "pending step" placeholders the user sees. Keep titles short (≤ 60 chars) and action-oriented; 3–6 steps is typical. Skip the \`plan\` arg on subsequent turns unless you're deliberately revising the outline.
- **report_progress** — call this ONLY on turns where you're iterating through a list of items (e.g. screening N candidates, scoring N companies, checking N files). Pass the FULL \`items\` list each time with the current per-item status (\`pending\` / \`checking\` / \`done\` / \`fail\`) and an optional short \`detail\`. The UI renders this as a "Live · partial output" block on the current trace step so the user can watch each row tick over. Skip on turns where there is no iteration to report — don't re-emit a stale list.

## How to execute

1. **Parse the instruction.** Identify the target entity (company name, etc.) and the desired action.
2. **Verify preconditions** with read tools. E.g. for a promotion: look up the company, confirm it exists, confirm it's at the expected stage. Gather concrete evidence you can cite in \`reason\` (financials, comparable acquisitions, screening criteria the company passed). If the instruction mentions a caveat the user acknowledged (e.g. weak EBITDA), include that in the \`note\` arg of the write tool so it's recorded on the deal alongside the reason.
3. **Execute the write.** Call the appropriate write tool. The tool returns a success or error string — capture it.
4. **Report.** Return a concise final message (see Reporting Format).

On EVERY model turn — including the final report turn — emit a parallel \`narrate_step\` call summarizing what you're doing. Title is short and action-oriented; overview is one sentence. This applies whether you're reasoning before a tool dispatch, executing alongside real tools, or delivering the final outcome.

On the FINAL turn specifically (when you're about to write the "✓ Done:" / "✗ Could not complete:" report), the narrate_step's \`title\` should be the outcome itself (e.g. "Promoted Acme Corp to L1", "Could not find Blue Harbor Logistics") and \`overview\` should restate the one-line summary in plain English. Then write your structured report as the message content as usual.

If you cannot complete the task (e.g. company not found, wrong pipeline stage, write tool refused), do not retry blindly — explain why in the final report. The row's output will be inspected by humans later for audit.

## Reporting Format

End your run with a final message of **at most 6 lines**, in this shape:

\`\`\`
✓ Done: <one-line summary of what you did>
- Action: <write tool called + args summary>
- Result: <pass/fail + key detail from the tool's return string>
- Notes: <any caveats, the recorded note, or "(none)">
\`\`\`

Or on failure:

\`\`\`
✗ Could not complete: <one-line reason>
- Attempted: <what you tried>
- Blocker: <specific reason — error message from a tool, missing data, etc.>
\`\`\`

Don't elaborate beyond that. The trace UI shows your full tool-call sequence separately; the final message is the executive summary.

## Constraints

- **Do NOT** emit \`<!-- THINKING_START -->\` / \`<!-- THINKING_END -->\` delimiters. Those are for the chat UI; you have no UI streaming your reasoning.
- **Do NOT** ask for confirmation before executing — the user already confirmed via the handoff card.
- **Do NOT** try to delegate further — you cannot spawn child workforce tasks.
- **Do NOT** restate the user's instruction back to them. Do the work and report what happened.
- **Do NOT** invent data. If you can't find something, look it up via a tool or web_search. If it's still missing, say so in the report.
- **You have NO access to chat attachments or uploaded files.** All information you need must come from the instruction text itself or your tools (get_company_details, web_search, query_files). If the instruction references a file you cannot open, work from any details already inlined in the instruction and use your tools to fill gaps.
- Format financial numbers consistently ($M for millions, $B for billions).
- When the instruction mentions an explicit ID (e.g. "Entry ID: 9003"), prefer it over fuzzy name match.

## Choosing the intake stage for \`add_company\`

A company can be added at one of two intake stages, both of which sit BELOW L1 and auto-execute. \`add_company\` CANNOT write to L0 — never try to add a company directly to the committed pipeline:

- **\`market_screening\`** (DEFAULT, the "AI Screened Companies" / "Market Scanning" bucket): any company the AI Workforce surfaces. When the instruction says "add this company" / "add Acme" / "find … and add them", use \`market_screening\` (pass it or omit \`stage\`). This is where AI-sourced companies belong.
- **\`discovered\`**: a company surfaced via the relationship graph that is not a market-scan find. Use only when the instruction frames the company as a graph/relationship discovery.

To move a company into the L0+ pipeline, use the gated \`promote_to_l1\` flow (or leave it for human action) — never the \`add_company\` tool.

## Forming an AI Opinion

When the instruction asks you to "analyze the AI Opinion" / "re-evaluate the AI Opinion" for a company, your job is to take a decisive stance and record it with \`save_ai_opinion\`:

1. Research the company with the read tools (\`get_company_details\` for the company_id in the instruction, then \`web_search\`, \`query_files\` as useful). The automated AI Screening results, if any, are context — not the verdict.
2. **Form the view independently — do not anchor on prior human decisions.** Do NOT read or consider any recorded drop reason (dropped-deal rationale, drop notes in files or comments) before forming your verdict — seeing it first biases the opinion. Judge the company on its fundamentals alone. Only AFTER you have committed to a verdict: if the company was dropped and your verdict disagrees with that decision, then read the drop reason, evaluate whether it holds up, and note the disagreement in your summary.
3. **Tracks are organizational, not investment signals.** Matched investment tracks are just a way of grouping the pipeline. A company matching no track is NOT evidence against it and must never drive a \`fail\`. Give track fit little weight either way — fundamentals (financials, market position, strategic rationale) decide the verdict.
4. Form a FIRM view and pick exactly one verdict:
   - \`pass\` — you'd advance this as an acquisition target.
   - \`fail\` — you'd pass on it.
   - \`tentative\` — genuinely on the fence. Use this SPARINGLY, only when the evidence is truly balanced.
5. **Be decisive even when every AI Screening criterion fails.** Failing the mechanical screen is itself a strong signal — usually it points to \`fail\`, not \`tentative\`. Do not hide behind "tentative" to avoid committing. Weigh the company on its merits and give a real take.
6. Call \`save_ai_opinion\` ONCE with the \`company_id\` (verbatim from the instruction), your \`verdict\`, and a \`summary\` of AT MOST 50 words in plain prose that justifies the verdict. The summary is truncated server-side if it runs long, so lead with the decisive reasoning.
7. After it returns, write your usual short final report. The "AI Opinion" column refreshes automatically.

## Important domain rules

- The pipeline stages are L0 → L1 → L2 → ... A company at L1+ cannot be re-promoted to L1; the write tool will refuse.
- **Intake adds auto-execute; L0+ promotions require explicit user approval.** \`add_company\` runs without an approval interrupt at either of its intake stages (\`market_screening\`, \`discovered\`) — these are triage stages below L1 and it cannot write to L0. \`promote_to_l1\` (and any future promote_to_l2, promote_to_l3, etc.) hits a HITL interrupt; the user approves or rejects before the tool actually runs. When promoting, expect that the tool may not execute on this turn — finish your reasoning, call the tool, and trust the runtime to pause for the decision.
- Caveats the user acknowledged ("user acknowledged weak FY2024 EBITDA", "user approved despite missing financials") MUST end up in the \`note\` arg of the write tool so the audit trail captures that the user proceeded knowingly. The \`reason\` arg is for the positive case (why the company qualifies for the next stage); \`note\` is for caveats and risks. Both are persisted on the deal record.
- When calling \`promote_to_l1\`, the \`reason\` arg is what the human reviewer sees in the approval card. Write it so a reviewer with no other context could decide: name the concrete fit (e.g. "Revenue $42M FY2024, EBITDA margin 18%, growing 28% YoY; comparable Asia-Pacific semicap deals closed at 11–14x EBITDA — Acme fits the thesis cleanly"). Avoid vague phrasing.`;

export type ModelChoice = 'sonnet' | 'opus';

const MODEL_IDS: Record<ModelChoice, string> = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
};

export interface AgentConfig {
  apiKey: string;
  checkpointer?: BaseCheckpointSaver;
  model?: ModelChoice;
}

export interface InvokeOptions {
  messages: BaseMessage[];
  additionalSystemContext?: string;
}

export interface InvokeConfig {
  recursionLimit?: number;
  configurable?: Record<string, unknown>;
  /**
   * Abort signal forwarded to the underlying LangGraph run. When it fires
   * (e.g. the client disconnects or hits the UI stop button), LangChain
   * cancels the in-flight model request and halts graph execution.
   */
  signal?: AbortSignal;
}

export interface InvokeResult {
  messages: BaseMessage[];
  // Present when the agent paused on a HITL interrupt. The first element of
  // langgraph's __interrupt__ array is surfaced verbatim so callers can
  // render it or persist it to ai_workforce_queue.
  interrupt?: {
    actionRequests: Array<{
      name: string;
      args: Record<string, unknown>;
      description?: string;
    }>;
  };
}

/**
 * Build a streaming-capable agent with optional additional system context.
 *
 * `toolList` and `systemPrompt` control the agent's behavior:
 *   - Chat agents use DEFAULT_TOOL_LIST + CHAT_SYSTEM_PROMPT
 *     (read tools + chat-only delegation + chatty user-facing prose)
 *   - Workforce agents use WORKFORCE_TOOL_LIST + WORKFORCE_SYSTEM_PROMPT
 *     (read tools + write tools + terse "do-and-report" execution)
 */
export function createLocalAgent(
  config: AgentConfig,
  additionalSystemContext?: string,
  toolList: ToolList = DEFAULT_TOOL_LIST,
  systemPrompt: string = CHAT_SYSTEM_PROMPT,
  middleware: ReadonlyArray<ReturnType<typeof humanInTheLoopMiddleware>> = [],
) {
  const modelId = MODEL_IDS[config.model ?? 'sonnet'];
  const llm = new ChatAnthropic({
    model: modelId,
    anthropicApiKey: config.apiKey,
    // Documents attached to a chat are uploaded via the Files API and referenced
    // by id in the message; both the upload and any message that references it
    // must carry this beta header. Harmless when no file is attached.
    // output-128k-2025-02-19 raises the output ceiling to 128k tokens.
    betas: [FILES_API_BETA, "output-128k-2025-02-19"],
    maxTokens: 128000,
    // Stream under the hood even for non-streaming callers (AgentGraph.invoke,
    // used by the workforce runtime and one-shot job handlers). The Anthropic
    // SDK rejects any non-streaming request whose maxTokens is large enough
    // that it could exceed the 10-minute request window ("Streaming is required
    // for operations that may take longer than 10 minutes") — at maxTokens
    // 128k that guard always fires. With streaming enabled, ChatAnthropic hits
    // the streaming endpoint and reassembles the full message, so .invoke()
    // still returns a complete result. The streamEvents (chat) path already
    // streams, so this is a no-op there.
    streaming: true,
    // Newer Anthropic models reject `temperature` (400: "temperature is
    // deprecated for this model"). Explicitly leave it unset — ChatAnthropic
    // omits the field from the request when this is undefined.
    temperature: undefined,
  });

  const fullSystemPrompt = additionalSystemContext
    ? `${systemPrompt}\n\n---\n\n## Additional Context\n\n${additionalSystemContext}`
    : systemPrompt;

  // createAgent's `middleware` typing is generic on the middleware list, so
  // we pass through `as any` to avoid having to materialize the inferred
  // tuple type at this seam. The runtime accepts AgentMiddleware[].
  return createAgent({
    model: llm,
    tools: toolList,
    systemPrompt: fullSystemPrompt,
    checkpointer: config.checkpointer,
    ...(middleware.length > 0
      ? { middleware: middleware as unknown as never }
      : {}),
  });
}

/**
 * Wrapper around the streaming agent that exposes both invoke and streamEvents.
 */
export class AgentGraph {
  private config: AgentConfig;
  private defaultAgent: ReturnType<typeof createAgent>;
  private toolList: ToolList;
  private systemPrompt: string;
  private middleware: ReadonlyArray<
    ReturnType<typeof humanInTheLoopMiddleware>
  >;

  constructor(
    config: AgentConfig,
    toolList: ToolList = DEFAULT_TOOL_LIST,
    systemPrompt: string = CHAT_SYSTEM_PROMPT,
    middleware: ReadonlyArray<ReturnType<typeof humanInTheLoopMiddleware>> = [],
  ) {
    this.config = { ...config };
    this.toolList = toolList;
    this.systemPrompt = systemPrompt;
    this.middleware = middleware;
    this.defaultAgent = createLocalAgent(
      this.config,
      undefined,
      toolList,
      systemPrompt,
      middleware,
    );
  }

  private getAgent(
    additionalSystemContext?: string,
  ): ReturnType<typeof createAgent> {
    if (!additionalSystemContext) {
      return this.defaultAgent;
    }
    return createLocalAgent(
      this.config,
      additionalSystemContext,
      this.toolList,
      this.systemPrompt,
      this.middleware,
    );
  }

  async invoke(
    inputs: InvokeOptions,
    config?: InvokeConfig,
  ): Promise<InvokeResult> {
    logger.debug(`messages are ${JSON.stringify(inputs)}`);
    logger.debug("=".repeat(60));
    logger.debug("🚀 AGENT INVOCATION STARTED");

    try {
      const agent = this.getAgent(inputs.additionalSystemContext);
      logger.debug(`📨 Sending ${inputs.messages.length} message(s) to agent`);
      if (inputs.additionalSystemContext) {
        logger.debug("📎 Additional system context provided");
      }
      const result = await agent.invoke({ messages: inputs.messages }, config);
      return this.shapeInvokeResult(result);
    } catch (error) {
      logger.error(`✗ AGENT INVOCATION FAILED: ${(error as Error).message}`);
      logger.debug("=".repeat(60));
      return {
        messages: [
          new AIMessage(`Error invoking agent: ${(error as Error).message}`),
        ],
      };
    }
  }

  /**
   * Resume a paused agent thread with a HITL decision payload. Wraps the
   * payload in a langgraph `Command({ resume })` and invokes the agent on
   * the same checkpoint thread. Returns the same shape as `invoke`, so
   * `result.interrupt` will be populated again if the agent paused on
   * another HITL interrupt during resume.
   */
  async resume(
    threadId: string,
    resumePayload: unknown,
  ): Promise<InvokeResult> {
    logger.debug(`🔁 Resuming agent thread ${threadId}`);
    try {
      const agent = this.defaultAgent;
      // Lazy import to avoid pulling Command type at module load.
      const { Command } = await import("@langchain/langgraph");
      const result = await agent.invoke(
        new Command({ resume: resumePayload }) as never,
        { configurable: { thread_id: threadId } } as never,
      );
      return this.shapeInvokeResult(result);
    } catch (error) {
      logger.error(`✗ AGENT RESUME FAILED: ${(error as Error).message}`);
      return {
        messages: [
          new AIMessage(`Error resuming agent: ${(error as Error).message}`),
        ],
      };
    }
  }

  private shapeInvokeResult(result: unknown): InvokeResult {
    logger.debug("✓ Agent graph invocation completed");
    logger.debug("✅ AGENT INVOCATION COMPLETED SUCCESSFULLY");
    logger.debug("=".repeat(60));

    if (result && typeof result === "object" && "messages" in result) {
      const out: InvokeResult = {
        messages: (result as { messages: BaseMessage[] }).messages,
      };
      const interruptRaw = (result as Record<string, unknown>).__interrupt__;
      if (Array.isArray(interruptRaw) && interruptRaw.length > 0) {
        const first = interruptRaw[0] as { value?: unknown };
        const value = (first?.value ?? first) as {
          actionRequests?: NonNullable<
            InvokeResult["interrupt"]
          >["actionRequests"];
        };
        if (value?.actionRequests?.length) {
          out.interrupt = { actionRequests: value.actionRequests };
        }
      }
      return out;
    }
    return { messages: [new AIMessage(JSON.stringify(result))] };
  }

  async ainvoke(
    inputs: InvokeOptions,
    config?: InvokeConfig,
  ): Promise<InvokeResult> {
    return this.invoke(inputs, config);
  }

  /**
   * Stream events from the agent. The chat route consumes these to push
   * incremental updates to the client.
   */
  async streamEvents(inputs: InvokeOptions, config?: any) {
    const agent = this.getAgent(inputs.additionalSystemContext);
    return agent.streamEvents({ messages: inputs.messages }, config);
  }

  /**
   * Load the persisted message history for a thread from the checkpointer.
   * Returns an empty array when the thread has no checkpoint yet (e.g. a
   * brand-new chat row that was created but never sent a message).
   */
  /**
   * Repoint (or neutralize) stale Files-API references in a thread's persisted
   * history so replaying it doesn't 404. Chat attachments are deleted from
   * Anthropic after every turn; `freshFileIds` are the ids re-uploaded for the
   * current turn. Rewritten messages reuse their original id, so the messages
   * reducer overwrites them in place rather than appending duplicates.
   */
  async rewriteFileReferences(
    threadId: string,
    freshFileIds: string[],
  ): Promise<void> {
    const messages = await this.getMessages(threadId);
    const replacements = rewriteStaleFileBlocks(messages, freshFileIds);
    if (replacements.length === 0) return;
    const agent = this.defaultAgent as unknown as {
      updateState: (
        config: { configurable: { thread_id: string } },
        values: { messages: BaseMessage[] },
      ) => Promise<unknown>;
    };
    await agent.updateState(
      { configurable: { thread_id: threadId } },
      { messages: replacements },
    );
  }

  async getMessages(threadId: string): Promise<BaseMessage[]> {
    // getState is marked @internal in LangChain v1 typings (return type
    // `never`) but it's the documented LangGraph API and works at runtime.
    const agent = this.defaultAgent as unknown as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<
        | {
            values?: { messages?: BaseMessage[] };
          }
        | undefined
      >;
    };
    const state = await agent.getState({
      configurable: { thread_id: threadId },
    });
    return state?.values?.messages ?? [];
  }

  /**
   * Seed a thread's checkpoint with an initial set of messages without running
   * the model. Used to fork a cached turn-1 (first question + first answer)
   * into a brand-new thread the caller owns, so the user can continue from
   * there with the prior context in place. `messages` is appended via the
   * graph's add-reducer; on a fresh thread that yields exactly these messages.
   */
  async seedMessages(threadId: string, messages: BaseMessage[]): Promise<void> {
    // updateState is marked @internal in LangChain v1 typings (return type
    // `never`) but it's the documented LangGraph API and works at runtime.
    const agent = this.defaultAgent as unknown as {
      updateState: (
        config: { configurable: { thread_id: string } },
        values: { messages: BaseMessage[] },
      ) => Promise<unknown>;
    };
    await agent.updateState(
      { configurable: { thread_id: threadId } },
      { messages },
    );
  }

  /**
   * Read raw checkpoint tuple data for a thread: the persisted message list
   * plus any pending writes (e.g. unresolved `__interrupt__` entries from
   * humanInTheLoopMiddleware). Used by the trace endpoint to render both
   * completed execution and live HITL-waiting state in one fetch.
   */
  async getTrace(threadId: string): Promise<{
    messages: BaseMessage[];
    pendingWrites: CheckpointPendingWrite[];
  }> {
    if (!this.config.checkpointer) {
      return { messages: [], pendingWrites: [] };
    }
    const tuple = await this.config.checkpointer.getTuple({
      configurable: { thread_id: threadId },
    });
    if (!tuple) {
      return { messages: [], pendingWrites: [] };
    }
    const channelValues = tuple.checkpoint.channel_values as
      { messages?: BaseMessage[] } | undefined;
    return {
      messages: channelValues?.messages ?? [],
      pendingWrites: tuple.pendingWrites ?? [],
    };
  }
}

// Singletons keyed by ModelChoice. chat and workforce graphs share the same
// checkpointer; thread_id namespaces conversations (copilot_chats.id vs
// ai_workforce_queue.id).
const chatAgentGraphs = new Map<ModelChoice, AgentGraph>();
const workforceAgentGraphs = new Map<ModelChoice, AgentGraph>();
let statelessAgentGraph: AgentGraph | null = null;
let checkpointerSetupPromise: Promise<PostgresSaver> | null = null;

/**
 * Lazily build (and `setup()`) a singleton PostgresSaver bound to the
 * `agent_states` schema. The first call runs the library's idempotent
 * setup() — every call after that resolves to the same instance.
 *
 * Connection config follows the same pattern as `src/lib/server/db.ts`:
 * discrete `DB_*` env vars + `RDS_IAM_DB_AUTH` to switch between static
 * password and rotating IAM token auth. `pg.Pool`'s `password` option accepts
 * an async function, which is called on every new connection — perfect for
 * IAM tokens that expire every 15 minutes.
 */
function getCheckpointer(): Promise<PostgresSaver> | null {
  let explicitDb;
  try {
    explicitDb = parseExplicitDbFromEnv();
  } catch (err) {
    logger.error((err as Error).message);
    return null;
  }
  const useIam = rdsIamDbAuthFromEnv();

  if (useIam && explicitDb.password) {
    logger.error(
      "With RDS_IAM_DB_AUTH, leave DB_PASSWORD empty; the app uses an IAM token.",
    );
    return null;
  }
  if (!useIam && explicitDb.password === undefined) {
    logger.error("Without RDS_IAM_DB_AUTH, set DB_PASSWORD.");
    return null;
  }

  if (checkpointerSetupPromise) return checkpointerSetupPromise;

  checkpointerSetupPromise = (async () => {
    const isLocal = isLocalPostgresHost(explicitDb.host);
    const pool = new pg.Pool({
      host: explicitDb.host,
      port: explicitDb.port,
      database: explicitDb.database,
      user: explicitDb.user,
      password: useIam
        ? () =>
            rdsIamAuthToken(explicitDb.host, explicitDb.port, explicitDb.user)
        : explicitDb.password!,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
    const saver = new PostgresSaver(pool, undefined, {
      schema: CHECKPOINT_SCHEMA,
    });
    await saver.setup();
    logger.info(
      `✓ PostgresSaver ready (schema: ${CHECKPOINT_SCHEMA}, ssl: ${!isLocal}, iam: ${useIam})`,
    );
    return saver;
  })().catch((err) => {
    // Reset on failure so the next caller retries instead of inheriting the
    // rejected promise forever.
    checkpointerSetupPromise = null;
    throw err;
  });

  return checkpointerSetupPromise;
}

async function buildAgentGraph(
  toolList: ToolList,
  systemPrompt: string,
  middleware: ReadonlyArray<ReturnType<typeof humanInTheLoopMiddleware>> = [],
  useCheckpointer = true,
  model: ModelChoice = 'sonnet',
): Promise<AgentGraph | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY environment variable is required");
    return null;
  }

  try {
    // Only copilot chat and the workforce queue need persisted state (resumable
    // threads / HITL). One-shot job handlers (screening, analysis) run stateless
    // — no checkpointer, so no `agent_states` writes and no thread_id required.
    const checkpointerPromise = useCheckpointer ? getCheckpointer() : null;
    const checkpointer = checkpointerPromise
      ? await checkpointerPromise
      : undefined;
    return new AgentGraph(
      { apiKey, checkpointer, model },
      toolList,
      systemPrompt,
      middleware,
    );
  } catch (error) {
    logger.error(`Failed to create agent: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Singleton for the copilot chat agent for a specific model. Includes
 * chat-only tools like propose_workforce_handoff and uses the chatty,
 * user-facing system prompt.
 */
export async function getAgentGraphForModel(
  model: ModelChoice = 'sonnet',
): Promise<AgentGraph | null> {
  const cached = chatAgentGraphs.get(model);
  if (cached) return cached;
  const graph = await buildAgentGraph(
    DEFAULT_TOOL_LIST,
    CHAT_SYSTEM_PROMPT,
    [],
    true,
    model,
  );
  if (graph) chatAgentGraphs.set(model, graph);
  return chatAgentGraphs.get(model) ?? null;
}

/** @deprecated Use getAgentGraphForModel('sonnet') */
export async function getAgentGraph(): Promise<AgentGraph | null> {
  return getAgentGraphForModel('sonnet');
}

/**
 * Singleton for one-shot job handlers (AI screening, company analysis, market
 * screening). Same tools and system prompt as the copilot chat agent, but
 * built WITHOUT a checkpointer: these runs are stateless, single-turn
 * evaluations that never resume, so there is nothing to persist. This avoids
 * spinning up the `agent_states` PostgresSaver for paths that don't need it.
 */
export async function getStatelessAgentGraph(): Promise<AgentGraph | null> {
  if (statelessAgentGraph) return statelessAgentGraph;
  const graph = await buildAgentGraph(
    DEFAULT_TOOL_LIST,
    CHAT_SYSTEM_PROMPT,
    [],
    false,
  );
  if (graph) statelessAgentGraph = graph;
  return statelessAgentGraph;
}

/**
 * Singleton for the workforce agent for a specific model. Uses base +
 * workforce-only tools and the terse "execute and report" system prompt.
 */
export async function getWorkforceAgentGraphForModel(
  model: ModelChoice = 'sonnet',
): Promise<AgentGraph | null> {
  const cached = workforceAgentGraphs.get(model);
  if (cached) return cached;
  const graph = await buildAgentGraph(
    WORKFORCE_TOOL_LIST,
    WORKFORCE_SYSTEM_PROMPT,
    [WORKFORCE_HITL_MIDDLEWARE],
    true,
    model,
  );
  if (graph) workforceAgentGraphs.set(model, graph);
  return workforceAgentGraphs.get(model) ?? null;
}

/** @deprecated Use getWorkforceAgentGraphForModel('sonnet') */
export async function getWorkforceAgentGraph(): Promise<AgentGraph | null> {
  return getWorkforceAgentGraphForModel('sonnet');
}

export function resetAgent(): void {
  chatAgentGraphs.clear();
  workforceAgentGraphs.clear();
  statelessAgentGraph = null;
  checkpointerSetupPromise = null;
}

/**
 * Extract the textual content of an agent message.
 *
 * `@langchain/anthropic` returns a tool-using agent's final message `content`
 * as an array of content blocks (e.g. `[{ type: "text", text: "..." }]`),
 * not a plain string. `JSON.stringify`-ing that array escapes newlines and
 * wraps the real text in block metadata, which mangles any embedded JSON and
 * breaks downstream `JSON.parse` extraction. Concatenate the text of every
 * text block instead. Plain-string content (no-tool agents) passes through
 * unchanged.
 */
export function extractMessageText(message: BaseMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          block &&
          typeof block === "object" &&
          "text" in block &&
          typeof (block as { text: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Pull the strict turn-1 of a thread: the FIRST human message, and the FULL
 * assistant reply to it. A tool-using turn is stored as several messages
 * (AI with tool_calls → Tool result → AI with the final answer), so the
 * assistant text is every `ai` message between the first human and the next
 * human — concatenated — NOT just the first AI blob (which is often only a
 * tool call with little or no text). Later turns are deliberately ignored;
 * they carry context that could mislead a reused answer. Either field is `""`
 * when that message type is absent.
 */
export function extractFirstTurn(messages: BaseMessage[]): {
  userText: string;
  assistantText: string;
} {
  const firstHumanIdx = messages.findIndex((m) => m._getType() === "human");
  if (firstHumanIdx === -1) {
    return { userText: "", assistantText: "" };
  }

  const assistantParts: string[] = [];
  for (let i = firstHumanIdx + 1; i < messages.length; i++) {
    const kind = messages[i]._getType();
    if (kind === "human") break; // next turn starts — stop.
    if (kind !== "ai") continue; // skip tool results etc.
    const text = extractMessageText(messages[i]);
    if (text.trim()) assistantParts.push(text);
  }

  return {
    userText: extractMessageText(messages[firstHumanIdx]),
    assistantText: assistantParts.join("\n\n"),
  };
}

export { HumanMessage, AIMessage };
