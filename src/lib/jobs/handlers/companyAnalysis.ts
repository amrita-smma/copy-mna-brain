import {
  extractMessageText,
  getStatelessAgentGraph,
  HumanMessage,
} from "@/lib/agents/analysis";
import { getToolDescriptions } from "@/lib/agents/analysis/tools";
import {
  CompanyAnalysisRepository,
  CompanyFinancialRepository,
  CompanyRepository,
  CompanyScreeningDerivedRepository,
} from "@/lib/repositories";
import type { DbClient, Tables } from "@/lib/repositories";
import {
  RELATION_TYPES,
  type RelationType,
} from "@/lib/repositories/companyRelationRepository";
import { getPostHogClient } from "@/lib/posthog-server";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";

export const COMPANY_ANALYSIS_TIMEOUT_SECONDS = 480; // 8 minutes

const RelatedCompanySchema = z.object({
  name: z.string(),
  relation_type: z.enum(
    RELATION_TYPES as unknown as [RelationType, ...RelationType[]],
  ),
  notes: z.string().optional(),
  evidence: z.string().optional(),
});

/** A company surfaced by a card as related to the analysed company. */
export type RelatedCompany = z.infer<typeof RelatedCompanySchema>;

const CompanyAnalysisResultSchema = z.object({
  business_overview: z.string(),
  business_model_summary: z.string(),
  key_takeaways: z.string(),
  investment_highlights: z.string(),
  investment_risks: z.string(),
  diligence_priorities: z.string(),
  logo_url: z.string().url().optional().nullable(),
  sources_used: z
    .array(
      z.object({
        type: z.string(),
        url: z.string().optional(),
        title: z.string().optional(),
      }),
    )
    .optional(),
  related_companies: z.array(RelatedCompanySchema).optional(),
});

type CompanyAnalysisResult = z.infer<typeof CompanyAnalysisResultSchema>;

export interface CompanyAnalysisPayload {
  companyId: string;
  source?: string;
}

/** Result of generating a company card: the saved record plus the related
 * companies the agent surfaced (to be linked into the relationship graph by
 * the caller) and the analysed company's display name. */
export interface CompanyCardResult {
  analysis: Tables<"company_analyses">;
  relatedCompanies: RelatedCompany[];
  companyName: string;
}

