import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockGetRunDraft, mockGetActiveWorkspaceId } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockGetRunDraft: vi.fn(),
  mockGetActiveWorkspaceId: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mockGetActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({
    insightService: {
      get: mockGet,
      getRunDraft: mockGetRunDraft,
    },
  })),
}));

import { getInsight, MAX_INSIGHT_READ_CHARS } from './get_insight';
import { CHAT_INLINE_DOCUMENT_MAX_CHARS } from '@/lib/insights/templateAttachment';

const INSIGHT_ID = '11111111-2222-3333-4444-555555555555';
const PAGE_CONTEXT = { pageContext: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID } };
const REFRESH = { configurable: { run_id: 'run-1', refresh_insight_id: INSIGHT_ID } };

function insight(overrides: Record<string, unknown> = {}) {
  return {
    id: INSIGHT_ID,
    name: 'Sector Brief',
    description: 'APAC semis',
    html: '<h1>Brief</h1>',
    version_no: 3,
    ...overrides,
  };
}

function invoke(args: Record<string, unknown>, config?: Record<string, unknown>): Promise<string> {
  return getInsight.invoke(args as never, config) as Promise<string>;
}

describe('getInsight', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue(insight());
    mockGetRunDraft.mockReset();
    mockGetActiveWorkspaceId.mockReset().mockResolvedValue('ws-1');
  });

  it('returns the current document for the insight in page context', async () => {
    const out = await invoke({}, { configurable: PAGE_CONTEXT });

    expect(mockGet).toHaveBeenCalledWith('ws-1', INSIGHT_ID);
    expect(mockGetRunDraft).not.toHaveBeenCalled();
    expect(out).toContain('<h1>Brief</h1>');
    expect(out).toContain('version 3');
    expect(out).toContain('Sector Brief');
    expect(out).not.toContain('TRUNCATED');
  });

  it("reports the document's length, so chat can tell whether it may rewrite it in one call", async () => {
    mockGet.mockResolvedValue(insight({ html: 'x'.repeat(25_000) }));

    const out = await invoke({}, { configurable: PAGE_CONTEXT });

    expect(out).toContain('Length: 25,000 characters');
  });

  it('prefers an explicit insight_id over page context', async () => {
    const other = '99999999-8888-7777-6666-555555555555';

    await invoke({ insight_id: other }, { configurable: PAGE_CONTEXT });

    expect(mockGet).toHaveBeenCalledWith('ws-1', other);
  });

  it('explains itself rather than throwing when no insight is open outside a refresh run', async () => {
    const out = await invoke({}, { configurable: { pageContext: { tabSlug: 'insight', path: '/insight' } } });

    expect(out).toContain('no insight is currently open');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('rejects a malformed id without hitting the database', async () => {
    const out = await invoke({ insight_id: 'not-a-uuid' });

    expect(out).toContain('not a valid UUID');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reports a missing insight instead of surfacing the service error', async () => {
    mockGet.mockRejectedValue(new Error('InsightNotFoundError'));

    expect(await invoke({ insight_id: INSIGHT_ID })).toContain('not found in this workspace');
  });

  it('returns only an outline and the Workforce handoff instruction in chat when the insight is over the chat cap', async () => {
    const html = `<section data-section="scope-rail"><h2>Scope rail</h2>${'<p>filler</p>'.repeat(3_000)}</section>`;
    mockGet.mockResolvedValue(insight({ html }));

    const out = await invoke({}, { configurable: PAGE_CONTEXT });

    expect(html.length).toBeGreaterThan(CHAT_INLINE_DOCUMENT_MAX_CHARS);
    expect(out).toContain('Sector Brief');
    expect(out).toContain('version 3');
    expect(out).toContain(`Length: ${html.length.toLocaleString('en-US')} characters`);
    expect(out).toContain('too large to edit whole in chat');
    expect(out).toContain('edit it in chat by section');
    expect(out).toContain('Do NOT call propose_insight_edit');
    expect(out).toContain('propose_workforce_handoff');
    expect(out).toContain(`insight_id ${INSIGHT_ID}`);
    expect(out).toContain('<insight_outline>');
    expect(out).toContain('scope-rail');
    expect(out).not.toContain('<p>filler</p>');
    expect(out).not.toContain('Current document:');
  });

  it('returns the full document in chat at exactly the chat cap', async () => {
    const html = 'x'.repeat(CHAT_INLINE_DOCUMENT_MAX_CHARS);
    mockGet.mockResolvedValue(insight({ html }));

    const out = await invoke({}, { configurable: PAGE_CONTEXT });

    expect(out).toContain('Current document:');
    expect(out).toContain(html);
    expect(out).not.toContain('<insight_outline>');
  });

  it('returns the full document of a large insight to a Workforce run', async () => {
    const html = 'y'.repeat(CHAT_INLINE_DOCUMENT_MAX_CHARS * 2);
    mockGet.mockResolvedValue(insight({ html }));

    const out = await invoke({ insight_id: INSIGHT_ID }, { configurable: { agentRole: 'workforce' } });

    expect(out).toContain('Current document:');
    expect(out).toContain(html);
    expect(out).not.toContain('<insight_outline>');
  });

  it('warns against a wholesale edit when the document is truncated', async () => {
    mockGet.mockResolvedValue(insight({ html: '<p>'.repeat(MAX_INSIGHT_READ_CHARS) }));

    const out = await invoke({ insight_id: INSIGHT_ID }, { configurable: { agentRole: 'workforce' } });

    expect(out).toContain('TRUNCATED');
    expect(out).toContain('Do NOT submit an edit built from this fragment');
  });

  it.each(['report', 'document'])('states the insight kind in the returned text for a %s', async (kind) => {
    mockGet.mockResolvedValue(insight({ kind }));

    expect(await invoke({ insight_id: INSIGHT_ID })).toContain(`Kind: ${kind}`);
  });

  it('reads refresh_insight_id in a refresh run and returns the current version when there is no draft', async () => {
    mockGet.mockResolvedValue(insight({ html: '<h1>Current HTML</h1>', version_no: 2 }));
    mockGetRunDraft.mockResolvedValue(undefined);

    const out = await invoke({}, REFRESH);

    expect(mockGet).toHaveBeenCalledWith('ws-1', INSIGHT_ID);
    expect(mockGetRunDraft).toHaveBeenCalledWith('ws-1', 'run-1');
    expect(out).toContain(`Insight: Sector Brief (id ${INSIGHT_ID}, version 2)`);
    expect(out).toContain('<h1>Current HTML</h1>');
    expect(out).not.toContain('unpublished draft');
  });

  it('returns draft html and unpublished draft header when draft exists in a refresh run', async () => {
    mockGet.mockResolvedValue(insight({ html: '<h1>Old Live Version</h1>', version_no: 2 }));
    mockGetRunDraft.mockResolvedValue({
      run_id: 'run-1',
      workspace_id: 'ws-1',
      insight_id: INSIGHT_ID,
      base_version_no: 2,
      html: '<h1>Draft HTML from Refresh Run</h1>',
    });

    const out = await invoke({ insight_id: INSIGHT_ID }, REFRESH);

    expect(out).toContain(
      `Insight: Sector Brief (id ${INSIGHT_ID}, unpublished draft for this refresh run, based on version 2)`,
    );
    expect(out).toContain('<h1>Draft HTML from Refresh Run</h1>');
    expect(out).not.toContain('<h1>Old Live Version</h1>');
  });

  it('returns the full draft of a large insight in a refresh run', async () => {
    const html = 'z'.repeat(CHAT_INLINE_DOCUMENT_MAX_CHARS * 2);
    mockGet.mockResolvedValue(insight({ version_no: 2 }));
    mockGetRunDraft.mockResolvedValue({ run_id: 'run-1', insight_id: INSIGHT_ID, base_version_no: 2, html });

    const out = await invoke({}, REFRESH);

    expect(out).toContain(html);
    expect(out).not.toContain('<insight_outline>');
  });

  it('never calls getRunDraft in a non-refresh run', async () => {
    await invoke({ insight_id: INSIGHT_ID }, { configurable: { run_id: 'run-1' } });

    expect(mockGetRunDraft).not.toHaveBeenCalled();
  });

  describe('one section', () => {
    const DOC =
      '<!DOCTYPE html><html><body>' +
      '<section data-section="summary"><h2>Summary</h2><p>Up 4%.</p></section>' +
      '<section data-section="risks"><ul><li>FX</li></ul></section>' +
      '</body></html>';

    it('returns only that block, with the instruction to propose it back by section', async () => {
      mockGet.mockResolvedValue(insight({ html: DOC }));

      const out = await invoke({ section: 'risks' }, { configurable: PAGE_CONTEXT });

      expect(out).toContain('Section: risks (');
      expect(out).toContain('<section data-section="risks"><ul><li>FX</li></ul></section>');
      expect(out).not.toContain('<h2>Summary</h2>');
      expect(out).toContain('propose_insight_edit with section: "risks"');
      expect(out).toContain('keep data-section="risks"');
      expect(out).not.toContain('Current document:');
    });

    it('reads one block of an insight too large to read whole in chat, instead of the outline', async () => {
      const big = DOC.replace('</body>', `<section data-section="appendix">${'<p>filler</p>'.repeat(3_000)}</section></body>`);
      mockGet.mockResolvedValue(insight({ html: big }));

      const out = await invoke({ section: 'summary' }, { configurable: PAGE_CONTEXT });

      expect(big.length).toBeGreaterThan(CHAT_INLINE_DOCUMENT_MAX_CHARS);
      expect(out).toContain('<section data-section="summary"><h2>Summary</h2><p>Up 4%.</p></section>');
      expect(out).not.toContain('<insight_outline>');
      expect(out).not.toContain('<p>filler</p>');
    });

    it('withholds a block that is itself too large for chat and sends that block to the Workforce', async () => {
      const big = DOC.replace('</body>', `<section data-section="appendix">${'<p>filler</p>'.repeat(3_000)}</section></body>`);
      mockGet.mockResolvedValue(insight({ html: big }));

      const out = await invoke({ section: 'appendix' }, { configurable: PAGE_CONTEXT });

      expect(out).toContain('Section "appendix" alone is');
      expect(out).toContain('propose_workforce_handoff');
      expect(out).toContain(`insight_id ${INSIGHT_ID}`);
      expect(out).toContain('section appendix');
      expect(out).toContain('<insight_section_outline>');
      expect(out).not.toContain('<p>filler</p>');
    });

    it('returns the whole oversized block in a Workforce run', async () => {
      const big = DOC.replace('</body>', `<section data-section="appendix">${'<p>filler</p>'.repeat(3_000)}</section></body>`);
      mockGet.mockResolvedValue(insight({ html: big }));

      const out = await invoke({ section: 'appendix' }, { configurable: { ...PAGE_CONTEXT, agentRole: 'workforce' } });

      expect(out).toContain('<p>filler</p>');
      expect(out).toContain('edit_insight_section with section "appendix"');
    });

    it('lists the keys the document has when the section is not there', async () => {
      mockGet.mockResolvedValue(insight({ html: DOC }));

      const out = await invoke({ section: 'outlook' }, { configurable: PAGE_CONTEXT });

      expect(out).toContain('Section "outlook": Section "outlook" not found in document.');
      expect(out).toContain('"summary", "risks"');
      expect(out).not.toContain('<h2>Summary</h2>');
    });

    it('says a document with no keys must be read whole', async () => {
      mockGet.mockResolvedValue(insight({ html: '<p>no keys</p>' }));

      const out = await invoke({ section: 'summary' }, { configurable: PAGE_CONTEXT });

      expect(out).toContain('has no data-section keys');
      expect(out).toContain('omit `section`');
    });

    it('sends a keyless document that is too large for chat to the Workforce instead of a whole read', async () => {
      mockGet.mockResolvedValue(insight({ html: `<div>${'<p>filler</p>'.repeat(3_000)}</div>` }));

      const out = await invoke({ section: 'summary' }, { configurable: PAGE_CONTEXT });

      expect(out).toContain('has no data-section keys');
      expect(out).toContain('too large to edit whole in chat');
      expect(out).toContain('propose_workforce_handoff');
      expect(out).not.toContain('omit `section`');
    });

    it('rejects a key that is not a data-section key without hitting the database', async () => {
      const out = await invoke({ section: 'bad key!' }, { configurable: PAGE_CONTEXT });

      expect(out).toContain('is not a data-section key');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('reads the section from the refresh run draft when there is one', async () => {
      mockGet.mockResolvedValue(insight({ html: DOC }));
      mockGetRunDraft.mockResolvedValue({
        insight_id: INSIGHT_ID,
        base_version_no: 3,
        html: DOC.replace('Up 4%.', 'Up 9%.'),
      });

      const out = await invoke({ section: 'summary' }, REFRESH);

      expect(out).toContain('unpublished draft for this refresh run');
      expect(out).toContain('Up 9%.');
    });
  });
});
