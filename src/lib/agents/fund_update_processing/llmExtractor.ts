import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { createAgent } from 'langchain';
import { getLangfuseCallbacks } from '@/lib/langfuse';
import { logger } from '../logger';
import type { ParsedAsset, TxnTypeEnum, ValuationMethodEnum } from '@/lib/fund_updates/parsers/startech_quarterly';
import { normalizeParsedAssets } from '@/lib/fund_updates/normalizeParsedAsset';

const FILES_API_BETA = 'files-api-2025-04-14' as const;

export interface ExtractedFundUpdateProposal {
  assets: any[];
}

const SYSTEM_PROMPT = `You are a specialized Fund Management Data Extraction Assistant. Your task is to extract portfolio asset information, transactions, and valuations from the provided fund update document (like a quarterly NAV pack, capital account statement, or portfolio update).

## Objectives:
1. **Identify Portfolio Assets**: Identify all distinct companies or assets being reported on in the document.
2. **Extract Transactions**: Extract any cash flows (contributions, distributions, dividends, etc.) associated with each asset.
3. **Extract Valuations**: Extract the market value, cost, share count, price per share, and valuation methodology for each asset at specific as-of dates.
4. **Format as Structured JSON**: Transform the extracted data into a highly structured JSON array of assets.

## Process:
1. **Create an entry for each asset**.
2. **Extract Asset Metadata**:
   - name: The human-readable name of the asset/company.
   - code: A stable, unique identifier (like a ticker, sheet code, or a slug derived from the name if none exists).
   - legalName: The formal legal entity name, if present.
   - country: The country of the asset.
   - investmentTypeLabel: Either "Direct Investments" or "Fund of Funds". Guess based on context if not explicit.
   - assetType: Must be strictly "direct_investment" or "fund_of_funds".
   - entity: The investment holding entity or fund vehicle that owns the asset.
   - fund: The name of the fund that holds the asset, if stated. Do not invent a catalog name.
   - entryDate: The date of the initial investment (YYYY-MM-DD), if stated.
   - stakePct: The percentage ownership (e.g. 14.5 for 14.5%).
   - sector, subSector, instrument, sharesOutstanding, vintageYear: Optional metadata.
3. **Extract Valuations (Market Value Tracker)**:
   - For each asset, extract an array of valuations (historical and current).
   - asOfDate: The date of the valuation (YYYY-MM-DD).
   - marketValue: The gross market value.
   - pricePerShare: Price per share.
   - sharesOutstanding: Total shares outstanding for the asset.
   - shareholdingPct: Ownership percentage at the time.
   - investedCapitalCum: Cumulative cost/invested capital.
   - grossMoic: Multiple on invested capital.
   - grossXirr: IRR.
   - valuationMethod: Must be one of: "at_cost", "fundraise_round", "secondary_sale", "stock_market_price", "comparables", "capital_account_statement", "other".
4. **Extract Transactions**:
   - date: Transaction date (YYYY-MM-DD).
   - type: Must be one of: "contribution", "divestment", "interest_income", "return_of_capital", "other". Proceeds returned to investors are "divestment" (the caller records them as distributed to the investor).
   - valueAmount: The absolute amount (always positive) in the transaction currency.
   - currency: 3-letter currency code (e.g. USD, SGD, IDR).
   - pricePerShare, shareCount: Details if applicable.

## Rules:
- **Never invent numbers.** If a field is not present in the document, use \`null\`.
- Prefer partial asset extraction over omitting an asset entirely. Omit txns/vals arrays if none are found for an asset.
- For dates, strictly use YYYY-MM-DD format. If only a month/year is given, assume the last day of the month.
- Ensure all numbers are clean numerics (not strings with commas).
- Output must be a valid JSON block containing an object with an "assets" array.

## Output Format:
Your response should end with a JSON block in this format:
\`\`\`json
{
  "assets": [
    {
      "code": "ACME",
      "name": "Acme Corp",
      "legalName": "Acme Corporation Inc.",
      "country": "USA",
      "investmentTypeLabel": "Direct Investments",
      "assetType": "direct_investment",
      "entity": "Meranti Global Investment Ltd",
      "entryDate": "2022-05-15",
      "stakePct": 15.0,
      "sector": "Tech",
      "subSector": "SaaS",
      "instrument": "Preferred Shares",
      "sharesOutstanding": 1000000,
      "vintageYear": 2022,
      "valuations": [
        {
          "asOfDate": "2024-03-31",
          "marketValue": 5000000,
          "pricePerShare": 5.0,
          "sharesOutstanding": 1000000,
          "shareholdingPct": 15.0,
          "investedCapitalCum": 3000000,
          "grossMoic": 1.67,
          "grossXirr": 0.25,
          "valuationMethod": "comparables",
          "notes": "Based on peer multiples"
        }
      ],
      "txns": [
        {
          "date": "2022-05-15",
          "type": "contribution",
          "subTypeLabel": "Initial Investment",
          "pricePerShare": 3.0,
          "shareCount": 1000000,
          "valueAmount": 3000000,
          "currency": "USD",
          "fxRate": 1.0,
          "notes": null
        }
      ]
    }
  ]
}
\`\`\`
`;

