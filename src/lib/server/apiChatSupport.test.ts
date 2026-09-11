import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prepareConversationRun } from './apiChatSupport';
import type { ApiKeyService } from '@/lib/services/apiKeyService';
import type { ApiChatConversationService } from '@/lib/services/apiChatConversationService';

function makeReq(authorization = 'Bearer tok-1') {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : null),
    },
  } as never;
}

describe('prepareConversationRun', () => {
  const principal = { id: 'key-1', name: 'bot', scopes: ['chat:write'] };
  let apiKeyService: { verify: ReturnType<typeof vi.fn> };
  let apiChatConversationService: {
    create: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
    touchLastActive: ReturnType<typeof vi.fn>;
    assertOwnedBy: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    apiKeyService = { verify: vi.fn().mockResolvedValue(principal) };
    apiChatConversationService = {
      create: vi.fn().mockResolvedValue({ id: 'conv-new' }),
      setTitle: vi.fn().mockResolvedValue(undefined),
      touchLastActive: vi.fn().mockResolvedValue(undefined),
      assertOwnedBy: vi.fn().mockResolvedValue({ id: 'conv-existing' }),
    };
  });

  it('returns the latest user-turn text as originalUserQuestion', async () => {
    const prepared = await prepareConversationRun(
      makeReq(),
      {
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'How did Apple do last quarter?' },
        ],
      },
      {
        apiKeyService: apiKeyService as unknown as ApiKeyService,
        apiChatConversationService:
          apiChatConversationService as unknown as ApiChatConversationService,
      },
    );

    expect(prepared.originalUserQuestion).toBe('How did Apple do last quarter?');
    expect(prepared.conversationId).toBe('conv-new');
  });

  it('uses the last user turn on an existing conversation as well', async () => {
    const prepared = await prepareConversationRun(
      makeReq(),
      {
        conversation_id: 'conv-existing',
        messages: [{ role: 'user', content: 'Follow-up on Nvidia.' }],
      },
      {
        apiKeyService: apiKeyService as unknown as ApiKeyService,
        apiChatConversationService:
          apiChatConversationService as unknown as ApiChatConversationService,
      },
    );

    expect(prepared.originalUserQuestion).toBe('Follow-up on Nvidia.');
    expect(prepared.conversationId).toBe('conv-existing');
  });
});
