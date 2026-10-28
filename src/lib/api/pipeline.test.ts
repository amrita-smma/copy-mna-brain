import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({
  apiRequest: apiRequestMock,
  buildWorkspaceHeaders: (_target: unknown, existing?: Record<string, string>) => ({
    ...existing,
    'X-Workspace-Slug': 'acme',
  }),
}));

import { downloadPipelinePresentationPptx, getCompaniesCount, startAIScreening } from './pipeline';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue({ count: 3 });
});

describe('getCompaniesCount', () => {
  it('sends source and excludeDropped so the count matches the Pending Confirmation tab', async () => {
    const count = await getCompaniesCount({
      stage: 'unreviewed',
      source: 'inbound',
      excludeDropped: true,
    });

    expect(count).toBe(3);
    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/companies?countOnly=true&stage=unreviewed&source=inbound&excludeDropped=true',
    );
  });

  it('omits filters that were not given', async () => {
    await getCompaniesCount({ stage: 'market_screening' });

    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/companies?countOnly=true&stage=market_screening',
    );
  });
});

describe('startAIScreening', () => {
  it('queues the company’s screening with one POST', async () => {
    await startAIScreening('c1');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/ai-screening', {
      method: 'POST',
      body: JSON.stringify({ companyId: 'c1' }),
    });
  });
});

describe('downloadPipelinePresentationPptx', () => {
  const deck = {
    title: 'Pipeline Companies',
    subtitle: 'L1',
    columns: [{ label: 'No', align: 'left' as const, width: 0.45 }],
    rows: [],
  };

  it('posts the deck with the workspace header and returns the file with the server-given name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(['pptx']), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="pipeline-companies-2026-10-28.pptx"' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { blob, fileName } = await downloadPipelinePresentationPptx(deck);

    // The workspace header, so the server brands the deck for this tab's workspace.
    expect(fetchMock).toHaveBeenCalledWith('/api/pipeline/presentation/pptx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Slug': 'acme' },
      body: JSON.stringify(deck),
    });
    expect(fileName).toBe('pipeline-companies-2026-10-28.pptx');
    expect(await blob.text()).toBe('pptx');
    vi.unstubAllGlobals();
  });

  it("throws the server's error message on failure", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'Invalid presentation' }, { status: 400 })),
    );
    await expect(downloadPipelinePresentationPptx(deck)).rejects.toThrow('Invalid presentation');
    vi.unstubAllGlobals();
  });
});
