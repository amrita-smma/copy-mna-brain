import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TREG_MAX_COST_USD,
  TREG_PEOPLE_ENRICH_URL,
  TregError,
  enrichPerson,
} from './treg';

function response(
  body: unknown,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  process.env.TREG_API_KEY = 'tk_test';
});

afterEach(() => {
  delete process.env.TREG_API_KEY;
});

describe('enrichPerson', () => {
  it('posts only the non-empty identifiers with the token and a cost ceiling', async () => {
    fetchMock.mockResolvedValue(response({ output: { full_name: null } }));

    await enrichPerson(
      { email: 'jane@evercore.com', full_name: 'Jane Doe', linkedin_url: '', domain: undefined },
      fetchMock,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TREG_PEOPLE_ENRICH_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'X-Treg-Token': 'tk_test',
      'X-Treg-Route-Max-Cost': TREG_MAX_COST_USD,
    });
    expect(JSON.parse(init.body)).toEqual({ email: 'jane@evercore.com', full_name: 'Jane Doe' });
  });

  it('returns the person, provider, call id and cost on a hit', async () => {
    fetchMock.mockResolvedValue(
      response(
        { output: { full_name: 'Jane Doe', title: 'MD' }, _treg: { served_by: 'pdl.people.enrich' } },
        { headers: { 'x-treg-call-id': 'call-1', 'x-treg-cost-micro': '10000' } },
      ),
    );

    const result = await enrichPerson({ email: 'jane@evercore.com' }, fetchMock);

    expect(result).toEqual({
      person: { full_name: 'Jane Doe', title: 'MD' },
      servedBy: 'pdl.people.enrich',
      callId: 'call-1',
      costMicro: 10000,
    });
  });

  it('treats a 200 with no full_name as a miss rather than an error', async () => {
    fetchMock.mockResolvedValue(response({ output: { full_name: null } }));

    const result = await enrichPerson({ email: 'jane@evercore.com' }, fetchMock);

    expect(result.person).toBeNull();
    expect(result.costMicro).toBe(0);
  });

  it("throws a TregError carrying treg's detail on a non-2xx", async () => {
    fetchMock.mockResolvedValue(
      response({ detail: { error: 'route_max_cost' } }, { status: 402 }),
    );

    await expect(enrichPerson({ email: 'a@b.com' }, fetchMock)).rejects.toMatchObject({
      name: 'TregError',
      status: 402,
      message: expect.stringContaining('route_max_cost'),
    });
  });

  it('throws without calling treg when the API key is missing', async () => {
    delete process.env.TREG_API_KEY;

    await expect(enrichPerson({ email: 'a@b.com' }, fetchMock)).rejects.toBeInstanceOf(TregError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws without calling treg when there is nothing to match on', async () => {
    await expect(enrichPerson({ email: ' ', full_name: '' }, fetchMock)).rejects.toThrow(
      'No identifiers',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
