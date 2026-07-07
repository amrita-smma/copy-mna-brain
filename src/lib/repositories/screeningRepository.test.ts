import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScreeningRepository } from './screeningRepository';

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};

describe('ScreeningRepository.markFailedIfPending', () => {
  let repo: ScreeningRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new ScreeningRepository(mockDb as never, 'workspace-1');
  });

  it('writes failed/error/remarks and returns the updated row when the row was still pending', async () => {
    const updated = {
      id: 's1',
      state: 'failed',
      result: 'error',
      remarks: 'Job j1 timed out',
    };
    mockDb.returning.mockResolvedValueOnce([updated]);

    const result = await repo.markFailedIfPending('s1', 'Job j1 timed out');

    expect(result).toEqual(updated);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({
      state: 'failed',
      result: 'error',
      remarks: 'Job j1 timed out',
    });
  });

  it('returns null when the row is no longer pending (no rows matched the WHERE)', async () => {
    mockDb.returning.mockResolvedValueOnce([]);

    const result = await repo.markFailedIfPending('s2', 'whatever');

    expect(result).toBeNull();
  });
});
