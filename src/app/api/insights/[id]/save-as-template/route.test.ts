import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, getInsightMock, createFromInsightMock, isWorkspaceAdminMock } = vi.hoisted(
  () => ({
    authMock: vi.fn(),
    createContainerMock: vi.fn(),
    getInsightMock: vi.fn(),
    createFromInsightMock: vi.fn(),
    isWorkspaceAdminMock: vi.fn(),
  }),
);

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace')>()),
  getActiveWorkspaceIdOrThrow: vi.fn(async () => WORKSPACE_ID),
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import { InsightNotFoundError } from '@/lib/services/insightService';
import { InsightTemplateValidationError } from '@/lib/services/insightTemplateService';

const WORKSPACE_ID = 'ws-test-1';
const INSIGHT_ID = 'insight-test-1';
const INSIGHT = { id: INSIGHT_ID, name: 'Insight Name', html: '<h1>Insight HTML</h1>' };

const post = (body: Record<string, unknown> = { name: 'Template Name' }) =>
  POST(
    new NextRequest(`http://localhost/api/insights/${INSIGHT_ID}/save-as-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: INSIGHT_ID }) },
  );

describe('POST /api/insights/[id]/save-as-template', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    getInsightMock.mockReset();
    createFromInsightMock.mockReset();
    isWorkspaceAdminMock.mockReset().mockResolvedValue(false);
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isWorkspaceAdmin: isWorkspaceAdminMock },
      insightService: { get: getInsightMock },
      insightTemplateService: { createFromInsight: createFromInsightMock },
    });
  });

  it('returns 201 with data and calls createFromInsight with insight html and auth userId', async () => {
    getInsightMock.mockResolvedValueOnce(INSIGHT);
    const createdTemplate = { id: 'tpl-1', name: 'Template Name' };
    createFromInsightMock.mockResolvedValueOnce(createdTemplate);

    const res = await post({ name: 'Template Name', description: 'Template Description' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: createdTemplate });
    expect(getInsightMock).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID);
    expect(createFromInsightMock).toHaveBeenCalledWith({
      name: 'Template Name',
      description: 'Template Description',
      html: '<h1>Insight HTML</h1>',
      userId: 'u1',
    });
  });

  it('returns 404 when the insight is not found', async () => {
    getInsightMock.mockRejectedValueOnce(new InsightNotFoundError(INSIGHT_ID));

    const res = await post();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Insight "${INSIGHT_ID}" not found` });
    expect(createFromInsightMock).not.toHaveBeenCalled();
  });

  it('returns 400 on a template validation error', async () => {
    getInsightMock.mockResolvedValueOnce(INSIGHT);
    createFromInsightMock.mockRejectedValueOnce(new InsightTemplateValidationError('Template name is required'));

    const res = await post({ name: '' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Template name is required' });
  });

  it('returns 401 when no session is present', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await post();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('lets a non-admin member save a template without an admin check', async () => {
    getInsightMock.mockResolvedValueOnce(INSIGHT);
    createFromInsightMock.mockResolvedValueOnce({ id: 'tpl-1', name: 'Template Name' });

    const res = await post({ name: 'Template Name' });

    expect(res.status).toBe(201);
    expect(isWorkspaceAdminMock).not.toHaveBeenCalled();
  });
});
