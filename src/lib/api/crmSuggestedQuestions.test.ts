import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { getSuggestedQuestions } from './crmSuggestedQuestions';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue([]);
});

describe('getSuggestedQuestions', () => {
  it("GETs the signed-in user's questions", async () => {
    await getSuggestedQuestions();
    expect(apiRequestMock).toHaveBeenCalledWith('/api/crm/suggested-questions');
  });
});
