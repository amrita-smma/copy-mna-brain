import { describe, expect, it } from 'vitest';
import {
  allocationsBalance,
  allocationsOf,
  buildLedgerIndex,
  countByEntryType,
  countEntityRows,
  createSyntheticPosition,
  describeFromTo,
  partyBadge,
  partyKindLabel,
  positionDirectionLabel,
  positionLabel,
  resolvePosition,
  rollupPosition,
  sourceNamesOf,
  summarizeLedger,
  transferLegProblem,
} from './derive';
import {
  ASSETS,
  ENTRIES,
  FUNDS,
  INVESTORS,
  POS_COINVEST_STARTECH,
  POS_MERANTI_AKULAKU,
  POS_MERANTI_GOTO,
  POS_SMMA_STARTECH,
  POS_STARTECH_1982,
  SOURCES,
  buildTestPortfolio,
} from './testFixtures';
import { holderKeyOf, instrumentKeyOf, positionsFor } from '@/views/ledger/PostEntryDialog';

const index = buildLedgerIndex(buildTestPortfolio());

describe('buildLedgerIndex', () => {
  it('resolves each position to its holder and what it holds', () => {
    const position = index.positions.get(POS_MERANTI_GOTO.id);
    expect(position?.holder).toEqual({
      id: INVESTORS.meranti.id,
      name: 'Meranti Global Investment Ltd',
      kind: 'investor',
    });
    expect(position?.instrument).toEqual({
      id: ASSETS.goto.id,
      name: 'GOTO Group',
      kind: 'asset',
    });
    expect(position?.instrumentKind).toBe('asset');
  });

  it('recognises a fund holding another fund', () => {
    const position = index.positions.get(POS_STARTECH_1982.id);
    expect(position?.holder).toMatchObject({ name: 'Startech Growth Fund VCC', kind: 'fund' });
    // The 1982 fund is not one of ours, so it reads as an external fund.
    expect(position?.instrument).toMatchObject({ name: '1982 Fund I', kind: 'external_fund' });
    expect(position?.instrumentKind).toBe('fund');
  });

  it('marks a loan holding apart from an equity one', () => {
    const mythic = [...index.positions.values()].find(
      (position) => position.instrument.id === ASSETS.mythic.id,
    );
    expect(mythic?.instrument.kind).toBe('loan');
  });

  it("carries the position's declared source of fund, and null when it declares none", () => {
    expect(index.positions.get(POS_MERANTI_GOTO.id)?.fundingSource?.name).toBe('DCA');
    expect(index.positions.get(POS_SMMA_STARTECH.id)?.fundingSource).toBeNull();
  });

  it('retains a position that resolves to no holder, clearly labeling it', () => {
    const broken = buildTestPortfolio({
      positions: [{ ...POS_SMMA_STARTECH, holder_investor: null, holder_fund: null } as never],
    });
    const brokenIndex = buildLedgerIndex(broken);
    expect(brokenIndex.positions.size).toBe(1);
    const pos = brokenIndex.positions.get(POS_SMMA_STARTECH.id);
    expect(pos).toBeDefined();
    expect(pos?.holder.name).toBe('Missing holder');
    expect(pos?.holder.kind).toBe('unknown');
    expect(pos?.instrument.name).toBe('Startech Growth Fund VCC');
    expect(pos?.instrumentKind).toBe('fund');
    expect(pos?.resolution.status).toBe('missing_holder');
    expect(pos?.resolution.isResolved).toBe(false);
    expect(pos?.resolution.hasHolder).toBe(false);
    expect(pos?.resolution.hasInstrument).toBe(true);
    expect(positionLabel(POS_SMMA_STARTECH.id, brokenIndex)).toBe(
      'Missing holder · Startech Growth Fund VCC',
    );
    expect(positionDirectionLabel(POS_SMMA_STARTECH.id, brokenIndex)).toBe(
      'Missing holder → Startech Growth Fund VCC',
    );
  });

  it('retains a position that resolves to no instrument, clearly labeling it', () => {
    const broken = buildTestPortfolio({
      positions: [{ ...POS_SMMA_STARTECH, fund: null, asset: null } as never],
    });
    const brokenIndex = buildLedgerIndex(broken);
    expect(brokenIndex.positions.size).toBe(1);
    const pos = brokenIndex.positions.get(POS_SMMA_STARTECH.id);
    expect(pos).toBeDefined();
    expect(pos?.holder.name).toBe('PT Sinar Mas Multiartha Tbk');
    expect(pos?.instrument.name).toBe('Missing instrument');
    expect(pos?.instrument.kind).toBe('unknown');
    expect(pos?.instrumentKind).toBe('unknown');
    expect(pos?.resolution.status).toBe('missing_instrument');
    expect(pos?.resolution.isResolved).toBe(false);
    expect(pos?.resolution.hasHolder).toBe(true);
    expect(pos?.resolution.hasInstrument).toBe(false);
    expect(positionLabel(POS_SMMA_STARTECH.id, brokenIndex)).toBe(
      'PT Sinar Mas Multiartha Tbk · Missing instrument',
    );
    expect(positionDirectionLabel(POS_SMMA_STARTECH.id, brokenIndex)).toBe(
      'PT Sinar Mas Multiartha Tbk → Missing instrument',
    );
  });

  it('retains a position missing both holder and instrument', () => {
    const broken = buildTestPortfolio({
      positions: [
        {
          ...POS_SMMA_STARTECH,
          holder_investor: null,
          holder_fund: null,
          fund: null,
          asset: null,
        } as never,
      ],
    });
    const brokenIndex = buildLedgerIndex(broken);
    expect(brokenIndex.positions.size).toBe(1);
    const pos = brokenIndex.positions.get(POS_SMMA_STARTECH.id);
    expect(pos).toBeDefined();
    expect(pos?.holder.name).toBe('Missing holder');
    expect(pos?.instrument.name).toBe('Missing instrument');
    expect(pos?.instrumentKind).toBe('unknown');
    expect(pos?.resolution.status).toBe('missing_both');
    expect(pos?.resolution.isResolved).toBe(false);
    expect(pos?.resolution.hasHolder).toBe(false);
    expect(pos?.resolution.hasInstrument).toBe(false);
    expect(positionLabel(POS_SMMA_STARTECH.id, brokenIndex)).toBe(
      'Missing holder · Missing instrument',
    );
  });

  it('creates a synthetic orphan position with explicit resolution flags', () => {
    const synthetic = createSyntheticPosition('orphan-pos-123');
    expect(synthetic.id).toBe('orphan-pos-123');
    expect(synthetic.holder.name).toBe('Missing holder');
    expect(synthetic.instrument.name).toBe('Missing instrument');
    expect(synthetic.instrumentKind).toBe('unknown');
    expect(synthetic.resolution.status).toBe('orphan');
    expect(synthetic.resolution.isSynthetic).toBe(true);
    expect(synthetic.resolution.isResolved).toBe(false);
  });

  it('groups the entries of one event so transfer legs can find each other', () => {
    const legs = index.entriesByEvent.get(ENTRIES.transferGive.business_event_id!);
    expect(legs?.map((leg) => leg.id).sort()).toEqual(['le-xfer-give', 'le-xfer-take']);
  });

  it('indexes every entity the search box offers, grouped', () => {
    const groups = new Set(index.searchEntities.map((entity) => entity.group));
    expect(groups).toEqual(new Set(['Investors', 'Funds', 'Assets', 'Sources of fund']));
    const startech = index.searchEntities.find((entity) => entity.id === FUNDS.startech.id);
    expect(startech).toMatchObject({ badge: 'FUND', meta: 'managed', kind: 'party' });
    const external = index.searchEntities.find((entity) => entity.id === FUNDS.f1982.id);
    expect(external).toMatchObject({ badge: 'EXT', meta: 'external' });
    const source = index.searchEntities.find((entity) => entity.id === SOURCES.dca.id);
    expect(source).toMatchObject({ badge: 'SRC', kind: 'source' });
  });

  it('carries a distinct English name so a Chinese-named entity is searchable in English', () => {
    const portfolio = buildTestPortfolio();
    const withEnglish = buildLedgerIndex({
      ...portfolio,
      assets: portfolio.assets.map((asset) =>
        asset.id === ASSETS.goto.id
          ? { ...asset, name: '高亚投资有限公司', english_name: 'Globe Asia Investment' }
          : asset,
      ),
    });
    const entity = withEnglish.searchEntities.find((candidate) => candidate.id === ASSETS.goto.id);
    expect(entity).toMatchObject({
      name: '高亚投资有限公司',
      englishName: 'Globe Asia Investment',
    });
  });

  it('leaves the English name unset when it only repeats the name', () => {
    const portfolio = buildTestPortfolio();
    const echoed = buildLedgerIndex({
      ...portfolio,
      assets: portfolio.assets.map((asset) =>
        asset.id === ASSETS.goto.id ? { ...asset, english_name: 'goto group ' } : asset,
      ),
    });
    const entity = echoed.searchEntities.find((candidate) => candidate.id === ASSETS.goto.id);
    expect(entity?.englishName).toBeUndefined();
  });

  it('tolerates a read model with empty collections', () => {
    const empty = buildLedgerIndex(
      buildTestPortfolio({
        positions: [],
        entries: [],
        business_events: [],
        funding_sources: [],
        investors: [],
        funds: [],
        assets: [],
      }),
    );
    expect(empty.positions.size).toBe(0);
    expect(empty.searchEntities).toEqual([]);
  });
});

