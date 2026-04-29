/**
 * File-processing agent.
 *
 * Builds a Claude-backed agent via langchain's `createAgent` and consumes its
 * output in streaming mode (`agent.stream` with `streamMode: "values"`).
 * The agent currently runs without tools — the structured JSON contract is
 * enforced by the system prompt — but tool definitions are kept under
 * ./tools so adding tools later is a one-line change.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { logger } from "../logger";
import { getAllCompanyReferences } from "@/lib/fuzzySearch";
import { splitPdf } from "@/lib/pdf";
import type { DbClient } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyFxAdjustmentRepository,
  CompanyRepository,
} from "@/lib/repositories";
import {
  applyFxBackfill,
  normalizeFxRow,
  type FinancialRow,
  type FxRow,
  type RawFxRow,
} from "./fxBackfill";

const generateSystemPrompt = (companies_list, userRawNotes) => `You are a specialized M&A File Processing Assistant. Your task is to analyze raw text extracted from meeting documents (like PPTX slides) and transform it into a highly structured format.

## Objectives:
1. **Understand Unstructured Data**: Read the provided raw text carefully.
2. **Reformat to Structured JSON**: Extract a clear summary, key points, action items, and tags.
3. **Generate Tags**: Create a list of tags including company names mentioned and short highlights.
4. **Identify Companies**: Identify which of the "Known Companies" provided in the prompt are mentioned in the text.
5. **Extract Company Notes**: For each identified company, extract specific notes or context.
6. **Extract Meeting Date**: Identify the date of the meeting/document (usually mentioned in the title or content).
7. **Categorize The File Type**: Identify the file type of the document.
8. **Extract Prospectus Summary**: If the file type is "prospectus", extract a detailed summary of the prospectus.

## Known Companies:
${companies_list}

## Additional Notes:
These are additional notes from the user about the document that might be relevant to the analysis. Please use this to understand the context of the document better.
${userRawNotes}

## Process:
1. Review the "Known Companies" list.
2. Identify which of those companies appear in the text.
3. **Detect Codenames**: Actively scan for and include project codenames (such as "Project Utopia", "Project Tulia", "Project Notos", "Project gChem", etc.) even if they do not match the "Known Companies" list. Treat these as valid detected companies.
3. **Categorize File Type**: Choose between "prospectus", "mom", and "other" file type.
4. Final Output must be a valid JSON block containing:
   - summary: A concise overview of the meeting/document.
   - key_points: Array of main takeaways.
   - action_items: Array of next steps.
   - tags: Array of useful searchable tags (company names, topics).
   - companies_detected: Array of STRINGS (exact names as they appear in the Known Companies list) that were found in the text.
   - company_notes: Array of objects { "company_name": "...", "note": "..." } containing the specific context for that company.
   - file_date: A string representing the meeting date in YYYY-MM-DD format. If not found, return null.
   - prospectus_summary: Detailed variables of the prospectus file type. Only exist if the file type is "prospectus". Please take a look at the example output below to see the structure of the prospectus_summary.

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
  "prospectus_summary": {
    "target": "Hidden company name. Please search for the company name in the known companies list or inside the document.",
    "segment": "...",
    "segment_related_offerings": "...",
    "company_focus": "...",
    "website": "...",
    "watchlist_status": "...",
    "comments": "...",
    "ownership": "...",
    "geography": "country name",
    "remarks": "...",
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

## Prospectus Summary Rules:
- \`financials\` is an array with one object per fiscal year that the document explicitly reports. Years are flexible (typically the most recent 3-5 reported years; valid range 1990..2100). Use \`null\` for individual fields the document does not provide; omit the year entry entirely if the document reports nothing for it.
- All \`*_usd_mn\` fields are in millions of USD.
- \`revenue_cagr_vs_prior\` is YoY growth of revenue versus the immediately prior fiscal_year row in this same array. Leave it \`null\` for the earliest year. Express as a decimal (e.g. 0.12 for 12%).
- \`ebitda_margin\` is also a decimal (e.g. 0.18 for 18%).
- \`fx_adjustments\` is only populated when the company reports primary financials in a non-USD currency. Include one row per fiscal_year that mirrors a row in \`financials\`. \`currency\` is the ISO-4217 code (e.g. "KRW", "IDR"). Omit the entire \`fx_adjustments\` array if the company reports in USD.
- When \`fx_adjustments\` is populated:
  - \`revenue_local\` is the document-reported revenue figure verbatim. Set \`revenue_local_unit\` to "mn", "bn", or "thousands" to match exactly how the document expresses it (e.g. "KRW 36.2 bn" → \`revenue_local: 36.2, revenue_local_unit: "bn"\`; "IDR 12,500 mn" → \`revenue_local: 12500, revenue_local_unit: "mn"\`). The server normalizes to millions of local currency before persisting.
  - \`ebitda_local\` and \`ebitda_local_unit\` follow the same rules; set both \`null\` when the document does not report EBITDA in local currency.
  - \`assumed_forex\` MUST be filled. Units: local currency per 1 USD (e.g. KRW 1370/USD → 1370; IDR 16100/USD → 16100). Use a rate quoted in the document if available, otherwise the period-average spot rate for that fiscal year from your training knowledge. Do not leave it null.
  - You MAY leave \`revenue_usd_mn\` and \`ebitda_usd_mn\` \`null\` when the document only reports local-currency figures. The server will derive them as \`<local_in_mn> / assumed_forex\`.
- Do NOT extract derived screening fields (any \`l0_*\`, \`l1_*\`, segment revenue ratios, priority-geo flags, drop counts, screening rationales, etc.). Those are computed downstream by the screening pipeline.

Always prioritize accuracy. Only list a company in 'companies_detected' if you are sure it matches one in the provided known list.`;

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
 */
