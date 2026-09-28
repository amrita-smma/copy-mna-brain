import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockList, mockPrepareForMessage, mockReadPartForWorkforce, mockGetActiveWorkspaceId } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockPrepareForMessage: vi.fn(),
  mockReadPartForWorkforce: vi.fn(),
  mockGetActiveWorkspaceId: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mockGetActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({
    insightTemplateService: {
      list: mockList,
      prepareForMessage: mockPrepareForMessage,
      readPartForWorkforce: mockReadPartForWorkforce,
    },
  })),
}));

import { getInsightTemplate } from './get_insight_template';
import {
  formatInsightTemplateBlock,
  formatInsightTemplatePart,
  WORKFORCE_TEMPLATE_PART_CHARS,
} from '@/lib/insights/largeDocument';
import { CHAT_INLINE_DOCUMENT_MAX_CHARS } from '@/lib/insights/templateAttachment';

const MARKET_BRIEF = {
  id: '00000000-0000-0000-0000-00000000e001',
  name: 'Market Brief',
  description: 'Deal landscape and valuation benchmarks.',
};
const INVESTMENT_MEMO = {
  id: '00000000-0000-0000-0000-00000000e002',
  name: 'Investment Memo',
  description: null,
};
const REGULATORY_WATCH = {
  id: '00000000-0000-0000-0000-00000000e004',
  name: 'Regulatory Watch',
  description: null,
};

describe('getInsightTemplate', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockPrepareForMessage.mockReset();
    mockReadPartForWorkforce.mockReset();
    mockGetActiveWorkspaceId.mockReset();
    mockGetActiveWorkspaceId.mockResolvedValue('ws-1');
    mockList.mockResolvedValue([MARKET_BRIEF, INVESTMENT_MEMO, REGULATORY_WATCH]);
    mockPrepareForMessage.mockImplementation(async ({ id, name }: { id: string; name: string }) => ({
      type: 'text',
      text: `<insight_template id="${id}" name="${name}">BLOCK</insight_template>`,
    }));
  });

  it('returns the template block for an explicit template_id', async () => {
    const out = (await getInsightTemplate.invoke({ template_id: INVESTMENT_MEMO.id })) as string;

    expect(mockPrepareForMessage).toHaveBeenCalledWith({ id: INVESTMENT_MEMO.id, name: 'Investment Memo' });
    expect(out).toBe(`<insight_template id="${INVESTMENT_MEMO.id}" name="Investment Memo">BLOCK</insight_template>`);
  });

  it('never finds a soft-deleted template by name: it searches only the live listing', async () => {
    // service.list() is the live library; a deleted "Regulatory Watch" isn't in it.
    mockList.mockResolvedValueOnce([MARKET_BRIEF, INVESTMENT_MEMO]);

    const out = (await getInsightTemplate.invoke({ template_name: 'Regulatory Watch' })) as string;

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockPrepareForMessage).not.toHaveBeenCalled();
    expect(out).toContain('No insight template matches "Regulatory Watch"');
  });

  it('prefers template_id over template_name', async () => {
    await getInsightTemplate.invoke({ template_id: MARKET_BRIEF.id, template_name: 'Investment Memo' });

    expect(mockPrepareForMessage).toHaveBeenCalledWith({ id: MARKET_BRIEF.id, name: 'Market Brief' });
  });

  it('falls back to the name, with a note, when template_id is unknown', async () => {
    const out = (await getInsightTemplate.invoke({
      template_id: '99999999-9999-9999-9999-999999999999',
      template_name: 'market brief',
    })) as string;

    expect(mockPrepareForMessage).toHaveBeenCalledWith({ id: MARKET_BRIEF.id, name: 'Market Brief' });
    expect(out).toContain('does not match any template');
  });

  it('resolves a template by name', async () => {
    await getInsightTemplate.invoke({ template_name: 'Regulatory Watch' });

    expect(mockPrepareForMessage).toHaveBeenCalledWith({ id: REGULATORY_WATCH.id, name: 'Regulatory Watch' });
  });

  it('ignores a malformed template_id without reading any template', async () => {
    const out = (await getInsightTemplate.invoke({ template_id: 'not-a-uuid' })) as string;

    expect(mockPrepareForMessage).not.toHaveBeenCalled();
    expect(out).toContain('does not match any template');
    expect(out).toContain('Available insight templates');
  });

  it('lists candidates with their ids instead of guessing when the name is ambiguous', async () => {
    mockList.mockResolvedValue([
      { id: '00000000-0000-0000-0000-0000000000a1', name: 'Sector Brief Asia', description: null },
      { id: '00000000-0000-0000-0000-0000000000a2', name: 'Sector Brief Europe', description: null },
    ]);

    const out = (await getInsightTemplate.invoke({ template_name: 'Sector Brief' })) as string;

    expect(mockPrepareForMessage).not.toHaveBeenCalled();
    expect(out).toContain('Several insight templates match');
    expect(out).toContain('00000000-0000-0000-0000-0000000000a1');
    expect(out).toContain('00000000-0000-0000-0000-0000000000a2');
  });

  it('lists the available templates when the name matches nothing', async () => {
    const out = (await getInsightTemplate.invoke({ template_name: 'Quantum Widgets' })) as string;

    expect(mockPrepareForMessage).not.toHaveBeenCalled();
    expect(out).toContain('No insight template matches "Quantum Widgets"');
    expect(out).toContain(`Market Brief (id ${MARKET_BRIEF.id})`);
  });

  it('lists the available templates when called with nothing', async () => {
    const out = (await getInsightTemplate.invoke({})) as string;

    expect(mockPrepareForMessage).not.toHaveBeenCalled();
    expect(out).toContain('No insight template was specified');
  });

  it('reports a failed template listing instead of throwing', async () => {
    mockList.mockRejectedValue(new Error('db down'));

    const out = (await getInsightTemplate.invoke({ template_name: 'Market Brief' })) as string;

    expect(out).toContain('**Error:**');
  });
});