describe('partyBadge / partyKindLabel', () => {
  it('abbreviates and labels each party kind', () => {
    expect(partyBadge('investor')).toBe('INV');
    expect(partyBadge('external_fund')).toBe('EXT');
    expect(partyKindLabel('external_fund')).toBe('Ext. fund');
    expect(partyKindLabel('loan')).toBe('Loan');
  });
});

describe('positionLabel', () => {
  it('names a position as holder · what is held', () => {
    expect(positionLabel(POS_MERANTI_GOTO.id, index)).toBe(
      'Meranti Global Investment Ltd · GOTO Group',
    );
  });

  it('falls back to the id when the position no longer resolves', () => {
    expect(positionLabel('missing', index)).toBe('missing');
  });
});

describe('positionDirectionLabel', () => {
  it('names a position as holder → what is held', () => {
    expect(positionDirectionLabel(POS_MERANTI_GOTO.id, index)).toBe(
      'Meranti Global Investment Ltd → GOTO Group',
    );
  });

  it('falls back to the id when the position no longer resolves', () => {
    expect(positionDirectionLabel('missing', index)).toBe('missing');
  });
});

describe('describeFromTo', () => {
  it('reads an outflow as holder → what is held', () => {
    const flow = describeFromTo(ENTRIES.gotoBuy, index);
    expect(flow.from.name).toBe('Meranti Global Investment Ltd');
    expect(flow.to.name).toBe('GOTO Group');
    expect(flow.toIsInstrument).toBe(true);
    expect(flow.noCash).toBe(false);
  });

  it('reads an inflow the other way round', () => {
    const flow = describeFromTo(ENTRIES.distribution, index);
    expect(flow.from.name).toBe('Startech Growth Fund VCC');
    expect(flow.fromIsInstrument).toBe(true);
    expect(flow.to.name).toBe('PT Sinar Mas Multiartha Tbk');
  });

  it('puts the two holders on either side of a transfer, giver first', () => {
    const give = describeFromTo(ENTRIES.transferGive, index);
    expect(give.from.name).toBe('Co-invest Partners');
    expect(give.to.name).toBe('PT Sinar Mas Multiartha Tbk');
    expect(give.fromIsInstrument).toBe(false);

    // The mirrored leg describes the same movement, so it reads identically.
    const take = describeFromTo(ENTRIES.transferTake, index);
    expect(take.from.name).toBe('Co-invest Partners');
    expect(take.to.name).toBe('PT Sinar Mas Multiartha Tbk');
  });

  it('flags a row where no cash moved', () => {
    expect(describeFromTo(ENTRIES.commitment, index).noCash).toBe(true);
    expect(describeFromTo(ENTRIES.writeOff, index).noCash).toBe(true);
  });

  it('falls back to a placeholder party when the position is gone', () => {
    const orphan = { ...ENTRIES.gotoBuy, position_id: 'missing' };
    const flow = describeFromTo(orphan, index);
    expect(flow.from.name).toBe('—');
    expect(flow.to.name).toBe('—');
  });
});