const ANALYSIS_PROMPT_TEMPLATE = `You are a senior M&A analyst preparing a comprehensive Company Card for an acquisition target. Your job is to research the company thoroughly using ALL available tools, then produce a structured analysis.

## IMPORTANT: Use All Available Tools to Research

You have access to these tools — USE THEM ALL to gather comprehensive information:
{toolDescriptions}

**Research steps you MUST follow:**
1. Use \`get_company_details\` to retrieve internal database information about "{companyName}"
2. Use \`inven_paid_data_source_search\` to find the company on Inven, then \`inven_paid_data_source_enrichment\` for detailed data
3. Use \`web_search\` to research the company's website, products, market position, recent news, and competitive landscape (e.g., "{companyName} company overview products services", "{companyName} revenue market position competitors")
4. Use \`query_files\` to check if there are any internal files about this company

## Company Context
{companyContext}

## Analysis Sections to Produce

Generate the following 6 sections. Each section must be **markdown-formatted** using bullet points (matching the style shown below). Be specific, data-driven, and concise.

**LENGTH LIMIT (strict): each section must be 150 words or fewer.** Prioritize the most decision-relevant points, keep bullets short, and cut filler — do not pad to reach the limit. Quality and signal over volume.

### 1. Business Overview
Establish a factual baseline about the company:
- **Primary Products/Services**: What the company makes or provides
- **End Markets**: Which industries/verticals they serve
- **Customer Types**: OEMs, distributors, end consumers, B2B, B2G, etc.
- **Geographic Footprint**: HQ location, production facilities, key markets
- **Company Size**: Employee count, revenue scale if available

### 2. Business Model & Value Chain Summary
Explain how the company operates economically:
- **Core Focus**: What is the company's niche or specialization
- **Value Chain Position**: Where the company sits (upstream, midstream, downstream)
- **Revenue Model**: Recurring vs. project-based, contract vs. spot, subscription vs. one-time
- **Competitive Dimension**: What drives customer selection (price, quality, speed, IP, compliance)
- **Switching Costs**: How sticky are customer relationships

### 3. Key Takeaways
Surface the 3-5 most important implications from the analysis (synthesized insights):
- Each takeaway should be a bold header followed by a brief explanation
- Focus on what an M&A investment committee member needs to know
- Include both positive and cautionary observations

### 4. Investment Highlights
Identify upside drivers linked to the company's business model and positioning:
- **Market Position**: Competitive standing and market share
- **Differentiation**: Proprietary technology, IP, regulatory advantages
- **Strategic Fit**: Alignment with investment thesis and portfolio
- **Growth Vectors**: Organic growth opportunities, new markets, product expansion

### 5. Investment Risks
Identify risks inherent to the company's business model and value chain:
- **Customer Concentration**: Revenue dependency on top customers
- **Regulatory Exposure**: Compliance costs, policy changes
- **End-Market Cyclicality**: Vulnerability to economic cycles
- **Data Gaps**: Information that could not be verified or found

### 6. Diligence Priorities
Define the 3-7 most critical unknowns to resolve before advancing investment:
- Frame each as a specific question that due diligence should answer
- Prioritize items that could be deal-breakers
- Include financial, operational, legal, and commercial dimensions

### 7. Related Companies
Identify other companies that "{companyName}" has a concrete business relationship with — its notable suppliers, partners/collaborators, and investors/owners. For each, classify the relationship FROM "{companyName}" TO the related company using exactly one of these types:
- **SUPPLIER**: "{companyName}" supplies products/services to the related company (the related company is a customer/downstream).
- **PARTNER**: "{companyName}" has a partnership, JV, alliance, or significant commercial collaboration with the related company.
- **INVESTED_IN**: "{companyName}" has invested in / owns a stake in the related company.

Only include companies you have a real basis for from your research — do NOT invent relationships. It is fine to return an empty list if none are evident. Use the company's commonly-known name (no legal suffixes needed).

**CRITICAL — return ONLY companies/organizations, never people:** Every entry in \`related_companies\` MUST be a company, business, or organization (e.g. a corporation, firm, fund, or institutional entity). Do NOT include the names of individual persons — founders, executives, board members, employees, advisors, or any other named human. If a relationship is tied to a person (e.g. an individual angel investor or a named founder), exclude it unless you can attribute it to an actual company/fund. When in doubt about whether an entity is a company or a person, leave it out.

## Response Format

Respond ONLY with a JSON object. Each section value should be a markdown string with bullet points, and **each must stay within the 150-word limit**.

\`\`\`json
{
  "business_overview": "- **Primary Products**: ...\\n- **End Markets**: ...\\n...",
  "business_model_summary": "- **Core Focus**: ...\\n- **Value Chain Position**: ...\\n...",
  "key_takeaways": "1. **Takeaway title** explanation...\\n2. ...\\n...",
  "investment_highlights": "- **Market Position**: ...\\n- **Differentiation**: ...\\n...",
  "investment_risks": "- **Customer Concentration**: ...\\n- **Regulatory Exposure**: ...\\n...",
  "diligence_priorities": "1. Question one?\\n2. Question two?\\n...",
  "logo_url": "https://...",
  "sources_used": [{"type": "database"}, {"type": "web", "url": "https://...", "title": "..."}, {"type": "inven"}, {"type": "{source}"}],
  "related_companies": [{"name": "Some Customer Inc", "relation_type": "SUPPLIER", "notes": "Key wafer supplier relationship", "evidence": "https://..."}]
}
\`\`\`

For \`logo_url\`: find the company's official logo. Try these sources in order:
1. The company's own website favicon/logo (e.g. https://companydomain.com/favicon.ico or look for og:image in their homepage)
2. If using Inven data, use the \`logo_url\` field from the enrichment result
3. If none found, set to null

Include ONLY the sources you actually used in \`sources_used\`. Respond with the JSON object only, no additional text.`;