export async function processFileContent(
  rawText: string,
  buffer: Buffer,
  contentType: string,
  userRawNotes: string,
  supabase: DbClient
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const allReferences = await getAllCompanyReferences();
  const allNames = allReferences.map(r => r.name).join(", ");

  const llm = new ChatAnthropic({
    model: "claude-sonnet-4-6",
    anthropicApiKey: apiKey,
    temperature: 0,
  });

  const agent = createAgent({
    model: llm,
    tools: [],
    systemPrompt: generateSystemPrompt(allNames, userRawNotes),
  });

  let inputs = {
    messages: [new HumanMessage(`Raw Content to process:\n\n${rawText}`)] as BaseMessage[],
  };

  let lastMessage: BaseMessage | null = null;
  let company: any = null;
  if (contentType === 'application/pdf') {
    logger.debug("📂 INVOKING FILE PROCESSING AGENT");

    const buffers = await splitPdf(buffer, 50);
    for (const buff of buffers) {
      let lastParsedContent = "";
      if (lastMessage) {
        const rawContent = typeof lastMessage.content === "string"
          ? lastMessage.content
          : JSON.stringify(lastMessage.content);
        const jsonMatch = rawContent.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            lastParsedContent = JSON.stringify(parsed);
          } catch {
            lastParsedContent = rawContent;
          }
        } else {
          lastParsedContent = rawContent;
        }
      }
      inputs = {
        messages: [new HumanMessage({
          content: [{
            type: 'text',
            text: `Analyze the following documents. This is the last state of the data. Please update: ${lastParsedContent}`,
          },
          {
            type: "file",
            source_type: "base64",
            data: buff.toString("base64"),
            mime_type: "application/pdf",
          },
          ],
        })],
      };
      const messagesList = await streamAgentMessages(agent, inputs.messages);
      lastMessage = messagesList[messagesList.length - 1];
    }
  } else {
    const messagesList = await streamAgentMessages(agent, inputs.messages);
    lastMessage = messagesList[messagesList.length - 1];
  }

  const content = typeof lastMessage?.content === "string"
    ? lastMessage?.content
    : JSON.stringify(lastMessage?.content);

  const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch && jsonMatch[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);

      const finalMatchedCompanies: any[] = [];
      let companiesDetected: string[] = Array.isArray(parsed.companies_detected)
        ? parsed.companies_detected.filter((n: unknown): n is string => typeof n === 'string' && n.length > 0)
        : [];
      if (companiesDetected.length === 0 && parsed.file_type === 'prospectus' && parsed.prospectus_summary?.target) {
        companiesDetected = [parsed.prospectus_summary.target];
      }

      for (const detectedName of companiesDetected) {
        const match = allReferences.find(r => r.name.toLowerCase() === (detectedName as string).toLowerCase());
        if (match) {
          finalMatchedCompanies.push(match);
        } else {
          if (parsed.file_type === 'prospectus') {
            const summary = parsed?.prospectus_summary ?? {};
            const insertData = {
              pipeline_stage: 'L0' as const,
              target: summary.target || null,
              thesis_content: null,
              segment: summary.segment || null,
              segment_related_offerings: summary.segment_related_offerings || null,
              company_focus: summary.company_focus || null,
              website: summary.website || null,
              watchlist_status: summary.watchlist_status || null,
              comments: summary.comments || null,
              ownership: summary.ownership || null,
              geography: summary.geography || null,
              remarks: summary.remarks || null,
              source: 'inbound' as const,
            };
            try {
              const companyRepo = new CompanyRepository(supabase);
              company = await companyRepo.insert(insertData);

              const financialRowsRaw: FinancialRow[] = Array.isArray(summary.financials)
                ? summary.financials
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

              const fxRows: FxRow[] = Array.isArray(summary.fx_adjustments)
                ? summary.fx_adjustments
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

              const financialRows = financialRowsRaw.filter((r: FinancialRow) =>
                r.revenue_usd_mn !== null || r.ebitda_usd_mn !== null || r.ev_usd_mn !== null ||
                r.ebitda_margin !== null || r.ev_ebitda !== null || r.revenue_cagr_vs_prior !== null,
              );

              if (financialRows.length > 0) {
                const financialRepo = new CompanyFinancialRepository(supabase);
                await financialRepo.bulkUpsertForCompany(company.id, financialRows);
              }

              if (fxRows.length > 0) {
                const fxRepo = new CompanyFxAdjustmentRepository(supabase);
                await fxRepo.bulkUpsertForCompany(company.id, fxRows);
              }
            } catch {
              logger.error('Error inserting companies results:');
            }
          }

          finalMatchedCompanies.push({
            id: company?.id || null,
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

      parsed.company = company;

      return parsed;
    } catch (e) {
      logger.error("Failed to parse JSON from agent response:");
      return { raw_response: content, company: company };
    }
  }

  return { raw_response: content, company: company };
}
