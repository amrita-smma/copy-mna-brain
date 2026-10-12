import { describe, expect, it, vi } from 'vitest';
import type { DealNoteRepository } from '@/lib/repositories';
import { DealNoteService, EmptyNoteError, NoteNotFoundError } from './dealNoteService';

function makeRepoStub(): DealNoteRepository {
  return {
    findByDealId: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as DealNoteRepository;
}

describe('DealNoteService.create', () => {
  it('defaults stage to L0 when not provided', async () => {
    const repo = makeRepoStub();
    const service = new DealNoteService(repo);

    await service.create('company-1', 'Met with the founder.');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'L0' }),
    );
  });

  it('uses the provided stage when given', async () => {
    const repo = makeRepoStub();
    const service = new DealNoteService(repo);

    await service.create('company-1', 'IOI submitted.', 'L2');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'L2' }),
    );
  });

  it('passes the deal_id and content through', async () => {
    const repo = makeRepoStub();
    const service = new DealNoteService(repo);

    await service.create('company-1', 'Met with the founder.');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ deal_id: 'company-1', content: 'Met with the founder.' }),
    );
  });
});

describe('DealNoteService.create backdating', () => {
  it('leaves created_at off the insert when no date was supplied, so the column default stamps it', async () => {
    const repo = makeRepoStub();
    const service = new DealNoteService(repo);

    await service.create('company-1', 'Met with the founder.');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.not.objectContaining({ created_at: expect.anything() }),
    );
  });

  it('stamps both created_at and updated_at when the composer backdated the entry', async () => {
    const repo = makeRepoStub();
    const service = new DealNoteService(repo);

    await service.create('company-1', 'Call happened Friday.', 'L1', '2026-10-09T14:30:00Z');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        created_at: '2026-10-09T14:30:00.000Z',
        updated_at: '2026-10-09T14:30:00.000Z',
      }),
    );
  });

  it('rejects an unparseable date rather than silently stamping now', async () => {
    const repo = makeRepoStub();
    const service = new DealNoteService(repo);

    expect(() => service.create('company-1', 'note', 'L0', 'last tuesday')).toThrow();
    expect(repo.insert).not.toHaveBeenCalled();
  });
});

describe('DealNoteService.update', () => {
  it('trims the body before writing it', async () => {
    const repo = makeRepoStub();
    vi.mocked(repo.update).mockResolvedValue({ id: 'n1' } as never);
    const service = new DealNoteService(repo);

    await service.update('n1', '  revised body  ');

    expect(repo.update).toHaveBeenCalledWith('n1', { content: 'revised body' });
  });

  it('throws EmptyNoteError for a blank body instead of wiping the note', async () => {
    const repo = makeRepoStub();
    const service = new DealNoteService(repo);

    await expect(service.update('n1', '   ')).rejects.toThrow(EmptyNoteError);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('throws NoteNotFoundError when the repository matched no row', async () => {
    const repo = makeRepoStub();
    vi.mocked(repo.update).mockResolvedValue(null);
    const service = new DealNoteService(repo);

    await expect(service.update('n-other', 'revised')).rejects.toThrow(NoteNotFoundError);
  });
});