describe('allocationsOf', () => {
  it('returns the split recorded on the entry when the position declares no source', () => {
    const splits = allocationsOf(ENTRIES.akulakuBuy, index);
    expect(splits.map((split) => [split.source.name, split.amount])).toEqual([
      ['Aldiracita', '4000000'],
      ['Hawthorn', '2630000'],
    ]);
    expect(splits.every((split) => !split.implied)).toBe(true);
    expect(allocationsBalance(ENTRIES.akulakuBuy, splits)).toBe(true);
  });

  it("attributes the whole amount to the position's declared source when none is recorded", () => {
    const splits = allocationsOf(ENTRIES.gotoBuy, index);
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({ implied: true, amount: '43780000.00000000' });
    expect(splits[0].source.name).toBe('DCA');
    expect(allocationsBalance(ENTRIES.gotoBuy, splits)).toBe(true);
  });

  it('attributes nothing when no cash moved', () => {
    expect(allocationsOf(ENTRIES.commitment, index)).toEqual([]);
    // Nothing moved, so there is nothing to attribute — that is not a mismatch.
    expect(allocationsBalance(ENTRIES.commitment, [])).toBe(true);
  });

  it('attributes nothing when cash moved but no pool is named', () => {
    expect(allocationsOf(ENTRIES.distribution, index)).toEqual([]);
    expect(allocationsBalance(ENTRIES.distribution, [])).toBe(false);
  });

  it('rejects a split that does not add up to the cash that moved', () => {
    const wrong = {
      ...ENTRIES.akulakuBuy,
      allocations: [{ ...ENTRIES.akulakuBuy.allocations[0], amount: '1000000' }],
    };
    expect(allocationsBalance(wrong, allocationsOf(wrong, index))).toBe(false);
  });

  it('skips an allocation naming a pool that no longer exists', () => {
    const orphan = {
      ...ENTRIES.akulakuBuy,
      allocations: [{ ...ENTRIES.akulakuBuy.allocations[0], funding_source_id: 'gone' }],
    };
    expect(allocationsOf(orphan, index)).toEqual([]);
  });
});