function buildCompanyContext(
  company: Tables<"companies">,
  financials: Tables<"company_financials">[],
  screening: Tables<"company_screening_derived"> | null,
): string {
  const lines: string[] = [];

  lines.push(`**Company Name:** ${company.target || "Unknown"}`);

  if (company.segment) lines.push(`**Segment:** ${company.segment}`);
  if (company.geography) lines.push(`**Geography:** ${company.geography}`);
  if (company.company_focus) lines.push(`**Focus:** ${company.company_focus}`);
  if (company.ownership) lines.push(`**Ownership:** ${company.ownership}`);
  if (company.website) lines.push(`**Website:** ${company.website}`);
  if (company.comments) lines.push(`**Comments:** ${company.comments}`);

  const byYear = new Map<number, Tables<"company_financials">>();
  for (const row of financials) byYear.set(row.fiscal_year, row);

  const revenueParts: string[] = [];
  const ebitdaParts: string[] = [];
  const marginParts: string[] = [];
  let evPart: string | null = null;
  for (const year of [2021, 2022, 2023, 2024]) {
    const row = byYear.get(year);
    if (!row) continue;
    if (row.revenue_usd_mn != null)
      revenueParts.push(`Revenue ${year}: $${row.revenue_usd_mn}M`);
    if (row.ebitda_usd_mn != null)
      ebitdaParts.push(`EBITDA ${year}: $${row.ebitda_usd_mn}M`);
    if (row.ebitda_margin != null)
      marginParts.push(`Margin ${year}: ${row.ebitda_margin}%`);
    if (year === 2024 && row.ev_usd_mn != null)
      evPart = `EV 2024: $${row.ev_usd_mn}M`;
  }
  const financialStrings = [
    ...revenueParts,
    ...ebitdaParts,
    ...(evPart ? [evPart] : []),
  ];

  if (financialStrings.length > 0) {
    lines.push(`**Financials:**`);
    lines.push(financialStrings.join(" | "));
  } else {
    lines.push(`**Financials:** No financial data available in database`);
  }

  if (marginParts.length > 0) {
    lines.push(`**EBITDA Margins:**`);
    lines.push(marginParts.join(" | "));
  }

  if (screening?.l1_screening_result)
    lines.push(`**L1 Screening Result:** ${screening.l1_screening_result}`);
  if (screening?.l1_rationale)
    lines.push(`**L1 Rationale:** ${screening.l1_rationale}`);

  return lines.join("\n");
}

/**
 * Generate (or regenerate) a Company Card: research the company on the
 * stateless analysis agent, parse the structured 6-section result, and persist
 * it to `company_analyses`. Returns the saved record plus any related
 * companies the agent surfaced — the caller decides how to link those into the
 * relationship graph.
 *
 * Decoupled from the jobs table: `jobId` is optional. The Company Card now runs
 * on the AI Workforce (see `generate_company_card` tool), which has no jobs row;
 * the legacy `runCompanyAnalysis` job wrapper still threads its job id through.
 */
