/**
 * File-processing agent.
 *
 * Builds a Claude-backed agent via langchain's `createAgent` and consumes its
 * output in streaming mode (`agent.stream` with `streamMode: "values"`).
 * The agent currently runs without tools — the structured JSON contract is
 * enforced by the system prompt — but tool definitions are kept under
 * ./tools so adding tools later is a one-line change.
 */
import { getActiveWorkspaceId } from '@/lib/workspace';
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { ChatAnthropic } from "@langchain/anthropic";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { logger } from "../logger";

/**
 * Beta flag required for the Files API. Both the upload/delete calls and any
 * message that references an uploaded file by id must carry this header.
 */
const FILES_API_BETA = "files-api-2025-04-14" as const;
import { getAllCompanyReferences } from "@/lib/fuzzySearch";
import { createDb } from "@/lib/server/db";
import { InvestmentThesisRepository } from "@/lib/repositories";
import { isGenericDocumentPhrase } from "./genericNameDenylist";
import {
  applyFxBackfill,
  normalizeFxRow,
  validateFxConsistency,
  type FinancialRow,
  type FxRow,
  type RawFxRow,
} from "./fxBackfill";

export type FileTypeOverride = 'mom' | 'prospectus' | 'other' | 'shopping_list' | 'market_study';

/**
 * File types whose documents describe deal targets and therefore emit the
 * multi-company `companies` array (each entry shaped like the legacy
 * `prospectus_summary`).
 */
const MULTI_COMPANY_FILE_TYPES = new Set<string>(['prospectus', 'shopping_list']);

type TrackRef = { id: string; title: string | null; content: string | null };

async function getAllInvestmentTracks(): Promise<TrackRef[]> {
  try {
    const db = createDb();
    const repo = new InvestmentThesisRepository(db, await getActiveWorkspaceId());
    const rows = await repo.findAll();
    return rows.map((r) => ({ id: r.id, title: r.title ?? null, content: r.content ?? null }));
  } catch {
    return [];
  }
}

const generateSystemPrompt = (
  companies_list: string,
  userRawNotes: string,
  fileTypeOverride?: FileTypeOverride,
  fileName?: string,
  tracks: TrackRef[] = [],
) => `You are a specialized M&A File Processing Assistant. Your task is to analyze raw text extracted from meeting documents (like PPTX slides) and transform it into a highly structured format.

## Objectives:
1. **Understand Unstructured Data**: Read the provided raw text carefully.
2. **Reformat to Structured JSON**: Extract a clear summary, key points, action items, and tags.
3. **Generate Tags**: Create a list of tags including company names mentioned and short highlights.
4. **Identify Companies**: Identify which of the "Known Companies" provided in the prompt are mentioned in the text.
5. **Extract Company Notes**: For each identified company, extract specific notes or context.
6. **Extract Meeting Date**: Identify the date of the meeting/document (usually mentioned in the title or content).
7. **Categorize The File Type**: Identify the file type of the document.
8. **Extract Companies On Offer**: If the file type is "prospectus" or "shopping_list", extract one entry per deal target in the "companies" array (a prospectus usually has exactly one; a shopping list has one per listed target).
9. **Extract Banker Communications**: If the file type is "banker_communications", extract all email communications with their participants.
10. **Extract Financial Statement Summary**: If the file type is "financial_statement", extract the company name and financial figures.
11. **Match Investment Tracks**: If any investment tracks are listed below, decide which (if any) the deal target genuinely fits. Return an empty array if not confident.
12. **Follow User Instructions**: The "Additional Notes" from the user may contain explicit instructions about which companies in the document to include or exclude. You MUST honor them (see "Additional Notes" below).

## Known Companies:
${companies_list}
${tracks.length > 0 ? `
## Investment Tracks (Theses):
${tracks.map((t) => `- id: ${t.id}\n  name: ${t.title ?? ''}\n  thesis: ${t.content ?? ''}`).join('\n')}
` : ''}
${
  fileName
    ? `
## File Name Hint:
The original filename is: "${fileName}"
Use this as a weak fallback signal when identifying the company or project name. M&A filenames often contain the target company name or project codename (e.g. "Acme Corp - IM.pdf", "Project Tulia Teaser.pdf"). Rules:
- Prefer names extracted from document content over the filename.
- Only fall back to the filename if the document body yields no clear company_name or project_name.
- Ignore generic tokens like "teaser", "IM", "CIM", "final", "v2", "draft", "deck", file extensions, and dates.
- Never override a confidently-extracted company_name with a filename-derived guess.
`
    : ''
}${
  fileTypeOverride
    ? `
