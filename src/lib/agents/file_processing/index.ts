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
import { CompanyFinancialRepository, CompanyRepository } from "@/lib/repositories";

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
    "segment": "...",
    "target": "Hidden company name. Please search for the company name in the known companies list or inside the document.",
    "segment_related_offerings": "...",
    "company_focus": "...",
    "website": "...",
    "watchlist_status": "...",
    "comments": "...",
    "ownership": "...",
    "geography": "country name",
    "revenue_2021_usd_mn": <numeric>,
    "revenue_2022_usd_mn": <numeric>,
    "revenue_2023_usd_mn": <numeric>,
    "revenue_2024_usd_mn": <numeric>,
    "ebitda_2021_usd_mn": <numeric>,
    "ebitda_2022_usd_mn": <numeric>,
    "ebitda_2023_usd_mn": <numeric>,
    "ebitda_2024_usd_mn": <numeric>,
    "ev_2024": <numeric>,
    "revenue_cagr_2021_2022": <numeric>,
    "revenue_cagr_2022_2023": <numeric>,
    "revenue_cagr_2023_2024": <numeric>,
    "ebitda_margin_2021": <numeric>,
    "ebitda_margin_2022": <numeric>,
    "ebitda_margin_2023": <numeric>,
    "ebitda_margin_2024": <numeric>,
    "ev_ebitda_2024": <numeric>,
    "segment_revenue": <numeric>,
    "segment_ebitda": <numeric>,
    "segment_revenue_total_ratio": <numeric>,
    "l0_ebitda_2024_usd_mn": <numeric>,
    "l0_ev_2024_usd_mn": <numeric>,
    "l0_revenue_2024_usd_mn": <numeric>,
    "l0_ev_ebitda_2024": <numeric>,
    "segment_specific_revenue_pct": <numeric>,
    "combined_segment_revenue": "...",
    "revenue_from_priority_geo_flag": "...",
    "pct_from_domestic": <numeric>,
    "l0_ev_usd_mn": <numeric>,
    "l1_revenue_cagr_l3y": <numeric>,
    "l1_revenue_drop_count": <numeric>,
    "l1_ebitda_below_threshold_count": <numeric>,
    "l1_revenue_cagr_n3y": <numeric>,
    "l1_vision_fit": "...",
    "l1_priority_geo_flag": "...",
    "l1_ev_below_threshold": "...",
    "l1_rationale": "...",
    "l1_revenue_no_consecutive_drop_usd": "...",
    "fx_revenue_2021": <numeric>,
    "fx_revenue_2022": <numeric>,
    "fx_revenue_2023": <numeric>,
    "fx_revenue_2024": <numeric>,
    "fx_currency": "...",
    "fx_assumed_forex_2021": <numeric>,
    "fx_assumed_forex_2022": <numeric>,
    "fx_assumed_forex_2023": <numeric>,
    "fx_assumed_forex_2024": <numeric>,
    "fx_forex_change_2021_2022": <numeric>,
    "fx_forex_change_2022_2023": <numeric>,
    "fx_forex_change_2023_2024": <numeric>,
    "fx_revenue_cagr_domestic_2021_2022": <numeric>,
    "fx_revenue_cagr_domestic_2022_2023": <numeric>,
    "fx_revenue_cagr_domestic_2023_2024": <numeric>,
    "fx_revenue_drop_count": <numeric>,
    "fx_revenue_no_consecutive_drop_local": "...",
    "fx_rationale": "...",
    "fx_ebitda_above_10_l3y": "..."
  }
}
\`\`\`

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
              ownership: summary.ownership || null,
              geography: summary.geography || null,
              remarks: summary.remarks || null,
              source: 'inbound' as const,
            };
            try {
              const companyRepo = new CompanyRepository(supabase);
              company = await companyRepo.insert(insertData);
              const financialRepo = new CompanyFinancialRepository(supabase);
              const financialRows = [
                { fiscal_year: 2021, revenue_usd_mn: summary.revenue_2021_usd_mn ?? null, ebitda_usd_mn: summary.ebitda_2021_usd_mn ?? null, ev_usd_mn: null, ebitda_margin: summary.ebitda_margin_2021 ?? null, ev_ebitda: null, revenue_cagr_vs_prior: null },
                { fiscal_year: 2022, revenue_usd_mn: summary.revenue_2022_usd_mn ?? null, ebitda_usd_mn: summary.ebitda_2022_usd_mn ?? null, ev_usd_mn: null, ebitda_margin: summary.ebitda_margin_2022 ?? null, ev_ebitda: null, revenue_cagr_vs_prior: summary.revenue_cagr_2021_2022 ?? null },
                { fiscal_year: 2023, revenue_usd_mn: summary.revenue_2023_usd_mn ?? null, ebitda_usd_mn: summary.ebitda_2023_usd_mn ?? null, ev_usd_mn: null, ebitda_margin: summary.ebitda_margin_2023 ?? null, ev_ebitda: null, revenue_cagr_vs_prior: summary.revenue_cagr_2022_2023 ?? null },
                { fiscal_year: 2024, revenue_usd_mn: summary.revenue_2024_usd_mn ?? null, ebitda_usd_mn: summary.ebitda_2024_usd_mn ?? null, ev_usd_mn: summary.ev_2024 ?? null, ebitda_margin: summary.ebitda_margin_2024 ?? null, ev_ebitda: summary.ev_ebitda_2024 ?? null, revenue_cagr_vs_prior: summary.revenue_cagr_2023_2024 ?? null },
              ].filter((r) =>
                r.revenue_usd_mn !== null || r.ebitda_usd_mn !== null || r.ev_usd_mn !== null ||
                r.ebitda_margin !== null || r.ev_ebitda !== null || r.revenue_cagr_vs_prior !== null,
              );
              if (financialRows.length > 0) {
                await financialRepo.bulkUpsertForCompany(company.id, financialRows);
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
