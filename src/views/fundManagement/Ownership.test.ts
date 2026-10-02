import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OwnershipContext, CorporateActionView } from '@/lib/api/fundLedger';
import {
  groupDigits,
  OwnershipDisabledNotice,
  OwnershipTables,
  ownershipTabState,
  ungroupDigits,
} from './Ownership';

const noop = () => {};

function event(over: Partial<CorporateActionView>): CorporateActionView {
  return {
    id: 'e',
    asset_id: 'asset-1',
    action_type: 'funding_round',
    action_date: '2026-06-30',
    label: null,
    currency: null,
    pre_money: null,
    round_size: null,
    post_money: null,
    notes: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    stale: false,
    changes: [],
    ...over,
  };
}

function part(
  positionId: string,
  holder: string,
  before: string,
  after: string,
  followOn = '0',
  english: string | null = null,
) {
  return {
    id: `${positionId}-${after}`,
    position_id: positionId,
    holder_name: holder,
    holder_english_name: english,
    pct_before: before,
    follow_on_amount: followOn,
    pct_after: after,
    pct_override: null,
    override_remark: null,
    effective_pct: after,
    implied_value: null,
  };
}

// The shape the scratch-DB probe produced: an opening stake, then a Series B
// that went stale when the opening stake was edited.
const ctx: OwnershipContext = {
  asset: { id: 'asset-1', name: 'CycleCraft', asset_kind: 'equity' },
  positions: [
    {
      position_id: 'pA',
      holder_kind: 'fund',
      holder_id: 'f1',
      holder_name: '瑞来',
      holder_english_name: 'Ruilai Fund',
      current_pct: '6.80000000',
      current_pct_as_of: '2026-06-30',
      current_pct_source: 'ownership',
      current_pct_event_id: 'series-b',
      opened_at: null,
    },
    {
      position_id: 'pB',
      holder_kind: 'fund',
      holder_id: 'f2',
      holder_name: '瑞满',
      holder_english_name: null,
      current_pct: '3.20000000',
      current_pct_as_of: '2026-06-30',
      current_pct_source: 'ownership',
      current_pct_event_id: 'series-b',
      opened_at: null,
    },
    {
      position_id: 'pC',
      holder_kind: 'fund',
      holder_id: 'f3',
      holder_name: 'Ray Ying',
      holder_english_name: null,
      current_pct: null,
      current_pct_as_of: null,
      current_pct_source: null,
      current_pct_event_id: null,
      opened_at: null,
    },
  ],
  actions: [
    event({
      id: 'open',
      action_type: 'opening_stake',
      action_date: '2026-01-15',
      label: 'Initial investment',
      changes: [part('pA', '瑞来', '0', '7.00000000'), part('pB', '瑞满', '0', '4.00000000')],
    }),
    event({
      id: 'series-b',
      label: 'Series B',
      currency: 'CNY',
      pre_money: '1000000000.00000000',
      round_size: '250000000.00000000',
      post_money: '1250000000.00000000',
      stale: true,
      changes: [
        part('pA', '瑞来', '6.00000000', '6.80000000', '25000000.00000000', 'Ruilai Fund'),
        part('pB', '瑞满', '4.00000000', '3.20000000'),
      ],
    }),
  ],
};

function render(c: OwnershipContext): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(OwnershipTables, { ctx: c, onRecord: noop, onEdit: noop, onDelete: noop }),
    ),
  );
}

describe('ownershipTabState', () => {
  const company = { id: 'asset-1', targetKind: 'asset' as const };

  it('shows the tab disabled unless the setting is explicitly on', () => {
    expect(ownershipTabState({}, company)).toBe('disabled');
    expect(ownershipTabState({ CORPORATE_ACTIONS_ENABLED: false }, company)).toBe('disabled');
    expect(ownershipTabState({ CORPORATE_ACTIONS_ENABLED: true }, company)).toBe('enabled');
  });

  it('hides the tab for fund-of-funds targets and unsaved holdings, whatever the setting', () => {
    for (const flags of [{}, { CORPORATE_ACTIONS_ENABLED: true }]) {
      expect(ownershipTabState(flags, { id: 'fund-1', targetKind: 'fund' })).toBe('hidden');
      expect(ownershipTabState(flags, { id: undefined, targetKind: 'asset' })).toBe('hidden');
    }
  });
});

describe('OwnershipDisabledNotice', () => {
  it('says the feature is off and where an admin turns it on', () => {
    const html = renderToStaticMarkup(React.createElement(OwnershipDisabledNotice));

    expect(html).toContain('data-testid="ownership-disabled"');
    expect(html).toContain('turned off');
    expect(html).toContain('Features tab');
  });
});

describe('groupDigits / ungroupDigits', () => {
  it('adds thousands commas without touching the decimals', () => {
    expect(groupDigits('1000000')).toBe('1,000,000');
    expect(groupDigits('1234567.891234')).toBe('1,234,567.891234');
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('')).toBe('');
  });

  it('keeps a trailing decimal point so the user can keep typing', () => {
    expect(groupDigits('50000.')).toBe('50,000.');
  });

  it('strips commas, letters and any second decimal point from typed input', () => {
    expect(ungroupDigits('1,000,000')).toBe('1000000');
    expect(ungroupDigits('1,000.5.2')).toBe('1000.52');
    expect(ungroupDigits('abc12x')).toBe('12');
  });

  it('round-trips digits that a float would lose', () => {
    expect(ungroupDigits(groupDigits('12345678901234567.25'))).toBe('12345678901234567.25');
  });
});

describe('OwnershipTables', () => {
  it("shows each fund's current stake and the event it comes from", () => {
    const html = render(ctx);
    const current = html.match(/data-testid="ownership-current"[\s\S]*?<\/table>/)?.[0] ?? '';

    expect(current).toContain('瑞来');
    // The English name follows when the holder has one; 瑞满 has none.
    expect(current).toContain('(Ruilai Fund)');
    expect(current).not.toMatch(/瑞满<span[^>]*> \(/);
    expect(current).toContain('6.80%');
    expect(current).toContain('瑞满');
    expect(current).toContain('3.20%');
    expect(current).toContain('Series B');
    // A fund with no history yet is told what to record.
    expect(current).toContain('Ray Ying');
    expect(current).toContain('Not recorded — add an opening stake');
  });

  it('lists the history newest first, with round terms, follow-ons and the stale flag', () => {
    const html = render(ctx);

    expect(html.indexOf('ownership-event-series-b')).toBeLessThan(html.indexOf('ownership-event-open'));
    const round = html.match(/data-testid="ownership-event-series-b"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(round).toContain('Funding round');
    expect(round).toContain('Stale');
    expect(round).toContain('CNY pre 1,000M + raised 250M = post');
    expect(round).toContain('1,250M');
    expect(round).toContain('6.00% → ');
    expect(round).toContain('瑞来 (Ruilai Fund):');
    expect(round).toContain('follow-on CNY 25M');
    // Labels carry no Chinese units; amounts are in millions like the rest of Fund Management.
    expect(html).not.toContain('万元');

    const opening = html.match(/data-testid="ownership-event-open"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(opening).toContain('Opening stake');
    expect(opening).not.toContain('→');
    expect(opening).not.toContain('Stale');
    expect(html).toContain('Record corporate action');
  });

  it('shows empty states when nothing is recorded', () => {
    const html = render({ ...ctx, positions: [], actions: [] });

    expect(html).toContain('No open holdings in this company');
    expect(html).toContain('No corporate actions recorded');
  });
});
