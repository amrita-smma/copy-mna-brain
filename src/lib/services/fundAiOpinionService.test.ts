import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueAgentRun, findActiveByFundAssetId, captureMock } = vi.hoisted(
  () => ({
    enqueueAgentRun: vi.fn(),
    findActiveByFundAssetId: vi.fn(),
    captureMock: vi.fn(),
  }),
);

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));

vi.mock('@/lib/posthog-server', () => ({
  captureWorkspaceEvent: captureMock,
}));

vi.mock('@/lib/repositories', () => ({
  AiWorkforceQueueRepository: class {
    findActiveByFundAssetId = findActiveByFundAssetId;
  },
}));

import { FUND_AI_OPINION_AGENT_NAME, FundAiOpinionService } from './fundAiOpinionService';
import { EntityNotFoundError, InvalidMasterDataError } from './flErrors';

const DEFAULT_VALUATIONS = [
  {
    as_of_date: '2023-12-31',
    market_value: '600000.00000000',
    net_value: '600000.00000000',
    price_per_unit: '12.00000000',
    valuation_method: 'at_cost',
    currency: 'USD',
  },
  {
    as_of_date: '2024-06-30',
    market_value: '700000.00000000',
    net_value: '700000.00000000',
    price_per_unit: '14.00000000',
    valuation_method: 'comparables',
    currency: 'USD',
  },
  {
    as_of_date: '2024-12-31',
    market_value: '800000.00000000',
    net_value: '800000.00000000',
    price_per_unit: '16.00000000',
    valuation_method: 'comparables',
    currency: 'USD',
  },
];

function makeValuationRepo(rows: unknown[] = DEFAULT_VALUATIONS) {
  return {
    findSeriesByTarget: vi.fn().mockResolvedValue(rows),
    findLatestByAssetIds: vi.fn().mockResolvedValue(rows),
  };
}

function makeService(
  assetRepo: Record<string, ReturnType<typeof vi.fn>>,
  valuationRepo: Record<string, ReturnType<typeof vi.fn>> = makeValuationRepo(),
  positionRepo?: Record<string, ReturnType<typeof vi.fn>>,
  balanceService?: Record<string, ReturnType<typeof vi.fn>>,
) {
  return new FundAiOpinionService(
    assetRepo as never,
    valuationRepo as never,
    {} as never,
    'workspace-1',
    positionRepo as never,
    balanceService as never,
  );
}

function makeAssetRepo(overrides: Record<string, unknown> = {}) {
  return {
    findById: vi.fn().mockResolvedValue({
      id: 'asset-1',
      workspace_id: 'workspace-1',
      name: 'Acme Robotics',
      legal_name: null,
      asset_kind: 'equity',
      sector: 'Robotics',
      sub_sector: null,
      country: 'Singapore',
      description: 'Series B lead investment.',
      instrument_terms: {},
      ...overrides,
    }),
    update: vi.fn().mockResolvedValue({ id: 'asset-1' }),
  };
}

function instructionFromEnqueue(): string {
  return enqueueAgentRun.mock.calls[0][1].input.instruction as string;
}

