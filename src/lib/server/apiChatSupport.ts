/**
 * Shared glue for the external chat API (`/api/v1/chat` and
 * `/api/v1/chat/stream`). This is server-only HTTP support — not a service —
 * so it may touch Next.js request types and the agent layer. All business
 * logic still lives in services.
 */
import type { NextRequest } from 'next/server';
import { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, AIMessage, extractMessageText } from '@/lib/agents/analysis';
import {
  ApiKeyService,
  ApiKeyPrincipal,
  InvalidApiKeyError,
  InsufficientScopeError,
  CHAT_WRITE_SCOPE,
} from '@/lib/services/apiKeyService';
import {
  ApiChatConversationService,
  ApiChatConversationNotFoundError,
} from '@/lib/services/apiChatConversationService';

/** Stable external message shape — deliberately decoupled from the AI SDK's UIMessage. */
export interface ExternalChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ParsedChatRequest {
  conversationId?: string;
  messages: ExternalChatMessage[];
}

export class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChatRequestError';
  }
}

/** Extract the raw bearer token from the Authorization header, or null. */
export function extractBearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/**
 * Authenticate a request from its bearer token, requiring `chat:write`.
 * Throws ChatRequestError with the right HTTP status (401 missing/invalid,
 * 403 insufficient scope) so the handler can render a uniform error body.
 */
export async function authenticateChatRequest(
  req: NextRequest,
  apiKeyService: ApiKeyService,
): Promise<ApiKeyPrincipal> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new ChatRequestError('Missing or malformed Authorization header', 401);
  }
  try {
    return await apiKeyService.verify(token, CHAT_WRITE_SCOPE);
  } catch (err) {
    if (err instanceof InvalidApiKeyError) {
      throw new ChatRequestError('Invalid or revoked API key', 401);
    }
    if (err instanceof InsufficientScopeError) {
      throw new ChatRequestError(err.message, 403);
    }
    throw err;
  }
}

/** Validate and normalize the external request body. Throws ChatRequestError (400) on bad input. */
export function parseChatRequest(body: unknown): ParsedChatRequest {
  if (!body || typeof body !== 'object') {
    throw new ChatRequestError('Request body must be a JSON object', 400);
  }
  const { conversation_id, messages } = body as {
    conversation_id?: unknown;
    messages?: unknown;
  };

  if (conversation_id !== undefined && typeof conversation_id !== 'string') {
    throw new ChatRequestError('conversation_id must be a string', 400);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ChatRequestError('messages must be a non-empty array', 400);
  }

  const normalized: ExternalChatMessage[] = messages.map((m, i) => {
    if (!m || typeof m !== 'object') {
      throw new ChatRequestError(`messages[${i}] must be an object`, 400);
    }
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') {
      throw new ChatRequestError(`messages[${i}].role must be 'user' or 'assistant'`, 400);
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new ChatRequestError(`messages[${i}].content must be a non-empty string`, 400);
    }
    return { role, content };
  });

  if (normalized[normalized.length - 1].role !== 'user') {
    throw new ChatRequestError('the last message must have role "user"', 400);
  }

  return {
    conversationId: conversation_id as string | undefined,
    messages: normalized,
  };
}

/**
 * Build the LangChain messages to feed the agent.
 *
 * - Resuming an existing conversation: feed only the latest user turn; the
 *   checkpointer rehydrates prior state by thread_id.
 * - A brand-new conversation: feed the whole provided history so stateless
 *   callers (who don't persist a conversation_id) keep their context.
 */
export function buildAgentMessages(
  messages: ExternalChatMessage[],
  isExistingConversation: boolean,
): BaseMessage[] {
  const toBase = (m: ExternalChatMessage): BaseMessage =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content);

  if (isExistingConversation) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return lastUser ? [toBase(lastUser)] : [];
  }
  return messages.map(toBase);
}

