import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, service, agentStampForMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  service: {
    archive: vi.fn(),
    restore: vi.fn(),
    delete: vi.fn(),
    setAgentBinding: vi.fn(),
    rename: vi.fn(),
    setFeatured: vi.fn(),
    get: vi.fn(),
    publishVersion: vi.fn(),
  },
  agentStampForMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => WORKSPACE_ID),
  // insightErrorResponse checks this first, so the mock must provide it.
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { DELETE, PATCH, POST } from './route';
import {
  InsightEvidenceMarkerError,
  InsightNotFoundError,
  InsightValidationError,
} from '@/lib/services/insightService';

const WORKSPACE_ID = 'ws-test-1';
const INSIGHT_ID = 'insight-test-1';
const CHAT_ID = '11111111-2222-4333-8444-555555555555';
const URL = `http://localhost/api/insights/${INSIGHT_ID}`;
const params = () => ({ params: Promise.resolve({ id: INSIGHT_ID }) });
const req = (method: string, body?: unknown, query = '') =>
  new NextRequest(URL + query, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  for (const fn of Object.values(service)) fn.mockReset();
  agentStampForMock.mockReset();
  createContainerMock.mockReset().mockReturnValue({
    insightService: service,
    copilotChatsService: { agentStampFor: agentStampForMock },
  });
});

describe('DELETE /api/insights/[id]', () => {
  it('calls archive and not delete when ?hard=true is not passed', async () => {
    service.archive.mockResolvedValueOnce({ id: INSIGHT_ID, name: 'Insight 1' });

    const res = await DELETE(req('DELETE'), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: INSIGHT_ID, name: 'Insight 1' } });
    expect(service.archive).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID);
    expect(service.delete).not.toHaveBeenCalled();
  });

  it('calls delete and not archive when ?hard=true is passed', async () => {
    service.delete.mockResolvedValueOnce(undefined);

    const res = await DELETE(req('DELETE', undefined, '?hard=true'), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: INSIGHT_ID, deleted: true } });
    expect(service.delete).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID);
    expect(service.archive).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/insights/[id] agent_key', () => {
  const patch = (body: unknown) => PATCH(req('PATCH', body), params());

  it('binds the agent for the session user and returns { data }', async () => {
    const summary = { id: INSIGHT_ID, agent_key: 'bangun' };
    service.setAgentBinding.mockResolvedValueOnce(summary);

    const res = await patch({ agent_key: 'bangun' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: summary });
    expect(service.setAgentBinding).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID, 'bangun', 'u1');
  });

  it('passes an explicit null through to unbind', async () => {
    service.setAgentBinding.mockResolvedValueOnce({ id: INSIGHT_ID, agent_key: null });

    expect((await patch({ agent_key: null })).status).toBe(200);
    expect(service.setAgentBinding).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID, null, 'u1');
  });

  it('leaves the binding alone when agent_key is absent', async () => {
    service.rename.mockResolvedValueOnce({ id: INSIGHT_ID, name: 'New' });

    await patch({ name: 'New' });

    expect(service.setAgentBinding).not.toHaveBeenCalled();
    expect(service.rename).toHaveBeenCalled();
  });

  it.each([42, { key: 'bangun' }])('returns 400 without calling the service when agent_key is %j', async (value) => {
    const res = await patch({ agent_key: value });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'agent_key must be a string or null' });
    expect(service.setAgentBinding).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-object body', async () => {
    expect((await patch(['agent_key'])).status).toBe(400);
    expect(service.setAgentBinding).not.toHaveBeenCalled();
  });

  it('maps an unknown or deprecated agent (InsightValidationError) to 400', async () => {
    service.setAgentBinding.mockRejectedValueOnce(new InsightValidationError('Unknown sector agent "nope"'));

    const res = await patch({ agent_key: 'nope' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown sector agent "nope"' });
  });

  it('maps a missing or archived insight to 404', async () => {
    service.setAgentBinding.mockRejectedValueOnce(new InsightNotFoundError(INSIGHT_ID));
    expect((await patch({ agent_key: 'bangun' })).status).toBe(404);
  });
});

describe('POST /api/insights/[id]', () => {
  const post = (body: Record<string, unknown>) => POST(req('POST', body), params());

  beforeEach(() => {
    service.publishVersion.mockResolvedValue({ id: INSIGHT_ID, version_no: 2 });
  });

  it("stamps a version approved from a chat with that thread's agent", async () => {
    const stamp = { agentKey: 'bangun' };
    agentStampForMock.mockResolvedValue(stamp);

    const res = await post({ html: '<p>x</p>', chat_id: CHAT_ID });

    expect(res.status).toBe(200);
    expect(agentStampForMock).toHaveBeenCalledWith(CHAT_ID, 'u1');
    expect(service.publishVersion).toHaveBeenCalledWith(expect.objectContaining({ agentStamp: stamp }));
  });

  it('writes a null stamp when no chat is given', async () => {
    await post({ html: '<p>x</p>' });

    expect(agentStampForMock).not.toHaveBeenCalled();
    expect(service.publishVersion).toHaveBeenCalledWith(expect.objectContaining({ agentStamp: null }));
  });

  it("answers 400 with the correction when a @dikti card's markers are malformed (MB-543)", async () => {
    agentStampForMock.mockResolvedValue({ agentKey: 'dikti' });
    service.publishVersion.mockRejectedValue(new InsightEvidenceMarkerError('1 malformed evidence marker'));

    const res = await post({ html: '<p>x</p>', chat_id: CHAT_ID });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '1 malformed evidence marker' });
  });
});

describe('PATCH /api/insights/[id] with several fields', () => {
  it.each([
    ['name + agent_key', { name: 'New', agent_key: 'bangun' }],
    ['archive + name', { archive: true, name: 'New' }],
    ['restore + name', { archive: false, name: 'New' }],
    ['restore + is_featured', { archive: false, is_featured: true }],
    ['archive and is_archived that disagree', { archive: true, is_archived: false }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = await PATCH(req('PATCH', body), params());

    expect(res.status).toBe(400);
    for (const fn of [
      service.rename,
      service.setAgentBinding,
      service.setFeatured,
      service.archive,
      service.restore,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('PATCH /api/insights/[id] archive', () => {
  it('restores an archived insight for { archive: false } and returns { data }', async () => {
    const summary = { id: INSIGHT_ID, is_featured: false };
    service.restore.mockResolvedValueOnce(summary);

    const res = await PATCH(req('PATCH', { archive: false }), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: summary });
    expect(service.restore).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID);
    expect(service.archive).not.toHaveBeenCalled();
  });

  it('restores for the older spelling { is_archived: false }', async () => {
    service.restore.mockResolvedValueOnce({ id: INSIGHT_ID });

    await PATCH(req('PATCH', { is_archived: false }), params());

    expect(service.restore).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID);
  });

  it('archives for { archive: true }', async () => {
    service.archive.mockResolvedValueOnce({ id: INSIGHT_ID });

    await PATCH(req('PATCH', { archive: true }), params());

    expect(service.archive).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID);
    expect(service.restore).not.toHaveBeenCalled();
  });

  it('maps restoring a missing or live insight to 404', async () => {
    service.restore.mockRejectedValueOnce(new InsightNotFoundError(INSIGHT_ID));

    const res = await PATCH(req('PATCH', { archive: false }), params());

    expect(res.status).toBe(404);
  });
});


describe('POST /api/insights/[id] body guard', () => {
  it('returns 400, not 500, for a JSON null body', async () => {
    const res = await POST(req('POST', null), params());

    expect(res.status).toBe(400);
    expect(service.publishVersion).not.toHaveBeenCalled();
  });
});
