import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getPortfolio: vi.fn() }));

vi.mock('./portfolio', () => ({ getPortfolio: mocks.getPortfolio }));

import { listCommitmentEvents } from './commitmentAdapters';

const position = (id: string, holder: string) => ({ id, holder_investor_id: holder, fund_id: 'fund-1' });
const entry = (overrides: Record<string, unknown>) => ({
  id: String(overrides.id),
  business_event_id: `evt-${String(overrides.id)}`,
  entry_date: '2024-01-15',
  created_at: '2024-01-15T00:00:00Z',
  currency: 'CNY',
  notes: null,
  counterparty_position_id: null,
  sub_type: null,
  ...overrides,
});

describe('listCommitmentEvents', () => {
  beforeEach(() => {
    mocks.getPortfolio.mockReset();
  });

  it('keeps a two-legged commitment transfer as transfer_out on the transferor and transfer_in on the transferee', async () => {
    mocks.getPortfolio.mockResolvedValue({
      positions: [position('pos-a', 'inv-a'), position('pos-b', 'inv-b')],
      entries: [
        entry({ id: 'e1', position_id: 'pos-a', entry_type: 'commitment', commitment_delta: '15000000' }),
        entry({ id: 'e2', position_id: 'pos-a', entry_type: 'commitment_transfer', sub_type: 'transfer_out', commitment_delta: '-10000000', counterparty_position_id: 'pos-b' }),
        entry({ id: 'e3', position_id: 'pos-b', entry_type: 'commitment_transfer', sub_type: 'transfer_in', commitment_delta: '10000000', counterparty_position_id: 'pos-a' }),
      ],
    });

    const events = await listCommitmentEvents();

    expect(events.find((e) => e.id === 'e2')).toMatchObject({ event_type: 'transfer_out', counterparty_holding_entity_id: 'inv-b', runningBalance: 5_000_000 });
    expect(events.find((e) => e.id === 'e3')).toMatchObject({ event_type: 'transfer_in', counterparty_holding_entity_id: 'inv-a', runningBalance: 10_000_000 });
  });

  it('shows a transferee-only commitment tagged transfer_in as a transfer in, with no counterparty', async () => {
    mocks.getPortfolio.mockResolvedValue({
      positions: [position('pos-b', 'inv-b')],
      entries: [
        entry({ id: 'e1', position_id: 'pos-b', entry_type: 'commitment', sub_type: 'transfer_in', commitment_delta: '4000000' }),
      ],
    });

    const [event] = await listCommitmentEvents();

    expect(event).toMatchObject({ event_type: 'transfer_in', amount: 4_000_000, counterparty_holding_entity_id: null, runningBalance: 4_000_000 });
  });

  it('keeps an untagged commitment as an additional commitment', async () => {
    mocks.getPortfolio.mockResolvedValue({
      positions: [position('pos-b', 'inv-b')],
      entries: [entry({ id: 'e1', position_id: 'pos-b', entry_type: 'commitment', commitment_delta: '4000000' })],
    });

    const [event] = await listCommitmentEvents();

    expect(event.event_type).toBe('additional_commitment');
  });
});
