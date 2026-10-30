import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDraft,
  getMessage,
  getProfile,
  getThread,
  GMAIL_SEARCH_MAX_RESULTS,
  GMAIL_THREAD_MAX_MESSAGES,
  GmailApiError,
  GmailUnauthorizedError,
  searchMessages,
} from './api';

const fetchMock = vi.fn();

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const urlOf = (call: number) => new URL(String(fetchMock.mock.calls[call]![0]));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('getProfile', () => {
  it('sends the bearer token and returns the mailbox address', async () => {
    fetchMock.mockResolvedValue(json({ emailAddress: 'me@gmail.com' }));
    expect(await getProfile('tok')).toEqual({ emailAddress: 'me@gmail.com' });
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer tok');
    expect(urlOf(0).pathname).toBe('/gmail/v1/users/me/profile');
  });
});

describe('searchMessages', () => {
  it('lists ids once, then fetches each hit’s headers only (no bodies)', async () => {
    fetchMock.mockImplementation(async (url: URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/messages')) return json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'n' });
      return json({ id: u.pathname.split('/').pop(), snippet: 's', payload: { headers: [{ name: 'Subject', value: 'S' }] } });
    });

    const out = await searchMessages('tok', { query: 'from:alice is:unread', maxResults: 2 });

    expect(out.hasMore).toBe(true);
    expect(out.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(out.messages[0]!.subject).toBe('S');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOf(0).searchParams.get('q')).toBe('from:alice is:unread');
    expect(urlOf(0).searchParams.get('maxResults')).toBe('2');
    expect(urlOf(1).searchParams.get('format')).toBe('metadata');
    expect(urlOf(1).searchParams.getAll('metadataHeaders')).toEqual(['From', 'To', 'Subject', 'Date']);
  });

  it('returns hits newest first whatever order the list and the parallel fetches settle in', async () => {
    const dates: Record<string, string> = { a: '2026-10-01', b: '2026-10-03', c: '2026-10-02' };
    fetchMock.mockImplementation(async (url: URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/messages')) return json({ messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
      const id = u.pathname.split('/').pop()!;
      return json({ id, internalDate: String(Date.parse(dates[id]!)), payload: {} });
    });
    const out = await searchMessages('tok', { query: '' });
    expect(out.messages.map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns nothing without further calls when nothing matches', async () => {
    fetchMock.mockResolvedValue(json({ resultSizeEstimate: 0 }));
    expect(await searchMessages('tok', { query: 'zzz' })).toEqual({ messages: [], hasMore: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps the page size so one search is a bounded number of requests', async () => {
    fetchMock.mockResolvedValue(json({}));
    await searchMessages('tok', { query: '', maxResults: 500 });
    expect(urlOf(0).searchParams.get('maxResults')).toBe(String(GMAIL_SEARCH_MAX_RESULTS));
  });
});

describe('getMessage / getThread', () => {
  it('reads a message in full format and encodes the id', async () => {
    fetchMock.mockResolvedValue(
      json({ id: 'm/1', payload: { mimeType: 'text/plain', body: { data: b64('hi') } } }),
    );
    const msg = await getMessage('tok', 'm/1');
    expect(msg.body).toBe('hi');
    expect(urlOf(0).pathname).toBe('/gmail/v1/users/me/messages/m%2F1');
    expect(urlOf(0).searchParams.get('format')).toBe('full');
  });

  it('keeps only the newest messages of a long thread but reports the real count', async () => {
    const messages = Array.from({ length: GMAIL_THREAD_MAX_MESSAGES + 5 }, (_, i) => ({
      id: `m${i}`,
      payload: { mimeType: 'text/plain', body: { data: b64(`body ${i}`) } },
    }));
    fetchMock.mockResolvedValue(json({ messages }));

    const out = await getThread('tok', 't1');

    expect(out.totalMessages).toBe(GMAIL_THREAD_MAX_MESSAGES + 5);
    expect(out.messages).toHaveLength(GMAIL_THREAD_MAX_MESSAGES);
    expect(out.messages.at(-1)!.id).toBe(`m${GMAIL_THREAD_MAX_MESSAGES + 4}`);
    expect(out.messages[0]!.id).toBe('m5');
  });
});

describe('createDraft', () => {
  it('POSTs the raw message to drafts.create and returns the draft ids', async () => {
    fetchMock.mockResolvedValue(json({ id: 'r123', message: { id: 'm9', threadId: 't9' } }));
    expect(await createDraft('tok', 'cmF3')).toEqual({ draftId: 'r123', messageId: 'm9', threadId: 't9' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/gmail/v1/users/me/drafts');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ message: { raw: 'cmF3' } });
  });

  it('never sends: no send endpoint is called, and reads stay GETs', async () => {
    fetchMock.mockResolvedValue(json({ id: 'r1' }));
    await createDraft('tok', 'x');
    expect(String(fetchMock.mock.calls[0]![0])).not.toMatch(/send/i);
    fetchMock.mockResolvedValue(json({ emailAddress: 'me@gmail.com' }));
    await getProfile('tok');
    expect(fetchMock.mock.calls[1]![1].method).toBe('GET');
  });

  it('rejects a response with no draft id, and maps 401 / 403 like any other call', async () => {
    fetchMock.mockResolvedValue(json({}));
    await expect(createDraft('tok', 'x')).rejects.toBeInstanceOf(GmailApiError);
    fetchMock.mockResolvedValue(json({ error: { message: 'bad' } }, 401));
    await expect(createDraft('tok', 'x')).rejects.toBeInstanceOf(GmailUnauthorizedError);
    fetchMock.mockResolvedValue(json({ error: { message: 'Request had insufficient authentication scopes.' } }, 403));
    await expect(createDraft('tok', 'x')).rejects.toMatchObject({ status: 403 });
  });
});

describe('errors', () => {
  it('maps 401 to GmailUnauthorizedError so the service can refresh and retry', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'Invalid Credentials' } }, 401));
    await expect(getProfile('tok')).rejects.toBeInstanceOf(GmailUnauthorizedError);
  });

  it("carries Google's message, status and Retry-After on other failures", async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'Rate Limit Exceeded' } }, 429, { 'retry-after': '12' }));
    const err = await getProfile('tok').catch((e) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err).toMatchObject({ status: 429, message: 'Rate Limit Exceeded', retryAfterSeconds: 12 });
  });

  it('falls back to the HTTP status for a non-JSON failure', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 503 }));
    const err = await getProfile('tok').catch((e) => e);
    expect(err).toMatchObject({ status: 503, message: 'HTTP 503', retryAfterSeconds: null });
  });
});
