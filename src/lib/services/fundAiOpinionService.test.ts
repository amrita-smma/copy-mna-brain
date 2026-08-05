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

const DEFAULT_VALUATIONS = [
  {
    as_of_date: '2024-12-31',
    market_value_amount: 800000,
    gross_moic: 1.6,
    dpi: 0.2,
    gross_xirr: 0.12,
    currency: 'USD',
  },
  {
    as_of_date: '2024-06-30',
    market_value_amount: 700000,
    gross_moic: 1.4,
    dpi: 0.1,
    gross_xirr: 0.1,
    currency: 'USD',
  },
  {
    as_of_date: '2023-12-31',
    market_value_amount: 600000,
    gross_moic: 1.2,
    dpi: 0.05,
    gross_xirr: 0.08,
    currency: 'USD',
  },
];

function makeValuationRepo(rows: unknown[] = DEFAULT_VALUATIONS) {
  return {
    findByFundAssetId: vi.fn().mockResolvedValue(rows),
  };
}

function makeService(
  fundAssetRepo: Record<string, ReturnType<typeof vi.fn>>,
  valuationRepo: Record<string, ReturnType<typeof vi.fn>> = makeValuationRepo(),
) {
  return new FundAiOpinionService(
    fundAssetRepo as never,
    valuationRepo as never,
    {} as never,
    'workspace-1',
  );
}

function makeFundAssetRepo(overrides: Record<string, unknown> = {}) {
  return {
    findById: vi.fn().mockResolvedValue({
      id: 'asset-1',
      asset_name: 'Acme Robotics',
      legal_name: null,
      asset_type: 'direct_investment',
      sector: 'Robotics',
      sub_sector: null,
      status: 'active',
      country: 'Singapore',
      stake_pct: 12.5,
      invested_capital_amount: 500000,
      commitment_amount: 750000,
      fmv_amount: 675000,
      net_distribution_amount: 50000,
      gross_moic: 1.35,
      gross_irr: 0.09,
      dpi: 0.1,
      entry_date: '2023-01-15',
      maturity_date: '2028-01-15',
      key_rights: 'Board observer seat.',
      investment_description: 'Series B lead investment.',
      report_currency: 'USD',
      ...overrides,
    }),
    update: vi.fn().mockResolvedValue({ id: 'asset-1' }),
  };
}

function instructionFromEnqueue(): string {
  return enqueueAgentRun.mock.calls[0][1].input.instruction as string;
}

