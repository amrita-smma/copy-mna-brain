import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmployerNoteRepository } from './employerNoteRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('EmployerNoteRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: EmployerNoteRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new EmployerNoteRepository(db as never);
  });

  it('findByEmployerId scopes to the employer and the workspace', async () => {
    const rows = [{ id: 'n1', employer_id: 'e1', workspace_id: 'w1' }];
    db.orderBy.mockResolvedValueOnce(rows);
    const result = await repo.findByEmployerId('e1', 'w1');
    expect(result).toEqual(rows);
  });

  it("findById returns undefined when the note belongs to a different workspace", async () => {
    db.limit.mockResolvedValueOnce([]);
    const result = await repo.findById('n1', 'other-workspace');
    expect(result).toBeUndefined();
  });

  it('insert writes the row as-is, including its stamped workspace_id', async () => {
    const row = { id: 'n1', employer_id: 'e1', workspace_id: 'w1', content: 'hi' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.insert({
      employer_id: 'e1',
      workspace_id: 'w1',
      content: 'hi',
    } as never);
    expect(result).toEqual(row);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'w1' }),
    );
  });

  it('update is guarded to the workspace', async () => {
    const row = { id: 'n1', content: 'edited' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.update('n1', { content: 'edited' }, 'w1');
    expect(result).toEqual(row);
  });

  it('delete is guarded to the workspace', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.delete('n1', 'w1');
    expect(db.delete).toHaveBeenCalled();
  });
});