describe('sourceNamesOf', () => {
  it('reports the pool a position declares', () => {
    expect(sourceNamesOf(ENTRIES.gotoBuy, index)).toEqual(['DCA']);
  });

  it('reports every pool named in the entry split', () => {
    expect(sourceNamesOf(ENTRIES.akulakuBuy, index)).toEqual(['Aldiracita', 'Hawthorn']);
  });

  it('agrees with countEntityRows, so the search count matches the sheet', () => {
    // These two disagreeing is what makes an entity show "1 row" and then
    // filter to nothing.
    for (const source of [SOURCES.dca, SOURCES.aldiracita, SOURCES.hawthorn, SOURCES.nic]) {
      const entity = index.searchEntities.find((candidate) => candidate.id === source.id)!;
      const bySourceNames = index.entries.filter((entry) =>
        sourceNamesOf(entry, index).includes(source.name),
      ).length;
      expect(bySourceNames).toBe(countEntityRows(entity, index));
    }
  });

  it('reports nothing for a row that touches no pool', () => {
    expect(sourceNamesOf(ENTRIES.distribution, index)).toEqual([]);
  });

  it('does not repeat a pool named both on the position and in the split', () => {
    const doubled = {
      ...ENTRIES.gotoBuy,
      allocations: [
        { ...ENTRIES.akulakuBuy.allocations[0], funding_source_id: SOURCES.dca.id },
      ],
    };
    expect(sourceNamesOf(doubled, index)).toEqual(['DCA']);
  });
});

describe('transferLegProblem', () => {
  it('passes a transfer whose legs cancel exactly', () => {
    expect(transferLegProblem(ENTRIES.transferGive, index)).toBeNull();
    expect(transferLegProblem(ENTRIES.transferTake, index)).toBeNull();
  });

  it('ignores rows that are not transfer legs', () => {
    expect(transferLegProblem(ENTRIES.gotoBuy, index)).toBeNull();
  });

  it('reports a leg whose partner row is missing', () => {
    const lonely = buildLedgerIndex(
      buildTestPortfolio({
        entries: [ENTRIES.transferGive],
      }),
    );
    expect(transferLegProblem(ENTRIES.transferGive, lonely)).toMatch(/no counterparty row/);
  });

  it("reports legs that do not cancel, because the fund's totals would move", () => {
    const skewed = buildLedgerIndex(
      buildTestPortfolio({
        entries: [ENTRIES.transferGive, { ...ENTRIES.transferTake, commitment_delta: '4000000' }],
      }),
    );
    expect(transferLegProblem(ENTRIES.transferGive, skewed)).toMatch(/do not cancel/);
  });
});

