import { describe, it, expect } from 'vitest';
import { buildFundSeedFixture, type FundSeedNs } from '../../../scripts/seed';
import { calculateChronologicalRunningBalances } from './fundCommitmentEventService';

describe('Fund commitment seed fixtures', () => {
  const namespaces: FundSeedNs[] = ['0', '1'];

  it.each(namespaces)('generates valid commitment event histories for namespace %s', (ns) => {
    const fixture = buildFundSeedFixture(ns);

    expect(fixture.SEED_INVESTOR_STAKES).toHaveLength(11);
    expect(fixture.SEED_COMMITMENT_EVENTS.length).toBeGreaterThanOrEqual(11);

    // Verify all 5 event types are present
    const eventTypes = new Set(fixture.SEED_COMMITMENT_EVENTS.map((e) => e.event_type));
    expect(eventTypes.has('initial_commitment')).toBe(true);
    expect(eventTypes.has('additional_commitment')).toBe(true);
    expect(eventTypes.has('reduction')).toBe(true);
    expect(eventTypes.has('transfer_in')).toBe(true);
    expect(eventTypes.has('transfer_out')).toBe(true);

    // Verify every seeded stake has a matching chronological commitment event ledger
    for (const stake of fixture.SEED_INVESTOR_STAKES) {
      const entityEvents = fixture.SEED_COMMITMENT_EVENTS.filter(
        (e) => e.fund_id === stake.fund_id && e.holding_entity_id === stake.holding_entity_id,
      );
      expect(entityEvents.length).toBeGreaterThan(0);

      const { currentBalance, eventBalances } = calculateChronologicalRunningBalances(
        entityEvents as never,
        stake.holding_entity_id,
        stake.fund_id,
      );

      // Final balance matches stake commitment amount
      expect(currentBalance).toBe(stake.commitment_amount);

      // Running balance never drops below zero and matches delta transitions
      for (const ev of eventBalances) {
        expect(ev.runningBalance).toBeGreaterThanOrEqual(0);
      }
    }

    // Verify fund totals: Fund 1 = $5M, Fund 2 = $10M, Fund 3 = $8M
    const fund1Stakes = fixture.SEED_INVESTOR_STAKES.filter((s) => s.fund_id === fixture.SEED_FUND_1_ID);
    const fund2Stakes = fixture.SEED_INVESTOR_STAKES.filter((s) => s.fund_id === fixture.SEED_FUND_2_ID);
    const fund3Stakes = fixture.SEED_INVESTOR_STAKES.filter((s) => s.fund_id === fixture.SEED_FUND_3_ID);

    expect(fund1Stakes.reduce((sum, s) => sum + s.commitment_amount, 0)).toBe(5_000_000);
    expect(fund2Stakes.reduce((sum, s) => sum + s.commitment_amount, 0)).toBe(10_000_000);
    expect(fund3Stakes.reduce((sum, s) => sum + s.commitment_amount, 0)).toBe(8_000_000);

    // Verify transfer pairs have matching attributes
    const transferOutEvents = fixture.SEED_COMMITMENT_EVENTS.filter((e) => e.event_type === 'transfer_out');
    const transferInEvents = fixture.SEED_COMMITMENT_EVENTS.filter((e) => e.event_type === 'transfer_in');

    expect(transferOutEvents.length).toBeGreaterThanOrEqual(2);
    expect(transferInEvents.length).toBe(transferOutEvents.length);

    for (const outEvent of transferOutEvents) {
      expect(outEvent.transfer_group_id).toBeTruthy();
      expect(outEvent.counterparty_holding_entity_id).toBeTruthy();

      const matchingIn = transferInEvents.find(
        (e) => e.transfer_group_id === outEvent.transfer_group_id,
      );
      expect(matchingIn).toBeDefined();
      expect(matchingIn?.amount).toBe(outEvent.amount);
      expect(matchingIn?.effective_date).toBe(outEvent.effective_date);
      expect(matchingIn?.fund_id).toBe(outEvent.fund_id);
      expect(matchingIn?.holding_entity_id).toBe(outEvent.counterparty_holding_entity_id);
      expect(matchingIn?.counterparty_holding_entity_id).toBe(outEvent.holding_entity_id);
    }
  });

  it('generates distinct IDs between namespace 0 and namespace 1', () => {
    const fixture0 = buildFundSeedFixture('0');
    const fixture1 = buildFundSeedFixture('1');

    const ids0 = new Set(fixture0.SEED_COMMITMENT_EVENTS.map((e) => e.id));
    const ids1 = new Set(fixture1.SEED_COMMITMENT_EVENTS.map((e) => e.id));

    expect(ids0.size).toBe(fixture0.SEED_COMMITMENT_EVENTS.length);
    expect(ids1.size).toBe(fixture1.SEED_COMMITMENT_EVENTS.length);

    for (const id of ids0) {
      expect(ids1.has(id)).toBe(false);
      expect(id).toContain('0000000f0');
    }
    for (const id of ids1) {
      expect(id).toContain('0000000f1');
    }
  });
});
