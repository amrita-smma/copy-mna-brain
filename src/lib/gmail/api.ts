import { GMAIL_API_URL } from './config';
import {
  parseMessage,
  parseMessageSummary,
  type GmailMessage,
  type GmailMessageSummary,
  type GmailRawMessage,
} from './message';

/**
 * Read-only calls to the Gmail REST API as one member, given their access
 * token. Token handling (refresh, retry on 401) is `GmailService`'s job.
 */

const API_TIMEOUT_MS = 20_000;

/** Most messages a search returns — each costs one metadata fetch. */
export const GMAIL_SEARCH_MAX_RESULTS = 15;
export const GMAIL_SEARCH_DEFAULT_RESULTS = 10;
/** Most messages of a thread read in one call. */
export const GMAIL_THREAD_MAX_MESSAGES = 15;

/** Google rejected the access token (expired, revoked). */
export class GmailUnauthorizedError extends Error {
  constructor() {
    super('Gmail rejected the access token');
    this.name = 'GmailUnauthorizedError';
  }
}

/** Any other non-2xx answer from the Gmail API. */
export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

async function gmailRequest<T>(
  accessToken: string,
  path: string,
  options: { params?: Record<string, string | string[]>; json?: unknown } = {},
): Promise<T> {
  const url = new URL(`${GMAIL_API_URL}${path}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
  }
  const hasBody = options.json !== undefined;
  const res = await fetch(url, {
    method: hasBody ? 'POST' : 'GET',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.json) } : {}),
  });
  if (res.status === 401) throw new GmailUnauthorizedError();
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') detail = body.error.message;
    } catch {
      // Non-JSON error body — keep the status.
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new GmailApiError(res.status, detail, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
  return (await res.json()) as T;
}

function gmailGet<T>(accessToken: string, path: string, params: Record<string, string | string[]> = {}): Promise<T> {
  return gmailRequest<T>(accessToken, path, { params });
}

const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date'];

/** A draft saved in the member's Drafts folder. */
export interface GmailDraft {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
}

/**
 * Save a draft (`users.drafts.create`) from a base64url RFC 822 message. This
 * is the only write the integration makes: it never calls `drafts.send` or
 * `messages.send`, so nothing leaves the mailbox until the member presses Send
 * themselves. Needs the `gmail.compose` scope.
 */
export async function createDraft(accessToken: string, raw: string): Promise<GmailDraft> {
  const body = await gmailRequest<{ id?: unknown; message?: { id?: unknown; threadId?: unknown } }>(
    accessToken,
    '/users/me/drafts',
    { json: { message: { raw } } },
  );
  if (typeof body.id !== 'string') throw new GmailApiError(502, 'Gmail did not return a draft id');
  return {
    draftId: body.id,
    messageId: typeof body.message?.id === 'string' ? body.message.id : null,
    threadId: typeof body.message?.threadId === 'string' ? body.message.threadId : null,
  };
}

/** The connected mailbox's address (`users.getProfile`). */
export async function getProfile(accessToken: string): Promise<{ emailAddress: string | null }> {
  const body = await gmailGet<{ emailAddress?: unknown }>(accessToken, '/users/me/profile');
  return { emailAddress: typeof body.emailAddress === 'string' ? body.emailAddress : null };
}

/**
 * Search the mailbox with Gmail's own query syntax (`from:`, `subject:`,
 * `after:`, `is:unread`, `has:attachment`, `label:` …), sorted newest first. The list
 * call returns only ids, so each hit's headers are fetched — at most
 * {@link GMAIL_SEARCH_MAX_RESULTS} requests, in parallel. This is the Gmail
 * API's shape (its batch endpoint is multipart and not worth the parser at
 * this size), bounded by the cap rather than by the mailbox.
 */
export async function searchMessages(
  accessToken: string,
  params: { query: string; maxResults?: number },
): Promise<{ messages: GmailMessageSummary[]; hasMore: boolean }> {
  const maxResults = Math.min(Math.max(params.maxResults ?? GMAIL_SEARCH_DEFAULT_RESULTS, 1), GMAIL_SEARCH_MAX_RESULTS);
  const list = await gmailGet<{ messages?: { id: string }[]; nextPageToken?: string }>(accessToken, '/users/me/messages', {
    q: params.query,
    maxResults: String(maxResults),
  });
  const ids = (list.messages ?? []).map((m) => m.id);
  const found = await Promise.all(
    ids.map(async (id) =>
      parseMessageSummary(
        await gmailGet<GmailRawMessage>(accessToken, `/users/me/messages/${encodeURIComponent(id)}`, {
          format: 'metadata',
          metadataHeaders: METADATA_HEADERS,
        }),
      ),
    ),
  );
  // The list call is newest-first in practice but not by contract; the dates
  // are in hand now, so make the order we promise ("newest first") a fact.
  const messages = found.sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? '') || 0);
  return { messages, hasMore: Boolean(list.nextPageToken) };
}

/** One message in full: headers, plain-text body, attachment names. */
export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  const raw = await gmailGet<GmailRawMessage>(accessToken, `/users/me/messages/${encodeURIComponent(id)}`, {
    format: 'full',
  });
  return parseMessage(raw);
}

/** A conversation in full, oldest message first, capped at {@link GMAIL_THREAD_MAX_MESSAGES}. */
export async function getThread(
  accessToken: string,
  id: string,
): Promise<{ messages: GmailMessage[]; totalMessages: number }> {
  const raw = await gmailGet<{ messages?: GmailRawMessage[] }>(accessToken, `/users/me/threads/${encodeURIComponent(id)}`, {
    format: 'full',
  });
  const all = raw.messages ?? [];
  // A long thread repeats its quoted history; the newest messages are the ones that matter.
  return { messages: all.slice(-GMAIL_THREAD_MAX_MESSAGES).map(parseMessage), totalMessages: all.length };
}