async function streamAgentMessages(
  agent: ReturnType<typeof createAgent>,
  messages: BaseMessage[],
): Promise<BaseMessage[]> {
  let finalMessages: BaseMessage[] = [];
  const stream = await agent.stream(
    { messages } as any,
    { streamMode: 'values', callbacks: getLangfuseCallbacks() } as any,
  );
  for await (const chunk of stream as AsyncIterable<{ messages?: BaseMessage[] }>) {
    if (chunk?.messages) {
      finalMessages = chunk.messages;
    }
  }
  return finalMessages;
}

export async function extractFundUpdateProposal(
  rawText: string,
  buffer: Buffer,
  contentType: string,
  fileName?: string,
): Promise<{ assets: ParsedAsset[] } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const llm = new ChatAnthropic({
    model: 'claude-sonnet-5',
    anthropicApiKey: apiKey,
    betas: [FILES_API_BETA],
    temperature: undefined,
    maxTokens: 32000,
    streaming: true,
    // Anthropic defaults to high effort when output_config is omitted; low effort is sufficient for field extraction from known layout.
    outputConfig: { effort: 'low' },
  });

  const anthropic = new Anthropic({ apiKey });

  const agent = createAgent({
    model: llm,
    tools: [],
    systemPrompt: SYSTEM_PROMPT,
  });

  const fileNamePrefix = fileName ? `Filename: ${fileName}\n\n` : '';
  let inputs = {
    messages: [
      new HumanMessage(`${fileNamePrefix}Raw Content to process:\n\n${rawText}`),
    ] as BaseMessage[],
  };

  let lastMessage: BaseMessage | null = null;
  if (contentType === 'application/pdf') {
    logger.info('📂 INVOKING FUND UPDATE LLM EXTRACTOR (PDF)');
    const uploaded = await anthropic.beta.files.upload({
      file: await toFile(buffer, 'document.pdf', { type: 'application/pdf' }),
      betas: [FILES_API_BETA],
    });

    try {
      inputs = {
        messages: [
          new HumanMessage({
            content: [
              {
                type: 'text',
                text: fileName
                  ? `Filename: ${fileName}\n\nAnalyze the following document.`
                  : 'Analyze the following document.',
              },
              {
                type: 'file',
                fileId: uploaded.id,
              },
            ],
          }),
        ],
      };
      const messagesList = await streamAgentMessages(agent, inputs.messages);
      lastMessage = messagesList[messagesList.length - 1];
    } finally {
      try {
        await anthropic.beta.files.delete(uploaded.id, { betas: [FILES_API_BETA] });
      } catch (err) {
        logger.warn(`Failed to delete uploaded file ${uploaded.id}: ${err}`);
      }
    }
  } else {
    logger.info('📂 INVOKING FUND UPDATE LLM EXTRACTOR (TEXT)');
    const messagesList = await streamAgentMessages(agent, inputs.messages);
    lastMessage = messagesList[messagesList.length - 1];
  }

  const content =
    typeof lastMessage?.content === 'string'
      ? lastMessage?.content
      : JSON.stringify(lastMessage?.content);

  const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
  if (!jsonMatch || !jsonMatch[1]) {
    logger.error('No JSON block found in fund update agent response');
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]) as ExtractedFundUpdateProposal;
    if (!parsed || !Array.isArray(parsed.assets)) return null;

    const parseNum = (val: any) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        const parsed = Number(val.replace(/,/g, ''));
        if (!isNaN(parsed)) return parsed;
      }
      return null;
    };
    
    const parseDate = (val: any) => {
      if (typeof val !== 'string') return null;
      const match = val.match(/^\d{4}-\d{2}-\d{2}$/);
      return match ? match[0] : null;
    };

    // Post-process rules
    const assets: ParsedAsset[] = parsed.assets.map((a: any, idx: number) => {
      const name = a.name && typeof a.name === 'string' ? a.name.trim() : `Unknown Asset ${idx + 1}`;
      let code = a.code && typeof a.code === 'string' ? a.code.trim() : '';
      if (!code) code = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!code) code = `asset_${idx + 1}`;
      
      const valuations = Array.isArray(a.valuations) ? a.valuations.map((v: any) => {
        let valuationMethod = v.valuationMethod as ValuationMethodEnum | null;
        if (!['at_cost', 'fundraise_round', 'secondary_sale', 'stock_market_price', 'comparables', 'capital_account_statement', 'other'].includes(valuationMethod || '')) {
            valuationMethod = 'other';
        }

        const asOfDate = parseDate(v.asOfDate);
        return {
            asOfDate,
            periodLabel: asOfDate ? asOfDate.substring(0, 7) : '',
            marketValue: parseNum(v.marketValue),
            pricePerShare: parseNum(v.pricePerShare),
            sharesOutstanding: parseNum(v.sharesOutstanding),
            shareholdingPct: parseNum(v.shareholdingPct),
            investedCapitalCum: parseNum(v.investedCapitalCum),
            grossMoic: parseNum(v.grossMoic),
            grossXirr: parseNum(v.grossXirr),
            valuationMethod: valuationMethod,
            notes: v.notes || null,
            dataStatus: 'needs_verification' as const,
        }
      }).filter((v: any) => v.asOfDate) : [];

      let currentPricePerShare = null;
      if (valuations.length > 0) {
        const sorted = [...valuations].sort((a, b) => a.asOfDate > b.asOfDate ? 1 : -1);
        const latest = sorted[sorted.length - 1];
        currentPricePerShare = latest.pricePerShare;
      }

      const txns = Array.isArray(a.txns) ? a.txns.map((t: any) => {
        const rawType = (t.type as string) === 'distribution' ? 'divestment' : t.type;
        let type = rawType as TxnTypeEnum;
        if (!['contribution', 'divestment', 'interest_income', 'return_of_capital', 'other'].includes(type)) {
            type = 'other';
        }

        const sellProceedsDestination =
          type === 'divestment'
            ? (t.sellProceedsDestination === 'cash_in_fund' || t.sellProceedsDestination === 'distributed_to_investor'
                ? t.sellProceedsDestination
                : 'distributed_to_investor')
            : null;

        return {
            date: parseDate(t.date),
            type: type,
            subTypeLabel: t.subTypeLabel || null,
            pricePerShare: parseNum(t.pricePerShare),
            shareCount: parseNum(t.shareCount),
            valueAmount: parseNum(t.valueAmount),
            currency: t.currency || 'USD',
            fxRate: parseNum(t.fxRate),
            sellProceedsDestination,
            notes: t.notes || null,
            dataStatus: 'needs_verification' as const,
        }
      }).filter((t: any) => t.date) : [];

      const assetType = a.assetType === 'fund_of_funds' ? 'fund_of_funds' : 'direct_investment';
      const investmentTypeLabel = assetType === 'fund_of_funds' ? 'Fund of Funds' : 'Direct Investments';
      const fundName =
        typeof a.fund === 'string' && a.fund.trim()
          ? a.fund.trim()
          : typeof a.entity === 'string' && a.entity.trim()
            ? a.entity.trim()
            : '';

      return {
        code,
        name,
        legalName: a.legalName || null,
        country: a.country || null,
        investmentTypeLabel,
        assetType,
        fund: fundName,
        entity: a.entity || null,
        fundingSource: a.fundingSource || null,
        fundingSourceRaw: a.fundingSourceRaw || a.fundingSource || null,
        entryDate: parseDate(a.entryDate),
        stakePct: parseNum(a.stakePct),
        commitmentAmount: parseNum(a.commitmentAmount),
        dealType: a.dealType || null,
        mgmtFeeRatePct: parseNum(a.mgmtFeeRatePct),
        sector: a.sector || null,
        subSector: a.subSector || null,
        instrument: a.instrument || null,
        sharesOutstanding: parseNum(a.sharesOutstanding),
        sourceRef: null,
        vintageYear: parseNum(a.vintageYear),
        valuations,
        currentPricePerShare,
        txns,
      } as ParsedAsset;
    });

    return { assets: normalizeParsedAssets(assets) };
  } catch (err) {
    logger.error('Failed to parse JSON from fund update agent response: ' + err);
    return null;
  }
}