describe('getInsightTemplate — chat vs Workforce reads', () => {
  const WORKFORCE = { configurable: { agentRole: 'workforce' } };
  const CHAT = { configurable: { agentRole: 'chat' } };
  const TEMPLATE = { id: '00000000-0000-0000-0000-00000000e010', name: 'Huge Brief', description: null };
  // Two full parts plus a 5-character tail, with a keyed section up front.
  const HEAD = '<section data-section="summary"><h2>Summary</h2></section>';
  const HTML =
    HEAD +
    'a'.repeat(WORKFORCE_TEMPLATE_PART_CHARS - HEAD.length) +
    'b'.repeat(WORKFORCE_TEMPLATE_PART_CHARS) +
    'c'.repeat(5);

  beforeEach(() => {
    mockList.mockReset().mockResolvedValue([TEMPLATE]);
    mockGetActiveWorkspaceId.mockReset().mockResolvedValue('ws-1');
    // The service's formatting is pure; run the real formatters over HTML.
    mockPrepareForMessage.mockReset().mockImplementation(async (att: { id: string; name: string }) => ({
      type: 'text',
      text: formatInsightTemplateBlock(att, HTML),
    }));
    mockReadPartForWorkforce
      .mockReset()
      .mockImplementation(async (att: { id: string; name: string }, part: number) => ({
        type: 'text',
        text: formatInsightTemplatePart(att, HTML, part),
      }));
  });

  it('reads part 1 by default in a Workforce run, with the next-part header', async () => {
    const out = (await getInsightTemplate.invoke({ template_id: TEMPLATE.id }, WORKFORCE)) as string;

    expect(mockReadPartForWorkforce).toHaveBeenCalledWith({ id: TEMPLATE.id, name: 'Huge Brief' }, 1);
    expect(mockPrepareForMessage).not.toHaveBeenCalled();
    expect(out).toContain('part 1 of 3, chars 1–60,000 of 120,005; call again with part 2 until 3.');
    expect(out).toContain(HEAD);
    expect(out).not.toContain('b'.repeat(10));
  });

  it('reads a later part at the exact boundary', async () => {
    const out = (await getInsightTemplate.invoke({ template_id: TEMPLATE.id, part: 2 }, WORKFORCE)) as string;

    expect(out).toContain('part 2 of 3, chars 60,001–120,000 of 120,005');
    expect(out).toContain(`\n${'b'.repeat(WORKFORCE_TEMPLATE_PART_CHARS)}\n`);
    expect(out).not.toContain('a'.repeat(10));
  });

  it('says so on the last part', async () => {
    const out = (await getInsightTemplate.invoke({ template_name: 'Huge Brief', part: 3 }, WORKFORCE)) as string;

    expect(out).toContain('part 3 of 3, chars 120,001–120,005 of 120,005; this is the last part');
    expect(out).toContain('\nccccc\n');
  });

  it('refuses a part out of range, naming the valid range', async () => {
    const out = (await getInsightTemplate.invoke({ template_id: TEMPLATE.id, part: 4 }, WORKFORCE)) as string;

    expect(out).toContain('Part 4 is out of range');
    expect(out).toContain('a part from 1 to 3');
    expect(out).not.toContain('<template_html');
  });

  it('in chat, returns the outline and the handoff rule for a template over the chat cap — never the HTML', async () => {
    expect(HTML.length).toBeGreaterThan(CHAT_INLINE_DOCUMENT_MAX_CHARS);

    const out = (await getInsightTemplate.invoke({ template_id: TEMPLATE.id, part: 2 }, CHAT)) as string;

    expect(mockReadPartForWorkforce).not.toHaveBeenCalled();
    expect(mockPrepareForMessage).toHaveBeenCalledWith({ id: TEMPLATE.id, name: 'Huge Brief' });
    expect(out).toContain('status="too-large-for-chat"');
    expect(out).toContain('propose_workforce_handoff');
    expect(out).toContain(`template_id ${TEMPLATE.id}`);
    expect(out).toContain('[section: summary]');
    expect(out).not.toContain('a'.repeat(2_000));
  });

  it('reads as chat when no agent role is configured', async () => {
    await getInsightTemplate.invoke({ template_id: TEMPLATE.id });

    expect(mockPrepareForMessage).toHaveBeenCalled();
    expect(mockReadPartForWorkforce).not.toHaveBeenCalled();
  });
});
