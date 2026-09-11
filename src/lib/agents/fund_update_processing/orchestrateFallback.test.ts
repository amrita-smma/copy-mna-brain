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

  describe('projectToLegacyAssets', () => {
    it('projects all four supported event types into asset transactions with correct types', () => {
      const entities: WorkbookFallbackProposalV1['entities'] = [
        { proposalId: 'ent-1', entityType: 'portfolio_company', originalName: 'Alpha Tech', aliases: [], sourceLocations: [], warnings: [] },
      ];
      const events: WorkbookFallbackProposalV1['events'] = [
        {
          proposalId: 'ev-1',
          eventType: 'asset_investment',
          toEntityRef: 'ent-1',
          relatedFundRef: 'Fund Alpha',
          date: '2023-01-15',
          normalizedAmount: 1000000,
          normalizedCurrency: 'USD',
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
        {
          proposalId: 'ev-2',
          eventType: 'asset_follow_on_investment',
          toEntityRef: 'ent-1',
          relatedFundRef: 'Fund Alpha',
          date: '2023-06-20',
          normalizedAmount: 500000,
          normalizedCurrency: 'USD',
          sourceLocation: { sheet: 'Sheet1', row: 3 },
          warnings: [],
        },
        {
          proposalId: 'ev-3',
          eventType: 'asset_exit',
          fromEntityRef: 'ent-1',
          relatedFundRef: 'Fund Alpha',
          date: '2023-11-01',
          normalizedAmount: 800000,
          normalizedCurrency: 'USD',
          sourceLocation: { sheet: 'Sheet1', row: 4 },
          warnings: [],
        },
        {
          proposalId: 'ev-4',
          eventType: 'asset_exit_distribution',
          fromEntityRef: 'ent-1',
          relatedFundRef: 'Fund Alpha',
          date: '2023-12-15',
          normalizedAmount: 400000,
          normalizedCurrency: 'USD',
          sourceLocation: { sheet: 'Sheet1', row: 5 },
          warnings: [],
        },
      ];

      const assets = projectToLegacyAssets(entities, events, []);

      expect(assets).toHaveLength(1);
      const asset = assets[0];
      expect(asset.code).toBe('ent-1');
      expect(asset.name).toBe('Alpha Tech');
      expect(asset.assetType).toBe('direct_investment');
      expect(asset.investmentTypeLabel).toBe('Direct Investments');
      expect(asset.fund).toBe('Fund Alpha');
      expect(asset.txns).toHaveLength(4);

      expect(asset.txns[0]).toMatchObject({
        date: '2023-01-15',
        type: 'contribution',
        valueAmount: 1000000,
        currency: 'USD',
        sellProceedsDestination: null,
      });
      expect(asset.txns[1]).toMatchObject({
        date: '2023-06-20',
        type: 'contribution',
        valueAmount: 500000,
        currency: 'USD',
        sellProceedsDestination: null,
      });
      expect(asset.txns[2]).toMatchObject({
        date: '2023-11-01',
        type: 'divestment',
        valueAmount: 800000,
        currency: 'USD',
        sellProceedsDestination: 'distributed_to_investor',
      });
      expect(asset.txns[3]).toMatchObject({
        date: '2023-12-15',
        type: 'divestment',
        valueAmount: 400000,
        currency: 'USD',
        sellProceedsDestination: 'distributed_to_investor',
      });
    });

    it('projects fund_or_partnership_asset as fund_of_funds asset type', () => {
      const entities: WorkbookFallbackProposalV1['entities'] = [
        { proposalId: 'ent_1', entityType: 'fund', originalName: 'Master Fund', aliases: [], sourceLocations: [], warnings: [] },
        { proposalId: 'fof-1', entityType: 'fund_or_partnership_asset', originalName: 'Target Fund LP', aliases: [], sourceLocations: [], warnings: [] },
      ];
      const events: WorkbookFallbackProposalV1['events'] = [
        {
          proposalId: 'ev-1',
          eventType: 'asset_investment',
          toEntityRef: 'fof-1',
          relatedFundRef: 'ent_1',
          date: '2023-03-01',
          normalizedAmount: 2000000,
          normalizedCurrency: 'USD',
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
      ];

      const assets = projectToLegacyAssets(entities, events, []);

      expect(assets).toHaveLength(1);
      expect(assets[0].assetType).toBe('fund_of_funds');
      expect(assets[0].investmentTypeLabel).toBe('Fund of Funds');
      expect(assets[0].name).toBe('Target Fund LP');
      expect(assets[0].fund).toBe('Master Fund');
      expect(assets[0].fund).not.toBe('ent_1');
    });

    it('projects valuations for portfolio companies and fund of funds', () => {
      const entities: WorkbookFallbackProposalV1['entities'] = [
        { proposalId: 'ent-1', entityType: 'portfolio_company', originalName: 'Bio Co', aliases: [], sourceLocations: [], warnings: [] },
      ];
      const valuations: WorkbookFallbackProposalV1['valuations'] = [
        {
          proposalId: 'val-1',
          entityRef: 'ent-1',
          asOfDate: '2023-06-30',
          normalizedMarketValue: 5000000,
          normalizedCurrency: 'USD',
          sourceMarketValue: 5000000,
          sourceCurrency: 'USD',
          valuationMethod: 'market_comparables',
          notes: 'Q2 mark',
          sourceLocation: { sheet: 'Valuations', row: 5 },
          warnings: [],
        },
      ];

      const assets = projectToLegacyAssets(entities, [], valuations);

      expect(assets).toHaveLength(1);
      expect(assets[0].name).toBe('Bio Co');
      expect(assets[0].valuations).toHaveLength(1);
      expect(assets[0].valuations[0]).toMatchObject({
        asOfDate: '2023-06-30',
        marketValue: 5000000,
        valuationMethod: 'market_comparables',
        notes: 'Q2 mark',
        sourceSheet: 'Valuations',
        sourceRow: 5,
      });
    });

    it('does not project unsupported investor-to-fund events or non-asset valuations into assets', () => {
      const entities: WorkbookFallbackProposalV1['entities'] = [
        { proposalId: 'fund-1', entityType: 'fund', originalName: 'Main Fund', aliases: [], sourceLocations: [], warnings: [] },
        { proposalId: 'inv-1', entityType: 'institutional_investor', originalName: 'Big LP', aliases: [], sourceLocations: [], warnings: [] },
      ];
      const events: WorkbookFallbackProposalV1['events'] = [
        {
          proposalId: 'ev-1',
          eventType: 'capital_contribution',
          fromEntityRef: 'inv-1',
          toEntityRef: 'fund-1',
          date: '2023-01-10',
          normalizedAmount: 10000000,
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
        {
          proposalId: 'ev-2',
          eventType: 'commitment',
          fromEntityRef: 'inv-1',
          toEntityRef: 'fund-1',
          date: '2023-01-01',
          normalizedAmount: 50000000,
          sourceLocation: { sheet: 'Sheet1', row: 3 },
          warnings: [],
        },
        {
          proposalId: 'ev-3',
          eventType: 'commitment_transfer',
          fromEntityRef: 'inv-1',
          date: '2023-02-01',
          normalizedAmount: 5000000,
          sourceLocation: { sheet: 'Sheet1', row: 4 },
          warnings: [],
        },
        {
          proposalId: 'ev-4',
          eventType: 'investor_distribution',
          fromEntityRef: 'fund-1',
          toEntityRef: 'inv-1',
          date: '2023-03-01',
          normalizedAmount: 2000000,
          sourceLocation: { sheet: 'Sheet1', row: 5 },
          warnings: [],
        },
        {
          proposalId: 'ev-5',
          eventType: 'capital_adjustment',
          date: '2023-04-01',
          normalizedAmount: 100000,
          sourceLocation: { sheet: 'Sheet1', row: 6 },
          warnings: [],
        },
      ];
      const valuations: WorkbookFallbackProposalV1['valuations'] = [
        {
          proposalId: 'val-1',
          entityRef: 'fund-1',
          asOfDate: '2023-06-30',
          normalizedMarketValue: 100000000,
          normalizedCurrency: 'CNY',
          sourceMarketValue: 100000000,
          sourceCurrency: 'CNY',
          sourceLocation: { sheet: 'Sheet1', row: 7 },
          warnings: [],
        },
      ];

      const assets = projectToLegacyAssets(entities, events, valuations);

      // None of the unsupported events or fund-level valuations should create legacy assets
      expect(assets).toHaveLength(0);
    });

    it('projects events and valuations referencing entities by englishName', () => {
      const entities: WorkbookFallbackProposalV1['entities'] = [
        {
          proposalId: 'ent-zh-1',
          entityType: 'portfolio_company',
          originalName: '南京生物医疗科技股份有限公司',
          englishName: 'Nanjing Biomedicine Tech Co., Ltd.',
          aliases: ['南京生物'],
          sourceLocations: [],
          warnings: [],
        },
      ];
      const events: WorkbookFallbackProposalV1['events'] = [
        {
          proposalId: 'ev-eng-1',
          eventType: 'asset_investment',
          toEntityRef: 'Nanjing Biomedicine Tech Co., Ltd.',
          relatedFundRef: 'Health Fund I',
          date: '2023-05-15',
          normalizedAmount: 2000000,
          normalizedCurrency: 'USD',
          sourceLocation: { sheet: 'Investments', row: 4 },
          warnings: [],
        },
      ];
      const valuations: WorkbookFallbackProposalV1['valuations'] = [
        {
          proposalId: 'val-eng-1',
          entityRef: 'Nanjing Biomedicine Tech Co., Ltd.',
          asOfDate: '2023-09-30',
          normalizedMarketValue: 8000000,
          normalizedCurrency: 'USD',
          sourceMarketValue: 8000000,
          sourceCurrency: 'USD',
          sourceLocation: { sheet: 'Valuations', row: 8 },
          warnings: [],
        },
      ];

      const assets = projectToLegacyAssets(entities, events, valuations);

      expect(assets).toHaveLength(1);
      expect(assets[0].name).toBe('南京生物医疗科技股份有限公司');
      expect(assets[0].txns).toHaveLength(1);
      expect(assets[0].txns[0]).toMatchObject({
        date: '2023-05-15',
        valueAmount: 2000000,
        sourceSheet: 'Investments',
        sourceRow: 4,
      });
      expect(assets[0].valuations).toHaveLength(1);
      expect(assets[0].valuations[0]).toMatchObject({
        asOfDate: '2023-09-30',
        marketValue: 8000000,
        sourceSheet: 'Valuations',
        sourceRow: 8,
      });
    });
  });
});
