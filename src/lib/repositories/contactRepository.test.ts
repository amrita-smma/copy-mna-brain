import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactRepository } from './contactRepository';

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
};

describe('ContactRepository', () => {
  let repo: ContactRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new ContactRepository(mockDb as any);
  });

  describe('findAll', () => {
    it('returns all contacts ordered by created_at desc', async () => {
      const mockContacts = [
        { id: '1', name: 'John Doe', email: 'john@example.com' },
        { id: '2', name: 'Jane Doe', email: 'jane@example.com' },
      ];
      mockDb.orderBy.mockResolvedValueOnce(mockContacts);

      const result = await repo.findAll();

      expect(result).toEqual(mockContacts);
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns contact when found', async () => {
      const mockContact = { id: '1', name: 'John Doe', email: 'john@example.com' };
      mockDb.limit.mockResolvedValueOnce([mockContact]);

      const result = await repo.findById('1');

      expect(result).toEqual(mockContact);
    });

    it('returns undefined when not found', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repo.findById('nonexistent');

      expect(result).toBeUndefined();
    });
  });

  describe('findByEmail', () => {
    it('returns contact when found by email', async () => {
      const mockContact = { id: '1', name: 'John Doe', email: 'john@example.com' };
      mockDb.limit.mockResolvedValueOnce([mockContact]);

      const result = await repo.findByEmail('john@example.com');

      expect(result).toEqual(mockContact);
    });
  });

  describe('search', () => {
    it('searches contacts by name, email, or company', async () => {
      const mockContacts = [{ id: '1', name: 'John Doe', email: 'john@example.com' }];
      mockDb.orderBy.mockResolvedValueOnce(mockContacts);

      const result = await repo.search('john');

      expect(result).toEqual(mockContacts);
    });
  });

  describe('insert', () => {
    it('inserts a new contact', async () => {
      const newContact = { name: 'John Doe', email: 'john@example.com' };
      const insertedContact = { id: '1', ...newContact };
      mockDb.returning.mockResolvedValueOnce([insertedContact]);

      const result = await repo.insert(newContact);

      expect(result).toEqual(insertedContact);
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates an existing contact', async () => {
      const updatedContact = { id: '1', name: 'John Updated', email: 'john@example.com' };
      mockDb.returning.mockResolvedValueOnce([updatedContact]);

      const result = await repo.update('1', { name: 'John Updated' });

      expect(result).toEqual(updatedContact);
    });
  });

  describe('delete', () => {
    it('deletes a contact', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);

      await expect(repo.delete('1')).resolves.toBeUndefined();
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });

  describe('findOrCreateByEmail', () => {
    it('returns existing contact if found', async () => {
      const existingContact = { id: '1', name: 'John Doe', email: 'john@example.com' };
      mockDb.limit.mockResolvedValueOnce([existingContact]);

      const result = await repo.findOrCreateByEmail('john@example.com', { name: 'John' });

      expect(result).toEqual(existingContact);
    });

    it('creates new contact if not found', async () => {
      const newContact = { id: '2', name: 'Jane', email: 'jane@example.com' };
      mockDb.limit.mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([newContact]);

      const result = await repo.findOrCreateByEmail('jane@example.com', { name: 'Jane' });

      expect(result).toEqual(newContact);
    });
  });
});
