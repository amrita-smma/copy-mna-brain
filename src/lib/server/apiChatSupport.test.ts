import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  eventStreamToSse,
  langfuseUserForApiKey,
  prepareConversationRun,
} from './apiChatSupport';
import { getLangfuseUserId, runWithLangfuseUser } from '@/lib/langfuseUser';
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

describe('langfuseUserForApiKey', () => {
  it('namespaces the key id so it can never collide with a users.id', () => {
    expect(
      langfuseUserForApiKey({ id: 'key-1', name: 'bot', scopes: ['chat:write'] }),
    ).toBe('api-key:key-1');
  });
});

describe('eventStreamToSse', () => {
  /** An event stream that yields across a real async hop, as a graph run does. */
  async function* events() {
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield { event: 'on_chat_model_stream', data: { chunk: { content: 'hi' } } };
      seenDuringDrain.push(getLangfuseUserId());
    }
  }
  let seenDuringDrain: Array<string | undefined>;

  beforeEach(() => {
    seenDuringDrain = [];
  });

  async function drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  }

  it('drains under the Langfuse user when it is constructed inside the scope', async () => {
    // Why the v1 stream route builds the reader inside `runWithLangfuseUser`
    // and not just the `streamEvents` call: the drain happens in this
    // function's `start`, and that is what a tool's hand-built trace (the pptx
    // skill) reads the user from.
    const stream = runWithLangfuseUser('api-key:k1', () => eventStreamToSse(events(), 'c1'));

    await drain(stream);

    expect(seenDuringDrain).toEqual(['api-key:k1', 'api-key:k1']);
  });

  it('drains unattributed when only the event stream was created in the scope', async () => {
    // The failure mode the route fix exists for: an iterator created inside the
    // scope but consumed from outside reads an empty store.
    const iterator = runWithLangfuseUser('api-key:k1', () => events());

    await drain(eventStreamToSse(iterator, 'c1'));

    expect(seenDuringDrain).toEqual([undefined, undefined]);
  });
});
