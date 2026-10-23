import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import {
  getContactConversation,
  requestRelationshipOverview,
} from './contactConversation';

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe('getContactConversation', () => {
  it('GETs conversation endpoint with correspondentId encoded and no query params when opts omitted', async () => {
    const data = { contactId: 'c/1', notes: [] };
    apiRequestMock.mockResolvedValueOnce(data);

    await expect(getContactConversation('c/1')).resolves.toEqual(data);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/crm/correspondents/c%2F1/conversation');
  });

  it('builds URL with cursor and limit encoded', async () => {
    apiRequestMock.mockResolvedValueOnce({});

    await getContactConversation('c1', { cursor: 'cur/456', limit: 25 });

    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/crm/correspondents/c1/conversation?cursor=cur%2F456&limit=25',
    );
  });
});

describe('requestRelationshipOverview', () => {
  it('POSTs to the overview endpoint with correspondentId encoded', async () => {
    const data = { status: 'pending', text: null, generatedAt: null, stale: false };
    apiRequestMock.mockResolvedValueOnce(data);

    await expect(requestRelationshipOverview('c/1')).resolves.toEqual(data);
    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/crm/correspondents/c%2F1/conversation/overview',
      { method: 'POST' },
    );
  });
});
