import type { SerializedWorkbook } from '@/lib/workbook/types';
import { serializeWorkbookFromBuffer } from '@/lib/workbook/serializeWorkbook';
import type {
  FundUpdateStructuredResult,
  ParsedAsset,
  ParsedTxn,
  ParsedValuation,
  WorkbookFallbackProposalV1,
} from '@/lib/fund_updates/types';
import { interpretWorkbook } from './interpretWorkbook';
import { planWorkbookExtraction, type ExtractionChunk } from './planWorkbookExtraction';
import { extractWorkbookChunk } from './extractWorkbookChunk';
import { mergeWorkbookExtraction } from './mergeWorkbookExtraction';
import { normalizeWorkbookExtraction } from './normalizeWorkbookExtraction';
import { validateWorkbookExtraction } from './validateWorkbookExtraction';
import { type LLMClientOverride } from './structuredOutput';
import { logger } from '../logger';

export interface FallbackOrchestrationOptions {
  buffer?: Buffer;
  workbook?: SerializedWorkbook;
  fileName?: string;
  contentType?: string;
  llmOverride?: LLMClientOverride;
  chunkSize?: number;
  maxConcurrency?: number;
  onProgress?: (stage: string, metadata?: Record<string, unknown>) => Promise<void> | void;
}

/**
 * Projects extracted workbook events and valuations into legacy ParsedAsset[] format
 * for direct company investments. Unsupported investor-to-fund events (contributions, commitments)
 * are NOT coerced into asset transactions.
 */
export function projectToLegacyAssets(
  entities: WorkbookFallbackProposalV1['entities'],
  events: WorkbookFallbackProposalV1['events'],
  valuations: WorkbookFallbackProposalV1['valuations'],
): ParsedAsset[] {
  const assetEntities = entities.filter((e) =>
    ['portfolio_company', 'fund_or_partnership_asset'].includes(e.entityType),
  );

  const assets: ParsedAsset[] = [];

  for (const ent of assetEntities) {
    const entEvents = events.filter(
      (ev) =>
        ev.toEntityRef === ent.originalName ||
        ev.toEntityRef === ent.proposalId ||
        ev.fromEntityRef === ent.originalName ||
        ev.fromEntityRef === ent.proposalId,
    );

    // Only project real portfolio asset transactions (investments, exits, divestments)
    const assetTxnEvents = entEvents.filter((ev) =>
      ['asset_investment', 'asset_follow_on_investment', 'asset_exit', 'asset_exit_distribution'].includes(
        ev.eventType,
      ),
    );

    const entVals = valuations.filter(
      (v) => v.entityRef === ent.originalName || v.entityRef === ent.proposalId,
    );

    if (assetTxnEvents.length === 0 && entVals.length === 0) continue;

    const txns: ParsedTxn[] = assetTxnEvents.map((ev) => {
      let type: ParsedTxn['type'] = 'other';
      if (ev.eventType === 'asset_investment' || ev.eventType === 'asset_follow_on_investment') {
        type = 'contribution';
      } else if (ev.eventType === 'asset_exit' || ev.eventType === 'asset_exit_distribution') {
        type = 'divestment';
      }

      return {
        date: ev.date,
        type,
        subTypeLabel: ev.sourceAction || null,
        pricePerShare: null,
        shareCount: null,
        valueAmount: ev.normalizedAmount,
        currency: ev.normalizedCurrency || '',
        fxRate: null,
        notes: null,
      };
    });

    const parsedVals: ParsedValuation[] = entVals.map((v) => ({
      asOfDate: v.asOfDate,
      periodLabel: v.asOfDate ? v.asOfDate.substring(0, 7) : '',
      marketValue: v.normalizedMarketValue,
      pricePerShare: v.pricePerShare ?? null,
      sharesOutstanding: v.sharesOutstanding ?? null,
      shareholdingPct: v.shareholdingPct ?? null,
      investedCapitalCum: v.investedCapitalCum ?? null,
      grossMoic: v.grossMoic ?? null,
      grossXirr: v.grossXirr ?? null,
      valuationMethod: (v.valuationMethod as any) || 'other',
      notes: v.notes ?? null,
    }));

    const fundName = assetTxnEvents[0]?.relatedFundRef || null;
    const isFoF = ent.entityType === 'fund_or_partnership_asset';

    assets.push({
      code: ent.proposalId,
      name: ent.originalName,
      legalName: ent.englishName || null,
      country: null,
      investmentTypeLabel: isFoF ? 'Fund of Funds' : 'Direct Investments',
      assetType: isFoF ? 'fund_of_funds' : 'direct_investment',
      fund: fundName || '',
      entity: null,
      fundingSource: null,
      fundingSourceRaw: null,
      entryDate: txns[0]?.date || null,
      stakePct: null,
      commitmentAmount: null,
      dealType: null,
      mgmtFeeRatePct: null,
      sector: null,
      subSector: null,
      instrument: null,
      sharesOutstanding: null,
      sourceRef: null,
      vintageYear: null,
      valuations: parsedVals,
      currentPricePerShare: null,
      txns,
    });
  }

  return assets;
}

/**
 * Orchestrates multi-step workbook fallback extraction:
 * 1. Lossless workbook serialization
 * 2. Layout & currency interpretation
 * 3. Planning & bounded chunk creation
 * 4. Parallel chunk extraction with bounded concurrency
 * 5. Deterministic merging & deduplication
 * 6. Deterministic currency/unit arithmetic and date normalization
 * 7. Row accounting and summary reconciliation validation
 * 8. Assembly of versioned proposal (WorkbookFallbackProposalV1)
 */
