import { beforeEach, describe, expect, it, vi } from 'vitest';

const { markPendingFailedForCompany } = vi.hoisted(() => ({
  markPendingFailedForCompany: vi.fn(),
}));

vi.mock('@/lib/repositories', () => ({
  ScreeningRepository: class {
    markPendingFailedForCompany = markPendingFailedForCompany;
  },
}));

import { failScreeningsIfStillPending } from './failScreeningsOnFailure';

const DB = {} as never;

describe('failScreeningsIfStillPending', () => {
  beforeEach(() => {
    markPendingFailedForCompany.mockReset().mockResolvedValue(2);
  });

  it('fails the company’s still-pending screenings when an ai_screening run ends', async () => {
    await failScreeningsIfStillPending(DB, 'ws-1', { company_id: ' c1 ' }, 'ai_screening');

    expect(markPendingFailedForCompany).toHaveBeenCalledWith(
      'c1',
      'The AI screening task ended before this criterion was screened',
    );
  });

  it('ignores runs of other agents, even when they name a company', async () => {
    await failScreeningsIfStillPending(DB, 'ws-1', { company_id: 'c1' }, 'company_card');
    expect(markPendingFailedForCompany).not.toHaveBeenCalled();
  });

  it('ignores a run with no company in its trigger meta', async () => {
    await failScreeningsIfStillPending(DB, 'ws-1', {}, 'ai_screening');
    await failScreeningsIfStillPending(DB, 'ws-1', null, 'ai_screening');
    expect(markPendingFailedForCompany).not.toHaveBeenCalled();
  });

  it('reads company_id from queue input when trigger_meta was dropped on retry', async () => {
    await failScreeningsIfStillPending(DB, 'ws-1', {}, 'ai_screening', {
      company_id: 'c-retry',
    });

    expect(markPendingFailedForCompany).toHaveBeenCalledWith(
      'c-retry',
      'The AI screening task ended before this criterion was screened',
    );
  });

  it('never throws when the clean-up write fails', async () => {
    markPendingFailedForCompany.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      failScreeningsIfStillPending(DB, 'ws-1', { company_id: 'c1' }, 'ai_screening'),
    ).resolves.toBeUndefined();
  });
});
