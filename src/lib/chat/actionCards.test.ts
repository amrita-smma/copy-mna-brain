import { describe, it, expect } from 'vitest';
import { BOT_ROUTINE_APPROVAL_MARKER } from '@/lib/bots/approval';
import { INSIGHT_REFRESH_APPROVAL_MARKER, encodeApprovalMarker } from '@/lib/insights/approvalMarker';
import { OPTION_CARD_MARKER } from '@/lib/chat/optionCards';
import {
  ACTION_CARD_SUMMARY_MAX_CHARS,
  cardDecisionContext,
  findActionCards,
  type ActionCardForContext,
} from './actionCards';

function toolPart(toolName: string, content: string, toolCallId = `call-${toolName}`) {
  return {
    type: 'dynamic-tool',
    toolCallId,
    toolName,
    state: 'output-available',
    input: {},
    output: { kwargs: { content } },
  };
}

describe('findActionCards', () => {
  it('finds base64-encoded and raw-JSON cards, with their ids and summaries, in order', () => {
    const parts = [
      { type: 'text', text: 'Here you go.' },
      toolPart(
        'propose_insight_refresh',
        `Offered.\n${encodeApprovalMarker(INSIGHT_REFRESH_APPROVAL_MARKER, {
          approval_id: 'ap-1',
          insight_id: 'ins-1',
          reason: 'Revenue is stale',
        })}`,
      ),
      toolPart(
        'propose_bulk_drop_companies',
        `Proposed.\n<!-- BULK_DROP_APPROVAL_JSON:${JSON.stringify({
          approval_id: 'ap-2',
          title: 'Stale watchlist',
          candidates: [{ id: 'c1' }, { id: 'c2' }],
        })} -->`,
      ),
      toolPart(
        'propose_workforce_handoff',
        `<!-- WORKFORCE_HANDOFF_JSON:${JSON.stringify({ handoff_id: 'h-1', title: 'Deep dive' })} -->`,
      ),
    ];

    expect(findActionCards(parts)).toEqual([
      {
        cardId: 'ap-1',
        toolName: 'propose_insight_refresh',
        toolCallId: 'call-propose_insight_refresh',
        summary: 'Refresh insight ins-1: Revenue is stale',
      },
      {
        cardId: 'ap-2',
        toolName: 'propose_bulk_drop_companies',
        toolCallId: 'call-propose_bulk_drop_companies',
        summary: 'Drop 2 companies: Stale watchlist',
      },
      {
        cardId: 'h-1',
        toolName: 'propose_workforce_handoff',
        toolCallId: 'call-propose_workforce_handoff',
        summary: 'Hand off to the Workforce: Deep dive',
      },
    ]);
  });

  it('reads a card from a plain string output and names a routine card by its title', () => {
    const part = {
      ...toolPart('propose_create_routine', ''),
      output: encodeApprovalMarker(BOT_ROUTINE_APPROVAL_MARKER, {
        approval_id: 'ap-3',
        bot_name: 'Scout',
        input: { title: 'Morning pipeline' },
      }),
    };
    expect(findActionCards([part])).toMatchObject([
      { cardId: 'ap-3', summary: 'Schedule routine "Morning pipeline" on Scout' },
    ]);
  });

  it('skips non-card tools, corrupt markers, missing ids and a card seen twice', () => {
    const option = encodeApprovalMarker(OPTION_CARD_MARKER, { card_id: 'o-1', question: 'Which?' });
    const parts = [
      toolPart('web_search', 'results'),
      toolPart('message_bot', 'sent'),
      toolPart('propose_bulk_drop_companies', '<!-- BULK_DROP_APPROVAL_JSON:{not json -->'),
      toolPart('propose_insight_refresh', encodeApprovalMarker(INSIGHT_REFRESH_APPROVAL_MARKER, { reason: 'x' })),
      toolPart('offer_options', option, 'a'),
      toolPart('offer_options', option, 'b'),
      { type: 'dynamic-tool', toolName: 'offer_options', state: 'input-available' },
      null,
    ];
    expect(findActionCards(parts).map((c) => c.cardId)).toEqual(['o-1']);
  });

  it('flattens and clips a long summary', () => {
    const question = `Which\n\n${'option '.repeat(100)}`;
    const [card] = findActionCards([
      toolPart('offer_options', encodeApprovalMarker(OPTION_CARD_MARKER, { card_id: 'o-2', question })),
    ]);
    expect(card.summary.length).toBe(ACTION_CARD_SUMMARY_MAX_CHARS);
    expect(card.summary).not.toContain('\n');
    expect(card.summary.endsWith('…')).toBe(true);
  });
});

describe('cardDecisionContext', () => {
  const card = (over: Partial<ActionCardForContext>): ActionCardForContext => ({
    card_id: 'ap-1',
    tool_name: 'propose_bulk_drop_companies',
    summary: 'Drop 2 companies: Stale',
    status: 'pending',
    resolution_text: null,
    decision_data: null,
    decided_at: null,
    ...over,
  });

  it('returns null when the chat has no cards', () => {
    expect(cardDecisionContext([])).toBeNull();
  });

  it('names each card with its decision, its detail, or that it is still waiting', () => {
    const text = cardDecisionContext([
      card({
        status: 'accepted',
        resolution_text: 'Dropped 2 companies.',
        decision_data: { company_ids: ['c1', 'c2'] },
        decided_at: '2026-10-28T09:00:00Z',
      }),
      card({ card_id: 'ap-2', status: 'declined', resolution_text: 'Kept all.' }),
      card({ card_id: 'ap-3' }),
    ])!;

    expect(text).toContain('[propose_bulk_drop_companies · ap-1] Drop 2 companies: Stale');
    expect(text).toContain('→ Accepted by the user (2026-10-28T09:00:00Z): Dropped 2 companies.');
    expect(text).toContain('Detail: {"company_ids":["c1","c2"]}');
    expect(text).toContain('[propose_bulk_drop_companies · ap-2]');
    expect(text).toContain('→ Declined by the user: Kept all.');
    expect(text).toContain('[propose_bulk_drop_companies · ap-3] Drop 2 companies: Stale\n  → Still waiting on the user.');
  });
});