describe('rollupPosition', () => {
  const entries = index.entries;

  it('counts commitment, paid-in and undrawn from the rows', () => {
    const rollup = rollupPosition(POS_SMMA_STARTECH.id, entries);
    // $50M pledged, plus $5M taken on in the transfer.
    expect(rollup.commitment).toBe('55000000.00000000');
    expect(rollup.paidIn).toBe('12000000.00000000');
    expect(rollup.undrawn).toBe('43000000.00000000');
  });

  it('nets units across acquisitions and disposals', () => {
    // 2.21M bought, 330k written off.
    expect(rollupPosition(POS_MERANTI_AKULAKU.id, entries).units).toBe('1880000.00000000');
  });

  it('blends the price over acquisitions only', () => {
    // $6.63M for 2.21M shares = $3.00. The write-off has no cash and must not move it.
    expect(rollupPosition(POS_MERANTI_AKULAKU.id, entries).blendedPrice).toBe('3.00000000');
  });

  it('returns no blended price for a position that never acquired units', () => {
    expect(rollupPosition(POS_STARTECH_1982.id, entries).blendedPrice).toBeNull();
  });

  it('nets cash across every row, from the holder point of view', () => {
    const rollup = rollupPosition(POS_SMMA_STARTECH.id, entries);
    // −12M paid in, −5.15M for the transfer, +3.2M distributed.
    expect(rollup.netCash).toBe('-13950000.00000000');
  });

  it('counts invested capital as paid-in plus buys', () => {
    expect(rollupPosition(POS_MERANTI_GOTO.id, entries).invested).toBe('43780000.00000000');
  });

  it('counts the rows that still need checking', () => {
    expect(rollupPosition(POS_STARTECH_1982.id, entries).needsChecking).toBe(1);
    expect(rollupPosition(POS_MERANTI_GOTO.id, entries).needsChecking).toBe(0);
  });

  it('returns zeroes for a position with no rows', () => {
    const rollup = rollupPosition(POS_COINVEST_STARTECH.id, []);
    expect(rollup.rowCount).toBe(0);
    expect(rollup.commitment).toBe('0.00000000');
    expect(rollup.blendedPrice).toBeNull();
  });

  it('leaves a reversal on the books, so the pair nets to nothing', () => {
    // The wrong fee and its reversal both stay; together they cancel.
    const rollup = rollupPosition(POS_STARTECH_1982.id, entries);
    expect(rollup.rowCount).toBe(3);
    expect(rollup.netCash).toBe('-2000000.00000000');
  });
});

describe('summarizeLedger', () => {
  it('totals cash in and out over the window', () => {
    const summary = summarizeLedger(index.entries, index.entries);
    // Out: 43.78M + 12M + 6.63M + 2M + 5.15M + 418k. In: 5.15M + 3.2M + 25k + 418k.
    expect(summary.cashOut).toBe('69978000.00000000');
    expect(summary.cashIn).toBe('8793000.00000000');
    expect(summary.cashOutRows).toBe(6);
    expect(summary.cashInRows).toBe(4);
  });

  it('counts commitment and undrawn from the as-of set, not the narrowed window', () => {
    // Narrowing the view must never change what has been pledged.
    const narrowed = summarizeLedger(index.entries, [ENTRIES.income]);
    const wide = summarizeLedger(index.entries, index.entries);
    expect(narrowed.commitment).toBe(wide.commitment);
    expect(narrowed.undrawn).toBe(wide.undrawn);
    expect(narrowed.cashIn).not.toBe(wide.cashIn);
  });

  it('counts flagged rows within the window only', () => {
    expect(summarizeLedger(index.entries, index.entries).needsChecking).toBe(1);
    expect(summarizeLedger(index.entries, [ENTRIES.income]).needsChecking).toBe(0);
  });

  it('returns zeroes for an empty ledger', () => {
    const summary = summarizeLedger([], []);
    expect(summary.cashIn).toBe('0.00000000');
    expect(summary.cashOut).toBe('0.00000000');
    expect(summary.windowRows).toBe(0);
  });
});

describe('countByEntryType', () => {
  it('tallies the entries of each type', () => {
    const counts = countByEntryType(index.entries);
    expect(counts.buy).toBe(2);
    expect(counts.commitment_transfer).toBe(2);
    expect(counts.expense).toBe(2);
    expect(counts.sell).toBeUndefined();
  });
});

