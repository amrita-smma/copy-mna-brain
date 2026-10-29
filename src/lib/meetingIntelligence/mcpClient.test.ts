import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meetingIntelligenceEndpoints } from './config';
import { callMcpTool, listMcpTools, McpHttpError, McpRpcError, McpUnauthorizedError } from './mcpClient';

const endpoints = meetingIntelligenceEndpoints('https://mi.test');

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('callMcpTool', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts a tools/call JSON-RPC request with the bearer token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { structuredContent: { items: [1] }, content: [{ type: 'text', text: '{"items":[1]}' }] },
      }),
    );

    const result = await callMcpTool(endpoints, 'tok', 'get_my_action_items', { status: 'delayed' });

    expect(result).toEqual({ structuredContent: { items: [1] }, text: '{"items":[1]}', isError: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://mi.test/api/mcp');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers.Accept).toBe('application/json, text/event-stream');
    const body = JSON.parse(init.body as string);
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'get_my_action_items', arguments: { status: 'delayed' } });
  });

  it('parses an SSE-framed answer', async () => {
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } })}\n\n`;
    fetchMock.mockResolvedValue(new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
    const result = await callMcpTool(endpoints, 'tok', 'whoami', {});
    expect(result.text).toBe('hi');
    expect(result.structuredContent).toBeNull();
  });

  it('reports a tool-level failure through isError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'bad date' }] } }),
    );
    expect(await callMcpTool(endpoints, 'tok', 'get_meeting', {})).toMatchObject({ isError: true, text: 'bad date' });
  });

  it('throws McpUnauthorizedError on 401', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    await expect(callMcpTool(endpoints, 'tok', 'whoami', {})).rejects.toBeInstanceOf(McpUnauthorizedError);
  });

  it('throws McpHttpError with Retry-After on 429', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '12' } }));
    const err = await callMcpTool(endpoints, 'tok', 'whoami', {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(12);
  });

  it('explains a 404 as the integration being off on their side', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    await expect(callMcpTool(endpoints, 'tok', 'whoami', {})).rejects.toThrow(/turned off on their side/);
  });

  it('throws McpRpcError for a JSON-RPC error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }),
    );
    const err = await callMcpTool(endpoints, 'tok', 'list_meetings', { bogus: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(McpRpcError);
    expect(err.code).toBe(-32602);
  });
});

describe('listMcpTools', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the tool definitions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'whoami', inputSchema: {} }] } }),
      ),
    );
    expect(await listMcpTools(endpoints, 'tok')).toEqual([{ name: 'whoami', inputSchema: {} }]);
  });
});