## User-Specified File Type:
The user has manually classified this document as "${fileTypeOverride}". You MUST set "file_type" to "${fileTypeOverride}" in your output regardless of the document's content. Continue to perform all other extraction (summary, tags, companies, financials, etc.) according to that classification — e.g. if "${fileTypeOverride}" is "prospectus", extract a full prospectus_summary; if "mom", treat the document as meeting minutes.
`
    : ''
}
## Additional Notes:
These are additional notes from the user about the document that might be relevant to the analysis. Please use this to understand the context of the document better.
**Company inclusion/exclusion instructions (CRITICAL):** the notes may specify which companies in the document should or should not be ingested (e.g. "only include Acme and Beta", "skip the Korean targets", "ignore everything except the first two"). When such instructions are present, the "companies" array MUST contain ONLY the companies the user wants included — omit excluded companies from "companies" entirely. Excluded companies may still be mentioned in the summary/tags/companies_detected for searchability, but they must NOT appear in "companies". When the notes give no such instructions, include every deal target found in the document.
${userRawNotes}

## Process:
1. Review the "Known Companies" list.
2. Identify which of those companies appear in the text.
3. **Classify Each Detected Entity** as one of three types:
   - **Company**: A real legal entity name (e.g. "Acme Corp", "PT Sinar Mas"). Goes into 'company_name'.
   - **Project**: A codename with no known underlying company (e.g. "Project Phoenix", "Project Utopia"). Goes into 'project_name' only; leave 'company_name' null.
   - **Project-in-Company**: A codename explicitly associated with a known company in the document (e.g. "Project Tulia (PT Sinar Mas)"). Set both 'company_name' and 'project_name'.
   Actively scan for project codenames even if they don't match the Known Companies list — treat them as valid detected entities.
   **IMPORTANT — Do NOT classify document section headings as company or project names.** Common false positives to reject: "Project Overview", "Project Summary", "Project Background", "Company Overview", "Company Profile", "Business Overview", "Executive Summary", "Transaction Overview", "Transaction Summary", "Deal Overview", "Investment Highlights", "Financial Summary", "Management Overview", "Market Overview", "Opportunity Overview", "Sector Overview". A real project codename is a unique proper name chosen to identify a deal (e.g. "Project Tulia", "Project Phoenix", "Project Atlas") — not a generic document structure phrase. If the only candidate is a generic heading, leave 'project_name' null.
4. **Categorize File Type**: Choose ONE of "prospectus", "financial_statement", "legal_document", "mom", "banker_communications", "shopping_list", "market_study", or "other".
   - **prospectus**: ONLY for a document that OFFERS A COMPANY OR BUSINESS FOR SALE to prospective buyers — a teaser, information memorandum (IM), confidential information memorandum (CIM), sale prospectus, or pitch deck marketing a target. The defining test: *is this document presenting a company/asset that is up for acquisition?* If you are not sure a company is being offered for sale, it is NOT a prospectus.
   - **financial_statement**: audited or management financial statements, annual reports, AFS, balance sheets, P&L, or cash-flow statements presented on their own. These describe a company's finances but do NOT offer it for sale.
   - **legal_document**: SPAs, share/stock purchase agreements, term sheets, credit agreements, commitment papers, NDAs, and other transaction legal documents.
   - **mom**: meeting minutes, meeting notes, or call summaries.
   - **banker_communications**: an email export (CSV or MBOX) containing email threads, especially from bankers or investment professionals.
   - **shopping_list**: a target list or deal pipeline of companies being considered for acquisition.
   - **market_study**: a market landscape, sector overview, or industry analysis.
   - **other**: anything that does not fit above — INCLUDING documents about a BUYER, ACQUIRER, SPONSOR, LENDER, INVESTMENT BANK, or LAW FIRM (e.g. a sponsor/buyer overview deck, a lender presentation, an advisor profile). These parties are NOT companies being sold.
   **CRITICAL — a document containing financial figures is NOT automatically a prospectus.** Financial statements, SPAs, and buyer/sponsor decks all contain revenue/EBITDA/balance-sheet figures but are NOT sale offerings. Only "prospectus" describes a deal target; misclassifying these other documents as "prospectus" wrongly registers a buyer, lender, or advisor as a company on sale. Classify as "prospectus" ONLY when a company is genuinely being offered for sale.
5. Final Output must be a valid JSON block containing:
   - summary: A concise, M&A-oriented overview of the meeting/document — cover deal, sector, track, acquisition, and external context (see "M&A Relevance Rules" below).
   - key_points: Array of main takeaways — M&A-relevant (deal, sector, track, acquisition, external), excluding internal-only info (see "M&A Relevance Rules" below).
   - action_items: Array of next steps — M&A-relevant, excluding internal-only info (see "M&A Relevance Rules" below).
   - tags: Array of useful searchable tags (company names, topics).
   - companies_detected: Array of STRINGS (exact names as they appear in the Known Companies list) that were found in the text.
   - company_notes: Array of objects { "company_name": "...", "note": "..." } containing the specific context for that company.
   - file_date: A string representing the meeting date in YYYY-MM-DD format. If not found, return null.
   - companies: Array of deal-target objects — one per company/project being offered or listed. Only present when the file type is "prospectus" or "shopping_list". Each entry has the exact same structure as prospectus_summary (see the example output below). A prospectus usually yields exactly ONE entry; only emit multiple when the document genuinely offers several distinct targets. A shopping_list yields one entry per listed target. Honor the user's inclusion/exclusion instructions from "Additional Notes".
   - prospectus_summary: Detailed variables of the primary deal target — identical to companies[0]. Only exists if the file type is "prospectus" or "shopping_list". Kept alongside "companies" for backward compatibility.
   - financial_statement_summary: Extracted financial data from the document. Only present when file_type is "financial_statement". Contains the company name and financials/fx_adjustments arrays in the same structure as prospectus_summary.
   - communications: Array of email communications extracted from banker communications files. Only exists if the file type is "banker_communications". Each communication should have: from_email, from_name, to_email, to_name, subject, body, sent_at (in ISO 8601 format if available), company (if the sender/recipient is associated with a company).

## Output Format:
Your response should end with a JSON block in this format:
\`\`\`json
{
  "file_type": "...",
  "summary": "...",
  "key_points": ["...", "..."],
  "action_items": ["...", "..."],
  "tags": ["...", "..."],
  "companies_detected": ["Acme Corp", "Beta Ltd"],
  "company_notes": [
     { "company_name": "Acme Corp", "note": "Target price discussion..." }
  ],
  "file_date": "2024-01-30",
  "suggested_track_ids": ["<track-id>"],
  "communications": [
    {
      "from_email": "john.banker@example.com",
      "from_name": "John Banker",
      "to_email": "team@starcapital.com",
      "to_name": "Star Capital Team",
      "subject": "Re: Project Phoenix Update",
      "body": "Email content here...",
      "sent_at": "2024-01-15T10:30:00Z",
      "company": "Example Bank"
    }
  ],
  "financial_statement_summary": {
    "company_name": "Legal entity name of the company whose financials are reported. Null if genuinely unclear.",
    "financials": [
      {
        "fiscal_year": 2024,
        "revenue_usd_mn": "<numeric or null>",
        "ebitda_usd_mn": "<numeric or null>",
        "ev_usd_mn": "<numeric or null>",
        "ebitda_margin": "<decimal or null>",
        "ev_ebitda": "<numeric or null>",
        "revenue_cagr_vs_prior": "<decimal or null>"
      }
    ],
    "fx_adjustments": []
  },
  "companies": [
    {
      "company_name": "Deal target legal entity name — same rules as prospectus_summary.company_name below.",
      "project_name": "Project codename if present — same rules as prospectus_summary.project_name below.",
      "segment": "...",
      "segment_related_offerings": "...",
      "company_focus": "...",
      "website": "...",
      "watchlist_status": "...",
      "comments": "...",
      "ownership": "...",
      "geography": "country name",
      "remarks": "...",
      "banker": "...",
      "financials": [],
      "fx_adjustments": []
    }
  ],
  "prospectus_summary": {
    "company_name": "Legal entity name if the document identifies one (e.g. 'Acme Corp'). Null if only a project codename is known.",
    "project_name": "Project codename if present (e.g. 'Project Phoenix'). Null if no codename is used. Set this even when company_name is also known.",
    "segment": "...",
    "segment_related_offerings": "...",
    "company_focus": "...",
    "website": "...",
    "watchlist_status": "...",
    "comments": "...",
    "ownership": "...",
    "geography": "country name",
    "remarks": "...",
    "banker": "Name of the investment bank or financial advisor that prepared or is presenting this document (e.g. 'Goldman Sachs', 'Morgan Stanley'). Only populate when explicitly stated and you are confident — null if unclear or low confidence.",
    "financials": [
      {
        "fiscal_year": 2023,
        "revenue_usd_mn": <numeric>,
        "ebitda_usd_mn": <numeric>,
        "ev_usd_mn": <numeric>,
        "ebitda_margin": <numeric>,
        "ev_ebitda": <numeric>,
        "revenue_cagr_vs_prior": <numeric>
      }
    ],
    "fx_adjustments": [
      {
        "fiscal_year": 2023,
        "currency": "...",
        "revenue_local": <numeric>,
        "revenue_local_unit": "mn" | "bn" | "thousands",
        "ebitda_local": <numeric>,
        "ebitda_local_unit": "mn" | "bn" | "thousands",
        "assumed_forex": <numeric>,
        "forex_change_vs_prior": <numeric>,
        "revenue_cagr_domestic": <numeric>
      }
    ]
  }
}
\`\`\`

## M&A Relevance Rules:
The \`summary\`, \`key_points\`, and \`action_items\` fields should capture a useful M&A-oriented picture of the document. Be GENEROUS about what counts as relevant — the goal is to surface a helpful summary, not to leave these fields empty. The ONLY hard exclusion is internal-organization information and internal people's names (see below).

**INCLUDE (M&A-relevant — capture broadly):**
- Deal structure, terms, valuation, pricing, multiples (EV/EBITDA, etc.), consideration, and process.
- Financial performance and projections (revenue, EBITDA, margins, growth).
- The target's or any discussed company's business, assets, products, market position, and competitive dynamics.
- **Sector and market context** — industry trends, sector landscape, market sizing, and thematic observations.
- **Investment track / thesis fit** — how a company or opportunity relates to an investment track or strategy.
- **Acquisition and transaction activity** — deals, targets, pipeline, diligence status, timeline, milestones, and risks.
- **External parties and market intelligence** — companies, counterparties, buyers, sellers, advisors, bankers, lenders, law firms, and their roles, as well as externally-relevant news and developments.
- Ownership, shareholders, cap table, and stake being offered/acquired.
- Regulatory, legal, or approval matters affecting a transaction.

**EXCLUDE (internal-only — do NOT mention these):**
- Internal people's names — do not name individual members of our own team/organization. Refer to them generically (e.g. "the deal team") if needed at all.
- Internal HR movement, hiring, headcount changes, promotions, departures, or internal org announcements.
- Internal team logistics, internal culture, and administrative chatter that carry no external or deal significance.

Names of EXTERNAL people (e.g. a target company's management, an external banker or advisor) are fine to include when relevant. Only OUR internal people and internal-org matters are excluded. Do not leave \`summary\`/\`key_points\`/\`action_items\` empty just because the content is not a hard deal term — sector, market, acquisition, and external context all belong here.

## Companies Array Rules:
- Populate \`companies\` ONLY when \`file_type\` is \`"prospectus"\` or \`"shopping_list"\`. Omit it (or use \`[]\`) for all other file types.
- Every entry follows ALL of the "Prospectus Summary Rules" below (identity, financials, fx_adjustments).
- One entry per distinct deal target. Do NOT create entries for buyers, acquirers, sponsors, lenders, banks, or advisors.
- A shopping_list row with only a name and no other data still gets an entry (fill what is known, leave the rest null).
- \`prospectus_summary\` MUST be an exact copy of \`companies[0]\` (the primary/first target). If \`companies\` is empty, set \`prospectus_summary\` to null.
- If the user's "Additional Notes" exclude a company, it MUST NOT appear in \`companies\` (and therefore not in \`prospectus_summary\`).

## Prospectus Summary Rules:
- \`company_name\` and \`project_name\` MUST identify the company or project being OFFERED FOR SALE (the deal target). NEVER set them to a buyer, acquirer, sponsor, lender, investment bank, or law firm named in the document. If the document is not offering a specific company for sale, leave both \`null\`.
- \`financials\` is an array with one object per fiscal year that the document explicitly reports. Years are flexible (typically the most recent 3-5 reported years; valid range 1990..2100). Use \`null\` for individual fields the document does not provide; omit the year entry entirely if the document reports nothing for it.
- All \`*_usd_mn\` fields are in millions of USD.
- \`revenue_cagr_vs_prior\` is YoY growth of revenue versus the immediately prior fiscal_year row in this same array. Leave it \`null\` for the earliest year. Express as a decimal (e.g. 0.12 for 12%).
- \`ebitda_margin\` is also a decimal (e.g. 0.18 for 18%).
- \`fx_adjustments\` is only populated when the company reports primary financials in a non-USD currency. Include one row per fiscal_year that mirrors a row in \`financials\`. \`currency\` is the ISO-4217 code (e.g. "KRW", "IDR"). Omit the entire \`fx_adjustments\` array if the company reports in USD.
- When \`fx_adjustments\` is populated:
  - \`revenue_local\` is the document-reported revenue figure verbatim. Set \`revenue_local_unit\` to "mn", "bn", or "thousands" to match exactly how the document expresses it (e.g. "KRW 36.2 bn" → \`revenue_local: 36.2, revenue_local_unit: "bn"\`; "IDR 12,500 mn" → \`revenue_local: 12500, revenue_local_unit: "mn"\`). The server normalizes to millions of local currency before persisting.
  - **East Asian numerical units (CRITICAL):** documents in Korean / Japanese / Chinese often use non-decimal magnitude markers. The schema only supports "mn" / "bn" / "thousands" — you MUST convert before emitting. Common conversions:
    - 億 / 억 (Korean / Japanese, = 100 million) → multiply by 100 to get mn. Example: "KRW 7,251 억" → \`revenue_local: 725100, revenue_local_unit: "mn"\` (NOT 7251000 — that would be a 10× error).
    - 万 / 萬 (Chinese, = 10,000) → multiply by 0.01 to get mn (or use "thousands" with ×10). Example: "CNY 5,000 万" → \`revenue_local: 50, revenue_local_unit: "mn"\`.
    - 兆 / 万亿 (10¹²) → use "bn" with ×1000. Example: "JPY 1.2 兆" → \`revenue_local: 1200, revenue_local_unit: "bn"\`.
    Sanity-check before emitting: \`revenue_local\` (after applying the unit) divided by \`assumed_forex\` MUST equal \`revenue_usd_mn\` within 5%. If they disagree, your unit conversion is wrong — fix \`revenue_local\`, do not change \`revenue_usd_mn\`.
  - \`ebitda_local\` and \`ebitda_local_unit\` follow the same rules; set both \`null\` when the document does not report EBITDA in local currency.
  - \`assumed_forex\` MUST be filled. Units: local currency per 1 USD (e.g. KRW 1370/USD → 1370; IDR 16100/USD → 16100). Use a rate quoted in the document if available, otherwise the period-average spot rate for that fiscal year from your training knowledge. Do not leave it null.
  - You MAY leave \`revenue_usd_mn\` and \`ebitda_usd_mn\` \`null\` when the document only reports local-currency figures. The server will derive them as \`<local_in_mn> / assumed_forex\`.
- Do NOT extract derived screening fields (any \`l0_*\`, \`l1_*\`, segment revenue ratios, priority-geo flags, drop counts, screening rationales, etc.). Those are computed downstream by the screening pipeline.

## Financial Statement Summary Rules:
- Only populate \`financial_statement_summary\` when \`file_type\` is \`"financial_statement"\`.
- \`company_name\` is the legal entity whose financials are being reported (e.g. "Frontier Resources Pte. Ltd."). This may be a buyer, seller, or any company — do NOT restrict to deal targets.
- \`financials\` and \`fx_adjustments\` follow the exact same rules as \`prospectus_summary.financials\` and \`fx_adjustments\` above.
- Omit \`financial_statement_summary\` entirely (or set to null) for all other file types.

Always prioritize accuracy. Only list a company in 'companies_detected' if you are sure it matches one in the provided known list.

## Investment Track Matching Rules:
- \`suggested_track_ids\` must be an array of track IDs from the "Investment Tracks" list above.
- Only include a track if the deal target's sector, geography, and profile genuinely match the track thesis.
- Return an empty array \`[]\` if no tracks fit or you are not confident. Never force a match.
- If no "Investment Tracks" are listed, always return \`[]\`.`;