describe('countEntityRows', () => {
  const entity = (id: string) =>
    index.searchEntities.find((candidate) => candidate.id === id)!;

  it('counts rows where an entity is the holder or the thing held', () => {
    // Two GOTO/Meranti rows? No — one buy on GOTO, plus Akulaku and Mythic rows.
    expect(countEntityRows(entity(ASSETS.goto.id), index)).toBe(1);
    expect(countEntityRows(entity(INVESTORS.meranti.id), index)).toBe(4);
  });

  it('counts the far leg of a transfer as involving that holder', () => {
    // Co-invest holds one leg and is named as the counterparty on the other.
    expect(countEntityRows(entity(INVESTORS.coinvest.id), index)).toBe(2);
  });

  it('counts a funding source through both the position and the entry split', () => {
    // DCA is declared on the GOTO position; Hawthorn appears in a split and on Mythic.
    expect(countEntityRows(entity(SOURCES.dca.id), index)).toBe(1);
    expect(countEntityRows(entity(SOURCES.hawthorn.id), index)).toBe(2);
    expect(countEntityRows(entity(SOURCES.aldiracita.id), index)).toBe(1);
  });
});

describe('unresolved positions and posting target exclusion', () => {
  it('matches fully resolved positions for posting targets', () => {
    const portfolio = buildTestPortfolio();
    const testIndex = buildLedgerIndex(portfolio);
    const holderKey = `investor:${INVESTORS.smma.id}`;
    const instrumentKey = `fund:${FUNDS.startech.id}`;

    const matches = positionsFor(testIndex, holderKey, instrumentKey);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(POS_SMMA_STARTECH.id);
    expect(matches[0].resolution.isResolved).toBe(true);
  });

  it('excludes positions missing only their holder from posting targets', () => {
    const brokenPosition = {
      ...POS_SMMA_STARTECH,
      id: 'pos-missing-holder',
      holder_investor: null,
      holder_fund: null,
      fund: FUNDS.startech,
    };
    const portfolio = buildTestPortfolio({
      positions: [brokenPosition],
    });
    const testIndex = buildLedgerIndex(portfolio);
    const resolved = testIndex.positions.get('pos-missing-holder')!;

    expect(resolved).toBeDefined();
    expect(resolved.holder.name).toBe('Missing holder');
    expect(resolved.resolution.status).toBe('missing_holder');
    expect(resolved.resolution.isResolved).toBe(false);

    expect(holderKeyOf(resolved)).toBe('');
    const matches = positionsFor(
      testIndex,
      `investor:${INVESTORS.smma.id}`,
      `fund:${FUNDS.startech.id}`,
    );
    expect(matches).toHaveLength(0);
  });

  it('excludes positions missing only their instrument from posting targets', () => {
    const brokenPosition = {
      ...POS_SMMA_STARTECH,
      id: 'pos-missing-instrument',
      holder_investor: INVESTORS.smma,
      fund: null,
      asset: null,
    };
    const portfolio = buildTestPortfolio({
      positions: [brokenPosition],
    });
    const testIndex = buildLedgerIndex(portfolio);
    const resolved = testIndex.positions.get('pos-missing-instrument')!;

    expect(resolved).toBeDefined();
    expect(resolved.instrument.name).toBe('Missing instrument');
    expect(resolved.resolution.status).toBe('missing_instrument');
    expect(resolved.resolution.isResolved).toBe(false);

    expect(instrumentKeyOf(resolved)).toBe('');
    const matches = positionsFor(
      testIndex,
      `investor:${INVESTORS.smma.id}`,
      `fund:${FUNDS.startech.id}`,
    );
    expect(matches).toHaveLength(0);
  });

  it('excludes positions missing both holder and instrument from posting targets', () => {
    const brokenPosition = {
      ...POS_SMMA_STARTECH,
      id: 'pos-missing-both',
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: null,
    };
    const portfolio = buildTestPortfolio({
      positions: [brokenPosition],
    });
    const testIndex = buildLedgerIndex(portfolio);
    const resolved = testIndex.positions.get('pos-missing-both')!;

    expect(resolved).toBeDefined();
    expect(resolved.holder.name).toBe('Missing holder');
    expect(resolved.instrument.name).toBe('Missing instrument');
    expect(resolved.resolution.status).toBe('missing_both');
    expect(resolved.resolution.isResolved).toBe(false);

    expect(holderKeyOf(resolved)).toBe('');
    expect(instrumentKeyOf(resolved)).toBe('');
    expect(positionsFor(testIndex, '', '')).toHaveLength(0);
  });

  it('excludes synthetic orphan positions from posting targets', () => {
    const synthetic = createSyntheticPosition('orphan-pos');
    const testIndex = buildLedgerIndex(
      buildTestPortfolio({
        positions: [],
      }),
    );
    testIndex.positions.set(synthetic.id, synthetic);

    expect(holderKeyOf(synthetic)).toBe('');
    expect(instrumentKeyOf(synthetic)).toBe('');
    expect(synthetic.resolution.isResolved).toBe(false);
    expect(positionsFor(testIndex, 'investor:any', 'asset:any')).toHaveLength(0);
  });

  it('retains ledger entries and computes rollups for positions with unresolved sides', () => {
    const missingHolderPos = {
      ...POS_MERANTI_GOTO,
      id: 'pos-goto-no-holder',
      holder_investor: null,
      holder_fund: null,
    };
    const gotoEntry = {
      ...ENTRIES.gotoBuy,
      id: 'le-goto-broken',
      position_id: 'pos-goto-no-holder',
    };
    const portfolio = buildTestPortfolio({
      positions: [missingHolderPos],
      entries: [gotoEntry],
    });
    const testIndex = buildLedgerIndex(portfolio);

    expect(testIndex.positions.size).toBe(1);
    const pos = testIndex.positions.get('pos-goto-no-holder')!;
    expect(pos.holder.name).toBe('Missing holder');
    expect(pos.instrument.name).toBe('GOTO Group');

    const rollup = rollupPosition('pos-goto-no-holder', testIndex.entries);
    expect(rollup.rowCount).toBe(1);
    expect(rollup.invested).toBe('43780000.00000000');
    expect(rollup.units).toBe('9500000.00000000');
  });

  it('correctly groups orphan entries referencing an absent position ID into a synthetic position', () => {
    const orphanEntry1 = {
      ...ENTRIES.gotoBuy,
      id: 'le-orphan-1',
      position_id: 'non-existent-pos-id',
      cash_delta: '-1000',
    };
    const orphanEntry2 = {
      ...ENTRIES.gotoBuy,
      id: 'le-orphan-2',
      position_id: 'non-existent-pos-id',
      cash_delta: '-2000',
    };

    const portfolio = buildTestPortfolio({
      positions: [POS_SMMA_STARTECH],
      entries: [orphanEntry1, orphanEntry2],
    });
    const testIndex = buildLedgerIndex(portfolio);

    expect(testIndex.positions.has('non-existent-pos-id')).toBe(false);

    const orphanEntries = portfolio.entries.filter((e) => !testIndex.positions.has(e.position_id));
    expect(orphanEntries).toHaveLength(2);

    const syntheticPos = createSyntheticPosition('non-existent-pos-id');
    expect(syntheticPos.id).toBe('non-existent-pos-id');
    expect(syntheticPos.holder.name).toBe('Missing holder');
    expect(syntheticPos.instrument.name).toBe('Missing instrument');
    expect(syntheticPos.resolution.status).toBe('orphan');
    expect(syntheticPos.resolution.isSynthetic).toBe(true);

    const rollup = rollupPosition('non-existent-pos-id', orphanEntries);
    expect(rollup.rowCount).toBe(2);
    expect(rollup.netCash).toBe('-3000.00000000');
  });
});


describe('non-cash paid-in rollups', () => {
  it('changes paid-in only and cancels with its reversal', () => {
    const paid = { ...ENTRIES.paidIn, cash_delta: '-1000000' };
    const adjustment = { ...paid, id: 'paid-in-writeoff', sub_type: 'paid_in_writeoff', entry_type: 'adjustment' as const,
      cash_delta: '0', quantity_delta: '0', valuation_delta: '-914781.37' };
    const rows = [paid, adjustment];
    expect(rollupPosition(paid.position_id, rows).paidIn).toBe('85218.63000000');
    const summary = summarizeLedger(rows, rows);
    expect(summary.paidIn).toBe('85218.63000000');
    expect(summary.cashOut).toBe('1000000.00000000');
    expect(summary.cashIn).toBe('0.00000000');
    expect(summarizeLedger([...rows, { ...adjustment, id: 'reversal',
      is_reversal: true, valuation_delta: '914781.37' }], []).paidIn).toBe('1000000.00000000');
  });
});
