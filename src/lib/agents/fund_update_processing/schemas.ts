import { z } from 'zod';

export const SourceLocationSchema = z.object({
  sheet: z.string(),
  row: z.number(),
  columns: z.array(z.string()).optional(),
  cellAddress: z.string().optional(),
});

export const ProposedEntityTypeSchema = z.enum([
  'fund',
  'investor',
  'institutional_investor',
  'individual_investor',
  'investment_vehicle',
  'portfolio_company',
  'fund_or_partnership_asset',
  'counterparty',
  'unknown',
]);

export const ProposedEntitySchema = z.object({
  proposalId: z.string().optional().default(''),
  entityType: ProposedEntityTypeSchema.default('unknown'),
  originalName: z.string(),
  englishName: z.string().nullable().optional(),
  aliases: z.array(z.string()).default([]),
  existingRecordId: z.string().nullable().optional(),
  matchConfidence: z.number().nullable().optional(),
  sourceLocations: z.array(SourceLocationSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export const ProposedEventTypeSchema = z.enum([
  'commitment',
  'commitment_transfer',
  'capital_contribution',
  'commitment_reduction',
  'investor_distribution',
  'asset_investment',
  'asset_follow_on_investment',
  'asset_exit',
  'asset_exit_distribution',
  'capital_adjustment',
  'other',
]);

export const ProposedEventSchema = z.object({
  proposalId: z.string().optional().default(''),
  eventType: ProposedEventTypeSchema.default('other'),
  fromEntityRef: z.string().nullable().optional(),
  toEntityRef: z.string().nullable().optional(),
  relatedFundRef: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  sourceAmount: z.number().nullable().optional(),
  sourceCurrency: z.string().nullable().optional(),
  sourceUnit: z.string().nullable().optional(),
  amountMultiplier: z.number().nullable().optional(),
  normalizedAmount: z.number().nullable().optional(),
  normalizedCurrency: z.string().nullable().optional(),
  sourceAction: z.string().nullable().optional(),
  sourceNature: z.string().nullable().optional(),
  cashFlowDirection: z.enum(['into_fund', 'out_of_fund', 'non_cash', 'unknown']).default('unknown'),
  counterpartyRef: z.string().nullable().optional(),
  sourceLocation: SourceLocationSchema,
  confidence: z.number().default(1.0),
  warnings: z.array(z.string()).default([]),
});

export const ProposedValuationSchema = z.object({
  proposalId: z.string().optional().default(''),
  entityRef: z.string(),
  asOfDate: z.string().nullable().optional(),
  sourceMarketValue: z.number().nullable().optional(),
  normalizedMarketValue: z.number().nullable().optional(),
  sourceCurrency: z.string().nullable().optional(),
  normalizedCurrency: z.string().nullable().optional(),
  pricePerShare: z.number().nullable().optional(),
  sharesOutstanding: z.number().nullable().optional(),
  shareholdingPct: z.number().nullable().optional(),
  investedCapitalCum: z.number().nullable().optional(),
  grossMoic: z.number().nullable().optional(),
  grossXirr: z.number().nullable().optional(),
  valuationMethod: z.string().optional().default('other'),
  sourceLocation: SourceLocationSchema,
  notes: z.string().nullable().optional(),
  warnings: z.array(z.string()).default([]),
});

export const InterpretedColumnSchema = z.object({
  column: z.string(),
  sourceHeader: z.string(),
  semanticRole: z.string(),
  required: z.boolean().default(false),
});

export const InterpretedTableSchema = z.object({
  tableId: z.string(),
  sheetName: z.string(),
  purpose: z.enum([
    'event_ledger',
    'entity_master',
    'valuation_table',
    'summary',
    'definitions',
    'unknown',
  ]),
  headerRows: z.array(z.number()).default([1]),
  dataStartRow: z.number().optional(),
  dataEndRow: z.number().optional(),
  columns: z.array(InterpretedColumnSchema).default([]),
  confidence: z.number().default(1.0),
});

export const CurrencyInterpretationSchema = z.object({
  sourceCurrency: z.string(),
  sourceUnit: z.string(),
  multiplier: z.number().default(1),
  evidence: z
    .object({
      sheet: z.string().optional(),
      cell: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
});

export const SummaryTableInterpretationSchema = z.object({
  sheetName: z.string(),
  tableId: z.string(),
  purpose: z.string().default('summary'),
  description: z.string(),
  metrics: z.array(
    z.object({
      name: z.string(),
      targetFund: z.string().optional(),
      targetEventType: z.string().optional(),
      expectedTotal: z.number().optional(),
      currency: z.string().optional(),
      unit: z.string().optional(),
      multiplier: z.number().optional(),
      cellAddress: z.string().optional(),
    }),
  ).default([]),
});

export const WorkbookInterpretationSchema = z.object({
  detectedLanguages: z.array(z.string()).default([]),
  workbookPurpose: z.string(),
  tables: z.array(InterpretedTableSchema).default([]),
  glossary: z
    .array(
      z.object({
        term: z.string(),
        definition: z.string(),
        category: z.string().optional(),
      }),
    )
    .default([]),
  currencies: z.array(CurrencyInterpretationSchema).default([]),
  summaryTables: z.array(SummaryTableInterpretationSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export const ChunkExtractionSchema = z.object({
  chunkId: z.string().optional().default(''),
  sheetName: z.string().optional().default(''),
  tableId: z.string().optional().default(''),
  inputRows: z.array(z.number()).optional().default([]),
  parsedRows: z.array(z.number()).default([]),
  excludedRows: z
    .array(
      z.object({
        row: z.number(),
        sheet: z.string().optional(),
        reason: z.string(),
      }),
    )
    .default([]),
  ambiguousRows: z
    .array(
      z.object({
        row: z.number(),
        sheet: z.string().optional(),
        reason: z.string(),
      }),
    )
    .default([]),
  entities: z.array(ProposedEntitySchema).default([]),
  events: z.array(ProposedEventSchema).default([]),
  valuations: z.array(ProposedValuationSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export type ChunkExtractionResult = z.infer<typeof ChunkExtractionSchema>;