describe('FundAiOpinionService.dispatch', () => {
  beforeEach(() => {
    enqueueAgentRun.mockReset();
    findActiveByFundAssetId.mockReset();
    captureMock.mockReset();
    findActiveByFundAssetId.mockResolvedValue(null);
    enqueueAgentRun.mockResolvedValue({ runId: 'run-9' });
  });

  it('throws without hitting the queue when fundAssetId is missing', async () => {
    const service = makeService(makeFundAssetRepo());
    await expect(service.dispatch('  ')).rejects.toThrow(
      'Missing required field: fundAssetId',
    );
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('reuses an in-flight run instead of enqueueing a duplicate', async () => {
    findActiveByFundAssetId.mockResolvedValueOnce({ id: 'run-active' });
    const fundAssetRepo = makeFundAssetRepo();
    const service = makeService(fundAssetRepo);

    const result = await service.dispatch('asset-1');

    expect(result.runId).toBe('run-active');
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(fundAssetRepo.update).toHaveBeenCalledWith('asset-1', {
      ai_opinion_status: 'processing',
    });
    // A reused run is not a new opinion request — no event.
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('throws when the fund asset does not exist', async () => {
    const fundAssetRepo = makeFundAssetRepo();
    fundAssetRepo.findById.mockResolvedValueOnce(undefined);
    const service = makeService(fundAssetRepo);

    await expect(service.dispatch('missing-asset')).rejects.toThrow(
      'No fund asset found for id "missing-asset"',
    );
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('captures a fund_ai_opinion_requested PostHog event attributed to the user', async () => {
    const service = makeService(makeFundAssetRepo());

    await service.dispatch('asset-1', 'user-1');

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        distinctId: 'user-1',
        event: 'fund_ai_opinion_requested',
        properties: expect.objectContaining({
          fund_asset_id: 'asset-1',
          asset_name: 'Acme Robotics',
          run_id: 'run-9',
        }),
      }),
    );
  });

  it('falls back to a server distinctId when no user triggered the run', async () => {
    const service = makeService(makeFundAssetRepo());

    await service.dispatch('asset-1');

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: 'server' }),
    );
  });

  it('marks the asset processing, clears the stale verdict, and enqueues the run', async () => {
    const fundAssetRepo = makeFundAssetRepo();
    const service = makeService(fundAssetRepo);

    const result = await service.dispatch('asset-1', 'user-1');

    expect(result.runId).toBe('run-9');
    expect(fundAssetRepo.update).toHaveBeenCalledWith('asset-1', {
      ai_opinion_status: 'processing',
      ai_opinion_verdict: null,
      ai_opinion_summary: null,
      ai_opinion_confidence: null,
      ai_opinion_data_gaps: null,
    });
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentName: FUND_AI_OPINION_AGENT_NAME,
        triggerSource: 'api',
        triggerMeta: { fund_asset_id: 'asset-1' },
        triggeredByUserId: 'user-1',
      }),
    );
  });

  it('inlines the asset metrics into the instruction', async () => {
    const service = makeService(makeFundAssetRepo());
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Robotics');
    expect(instruction).toContain('500,000');
    expect(instruction).toContain('1.35x');
  });

  it('inlines country, ownership stake, unfunded commitment, and DPI', async () => {
    const service = makeService(makeFundAssetRepo());
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Country: Singapore');
    expect(instruction).toContain('Ownership stake: 12.5%');
    expect(instruction).toContain('Unfunded commitment: 250,000 USD');
    expect(instruction).toContain('DPI: 0.10x');
    expect(instruction).toContain('Maturity date: 2028-01-15');
    expect(instruction).toContain('Key rights: Board observer seat.');
  });

  it('inlines valuation history with FMV and MOIC', async () => {
    const valuationRepo = makeValuationRepo();
    const service = makeService(makeFundAssetRepo(), valuationRepo);
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Valuation history (most recent first):');
    expect(instruction).toContain('FMV 800,000 USD');
    expect(instruction).toContain('MOIC 1.60x');
    expect(instruction).toContain(
      'Weigh the direction of the valuation trend',
    );
    expect(valuationRepo.findByFundAssetId).toHaveBeenCalledWith('asset-1');
  });

  it('emits an empty-history guard when no valuations exist', async () => {
    const service = makeService(makeFundAssetRepo(), makeValuationRepo([]));
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('No valuation history on record.');
    expect(instruction).not.toContain('Valuation history (most recent first):');
    expect(instruction).toContain('sparse recorded data');
    expect(instruction).toContain('confidence no higher than "low"');
  });

  it('injects a high-confidence ceiling when recorded data is rich', async () => {
    const service = makeService(makeFundAssetRepo());
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('confidence up to "high"');
    expect(instruction).toContain('Be decisive about the verdict; be honest about the basis');
  });

  it('omits unfunded commitment when commitment is null or over-called', async () => {
    const nullCommitment = makeService(
      makeFundAssetRepo({ commitment_amount: null }),
    );
    await nullCommitment.dispatch('asset-1');
    expect(instructionFromEnqueue()).not.toContain('Unfunded commitment');

    enqueueAgentRun.mockClear();
    const overCalled = makeService(
      makeFundAssetRepo({ commitment_amount: 100000, invested_capital_amount: 500000 }),
    );
    await overCalled.dispatch('asset-1');
    expect(instructionFromEnqueue()).not.toContain('Unfunded commitment');
  });

  it('marks the asset failed when valuation fetch throws after flipping to processing', async () => {
    const fundAssetRepo = makeFundAssetRepo();
    const valuationRepo = makeValuationRepo();
    valuationRepo.findByFundAssetId.mockRejectedValueOnce(new Error('db down'));
    const service = makeService(fundAssetRepo, valuationRepo);

    await expect(service.dispatch('asset-1')).rejects.toThrow('db down');
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(fundAssetRepo.update).toHaveBeenCalledWith('asset-1', {
      ai_opinion_status: 'failed',
    });
  });

  it('caps valuation history at the 8 newest snapshots', async () => {
    // Newest-first with distinct FMVs so the 9th+ are easy to assert absent.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      as_of_date: `2025-01-${String(31 - i).padStart(2, '0')}`,
      market_value_amount: 900_000 - i * 10_000,
      gross_moic: 1.8 - i * 0.05,
      dpi: 0.1,
      gross_xirr: 0.1,
      currency: 'USD',
    }));
    const service = makeService(makeFundAssetRepo(), makeValuationRepo(rows));
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    // Newest 8: 900k … 830k; 9th is 820k and must be omitted
    expect(instruction).toContain('FMV 900,000 USD');
    expect(instruction).toContain('FMV 830,000 USD');
    expect(instruction).not.toContain('FMV 820,000 USD');
    expect(instruction).not.toContain('FMV 790,000 USD');
  });

  it('instructs the agent to check internal notes before web_search', async () => {
    const service = makeService(makeFundAssetRepo());
    await service.dispatch('asset-1');

    const instruction = instructionFromEnqueue();
    expect(instruction).toContain('Before web_search, check internal notes');
    expect(instruction).toContain('query_files');
  });

  it('instructs the agent not to use hold as an escape hatch', async () => {
    const service = makeService(makeFundAssetRepo());
    await service.dispatch('asset-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('buy / hold / sell');
    expect(input.instruction).toContain(
      'do NOT use "hold" as a way to avoid a decision',
    );
  });

  it('routes the Fund AI Opinion run to high effort (Opus)', async () => {
    const service = makeService(makeFundAssetRepo());
    await service.dispatch('asset-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.effort).toBe('high');
  });

  it('marks the asset failed when enqueue throws after flipping to processing', async () => {
    enqueueAgentRun.mockRejectedValueOnce(new Error('queue unavailable'));
    const fundAssetRepo = makeFundAssetRepo();
    const service = makeService(fundAssetRepo);

    await expect(service.dispatch('asset-1')).rejects.toThrow('queue unavailable');
    expect(fundAssetRepo.update).toHaveBeenCalledWith('asset-1', {
      ai_opinion_status: 'failed',
    });
  });

  it('mirrors the instruction into input.prompt and includes the fund_asset_id verbatim', async () => {
    const service = makeService(makeFundAssetRepo());
    await service.dispatch('asset-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.prompt).toBe(input.instruction);
    expect(input.instruction).toContain('fund_asset_id: asset-1');
    expect(input.title).toBe('Fund AI Opinion: Acme Robotics');
  });
});