/**
 * Sanitize one deal-target entry (an element of `companies`, shaped like the
 * legacy `prospectus_summary`): run the pure-compute FX backfill so USD
 * figures are ready to persist, cross-check USD vs local figures (trusting
 * USD on divergence), drop financial rows with no data, and null out
 * section-header phrases so they can't flow into company creation.
 * Mutates and returns the entry.
 */
function sanitizeCompanyEntry(entry: any, logPrefix: string): any {
  const financialRowsRaw: FinancialRow[] = Array.isArray(entry.financials)
    ? entry.financials
        .filter((r: any) => r && Number.isInteger(r.fiscal_year))
        .map((r: any): FinancialRow => ({
          fiscal_year: r.fiscal_year as number,
          revenue_usd_mn: r.revenue_usd_mn ?? null,
          ebitda_usd_mn: r.ebitda_usd_mn ?? null,
          ev_usd_mn: r.ev_usd_mn ?? null,
          ebitda_margin: r.ebitda_margin ?? null,
          ev_ebitda: r.ev_ebitda ?? null,
          revenue_cagr_vs_prior: r.revenue_cagr_vs_prior ?? null,
        }))
    : [];

  const fxRows: FxRow[] = Array.isArray(entry.fx_adjustments)
    ? entry.fx_adjustments
        .filter(
          (r: any) =>
            r &&
            Number.isInteger(r.fiscal_year) &&
            typeof r.currency === 'string' &&
            r.currency.length > 0,
        )
        .map((r: any) => normalizeFxRow(r as RawFxRow))
    : [];

  applyFxBackfill(financialRowsRaw, fxRows);

  // Cross-check USD vs local (after backfill). When the LLM emits both and
  // they disagree (commonly because it mishandled non-decimal units like
  // 억 / 万), trust the USD value and recompute local so the FX row stays
  // consistent. Surface the corrections in the agent log.
  const warnings = validateFxConsistency(financialRowsRaw, fxRows);
  for (const w of warnings) {
    logger.warn(
      `[${logPrefix}] FX inconsistency FY${w.fiscal_year} ${w.field}: ` +
        `reported_usd=${w.reported_usd_mn} vs local/forex=${w.derived_usd_mn.toFixed(2)} ` +
        `(divergence ${(w.divergence_ratio * 100).toFixed(1)}%). ` +
        `Trusting USD; ${w.field}_local recomputed to ${w.resolved_local_mn.toFixed(0)}.`,
    );
  }

  entry.financials = financialRowsRaw.filter(
    (r: FinancialRow) =>
      r.revenue_usd_mn !== null || r.ebitda_usd_mn !== null || r.ev_usd_mn !== null ||
      r.ebitda_margin !== null || r.ev_ebitda !== null || r.revenue_cagr_vs_prior !== null,
  );
  entry.fx_adjustments = fxRows;

  // Null out section-header phrases so they can't flow into company creation.
  if (isGenericDocumentPhrase(entry.company_name ?? '')) {
    entry.company_name = null;
  }
  if (isGenericDocumentPhrase(entry.project_name ?? '')) {
    entry.project_name = null;
  }

  return entry;
}

