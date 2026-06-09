import { describe, it, expect, vi } from 'vitest';
import { LlmBatchRepository } from './llmBatchRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
}

describe('LlmBatchRepository.insert', () => {
  it('returns the inserted row', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([
      { id: 'b1', anthropic_batch_id: 'msgbatch_x', status: 'in_progress' },
    ]);
    const repo = new LlmBatchRepository(db as never);
    const out = await repo.insert({
      anthropic_batch_id: 'msgbatch_x',
      status: 'in_progress',
      model: 'claude-haiku-4-5',
      request_count: 10,
      custom_id_map: { abc: 'r1' },
    });
    expect(out).toMatchObject({ id: 'b1', status: 'in_progress' });
  });
});

describe('LlmBatchRepository.listInProgress', () => {
  it('queries for in_progress rows', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ id: 'b1', status: 'in_progress' }]);
    const repo = new LlmBatchRepository(db as never);
    const out = await repo.listInProgress();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'in_progress' });
  });
});

describe('LlmBatchRepository.markEnded', () => {
  it('sets status=ended and stores ended_at', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ id: 'b1', status: 'ended' }]);
    const repo = new LlmBatchRepository(db as never);
    const out = await repo.markEnded('b1', '2026-05-28T12:00:00Z');
    expect(out).toMatchObject({ status: 'ended' });
  });

  it('throws when the row does not exist', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([]);
    const repo = new LlmBatchRepository(db as never);
    await expect(repo.markEnded('missing', '2026-05-28T12:00:00Z')).rejects.toThrow(
      /not found/,
    );
  });
});

describe('LlmBatchRepository.markFailed', () => {
  it('stores error message on the row', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([
      { id: 'b1', status: 'failed', error: 'boom' },
    ]);
    const repo = new LlmBatchRepository(db as never);
    const out = await repo.markFailed('b1', 'boom');
    expect(out).toMatchObject({ status: 'failed', error: 'boom' });
  });
});
