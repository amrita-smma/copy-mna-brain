import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { toPptx, getWorkspaceTemplate } = vi.hoisted(() => ({
  toPptx: vi.fn(),
  getWorkspaceTemplate: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({ workspaceService: { getPptxTemplate: getWorkspaceTemplate } })),
}));

vi.mock('@/lib/pptx/pipelinePresentationPptx', () => ({
  pipelinePresentationToPptx: toPptx,
  presentationFileName: () => 'pipeline-companies-2026-10-28.pptx',
}));

import { POST } from './route';
import { getPptxTemplate } from '@/lib/pptx/templates';

const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/pipeline/presentation/pptx', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const columns = [
  { label: 'No', align: 'left', width: 0.45 },
  { label: 'Company', align: 'left', width: 3 },
];
const row = ['1', 'Acme'];

beforeEach(() => {
  toPptx.mockReset().mockResolvedValue(Buffer.from('pptx'));
  getWorkspaceTemplate.mockReset().mockResolvedValue('starcapital');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/pipeline/presentation/pptx', () => {
  it('returns the deck as a .pptx attachment', async () => {
    const res = await post({ title: 'Pipeline Companies', subtitle: 'L1', columns, rows: [row] });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="pipeline-companies-2026-10-28.pptx"',
    );
    expect(toPptx).toHaveBeenCalledWith(
      { title: 'Pipeline Companies', subtitle: 'L1', columns, rows: [row] },
      getPptxTemplate('starcapital'),
    );
    expect(getWorkspaceTemplate).toHaveBeenCalledWith('ws-1');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('pptx');
  });

  it('rejects a malformed body with 400 and builds nothing', async () => {
    expect((await post({ title: 'T', subtitle: '', columns, rows: [['x']] })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect(toPptx).not.toHaveBeenCalled();
  });

  it('returns 500 when the deck cannot be written', async () => {
    toPptx.mockRejectedValue(new Error('boom'));
    const res = await post({ title: 'T', subtitle: '', columns, rows: [] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it("renders plain slides (no template) when the workspace uses the Default template", async () => {
    getWorkspaceTemplate.mockResolvedValue('default');
    const res = await post({ title: 'T', subtitle: '', columns, rows: [row] });
    expect(res.status).toBe(200);
    expect(toPptx).toHaveBeenCalledWith(expect.anything(), null);
  });
});