/** A short title derived from the first user message — cheap, no LLM call. */
export function deriveTitle(messages: ExternalChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  return (firstUser?.content ?? 'Conversation').trim().slice(0, 80);
}

export interface PreparedRun {
  principal: ApiKeyPrincipal;
  conversationId: string;
  messages: BaseMessage[];
  /** The caller's own latest user-turn text, for tool-call historical lookback. */
  originalUserQuestion: string;
}

/**
 * Run the shared request pipeline for both chat endpoints: authenticate,
 * validate the body, resolve (or create) the caller-owned conversation, and
 * assemble the agent input messages. Throws ChatRequestError with the correct
 * HTTP status on any failure. The conversation id doubles as the agent
 * checkpointer thread_id.
 */
export async function prepareConversationRun(
  req: NextRequest,
  body: unknown,
  services: {
    apiKeyService: ApiKeyService;
    apiChatConversationService: ApiChatConversationService;
  },
): Promise<PreparedRun> {
  const principal = await authenticateChatRequest(req, services.apiKeyService);
  const { conversationId, messages } = parseChatRequest(body);

  let conversationDbId: string;
  let isExisting: boolean;
  if (conversationId) {
    try {
      const conv = await services.apiChatConversationService.assertOwnedBy(
        conversationId,
        principal.id,
      );
      conversationDbId = conv.id;
      isExisting = true;
    } catch (err) {
      if (err instanceof ApiChatConversationNotFoundError) {
        throw new ChatRequestError('Conversation not found', 404);
      }
      throw err;
    }
  } else {
    const conv = await services.apiChatConversationService.create(principal.id);
    conversationDbId = conv.id;
    isExisting = false;
    await services.apiChatConversationService.setTitle(conv.id, deriveTitle(messages));
  }

  await services.apiChatConversationService.touchLastActive(conversationDbId);

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  return {
    principal,
    conversationId: conversationDbId,
    messages: buildAgentMessages(messages, isExisting),
    originalUserQuestion: lastUser?.content ?? '',
  };
}

/**
 * The Langfuse user id for an external API caller.
 *
 * `api_keys` rows carry no user — a key is the only principal these requests
 * have — so the key's own id is the identity, namespaced so it can never
 * collide with a `users.id` coming off a Copilot session. Keeps the Langfuse
 * Users view able to answer "which integration drove this spend?" alongside
 * "which person did?".
 */
export function langfuseUserForApiKey(principal: ApiKeyPrincipal): string {
  return `api-key:${principal.id}`;
}

/** SSE event types emitted by the streaming endpoint (documented external contract). */
export type SseEvent =
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool_call'; data: { name: string; args: unknown } }
  | { event: 'done'; data: { conversation_id: string } }
  | { event: 'error'; data: { code: string; message: string } };

function formatSse(evt: SseEvent): string {
  return `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`;
}

/**
 * Translate a LangChain `streamEvents({ version: 'v2' })` stream into our own
 * stable SSE protocol, so external clients never depend on AI SDK internals.
 */
export function eventStreamToSse(
  eventStream: AsyncIterable<unknown>,
  conversationId: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (evt: SseEvent) => controller.enqueue(encoder.encode(formatSse(evt)));
      try {
        for await (const raw of eventStream) {
          const event = raw as {
            event?: string;
            name?: string;
            data?: { chunk?: BaseMessage; input?: unknown };
          };
          if (event.event === 'on_chat_model_stream') {
            const text = extractMessageText(event.data?.chunk);
            if (text) send({ event: 'delta', data: { text } });
          } else if (event.event === 'on_tool_start') {
            send({
              event: 'tool_call',
              data: { name: event.name ?? 'unknown', args: event.data?.input },
            });
          }
        }
        send({ event: 'done', data: { conversation_id: conversationId } });
      } catch (err) {
        send({
          event: 'error',
          data: { code: 'stream_error', message: (err as Error).message },
        });
      } finally {
        controller.close();
      }
    },
  });
}
