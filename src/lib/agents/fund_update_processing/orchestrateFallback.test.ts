import { describe, expect, it, vi } from 'vitest';
import { orchestrateWorkbookFallback, projectToLegacyAssets } from './orchestrateFallback';
import type { SerializedWorkbook } from '@/lib/workbook/types';
import type { WorkbookFallbackProposalV1 } from '@/lib/fund_updates/types';

describe('orchestrateWorkbookFallback', () => {
  const mockWorkbook: SerializedWorkbook = {
    fileName: 'fund_investments.xlsx',
    sheets: [
      {
        name: '投资明细',
        id: 1,
        rowCount: 4,
        columnCount: 5,
        nonEmptyRowCount: 4,
        mergedRanges: [],
        rows: [
          {
            rowNumber: 1,
            cells: {},
            rawValues: ['项目名称', '投资日期', '投资金额（万元）', '业务性质'],
            formattedValues: ['项目名称', '投资日期', '投资金额（万元）', '业务性质'],
            hasContent: true,
          },
          {
            rowNumber: 2,
            cells: {},
            rawValues: ['Alpha Tech', '2024-01-10', 500, '投资'],
            formattedValues: ['Alpha Tech', '2024-01-10', '500', '投资'],
            hasContent: true,
          },
          {
            rowNumber: 3,
            cells: {},
            rawValues: ['Beta Bio', '2024-02-15', 300, '投资'],
            formattedValues: ['Beta Bio', '2024-02-15', '300', '投资'],
            hasContent: true,
          },
          {
            rowNumber: 4,
            cells: {},
            rawValues: ['Gamma AI', '2024-03-01', 200, '投资'],
            formattedValues: ['Gamma AI', '2024-03-01', '200', '投资'],
            hasContent: true,
          },
          {
            rowNumber: 5,
            cells: {},
            rawValues: ['Delta Robotics', '2024-04-10', 400, '投资'],
            formattedValues: ['Delta Robotics', '2024-04-10', '400', '投资'],
            hasContent: true,
          },
          {
            rowNumber: 6,
            cells: {},
            rawValues: ['合计', '', 1400, ''],
            formattedValues: ['合计', '', '1400', ''],
            hasContent: true,
          },
        ],
      },
    ],
  };

  it('runs complete multi-step fallback extraction and builds v1 proposal', async () => {
    let callCount = 0;
    const mockLlm = {
      withStructuredOutput: vi.fn().mockImplementation(() => ({
        invoke: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // Step 1: Interpretation
            return {
              detectedLanguages: ['zh'],
              workbookPurpose: 'Direct Investment Ledger',
              tables: [
                {
                  tableId: 'table_1',
                  sheetName: '投资明细',
                  purpose: 'event_ledger',
                  headerRows: [1],
                  dataStartRow: 2,
                  dataEndRow: 6,
                  columns: [],
                  confidence: 0.95,
                },
              ],
              glossary: [],
              currencies: [
                {
                  sourceCurrency: 'CNY',
                  sourceUnit: '万元',
                  multiplier: 10000,
                  evidence: { sheet: '投资明细', text: '投资金额（万元）' },
                },
              ],
              summaryTables: [],
              warnings: [],
            };
          }

          // Step 2: Chunk extraction
          return {
            entities: [
              {
                proposalId: 'temp_1',
                entityType: 'portfolio_company',
                originalName: 'Alpha Tech',
              },
              {
                proposalId: 'temp_2',
                entityType: 'portfolio_company',
                originalName: 'Beta Bio',
              },
              {
                proposalId: 'temp_3',
                entityType: 'portfolio_company',
                originalName: 'Gamma AI',
              },
              {
                proposalId: 'temp_4',
                entityType: 'portfolio_company',
                originalName: 'Delta Robotics',
              },
            ],
            events: [
              {
                proposalId: 'evt_1',
                eventType: 'asset_investment',
                cashFlowDirection: 'out_of_fund',
                fromEntityRef: 'Fund I',
                toEntityRef: 'Alpha Tech',
                relatedFundRef: 'Fund I',
                date: '2024-01-10',
                sourceAmount: 500,
                sourceCurrency: 'CNY',
                sourceUnit: '万元',
                amountMultiplier: 10000,
                sourceAction: '投资',
                sourceLocation: { sheet: '投资明细', row: 2 },
                warnings: [],
              },
              {
                proposalId: 'evt_2',
                eventType: 'asset_investment',
                cashFlowDirection: 'out_of_fund',
                fromEntityRef: 'Fund I',
                toEntityRef: 'Beta Bio',
                relatedFundRef: 'Fund I',
                date: '2024-02-15',
                sourceAmount: 300,
                sourceCurrency: 'CNY',
                sourceUnit: '万元',
                amountMultiplier: 10000,
                sourceAction: '投资',
                sourceLocation: { sheet: '投资明细', row: 3 },
                warnings: [],
              },
              {
                proposalId: 'evt_3',
                eventType: 'asset_investment',
                cashFlowDirection: 'out_of_fund',
                fromEntityRef: 'Fund I',
                toEntityRef: 'Gamma AI',
                relatedFundRef: 'Fund I',
                date: '2024-03-01',
                sourceAmount: 200,
                sourceCurrency: 'CNY',
                sourceUnit: '万元',
                amountMultiplier: 10000,
                sourceAction: '投资',
                sourceLocation: { sheet: '投资明细', row: 4 },
                warnings: [],
              },
              {
                proposalId: 'evt_4',
                eventType: 'asset_investment',
                cashFlowDirection: 'out_of_fund',
                fromEntityRef: 'Fund I',
                toEntityRef: 'Delta Robotics',
                relatedFundRef: 'Fund I',
                date: '2024-04-10',
                sourceAmount: 400,
                sourceCurrency: 'CNY',
                sourceUnit: '万元',
                amountMultiplier: 10000,
                sourceAction: '投资',
                sourceLocation: { sheet: '投资明细', row: 5 },
                warnings: [],
              },
            ],
            valuations: [],
            parsedRows: [2, 3, 4, 5],
            excludedRows: [{ row: 6, reason: 'Total row' }],
            ambiguousRows: [],
            warnings: [],
          };
        }),
      })),
    };

    const progressStages: string[] = [];
    const res = await orchestrateWorkbookFallback({
      workbook: mockWorkbook,
      fileName: 'fund_investments.xlsx',
      llmOverride: mockLlm,
      onProgress: (stage) => {
        progressStages.push(stage);
      },
    });

    expect(progressStages).toContain('interpreting_workbook');
    expect(progressStages).toContain('extracting_chunks');
    expect(progressStages).toContain('normalizing_data');
    expect(progressStages).toContain('validating_results');

    expect(res.parser).toBe('workbook_fallback_v1');
    expect(res.fund_update_proposal).toBeDefined();

    const proposal = res.fund_update_proposal as WorkbookFallbackProposalV1;
    expect(proposal.schema_version).toBe('workbook_fallback_v1');
    expect(proposal.entities).toHaveLength(4);
    expect(proposal.events).toHaveLength(4);
    expect(proposal.events[0].normalizedAmount).toBe(5000000); // 500 * 10000
    expect(proposal.events[1].normalizedAmount).toBe(3000000); // 300 * 10000
    expect(proposal.row_accounting.parsedRows).toEqual([2, 3, 4, 5]);
    expect(proposal.row_accounting.excludedRows).toEqual([
      { sheet: '投资明细', tableId: 'table_1', row: 6, reason: 'Total row' },
    ]);
    expect(proposal.validation.isReviewable).toBe(true);

    // Backward compatibility projection
    expect(proposal.assets).toHaveLength(4);
    expect(proposal.assets[0].name).toBe('Alpha Tech');
    expect(proposal.assets[0].txns[0].valueAmount).toBe(5000000);
  });
});
