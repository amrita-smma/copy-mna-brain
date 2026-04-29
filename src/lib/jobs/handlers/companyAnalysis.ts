import { getAgentGraph, HumanMessage } from '@/lib/agents/analysis';
import { getToolDescriptions } from '@/lib/agents/analysis/tools';
import {
  CompanyAnalysisRepository,
  CompanyFinancialRepository,
  CompanyRepository,
  CompanyScreeningDerivedRepository,
} from '@/lib/repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { z } from 'zod';

export const COMPANY_ANALYSIS_TIMEOUT_SECONDS = 300;

const CompanyAnalysisResultSchema = z.object({
  business_overview: z.string(),
  business_model_summary: z.string(),
  key_takeaways: z.string(),
  investment_highlights: z.string(),
  investment_risks: z.string(),
  diligence_priorities: z.string(),
  sources_used: z
    .array(
      z.object({
        type: z.string(),
        url: z.string().optional(),
        title: z.string().optional(),
      }),
    )
    .optional(),
});

type CompanyAnalysisResult = z.infer<typeof CompanyAnalysisResultSchema>;

export interface CompanyAnalysisPayload {
  companyId: string;
  source?: string;
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
5. Use \`compare_with_past_acquisitions\` if relevant to check how it compares to past deals

## Company Context
{companyContext}

## Analysis Sections to Produce

Generate the following 6 sections. Each section must be **markdown-formatted** using bullet points (matching the style shown below). Be specific, data-driven, and concise.

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

## Response Format

Respond ONLY with a JSON object. Each section value should be a markdown string with bullet points.

\`\`\`json
{
  "business_overview": "- **Primary Products**: ...\\n- **End Markets**: ...\\n...",
  "business_model_summary": "- **Core Focus**: ...\\n- **Value Chain Position**: ...\\n...",
  "key_takeaways": "1. **Takeaway title** explanation...\\n2. ...\\n...",
  "investment_highlights": "- **Market Position**: ...\\n- **Differentiation**: ...\\n...",
  "investment_risks": "- **Customer Concentration**: ...\\n- **Regulatory Exposure**: ...\\n...",
  "diligence_priorities": "1. Question one?\\n2. Question two?\\n...",
  "sources_used": [{"type": "database"}, {"type": "web", "url": "https://...", "title": "..."}, {"type": "inven"}, {"type": "{source}"}]
}
\`\`\`

Include ONLY the sources you actually used in \`sources_used\`. Respond with the JSON object only, no additional text.`;

function buildCompanyContext(
  company: Tables<'companies'>,
  financials: Tables<'company_financials'>[],
  screening: Tables<'company_screening_derived'> | null,
): string {
  const lines: string[] = [];

  lines.push(`**Company Name:** ${company.target || 'Unknown'}`);

  if (company.segment) lines.push(`**Segment:** ${company.segment}`);
  if (company.geography) lines.push(`**Geography:** ${company.geography}`);
  if (company.company_focus) lines.push(`**Focus:** ${company.company_focus}`);
  if (company.ownership) lines.push(`**Ownership:** ${company.ownership}`);
  if (company.website) lines.push(`**Website:** ${company.website}`);
  if (company.comments) lines.push(`**Comments:** ${company.comments}`);

  const byYear = new Map<number, Tables<'company_financials'>>();
  for (const row of financials) byYear.set(row.fiscal_year, row);

  const revenueParts: string[] = [];
  const ebitdaParts: string[] = [];
  const marginParts: string[] = [];
  let evPart: string | null = null;
  for (const year of [2021, 2022, 2023, 2024]) {
    const row = byYear.get(year);
    if (!row) continue;
    if (row.revenue_usd_mn != null) revenueParts.push(`Revenue ${year}: $${row.revenue_usd_mn}M`);
    if (row.ebitda_usd_mn != null) ebitdaParts.push(`EBITDA ${year}: $${row.ebitda_usd_mn}M`);
    if (row.ebitda_margin != null) marginParts.push(`Margin ${year}: ${row.ebitda_margin}%`);
    if (year === 2024 && row.ev_usd_mn != null) evPart = `EV 2024: $${row.ev_usd_mn}M`;
  }
  const financialStrings = [...revenueParts, ...ebitdaParts, ...(evPart ? [evPart] : [])];

  if (financialStrings.length > 0) {
    lines.push(`**Financials:**`);
    lines.push(financialStrings.join(' | '));
  } else {
    lines.push(`**Financials:** No financial data available in database`);
  }

  if (marginParts.length > 0) {
    lines.push(`**EBITDA Margins:**`);
    lines.push(marginParts.join(' | '));
  }

  if (screening?.l1_screening_result) lines.push(`**L1 Screening Result:** ${screening.l1_screening_result}`);
  if (screening?.l1_rationale) lines.push(`**L1 Rationale:** ${screening.l1_rationale}`);

  return lines.join('\n');
}

export async function runCompanyAnalysis(
  payload: CompanyAnalysisPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<Tables<'company_analyses'>> {
  const { companyId, source } = payload;

  if (!companyId) throw new Error('Missing required field: companyId');

  const analysisRepo = new CompanyAnalysisRepository(deps.db);
  const companyRepo = new CompanyRepository(deps.db);
  const financialRepo = new CompanyFinancialRepository(deps.db);
  const screeningRepo = new CompanyScreeningDerivedRepository(deps.db);

  const [company, financials, screening] = await Promise.all([
    companyRepo.findById(companyId),
    financialRepo.findByCompany(companyId),
    screeningRepo.findByCompany(companyId),
  ]);

  await analysisRepo.upsertByCompanyId({
    company_id: companyId,
    status: 'processing',
    error_message: null,
    job_id: deps.job.id,
  });

  const agent = getAgentGraph();
  if (!agent) {
    await analysisRepo.updateByCompanyId(companyId, {
      status: 'failed',
      error_message: 'Agent not available. Check ANTHROPIC_API_KEY.',
    });
    throw new Error('Agent not available. Please ensure ANTHROPIC_API_KEY is set.');
  }

  const companyContext = buildCompanyContext(company, financials, screening);
  const toolDescriptions = getToolDescriptions();

  const prompt = ANALYSIS_PROMPT_TEMPLATE.replace('{toolDescriptions}', toolDescriptions)
    .replace('{companyName}', company.target || 'Unknown')
    .replace('{companyName}', company.target || 'Unknown')
    .replace('{companyContext}', companyContext)
    .replace('{source}', source || 'files');

  let agentResult;
  try {
    agentResult = await agent.invoke({ messages: [new HumanMessage(prompt)] });
  } catch (err) {
    const message = (err as Error).message || 'Unknown error';
    await analysisRepo.updateByCompanyId(companyId, {
      status: 'failed',
      error_message: message,
    });
    throw err;
  }

  const messages = agentResult.messages;
  const lastMsg = messages[messages.length - 1];
  const content = lastMsg
    ? typeof lastMsg.content === 'string'
      ? lastMsg.content
      : JSON.stringify(lastMsg.content)
    : '';

  let analysisResult: CompanyAnalysisResult;
  try {
    analysisResult = CompanyAnalysisResultSchema.parse(JSON.parse(content));
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        analysisResult = CompanyAnalysisResultSchema.parse(JSON.parse(jsonMatch[0]));
      } catch {
        await analysisRepo.updateByCompanyId(companyId, {
          status: 'failed',
          error_message: 'Failed to parse AI response into structured format',
        });
        throw new Error('Failed to parse AI response');
      }
    } else {
      await analysisRepo.updateByCompanyId(companyId, {
        status: 'failed',
        error_message: 'AI response was not in expected JSON format',
      });
      throw new Error('AI response was not in expected format');
    }
  }

  const updated = await analysisRepo.updateByCompanyId(companyId, {
    status: 'completed',
    business_overview: analysisResult.business_overview,
    business_model_summary: analysisResult.business_model_summary,
    key_takeaways: analysisResult.key_takeaways,
    investment_highlights: analysisResult.investment_highlights,
    investment_risks: analysisResult.investment_risks,
    diligence_priorities: analysisResult.diligence_priorities,
    sources: analysisResult.sources_used || [],
    error_message: null,
  });

  return updated;
}