/**
 * Stream the agent and return the messages from the final state.
 */
async function streamAgentMessages(
  agent: ReturnType<typeof createAgent>,
  messages: BaseMessage[],
): Promise<BaseMessage[]> {
  let finalMessages: BaseMessage[] = [];
  const stream = await agent.stream(
    { messages } as any,
    { streamMode: "values" } as any,
  );
  for await (const chunk of stream as AsyncIterable<{ messages?: BaseMessage[] }>) {
    if (chunk?.messages) {
      finalMessages = chunk.messages;
    }
  }
  return finalMessages;
}

/**
 * Invoke the file processing agent.
 *
 * Returns the AI's parsed classification + extraction result. No DB writes —
 * persistence (creating companies, financials, fx) is handled by the caller
 * (`FileService.processUpload` auto-creates deal-target companies from the
 * `companies` array, skipping duplicates).
 */
export async function processFileContent(
  rawText: string,
  buffer: Buffer,
  contentType: string,
  userRawNotes: string,
  fileTypeOverride?: FileTypeOverride,
  fileName?: string,
) {
  const startedAt = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const refsStart = Date.now();
  const [allReferences, tracks] = await Promise.all([
    getAllCompanyReferences(),
    getAllInvestmentTracks(),
  ]);
  const allNames = allReferences.map(r => r.name).join(", ");
  logger.info(`⏱️  Loaded ${allReferences.length} company references + ${tracks.length} tracks in ${Date.now() - refsStart}ms`);

  const llm = new ChatAnthropic({
    model: "claude-sonnet-5",
    anthropicApiKey: apiKey,
    // Documents referenced by Files API id are served from the beta endpoint.
    betas: [FILES_API_BETA],
    // Sonnet 5 rejects `temperature` (400: "temperature is deprecated for
    // this model"). Explicitly leave it unset — ChatAnthropic omits the field
    // from the request when this is undefined (see invocationParams).
    temperature: undefined,
    // Meeting-minutes / shopping-list docs produce very long structured JSON
    // (multi-paragraph summary + dozens of key_points, tags, companies_detected
    // and company_notes). LangChain defaults maxTokens to 2048, which truncates
    // the JSON block mid-array and breaks the downstream ```json``` parse.
    // Give the model ample room to finish the JSON.
    maxTokens: 32000,
    // With maxTokens this large, the Anthropic SDK rejects NON-streaming
    // requests ("Streaming is required for operations that may take longer
    // than 10 minutes"). `agent.stream(...)` only streams LangGraph state
    // values — the underlying Messages API call is still non-streaming unless
    // the model itself streams. This makes ChatAnthropic use the streaming
    // API under the hood and aggregate the chunks.
    streaming: true,
  });

  const anthropic = new Anthropic({ apiKey });

  const agent = createAgent({
    model: llm,
    tools: [],
    systemPrompt: generateSystemPrompt(allNames, userRawNotes, fileTypeOverride, fileName, tracks),
  });

  const fileNamePrefix = fileName ? `Filename: ${fileName}\n\n` : '';
  let inputs = {
    messages: [new HumanMessage(`${fileNamePrefix}Raw Content to process:\n\n${rawText}`)] as BaseMessage[],
  };

  let lastMessage: BaseMessage | null = null;
  if (contentType === 'application/pdf') {
    logger.info("📂 INVOKING FILE PROCESSING AGENT");

    // Upload the whole PDF via the Files API and reference it by id rather than
    // inlining the PDF as base64. The file is deleted immediately after the
    // agent processes it so nothing is left behind in the workspace.
    const uploadStart = Date.now();
    const uploaded = await anthropic.beta.files.upload({
      file: await toFile(buffer, "document.pdf", { type: "application/pdf" }),
      betas: [FILES_API_BETA],
    });
    logger.info(`⬆️  Uploaded PDF (${buffer.length} bytes) as ${uploaded.id} in ${Date.now() - uploadStart}ms`);

    try {
      inputs = {
        messages: [new HumanMessage({
          content: [{
            type: 'text',
            text: fileName ? `Filename: ${fileName}\n\nAnalyze the following document.` : 'Analyze the following document.',
          },
          {
            type: "file",
            fileId: uploaded.id,
          },
          ],
        })],
      };
      const agentStart = Date.now();
      const messagesList = await streamAgentMessages(agent, inputs.messages);
      lastMessage = messagesList[messagesList.length - 1];
      logger.info(`🤖 Agent processed PDF in ${Date.now() - agentStart}ms`);
    } finally {
      // Best-effort cleanup — a failed delete should not fail the pipeline.
      const deleteStart = Date.now();
      try {
        await anthropic.beta.files.delete(uploaded.id, { betas: [FILES_API_BETA] });
        logger.info(`🗑️  Deleted uploaded file ${uploaded.id} in ${Date.now() - deleteStart}ms`);
      } catch (err) {
        logger.warn(`Failed to delete uploaded file ${uploaded.id}: ${err}`);
      }
    }
  } else {
    const agentStart = Date.now();
    const messagesList = await streamAgentMessages(agent, inputs.messages);
    lastMessage = messagesList[messagesList.length - 1];
    logger.info(`🤖 Agent processed text in ${Date.now() - agentStart}ms`);
  }

  logger.info(`⏱️  LLM phase complete in ${Date.now() - startedAt}ms`);

  const content = typeof lastMessage?.content === "string"
    ? lastMessage?.content
    : JSON.stringify(lastMessage?.content);

  const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch && jsonMatch[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);

      const finalMatchedCompanies: any[] = [];
      let companiesDetected: string[] = Array.isArray(parsed.companies_detected)
        ? parsed.companies_detected.filter(
            (n: unknown): n is string =>
              typeof n === 'string' && n.length > 0 && !isGenericDocumentPhrase(n),
          )
        : [];
      if (companiesDetected.length === 0 && MULTI_COMPANY_FILE_TYPES.has(parsed.file_type)) {
        const entries: any[] = Array.isArray(parsed.companies) && parsed.companies.length > 0
          ? parsed.companies
          : parsed.prospectus_summary
            ? [parsed.prospectus_summary]
            : [];
        companiesDetected = entries
          .map((e: any) => e?.company_name || e?.project_name)
          .filter(
            (n: unknown): n is string =>
              typeof n === 'string' && n.length > 0 && !isGenericDocumentPhrase(n),
          );
      }

      for (const detectedName of companiesDetected) {
        const match = allReferences.find(r => r.name.toLowerCase() === (detectedName as string).toLowerCase());
        if (match) {
          finalMatchedCompanies.push(match);
        } else if (!isGenericDocumentPhrase(detectedName)) {
          finalMatchedCompanies.push({
            id: null,
            name: detectedName,
            type: 'company',
            similarity: 1,
          });
        }
      }

      parsed.matched_companies = finalMatchedCompanies;

      if (parsed.company_notes && Array.isArray(parsed.company_notes)) {
        for (const noteObj of parsed.company_notes) {
          const match = allReferences.find(r => r.name.toLowerCase() === (noteObj.company_name as string).toLowerCase());
          if (match) {
            const recordIndex = finalMatchedCompanies.findIndex(m => m.id === match.id);
            if (recordIndex >= 0) {
              finalMatchedCompanies[recordIndex].note = noteObj.note;
            }
          }
        }
      }

      parsed.matched_companies = finalMatchedCompanies;

      if (!parsed.file_type) {
        parsed.file_type = 'other';
      }

      // Normalize deal-target extraction for multi-company file types.
      // Fall back to the legacy single `prospectus_summary` when the model
      // didn't emit a `companies` array, sanitize every entry (FX backfill +
      // generic-name nulling), and keep `prospectus_summary` mirroring
      // `companies[0]` so legacy consumers keep working.
      if (MULTI_COMPANY_FILE_TYPES.has(parsed.file_type)) {
        let companyEntries: any[] = Array.isArray(parsed.companies)
          ? parsed.companies.filter((e: any) => e && typeof e === 'object')
          : [];
        if (companyEntries.length === 0 && parsed.prospectus_summary) {
          companyEntries = [parsed.prospectus_summary];
        }

        parsed.companies = companyEntries.map((entry: any, i: number) =>
          sanitizeCompanyEntry(entry, `companies[${i}]`),
        );
        parsed.prospectus_summary = parsed.companies[0] ?? null;
      }

      // Parse and FX-backfill financial_statement_summary.financials.
      if (parsed.file_type === 'financial_statement' && parsed.financial_statement_summary) {
        const fss = parsed.financial_statement_summary;

        const financialRowsRaw: FinancialRow[] = Array.isArray(fss.financials)
          ? fss.financials
              .filter((r: any) => r && Number.isInteger(r.fiscal_year))
              .map((r: any): FinancialRow => ({
                fiscal_year: r.fiscal_year as number,
                revenue_usd_mn: r.revenue_usd_mn ?? null,
                ebitda_usd_mn: r.ebitda_usd_mn ?? null,
                ev_usd_mn: r.ev_usd_mn ?? null,
                ebitda_margin: r.ebitda_margin ?? null,
                ev_ebitda: r.ev_ebitda ?? null,
                revenue_cagr_vs_prior: r.revenue_cagr_vs_prior ?? null,
              }))
          : [];

        const fxRows: FxRow[] = Array.isArray(fss.fx_adjustments)
          ? fss.fx_adjustments
              .filter(
                (r: any) =>
                  r &&
                  Number.isInteger(r.fiscal_year) &&
                  typeof r.currency === 'string' &&
                  r.currency.length > 0,
              )
              .map((r: any) => normalizeFxRow(r as RawFxRow))
          : [];

        applyFxBackfill(financialRowsRaw, fxRows);

        const warnings = validateFxConsistency(financialRowsRaw, fxRows);
        for (const w of warnings) {
          logger.warn(
            `[financial_statement] FX inconsistency FY${w.fiscal_year} ${w.field}: ` +
              `reported_usd=${w.reported_usd_mn} vs local/forex=${w.derived_usd_mn.toFixed(2)} ` +
              `(divergence ${(w.divergence_ratio * 100).toFixed(1)}%). ` +
              `Trusting USD; ${w.field}_local recomputed to ${w.resolved_local_mn.toFixed(0)}.`,
          );
        }

        parsed.financial_statement_summary.financials = financialRowsRaw.filter(
          (r: FinancialRow) =>
            r.revenue_usd_mn !== null || r.ebitda_usd_mn !== null || r.ev_usd_mn !== null ||
            r.ebitda_margin !== null || r.ev_ebitda !== null || r.revenue_cagr_vs_prior !== null,
        );
        parsed.financial_statement_summary.fx_adjustments = fxRows;
      }

      return parsed;
    } catch (err) {
      // A common cause here is output-token truncation: the model ran out of
      // budget mid-JSON, so the ```json``` block is present but not valid JSON.
      // Surface enough detail to tell truncation apart from a genuine format error.
      const jsonBody = jsonMatch[1];
      logger.error(
        `Failed to parse JSON from agent response (len=${jsonBody.length}): ${err instanceof Error ? err.message : String(err)}. ` +
          `Tail: ${JSON.stringify(jsonBody.slice(-120))}`,
      );
      return { raw_response: content };
    }
  }

  // No ```json``` block at all — usually means the response was truncated before
  // the closing fence (output-token limit) or the model didn't emit JSON.
  logger.error(`No JSON block found in agent response (content len=${content.length}). Tail: ${JSON.stringify(content.slice(-120))}`);
  return { raw_response: content };
}