export async function generateCompanyCard(
  payload: CompanyAnalysisPayload,
  deps: { db: DbClient; jobId?: string | null; workspaceId?: string | null },
): Promise<CompanyCardResult> {
  const { companyId, source } = payload;
  const jobId = deps.jobId ?? null;
  const workspaceId = deps.workspaceId ?? (await getActiveWorkspaceId());

  if (!companyId) throw new Error("Missing required field: companyId");

  const analysisRepo = new CompanyAnalysisRepository(deps.db, workspaceId);
  const companyRepo = new CompanyRepository(deps.db, workspaceId);
  const financialRepo = new CompanyFinancialRepository(deps.db, workspaceId);
  const screeningRepo = new CompanyScreeningDerivedRepository(deps.db, workspaceId);

  const [company, financials, screening] = await Promise.all([
    companyRepo.findById(companyId),
    financialRepo.findByCompany(companyId),
    screeningRepo.findByCompany(companyId),
  ]);

  await analysisRepo.upsertByCompanyId({
    company_id: companyId,
    status: "processing",
    error_message: null,
    job_id: jobId,
  });

  const agent = await getStatelessAgentGraph();
  if (!agent) {
    await analysisRepo.updateByCompanyId(companyId, {
      status: "failed",
      error_message: "Agent not available. Check ANTHROPIC_API_KEY.",
    });
    throw new Error(
      "Agent not available. Please ensure ANTHROPIC_API_KEY is set.",
    );
  }

  const companyName = company.target || company.project_name || "Unknown";
  const companyContext = buildCompanyContext(company, financials, screening);
  const toolDescriptions = getToolDescriptions();

  const prompt = ANALYSIS_PROMPT_TEMPLATE.replace(
    "{toolDescriptions}",
    toolDescriptions,
  )
    .replaceAll("{companyName}", companyName)
    .replace("{companyContext}", companyContext)
    .replace("{source}", source || "files");

  // The stateless graph has no checkpointer, so thread_id is only a trace
  // label — use the job id when present, else a company-scoped fallback.
  const threadId = jobId ?? `company-card-${companyId}`;

  let agentResult;
  try {
    agentResult = await agent.invoke(
      { messages: [new HumanMessage(prompt)] },
      { configurable: { thread_id: threadId } },
    );
  } catch (err) {
    const message = (err as Error).message || "Unknown error";
    await analysisRepo.updateByCompanyId(companyId, {
      status: "failed",
      error_message: message,
    });
    throw err;
  }

  const messages = agentResult.messages;
  const lastMsg = messages[messages.length - 1];
  const content = extractMessageText(lastMsg);

  let analysisResult: CompanyAnalysisResult;
  try {
    analysisResult = CompanyAnalysisResultSchema.parse(JSON.parse(content));
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        analysisResult = CompanyAnalysisResultSchema.parse(
          JSON.parse(jsonMatch[0]),
        );
      } catch (parseErr) {
        console.error(
          "[companyAnalysis] failed to parse agent output into structured format",
          {
            jobId,
            companyId,
            contentIsArray: Array.isArray(lastMsg?.content),
            contentPreview: content.slice(0, 500),
            error: (parseErr as Error).message,
          },
        );
        await analysisRepo.updateByCompanyId(companyId, {
          status: "failed",
          error_message: "Failed to parse AI response into structured format",
        });
        throw new Error("Failed to parse AI response");
      }
    } else {
      console.error(
        "[companyAnalysis] agent output contained no JSON object",
        {
          jobId,
          companyId,
          contentIsArray: Array.isArray(lastMsg?.content),
          contentPreview: content.slice(0, 500),
        },
      );
      await analysisRepo.updateByCompanyId(companyId, {
        status: "failed",
        error_message: "AI response was not in expected JSON format",
      });
      throw new Error("AI response was not in expected format");
    }
  }

  const updated = await analysisRepo.updateByCompanyId(companyId, {
    status: "completed",
    business_overview: analysisResult.business_overview,
    business_model_summary: analysisResult.business_model_summary,
    key_takeaways: analysisResult.key_takeaways,
    investment_highlights: analysisResult.investment_highlights,
    investment_risks: analysisResult.investment_risks,
    diligence_priorities: analysisResult.diligence_priorities,
    sources: analysisResult.sources_used || [],
    logo_url: analysisResult.logo_url ?? null,
    error_message: null,
  });

  getPostHogClient()?.capture({
    distinctId: "server",
    event: "company_card_generated",
    properties: {
      company_id: companyId,
      company_name: companyName,
      source: source || "files",
      related_company_count: analysisResult.related_companies?.length ?? 0,
    },
  });

  return {
    analysis: updated,
    relatedCompanies: analysisResult.related_companies ?? [],
    companyName,
  };
}

/**
 * Legacy jobs-table entrypoint. The Company Card now runs on the AI Workforce
 * (`generate_company_card` tool); this wrapper is kept for the `company_analysis`
 * job type and returns just the saved record for backward compatibility.
 */
export async function runCompanyAnalysis(
  payload: CompanyAnalysisPayload,
  deps: { db: DbClient; job: Tables<"jobs"> },
): Promise<Tables<"company_analyses">> {
  const { analysis } = await generateCompanyCard(payload, {
    db: deps.db,
    jobId: deps.job.id,
    workspaceId: deps.job.workspace_id,
  });
  return analysis;
}
