import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimForIndustryClassification: vi.fn(),
  dispatch: vi.fn(),
  runFirmIndustryClassification: vi.fn(),
}));

vi.mock('@/lib/jobs/handlers/firmIndustryClassification', () => ({
  runFirmIndustryClassification: mocks.runFirmIndustryClassification,
}));

import {
  FIRM_INDUSTRY_PER_SWEEP,
  FIRM_INDUSTRY_RETRY_DAYS,
  FirmIndustryService,
} from './firmIndustryService';

describe('FirmIndustryService.classifyUnlabelledFirms', () => {
  const now = new Date('2026-10-26T00:00:00.000Z');
  let service: FirmIndustryService;

  beforeEach(() => {
    mocks.claimForIndustryClassification.mockReset();
    mocks.dispatch.mockReset().mockResolvedValue({ jobId: 'job-1' });
    mocks.runFirmIndustryClassification.mockReset().mockResolvedValue({ classified: 2 });
    service = new FirmIndustryService(
      { claimForIndustryClassification: mocks.claimForIndustryClassification } as never,
      { dispatch: mocks.dispatch } as never,
      'ws-1',
    );
  });

  it('claims this workspace\'s firms with the retry window and cap', async () => {
    mocks.claimForIndustryClassification.mockResolvedValue([]);

    await service.classifyUnlabelledFirms(now);

    const retryBefore = new Date(now.getTime() - FIRM_INDUSTRY_RETRY_DAYS * 86_400_000).toISOString();
    expect(mocks.claimForIndustryClassification).toHaveBeenCalledWith(
      'ws-1',
      retryBefore,
      FIRM_INDUSTRY_PER_SWEEP,
    );
  });

  it('queues no job when nothing was claimed', async () => {
    mocks.claimForIndustryClassification.mockResolvedValue([]);

    await expect(service.classifyUnlabelledFirms(now)).resolves.toEqual({ claimed: 0, jobId: null });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('queues one job for every claimed firm and runs the handler with the job id', async () => {
    mocks.claimForIndustryClassification.mockResolvedValue(['e1', 'e2']);

    await expect(service.classifyUnlabelledFirms(now)).resolves.toEqual({ claimed: 2, jobId: 'job-1' });

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const opts = mocks.dispatch.mock.calls[0][0];
    expect(opts).toMatchObject({ type: 'firm_industry_classification', payload: { employerIds: ['e1', 'e2'], workspaceId: 'ws-1' } });
    const db = {};
    await opts.work({ job: { id: 'job-1' }, db });
    expect(mocks.runFirmIndustryClassification).toHaveBeenCalledWith(
      { employerIds: ['e1', 'e2'], workspaceId: 'ws-1', jobId: 'job-1' },
      { db },
    );
  });
});
