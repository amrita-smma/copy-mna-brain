import { describe, expect, it } from 'vitest';

import { DEAL_TYPES, type DealType } from '@/lib/companies/dealTypes';
import { COPILOT_AGENT_KEYS } from './keys';
import { FLAVOR_DEFAULT_DEAL_TYPE, defaultDealTypeFor } from './flavorDealTypes';

describe('FLAVOR_DEFAULT_DEAL_TYPE', () => {
  it('declares a default for every Copilot flavor', () => {
    expect(Object.keys(FLAVOR_DEFAULT_DEAL_TYPE).sort()).toEqual(
      [...COPILOT_AGENT_KEYS].sort(),
    );
  });

  it('only ever names a real deal_type enum value', () => {
    for (const value of Object.values(FLAVOR_DEFAULT_DEAL_TYPE)) {
      expect(DEAL_TYPES).toContain(value);
    }
  });

  it('maps each flavor to the transaction shape its desk actually runs', () => {
    expect(FLAVOR_DEFAULT_DEAL_TYPE).toEqual({
      mna: 'majority',
      minority: 'public_market',
      capital_markets: 'ipo',
      investment_banking: 'joint_venture',
      crowdfunding: 'equity_crowdfunding',
      vc: 'minority',
      combined: 'minority',
      investment: 'majority',
    });
  });
});

describe('defaultDealTypeFor', () => {
  it('returns the declared default for a known flavor', () => {
    for (const key of COPILOT_AGENT_KEYS) {
      expect(defaultDealTypeFor(key)).toBe(FLAVOR_DEFAULT_DEAL_TYPE[key]);
    }
  });

  it('falls back to the mna default for a key this build does not know', () => {
    // `workspaces.copilot_agent` is a plain text column, so a row written by a
    // newer deploy must not break company creation.
    expect(defaultDealTypeFor('written_by_a_newer_deploy' as never)).toBe('majority');
  });

  it('never returns undefined', () => {
    const result: DealType = defaultDealTypeFor('mna');
    expect(result).toBeTruthy();
  });
});