export async function orchestrateWorkbookFallback(
  options: FallbackOrchestrationOptions,
): Promise<FundUpdateStructuredResult> {
  const {
    buffer,
    workbook: inputWorkbook,
    fileName = 'workbook.xlsx',
    llmOverride,
    chunkSize,
    maxConcurrency = 2,
    onProgress,
  } = options;

  logger.info(`🚀 Starting multi-step workbook fallback for "${fileName}"`);

  if (!inputWorkbook && !buffer) {
    throw new Error('orchestrateWorkbookFallback requires either a workbook or a buffer');
  }

  // Step 1: Serialize workbook
  await onProgress?.('serializing_workbook', { fileName });
  const serializedWb: SerializedWorkbook = inputWorkbook
    ? inputWorkbook
    : await serializeWorkbookFromBuffer(buffer, fileName);

  // Step 2: Interpret workbook
  await onProgress?.('interpreting_workbook', {
    sheetCount: serializedWb.sheets.length,
  });
  const interpretation = await interpretWorkbook({
    workbook: serializedWb,
    llmOverride,
  });

  // Step 3: Plan chunk extraction
  await onProgress?.('planning_extraction', {
    tableCount: interpretation.tables.length,
  });
  const plan = planWorkbookExtraction(serializedWb, interpretation, chunkSize);

  logger.info(
    `📋 Extraction plan: ${plan.totalDataRows} data rows across ${plan.chunks.length} chunks`,
  );

  // Step 4: Extract chunks with bounded concurrency
  await onProgress?.('extracting_chunks', {
    totalChunks: plan.chunks.length,
    totalRows: plan.totalDataRows,
  });

  const chunkResults: any[] = [];
  // Execute chunks in batches of maxConcurrency
  for (let i = 0; i < plan.chunks.length; i += maxConcurrency) {
    const batch = plan.chunks.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map((chunk) => extractWorkbookChunk({ chunk, llmOverride })),
    );
    chunkResults.push(...batchResults);
    await onProgress?.('chunk_progress', {
      completedChunks: Math.min(i + maxConcurrency, plan.chunks.length),
      totalChunks: plan.chunks.length,
    });
  }

  // Step 5: Merge extraction results with source-qualified plan rows
  await onProgress?.('merging_results');
  const merged = mergeWorkbookExtraction(chunkResults, plan.plannedRows);

  // Step 6: Code-level currency & unit normalization
  await onProgress?.('normalizing_data');
  const normalized = normalizeWorkbookExtraction(merged, interpretation);

  // Step 7: Deterministic validation and reconciliation
  await onProgress?.('validating_results');
  const { validation, reconciliation } = validateWorkbookExtraction(normalized, interpretation);

  // Step 8: Build proposal
  const legacyAssets = projectToLegacyAssets(
    normalized.entities,
    normalized.events,
    normalized.valuations,
  );

  let directCount = 0;
  let fundOfFundsCount = 0;
  let txnCnt = 0;
  let valCnt = 0;
  for (const a of legacyAssets) {
    if (a.assetType === 'fund_of_funds') fundOfFundsCount++;
    else directCount++;
    txnCnt += a.txns.length;
    valCnt += a.valuations.length;
  }

  const v1Proposal: WorkbookFallbackProposalV1 = {
    template_id: 'workbook_fallback_v1',
    schema_version: 'workbook_fallback_v1',
    stats: {
      asset_count: legacyAssets.length,
      direct_count: directCount,
      fund_of_funds_count: fundOfFundsCount,
      transaction_count: txnCnt,
      valuation_count: valCnt,
      total_data_rows: plan.totalDataRows,
      parsed_rows_count: normalized.rowAccounting.parsedRows.length,
      excluded_rows_count: normalized.rowAccounting.excludedRows.length,
      ambiguous_rows_count: normalized.rowAccounting.ambiguousRows.length,
      coverage_pct: normalized.rowAccounting.coveragePct,
      entity_count: normalized.entities.length,
      event_count: normalized.events.length,
    },
    entities: normalized.entities,
    events: normalized.events,
    valuations: normalized.valuations,
    row_accounting: normalized.rowAccounting,
    interpretation,
    warnings: [...normalized.warnings, ...validation.warnings],
    reconciliation,
    validation,
    assets: legacyAssets,
  };

  const detectedFunds = [...new Set(normalized.events.map((e) => e.relatedFundRef).filter(Boolean))];
  const detectedEntities = normalized.entities.map((e) => e.originalName);

  const summary = `Extracted ${normalized.events.length} financial events across ${normalized.entities.length} entities (${normalized.rowAccounting.parsedRows.length}/${plan.totalDataRows} rows, ${normalized.rowAccounting.coveragePct}% coverage).`;

  return {
    file_type: 'fund_updates',
    parser: 'workbook_fallback_v1',
    summary,
    key_points: [
      `Coverage: ${normalized.rowAccounting.parsedRows.length} parsed, ${normalized.rowAccounting.excludedRows.length} excluded, ${normalized.rowAccounting.ambiguousRows.length} ambiguous of ${plan.totalDataRows} rows`,
      `Entities: ${normalized.entities.length} distinct entities detected`,
      `Events: ${normalized.events.length} total events (${Object.entries(validation.stats.eventCounts).map(([k, v]) => `${k}: ${v}`).join(', ')})`,
    ],
    action_items: validation.isReviewable
      ? ['Review proposed entities and events before applying to fund ledgers.']
      : [`Needs attention: ${validation.hardFailures.join('; ')}`],
    tags: ['Fund Update', ...detectedFunds.slice(0, 5) as string[]],
    companies_detected: detectedEntities.slice(0, 20),
    company_notes: [],
    file_date: null,
    suggested_track_ids: [],
    matched_companies: [],
    fund_update_proposal: v1Proposal,
  };
}