describe('FundAiOpinionService', () => {
  beforeEach(() => {
    enqueueAgentRun.mockReset();
    findActiveByFundAssetId.mockReset();
    captureMock.mockReset();
    findActiveByFundAssetId.mockResolvedValue(null);
    enqueueAgentRun.mockResolvedValue({ runId: 'run-9' });
  });

  it('throws without hitting the queue when assetId is missing', async () => {
    const service = makeService(makeAssetRepo());
    await expect(service.dispatch('  ')).rejects.toThrowError(
      InvalidMasterDataError,
    );
    await expect(service.dispatch('  ')).rejects.toThrow(
      'Missing required field: assetId',
    );
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('reuses an in-flight run instead of enqueueing a duplicate', async () => {
    findActiveByFundAssetId.mockResolvedValueOnce({ id: 'run-active' });
    const assetRepo = makeAssetRepo();
    const service = makeService(assetRepo);

    const result = await service.dispatch('asset-1');

    expect(result.runId).toBe('run-active');
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(assetRepo.update).toHaveBeenCalledWith('workspace-1', 'asset-1', {
      instrument_terms: {
        aiOpinion: {
          status: 'processing',
        },
      },
    });
    // A reused run is not a new opinion request — no event.
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('throws EntityNotFoundError when the fund asset does not exist', async () => {
    const assetRepo = makeAssetRepo();
    assetRepo.findById.mockResolvedValue(undefined);
    const service = makeService(assetRepo);

    await expect(service.dispatch('missing-asset')).rejects.toThrowError(
      EntityNotFoundError,
    );
    await expect(service.dispatch('missing-asset')).rejects.toThrow(
      'No fund asset found for id "missing-asset"',
    );
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('captures a fund_ai_opinion_requested PostHog event attributed to the user', async () => {
    const service = makeService(makeAssetRepo());

    await service.dispatch('asset-1', 'user-1');

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        distinctId: 'user-1',
        event: 'fund_ai_opinion_requested',
        properties: expect.objectContaining({
          asset_id: 'asset-1',
          asset_name: 'Acme Robotics',
          run_id: 'run-9',
        }),
      }),
    );
  });

  it('falls back to a server distinctId when no user triggered the run', async () => {
    const service = makeService(makeAssetRepo());

    await service.dispatch('asset-1');

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: 'server' }),
    );
  });

  it('marks the asset processing, clears the stale verdict, and enqueues the run', async () => {
    const assetRepo = makeAssetRepo({
      instrument_terms: { customField: 123 },
    });
    const service = makeService(assetRepo);

    const result = await service.dispatch('asset-1', 'user-1');

    expect(result.runId).toBe('run-9');
    expect(assetRepo.update).toHaveBeenCalledWith(
      'workspace-1',
      'asset-1',
      expect.objectContaining({
        instrument_terms: expect.objectContaining({
          customField: 123,
          aiOpinion: expect.objectContaining({
            status: 'processing',
            verdict: null,
            summary: null,
            confidence: null,
            data_gaps: null,
          }),
        }),
      }),
    );
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentName: FUND_AI_OPINION_AGENT_NAME,
        triggerSource: 'api',
        triggerMeta: { asset_id: 'asset-1', fund_asset_id: 'asset-1' },
        triggeredByUserId: 'user-1',
      }),
    );
  });

  it('inlines the asset metrics into the instruction', async () => {
    const service = makeService(makeAssetRepo());
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Robotics');
    expect(instruction).toContain('Kind: equity');
  });

  it('inlines country, description, and valuation history', async () => {
    const service = makeService(makeAssetRepo());
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Country: Singapore');
    expect(instruction).toContain('Description: Series B lead investment.');
  });

  it('inlines valuation history with FMV and method', async () => {
    const valuationRepo = makeValuationRepo();
    const service = makeService(makeAssetRepo(), valuationRepo);
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Valuation history (most recent first):');
    expect(instruction).toContain('Market Value 800,000 USD');
    expect(instruction).toContain('comparables');
    expect(instruction).toContain(
      'Weigh the direction of the valuation trend',
    );
    expect(valuationRepo.findSeriesByTarget).toHaveBeenCalledWith('workspace-1', { assetId: 'asset-1' });
  });

  it('emits an empty-history guard when no valuations exist', async () => {
    const service = makeService(makeAssetRepo(), makeValuationRepo([]));
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('No valuation history on record.');
    expect(instruction).not.toContain('Valuation history (most recent first):');
    expect(instruction).toContain('sparse recorded data');
    expect(instruction).toContain('confidence no higher than "low"');
  });

  it('injects a high-confidence ceiling when recorded data is rich', async () => {
    const positionRepo = {
      findByAssetIds: vi.fn().mockResolvedValue([{ id: 'pos-1' }]),
    };
    const balanceService = {
      getPositionBalances: vi.fn().mockResolvedValue([
        { position_id: 'pos-1', contributed: '500000.00000000', quantity: '1000.00000000' },
      ]),
    };
    const service = makeService(
      makeAssetRepo(),
      makeValuationRepo(),
      positionRepo,
      balanceService,
    );
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('confidence up to "high"');
    expect(instruction).toContain('Be decisive about the verdict; be honest about the basis');
  });

  it('marks the asset failed when valuation fetch throws after flipping to processing', async () => {
    const assetRepo = makeAssetRepo();
    const valuationRepo = makeValuationRepo();
    valuationRepo.findSeriesByTarget.mockRejectedValueOnce(new Error('db down'));
    const service = makeService(assetRepo, valuationRepo);

    await expect(service.dispatch('asset-1')).rejects.toThrow('db down');
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(assetRepo.update).toHaveBeenCalledWith(
      'workspace-1',
      'asset-1',
      expect.objectContaining({
        instrument_terms: expect.objectContaining({
          aiOpinion: expect.objectContaining({ status: 'failed' }),
        }),
      }),
    );
  });

  it('caps valuation history at the 8 newest snapshots', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      as_of_date: `2025-01-${String(i + 1).padStart(2, '0')}`,
      market_value: String(600_000 + i * 20_000),
      net_value: String(600_000 + i * 20_000),
      price_per_unit: '10.0',
      valuation_method: 'comparables',
      currency: 'USD',
    }));
    const service = makeService(makeAssetRepo(), makeValuationRepo(rows));
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Market Value 820,000 USD');
    expect(instruction).toContain('Market Value 680,000 USD');
    expect(instruction).not.toContain('Market Value 600,000 USD');
  });

  it('instructs the agent to check internal notes before web_search', async () => {
    const service = makeService(makeAssetRepo());
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Before web_search, check internal notes');
    expect(instruction).toContain('query_files');
  });

  it('instructs the agent not to use hold as an escape hatch', async () => {
    const service = makeService(makeAssetRepo());
    await service.dispatch('asset-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('buy / hold / sell');
    expect(input.instruction).toContain(
      'do NOT use "hold" as a way to avoid a decision',
    );
  });

  it('routes the Fund AI Opinion run to high effort (Opus)', async () => {
    const service = makeService(makeAssetRepo());
    await service.dispatch('asset-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.effort).toBe('high');
  });

  it('marks the asset failed when enqueue throws after flipping to processing', async () => {
    enqueueAgentRun.mockRejectedValueOnce(new Error('queue unavailable'));
    const assetRepo = makeAssetRepo();
    const service = makeService(assetRepo);

    await expect(service.dispatch('asset-1')).rejects.toThrow('queue unavailable');
    expect(assetRepo.update).toHaveBeenCalledWith(
      'workspace-1',
      'asset-1',
      expect.objectContaining({
        instrument_terms: expect.objectContaining({
          aiOpinion: expect.objectContaining({ status: 'failed' }),
        }),
      }),
    );
  });

  it('clears opinion state and preserves other instrument_terms keys on clear()', async () => {
    const assetRepo = makeAssetRepo({
      instrument_terms: {
        otherKey: 'preserve-me',
        aiOpinion: { verdict: 'buy', status: 'completed' },
      },
    });
    const service = makeService(assetRepo);

    const res = await service.clear('asset-1');
    expect(res).toEqual({ success: true });
    expect(assetRepo.update).toHaveBeenCalledWith('workspace-1', 'asset-1', {
      instrument_terms: {
        otherKey: 'preserve-me',
      },
    });
  });

  it('throws InvalidMasterDataError on clear() when assetId is empty', async () => {
    const service = makeService(makeAssetRepo());
    await expect(service.clear('  ')).rejects.toThrowError(InvalidMasterDataError);
    await expect(service.clear('  ')).rejects.toThrow('Missing required field: assetId');
  });

  it('throws EntityNotFoundError on clear() when asset does not exist', async () => {
    const assetRepo = makeAssetRepo();
    assetRepo.findById.mockResolvedValue(undefined);
    const service = makeService(assetRepo);

    await expect(service.clear('missing-asset')).rejects.toThrowError(EntityNotFoundError);
    await expect(service.clear('missing-asset')).rejects.toThrow('No fund asset found for id "missing-asset"');
  });

  it('returns opinion state from getOpinion()', async () => {
    const assetRepo = makeAssetRepo({
      instrument_terms: {
        aiOpinion: { verdict: 'buy', status: 'completed', summary: 'Strong performance' },
      },
    });
    const service = makeService(assetRepo);

    const opinion = await service.getOpinion('asset-1');
    expect(opinion).toEqual({
      verdict: 'buy',
      status: 'completed',
      summary: 'Strong performance',
    });
  });

  it('throws InvalidMasterDataError on getOpinion() when assetId is empty', async () => {
    const service = makeService(makeAssetRepo());
    await expect(service.getOpinion('  ')).rejects.toThrowError(InvalidMasterDataError);
    await expect(service.getOpinion('  ')).rejects.toThrow('Missing required field: assetId');
  });

  it('throws EntityNotFoundError on getOpinion() when asset does not exist', async () => {
    const assetRepo = makeAssetRepo();
    assetRepo.findById.mockResolvedValue(undefined);
    const service = makeService(assetRepo);

    await expect(service.getOpinion('missing-asset')).rejects.toThrowError(EntityNotFoundError);
    await expect(service.getOpinion('missing-asset')).rejects.toThrow('No fund asset found for id "missing-asset"');
  });

  it('aggregates contributed capital and quantity across multiple positions', async () => {
    const positionRepo = {
      findByAssetIds: vi.fn().mockResolvedValue([{ id: 'pos-1' }, { id: 'pos-2' }]),
    };
    const balanceService = {
      getPositionBalances: vi.fn().mockResolvedValue([
        { position_id: 'pos-1', contributed: '500000.00000000', quantity: '1000.00000000' },
        { position_id: 'pos-2', contributed: '250000.00000000', quantity: '500.00000000' },
      ]),
    };
    const service = makeService(
      makeAssetRepo(),
      makeValuationRepo(),
      positionRepo,
      balanceService,
    );
    await service.dispatch('asset-1');

    expect(positionRepo.findByAssetIds).toHaveBeenCalledWith('workspace-1', ['asset-1']);
    expect(balanceService.getPositionBalances).toHaveBeenCalledWith('workspace-1', ['pos-1', 'pos-2']);

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Invested capital: 750,000 USD.');
    expect(instruction).toContain('Quantity / units: 1500.00000000.');
  });

  it('does not fabricate gross_irr and reflects missing IRR in data sufficiency', async () => {
    const assetRepo = makeAssetRepo({
      description: null,
    });
    const positionRepo = {
      findByAssetIds: vi.fn().mockResolvedValue([{ id: 'pos-1' }]),
    };
    const balanceService = {
      getPositionBalances: vi.fn().mockResolvedValue([
        { position_id: 'pos-1', contributed: '500000.00000000', quantity: '1000.00000000' },
      ]),
    };
    const service = makeService(
      assetRepo,
      makeValuationRepo(),
      positionRepo,
      balanceService,
    );
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('missing IRR; no investment description');
    expect(instruction).toContain('confidence no higher than "medium"');
    expect(instruction).not.toContain('12%');
    expect(instruction).not.toContain('0.12');
  });

  it('uses the latest valuation currency consistently', async () => {
    const valuationsWithMixedCurrencies = [
      {
        as_of_date: '2023-12-31',
        market_value: '600000.00000000',
        net_value: '600000.00000000',
        price_per_unit: '12.00000000',
        valuation_method: 'at_cost',
        currency: 'USD',
      },
      {
        as_of_date: '2024-12-31',
        market_value: '800000.00000000',
        net_value: '800000.00000000',
        price_per_unit: '16.00000000',
        valuation_method: 'comparables',
        currency: 'EUR',
      },
    ];
    const positionRepo = {
      findByAssetIds: vi.fn().mockResolvedValue([{ id: 'pos-1' }]),
    };
    const balanceService = {
      getPositionBalances: vi.fn().mockResolvedValue([
        { position_id: 'pos-1', contributed: '500000.00000000', quantity: '1000.00000000' },
      ]),
    };
    const service = makeService(
      makeAssetRepo(),
      makeValuationRepo(valuationsWithMixedCurrencies),
      positionRepo,
      balanceService,
    );
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Invested capital: 500,000 EUR.');
    expect(instruction).toContain('Fair market value: 800,000 EUR.');
    expect(instruction).toContain('2024-12-31: Market Value 800,000 EUR');
    expect(instruction).toContain('2023-12-31: Market Value 600,000 USD');
  });
});
