import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CRMService } from './crmService';

const mockContactRepo = {
  findAll: vi.fn(),
  findById: vi.fn(),
  findByEmail: vi.fn(),
  search: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findOrCreateByEmail: vi.fn(),
};

const mockMessageRepo = {
  findByContactId: vi.fn(),
  findById: vi.fn(),
  findByFileId: vi.fn(),
  insert: vi.fn(),
  insertMany: vi.fn(),
  delete: vi.fn(),
  deleteByFileId: vi.fn(),
};

describe('CRMService', () => {
  let service: CRMService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CRMService(mockContactRepo as any, mockMessageRepo as any);
  });

  describe('findAllContacts', () => {
    it('returns all contacts', async () => {
      const mockContacts = [
        { id: '1', name: 'John Doe' },
        { id: '2', name: 'Jane Doe' },
      ];
      mockContactRepo.findAll.mockResolvedValueOnce(mockContacts);

      const result = await service.findAllContacts();

      expect(result).toEqual(mockContacts);
      expect(mockContactRepo.findAll).toHaveBeenCalled();
    });
  });

  describe('findContactById', () => {
    it('returns contact with messages when found', async () => {
      const mockContact = { id: '1', name: 'John Doe' };
      const mockMessages = [
        { id: 'm1', body: 'Hello' },
        { id: 'm2', body: 'World' },
      ];
      mockContactRepo.findById.mockResolvedValueOnce(mockContact);
      mockMessageRepo.findByContactId.mockResolvedValueOnce(mockMessages);

      const result = await service.findContactById('1');

      expect(result).toEqual({
        ...mockContact,
        messages: mockMessages,
        message_count: 2,
      });
    });

    it('returns null when contact not found', async () => {
      mockContactRepo.findById.mockResolvedValueOnce(undefined);

      const result = await service.findContactById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('searchContacts', () => {
    it('searches contacts by query', async () => {
      const mockContacts = [{ id: '1', name: 'John Doe' }];
      mockContactRepo.search.mockResolvedValueOnce(mockContacts);

      const result = await service.searchContacts('john');

      expect(result).toEqual(mockContacts);
      expect(mockContactRepo.search).toHaveBeenCalledWith('john');
    });
  });

  describe('createContact', () => {
    it('creates a new contact', async () => {
      const newContact = { name: 'John Doe', email: 'john@example.com' };
      const createdContact = { id: '1', ...newContact };
      mockContactRepo.insert.mockResolvedValueOnce(createdContact);

      const result = await service.createContact(newContact);

      expect(result).toEqual(createdContact);
      expect(mockContactRepo.insert).toHaveBeenCalledWith(newContact);
    });
  });

  describe('updateContact', () => {
    it('updates contact when found', async () => {
      const updatedContact = { id: '1', name: 'John Updated' };
      mockContactRepo.update.mockResolvedValueOnce(updatedContact);

      const result = await service.updateContact('1', { name: 'John Updated' });

      expect(result).toEqual(updatedContact);
    });

    it('returns null when contact not found', async () => {
      mockContactRepo.update.mockResolvedValueOnce(undefined);

      const result = await service.updateContact('nonexistent', { name: 'Test' });

      expect(result).toBeNull();
    });
  });

  describe('deleteContact', () => {
    it('deletes a contact', async () => {
      mockContactRepo.delete.mockResolvedValueOnce(undefined);

      await expect(service.deleteContact('1')).resolves.toBeUndefined();
      expect(mockContactRepo.delete).toHaveBeenCalledWith('1');
    });
  });

  describe('addMessagesFromFile', () => {
    it('creates contacts and adds messages from file', async () => {
      const fileId = 'file-1';
      const messages = [
        {
          email: 'john@example.com',
          name: 'John Doe',
          company: 'Acme',
          direction: 'inbound' as const,
          subject: 'Test',
          body: 'Hello',
          sent_at: '2024-01-01T00:00:00Z',
          from_email: 'john@example.com',
          to_email: 'team@starcapital.com',
        },
      ];

      mockContactRepo.findByEmail.mockResolvedValueOnce(undefined);
      mockContactRepo.insert.mockResolvedValueOnce({ id: 'c1', email: 'john@example.com', name: 'John Doe' });
      mockMessageRepo.insertMany.mockResolvedValueOnce([{ id: 'm1' }]);

      const result = await service.addMessagesFromFile(fileId, messages);

      expect(result).toEqual({
        contacts_created: 1,
        messages_added: 1,
      });
      expect(mockContactRepo.insert).toHaveBeenCalled();
      expect(mockMessageRepo.insertMany).toHaveBeenCalled();
    });

    it('uses existing contact when found', async () => {
      const fileId = 'file-1';
      const messages = [
        {
          email: 'john@example.com',
          name: 'John Doe',
          direction: 'inbound' as const,
          body: 'Hello',
        },
      ];

      const existingContact = { id: 'c1', email: 'john@example.com', name: 'John Doe' };
      mockContactRepo.findByEmail.mockResolvedValueOnce(existingContact);
      mockMessageRepo.insertMany.mockResolvedValueOnce([{ id: 'm1' }]);

      const result = await service.addMessagesFromFile(fileId, messages);

      expect(result).toEqual({
        contacts_created: 0,
        messages_added: 1,
      });
      expect(mockContactRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('deleteMessagesByFileId', () => {
    it('deletes messages by file id', async () => {
      mockMessageRepo.deleteByFileId.mockResolvedValueOnce(undefined);

      await expect(service.deleteMessagesByFileId('file-1')).resolves.toBeUndefined();
      expect(mockMessageRepo.deleteByFileId).toHaveBeenCalledWith('file-1');
    });
  });
});
