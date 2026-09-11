import type {
  DbClient,
  FlAssetRepository,
  FlFundRepository,
  FlLedgerEntryRepository,
  FlPositionRepository,
  FlValuationRepository,
  Tables,
} from '@/lib/repositories';
import {
  flAbs,
  flAdd,
  flDiv,
  flGt,
  flIsZero,
  flLt,
  flMul,
  flNeg,
  flSub,
  flSum,
  toDecimalString,
} from './flDecimal';
import { EntityNotFoundError } from './flErrors';
import {
  computeFundCashSummary,
  type FundCashSummary,
} from '@/lib/fundLedger/fundCashSummary';

export interface PositionBalances {
  position_id: string;
  asset_kind?: string | null;
  committed: string;
  contributed: string;
  unfunded: string;
  quantity: string;
  cash_total: string;
  valuation_adjustment?: string;
  distributed: string;
  retained_proceeds?: string;
  commitment?: string;
  drawn_commitment?: string;
  contributed_capital?: string;
  distributed_capital?: string;
}

export interface LpRollupRecord {
  position_id: string;
  holder_investor_id: string | null;
  holder_fund_id: string | null;
  committed: string;
  contributed: string;
  unfunded: string;
  quantity: string;
  distributed: string;
  ownership_percentage: string; // e.g. "50.000000"
}

export interface PositionValue {
  position_id: string;
  value: string;
  method: string | null;
}

export interface PortfolioPositionRecord {
  position_id: string;
  asset_id: string | null;
  fund_id: string | null;
  quantity: string;
  invested_capital: string;
  current_value: string;
  valuation_method: string | null;
}

export interface FundRollupResult {
  fund: Tables<'fl_funds'>;
  as_of_date: string | null;
  cash_balance?: string | null;
  cash_balances?: Array<{ currency: string; amount: string }>;
  retained_proceeds?: string;
  reporting_total_available?: boolean;
  fx_status?: 'available' | 'pending_fx';
  total_value_available?: boolean;
  lp_registry: {
    total_committed: string;
    total_contributed: string;
    total_unfunded: string;
    total_distributed: string;
    total_units: string;
    lps: LpRollupRecord[];
  };
  portfolio: {
    total_invested: string;
    total_value: string | null;
    total_value_available?: boolean;
    positions: PortfolioPositionRecord[];
  };
}

export class FlBalanceService {
  constructor(
    private readonly db: DbClient,
    private readonly ledgerRepo: FlLedgerEntryRepository,
    private readonly positionRepo: FlPositionRepository,
    private readonly fundRepo: FlFundRepository,
    private readonly assetRepo: FlAssetRepository,
    private readonly valuationRepo: FlValuationRepository,
  ) {}

  async getPositionBalances(
    workspaceId: string,
    positionIds: string[],
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<PositionBalances[]> {
    if (positionIds.length === 0) return [];

    const deltaSums = await this.ledgerRepo.sumDeltasByPositionIds(
      workspaceId,
      positionIds,
      asOfDate,
      executor,
    );

    const map = new Map<string, (typeof deltaSums)[0]>();
    for (const row of deltaSums) {
      map.set(row.position_id, row);
    }

    return positionIds.map((id) => {
      const row = map.get(id);
      const committed = row?.commitment_sum ?? '0.00000000';
      const cashContributed = row?.contributed_sum ?? '0.00000000';
      const contributed = flAdd(cashContributed, row?.paid_in_adjustment_sum ?? '0');
      const unfunded = flSub(committed, contributed);
      const quantity = row?.quantity_sum ?? '0.00000000';
      const cashTotal = row?.cash_sum ?? '0.00000000';
      const valuationAdjustment = row?.valuation_delta_sum ?? '0.00000000';

      // Cash distributions are cash_delta > 0.
      // Net cash is -cashContributed + distributions + other; non-cash paid-in
      // adjustments must not create or erase distributions.
      // Retained divestment proceeds remain fund value, not distributions.
      // So distributed = max(0, cash_sum + cashContributed - retained proceeds).
      // Cash positions MUST return distributed = 0 to prevent bank balance inflating DPI.
      const isCash = row?.asset_kind === 'cash';
      const retainedProceeds = row?.retained_proceeds_sum ?? '0.00000000';
      const rawDist = flAdd(flAdd(cashTotal, cashContributed), flNeg(retainedProceeds));
      const distributed = isCash ? '0.00000000' : (flLt(rawDist, '0') ? '0.00000000' : rawDist);

      return {
        position_id: id,
        asset_kind: row?.asset_kind ?? null,
        committed: toDecimalString(committed),
        contributed: toDecimalString(contributed),
        unfunded: toDecimalString(unfunded),
        quantity: toDecimalString(quantity),
        cash_total: toDecimalString(cashTotal),
        valuation_adjustment: toDecimalString(valuationAdjustment),
        distributed: toDecimalString(distributed),
        retained_proceeds: toDecimalString(retainedProceeds),
        commitment: toDecimalString(committed),
        drawn_commitment: toDecimalString(contributed),
        contributed_capital: toDecimalString(contributed),
        distributed_capital: toDecimalString(distributed),
      };
    });
  }

  async getPositionValue(
    workspaceId: string,
    positionId: string,
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<{ value: string; method: string | null }> {
    const position = await this.positionRepo.findById(
      workspaceId,
      positionId,
      executor,
    );
    if (!position) {
      throw new EntityNotFoundError(`Position ${positionId} not found`);
    }

    const [val] = await this.getPositionValues(
      workspaceId,
      [position],
      asOfDate,
      executor,
    );
    return { value: val.value, method: val.method };
  }

  async getPositionValues(
    workspaceId: string,
    positions: Tables<'fl_positions'>[],
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<PositionValue[]> {
    if (positions.length === 0) return [];

    const positionIds = positions.map((p) => p.id);
    const assetIds = Array.from(
      new Set(
        positions
          .map((p) => p.asset_id)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    );
    const targetFundIds = Array.from(
      new Set(
        positions
          .map((p) => p.fund_id)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    );

    // Batched round 1: Fetch balances, valuations, target funds, all LP positions for target funds, and workspace asset positions
    const [
      balances,
      posValuations,
      assetValuations,
      fundValuations,
      targetFundList,
      allTargetLpPositions,
      allAssetPositions,
      assetList,
    ] = await Promise.all([
      this.getPositionBalances(workspaceId, positionIds, asOfDate, executor),
      this.valuationRepo.findLatestByPositionIds(
        workspaceId,
        positionIds,
        asOfDate,
        executor,
      ),
      assetIds.length > 0
        ? this.valuationRepo.findLatestByAssetIds(
            workspaceId,
            assetIds,
            asOfDate,
            executor,
          )
        : Promise.resolve([]),
      targetFundIds.length > 0
        ? this.valuationRepo.findLatestByFundIds(
            workspaceId,
            targetFundIds,
            asOfDate,
            executor,
          )
        : Promise.resolve([]),
      targetFundIds.length > 0
        ? this.fundRepo.findByIds(workspaceId, targetFundIds, executor)
        : Promise.resolve([]),
      targetFundIds.length > 0
        ? this.positionRepo.findByFundIds(
            workspaceId,
            targetFundIds,
            executor,
          )
        : Promise.resolve([]),
      assetIds.length > 0
        ? this.positionRepo.findByAssetIds(workspaceId, assetIds, executor)
        : Promise.resolve([]),
      assetIds.length > 0 && typeof (this.assetRepo as any).findByIds === 'function'
        ? this.assetRepo.findByIds(workspaceId, assetIds, executor)
        : Promise.resolve([]),
    ]);

    // Batched round 2: Fetch balances for all LP positions in target funds (to compute target funds' denominators)
    // AND fetch balances for all asset positions across workspace (to compute allocation basis denominators)
    const allAssetPositionIds = allAssetPositions.map((p) => p.id);
    const allTargetLpPositionIds = allTargetLpPositions.map((p) => p.id);

    const [targetLpBalances, allAssetBalances] = await Promise.all([
      allTargetLpPositionIds.length > 0
        ? this.getPositionBalances(
            workspaceId,
            allTargetLpPositionIds,
            asOfDate,
            executor,
          )
        : Promise.resolve([]),
      allAssetPositionIds.length > 0
        ? this.getPositionBalances(
            workspaceId,
            allAssetPositionIds,
            asOfDate,
            executor,
          )
        : Promise.resolve([]),
    ]);

    const targetLpBalanceMap = new Map<string, PositionBalances>();
    for (const b of targetLpBalances) {
      targetLpBalanceMap.set(b.position_id, b);
    }

    const allAssetBalanceMap = new Map<string, PositionBalances>();
    for (const b of allAssetBalances) {
      allAssetBalanceMap.set(b.position_id, b);
    }

    const targetFundsMap = new Map<string, Tables<'fl_funds'>>();
    for (const f of targetFundList) {
      if (f) targetFundsMap.set(f.id, f);
    }

    // Compute denominator for each target fund
    const targetFundDenominatorMap = new Map<string, string>();
    for (const fid of targetFundIds) {
      const fund = targetFundsMap.get(fid);
      const lpsForFund = allTargetLpPositions.filter((p) => p.fund_id === fid);
      const lpBals = lpsForFund
        .map((p) => targetLpBalanceMap.get(p.id))
        .filter((b): b is PositionBalances => b !== undefined);

      let denominator = '0.00000000';
      if (fund) {
        if (fund.ownership_basis === 'units') {
          denominator = flSum(lpBals.map((b) => b.quantity));
        } else if (fund.ownership_basis === 'commitment') {
          denominator = flSum(lpBals.map((b) => b.committed));
        } else if (fund.ownership_basis === 'capital_account') {
          denominator = flSum(lpBals.map((b) => b.contributed));
        }
      }
      targetFundDenominatorMap.set(fid, denominator);
    }

    const balanceMap = new Map<string, PositionBalances>();
    for (const b of balances) {
      balanceMap.set(b.position_id, b);
    }

    const posValMap = new Map<string, Tables<'fl_valuations'>>();
    for (const v of posValuations) {
      if (v.position_id) posValMap.set(v.position_id, v);
    }

    const assetValMap = new Map<string, Tables<'fl_valuations'>>();
    for (const v of assetValuations) {
      if (v.asset_id) assetValMap.set(v.asset_id, v);
    }

    const assetMap = new Map<string, Tables<'fl_assets'>>();
    for (const a of assetList) {
      if (a) assetMap.set(a.id, a);
    }

    const fundValMap = new Map<string, Tables<'fl_valuations'>>();
    for (const v of fundValuations) {
      if (v.fund_id) fundValMap.set(v.fund_id, v);
    }

    const isEligible = (
      pos: Tables<'fl_positions'>,
      bal?: PositionBalances,
    ): boolean => {
      if (!asOfDate) {
        if (pos.opened_at) return true;
        if (bal) {
          return (
            !flIsZero(bal.committed) ||
            !flIsZero(bal.contributed) ||
            !flIsZero(bal.quantity) ||
            !flIsZero(bal.cash_total)
          );
        }
        return true;
      }
      if (pos.opened_at) {
        return pos.opened_at <= asOfDate;
      }
      if (bal) {
        return (
          !flIsZero(bal.committed) ||
          !flIsZero(bal.contributed) ||
          !flIsZero(bal.quantity) ||
          !flIsZero(bal.cash_total)
        );
      }
      return false;
    };

    const eligibleAssetPositionsMap = new Map<
      string,
      Tables<'fl_positions'>[]
    >();
    for (const ap of allAssetPositions) {
      if (ap.asset_id) {
        const apBal = allAssetBalanceMap.get(ap.id) ?? balanceMap.get(ap.id);
        if (isEligible(ap, apBal)) {
          const list = eligibleAssetPositionsMap.get(ap.asset_id) ?? [];
          list.push(ap);
          eligibleAssetPositionsMap.set(ap.asset_id, list);
        }
      }
    }

    return positions.map((pos) => {
      const bal = balanceMap.get(pos.id);

      // Check eligibility (asOfDate / opened_at / first economic entry)
      if (!isEligible(pos, bal)) {
        return {
          position_id: pos.id,
          value: '0.00000000',
          method: null,
        };
      }

      // Cash positions value at par (value = cash balance, method = 'cash_par')
      // bypassing asset valuation precedence
      const isCash =
        bal?.asset_kind === 'cash' ||
        (pos.asset_id ? assetMap.get(pos.asset_id)?.asset_kind === 'cash' : false);
      if (isCash) {
        return {
          position_id: pos.id,
          value: toDecimalString(bal?.cash_total ?? '0.00000000'),
          method: 'cash_par',
        };
      }

      // Precedence 1: Explicit position valuation (CAS)
      const explicitVal = posValMap.get(pos.id);
      if (explicitVal) {
        const markDateValid =
          !pos.opened_at || explicitVal.as_of_date >= pos.opened_at;
        if (markDateValid) {
          const valStr = explicitVal.net_value ?? explicitVal.market_value;
          if (valStr !== null && valStr !== undefined) {
            return {
              position_id: pos.id,
              value: toDecimalString(valStr),
              method:
                explicitVal.valuation_method ?? 'capital_account_statement',
            };
          }
        }
      }

      // Precedence 2: Asset position
      if (pos.asset_id) {
        const assetVal = assetValMap.get(pos.asset_id);
        if (assetVal && bal) {
          // Branch 2A: Quantity-tracked with Price-Per-Unit (PPS)
          if (
            assetVal.price_per_unit !== null &&
            assetVal.price_per_unit !== undefined &&
            !flIsZero(bal.quantity) &&
            flGt(bal.quantity, '0')
          ) {
            const calculated = flMul(bal.quantity, assetVal.price_per_unit);
            return {
              position_id: pos.id,
              value: calculated,
              method: assetVal.valuation_method ?? 'at_cost',
            };
          }

          // Branch 2B: Quantity-tracked with Derived PPS from market_value / units_outstanding
          if (
            assetVal.market_value !== null &&
            assetVal.market_value !== undefined &&
            assetVal.units_outstanding !== null &&
            assetVal.units_outstanding !== undefined &&
            !flIsZero(assetVal.units_outstanding) &&
            !flIsZero(bal.quantity) &&
            flGt(bal.quantity, '0')
          ) {
            const derivedPpu = flDiv(
              assetVal.market_value,
              assetVal.units_outstanding,
              8,
            );
            const calculated = flMul(bal.quantity, derivedPpu);
            return {
              position_id: pos.id,
              value: calculated,
              method: assetVal.valuation_method ?? 'at_cost',
            };
          }

          // Branch 2C: Shareless / Untracked Quantity or Fall-through to Market Value
          if (
            assetVal.market_value !== null &&
            assetVal.market_value !== undefined
          ) {
            const eligiblePositions =
              eligibleAssetPositionsMap.get(pos.asset_id) ??
              positions.filter(
                (p) =>
                  p.asset_id === pos.asset_id &&
                  isEligible(p, balanceMap.get(p.id)),
              );

            if (eligiblePositions.length === 1) {
              return {
                position_id: pos.id,
                value: toDecimalString(assetVal.market_value),
                method: assetVal.valuation_method ?? 'other',
              };
            }

            if (eligiblePositions.length > 1) {
              const eligibleBals = eligiblePositions.map(
                (p) => allAssetBalanceMap.get(p.id) ?? balanceMap.get(p.id),
              );

              // Check quantity allocation basis
              const totalQuantity = flSum(
                eligibleBals.map((b) => b?.quantity ?? '0.00000000'),
              );
              if (!flIsZero(totalQuantity) && flGt(totalQuantity, '0')) {
                const posQty = bal.quantity;
                if (!flIsZero(posQty) && flGt(posQty, '0')) {
                  const allocated = flDiv(
                    flMul(assetVal.market_value, posQty),
                    totalQuantity,
                    8,
                  );
                  return {
                    position_id: pos.id,
                    value: allocated,
                    method: assetVal.valuation_method ?? 'other',
                  };
                }
              }

              // Check contributed capital (invested capital / cost basis) allocation basis
              const totalContributed = flSum(
                eligibleBals.map((b) => b?.contributed ?? '0.00000000'),
              );
              if (!flIsZero(totalContributed) && flGt(totalContributed, '0')) {
                const posContributed = bal.contributed;
                if (!flIsZero(posContributed) && flGt(posContributed, '0')) {
                  const allocated = flDiv(
                    flMul(assetVal.market_value, posContributed),
                    totalContributed,
                    8,
                  );
                  return {
                    position_id: pos.id,
                    value: allocated,
                    method: assetVal.valuation_method ?? 'other',
                  };
                }
              }

              // No explicit allocation basis exists (e.g. totalContributed = 0 and totalQuantity = 0)
              // Return explicit ambiguous result
              return {
                position_id: pos.id,
                value: '0.00000000',
                method: 'ambiguous',
              };
            }
          }
        }

        // If no applicable valuation on asset: return 0 with null method (do NOT manufacture at-cost)
        return {
          position_id: pos.id,
          value: '0.00000000',
          method: null,
        };
      }

      // Precedence 3: Fund position (pro-rata fund NAV by ownership_basis)
      if (pos.fund_id) {
        const fVal = fundValMap.get(pos.fund_id);
        const targetFund = targetFundsMap.get(pos.fund_id);
        if (fVal && targetFund && bal) {
          const nav = fVal.net_value ?? fVal.market_value;
          if (nav !== null && nav !== undefined) {
            const denominator =
              targetFundDenominatorMap.get(pos.fund_id) ?? '0.00000000';
            let numerator = '0.00000000';

            if (targetFund.ownership_basis === 'units') {
              numerator = bal.quantity;
            } else if (targetFund.ownership_basis === 'commitment') {
              numerator = bal.committed;
            } else if (targetFund.ownership_basis === 'capital_account') {
              numerator = bal.contributed;
            }

            if (!flIsZero(denominator) && flGt(denominator, '0')) {
              // Pro-rata share of NAV: nav * (numerator / denominator)
              const value = flDiv(flMul(nav, numerator), denominator, 8);
              return {
                position_id: pos.id,
                value,
                method:
                  fVal.valuation_method ?? 'capital_account_statement',
              };
            }
          }
        }
        // If no applicable valuation on fund or zero denominator: return 0 with null method
        return {
          position_id: pos.id,
          value: '0.00000000',
          method: null,
        };
      }

      return {
        position_id: pos.id,
        value: '0.00000000',
        method: null,
      };
    });
  }

  async getFundRollup(
    workspaceId: string,
    fundId: string,
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<FundRollupResult> {
    const fund = await this.fundRepo.findById(workspaceId, fundId, executor);
    if (!fund) {
      throw new EntityNotFoundError(
        `Fund ${fundId} not found in workspace ${workspaceId}`,
      );
    }

    // 1. Fetch LP positions and portfolio positions in parallel
    const [rawLpPositions, rawPortfolioPositions] = await Promise.all([
      this.positionRepo.findByFundIds(workspaceId, [fundId], executor),
      this.positionRepo.findByHolderFundIds(workspaceId, [fundId], executor),
    ]);
    const lpPositions = asOfDate
      ? rawLpPositions.filter((p) => !p.opened_at || p.opened_at <= asOfDate)
      : rawLpPositions;
    const portfolioPositions = asOfDate
      ? rawPortfolioPositions.filter((p) => !p.opened_at || p.opened_at <= asOfDate)
      : rawPortfolioPositions;

    // 2. Fetch LP balances in one batched call
    const lpBalances = await this.getPositionBalances(
      workspaceId,
      lpPositions.map((p) => p.id),
      asOfDate,
      executor,
    );

    const totalCommitted = flSum(lpBalances.map((b) => b.committed));
    const totalContributed = flSum(lpBalances.map((b) => b.contributed));
    const totalUnfunded = flSum(lpBalances.map((b) => b.unfunded));
    const totalDistributed = flSum(lpBalances.map((b) => b.distributed));
    const totalUnits = flSum(lpBalances.map((b) => b.quantity));

    const lpBalanceMap = new Map<string, PositionBalances>();
    for (const b of lpBalances) {
      lpBalanceMap.set(b.position_id, b);
    }

    // 3. Compute LP ownership percentages
    const lps: LpRollupRecord[] = lpPositions.map((pos) => {
      const bal = lpBalanceMap.get(pos.id)!;
      let ownershipPct = '0.000000';

      if (fund.ownership_basis === 'units' && !flIsZero(totalUnits)) {
        ownershipPct = flDiv(flMul(bal.quantity, '100'), totalUnits, 6);
      } else if (
        fund.ownership_basis === 'commitment' &&
        !flIsZero(totalCommitted)
      ) {
        ownershipPct = flDiv(flMul(bal.committed, '100'), totalCommitted, 6);
      } else if (
        fund.ownership_basis === 'capital_account' &&
        !flIsZero(totalContributed)
      ) {
        ownershipPct = flDiv(
          flMul(bal.contributed, '100'),
          totalContributed,
          6,
        );
      }

      return {
        position_id: pos.id,
        holder_investor_id: pos.holder_investor_id,
        holder_fund_id: pos.holder_fund_id,
        committed: bal.committed,
        contributed: bal.contributed,
        unfunded: bal.unfunded,
        quantity: bal.quantity,
        distributed: bal.distributed,
        ownership_percentage: ownershipPct,
      };
    });

    // 4. Fetch portfolio balances & valuations in batched queries
    const portfolioBalances = await this.getPositionBalances(
      workspaceId,
      portfolioPositions.map((p) => p.id),
      asOfDate,
      executor,
    );

    const portfolioValuations = await this.getPositionValues(
      workspaceId,
      portfolioPositions,
      asOfDate,
      executor,
    );

    const portBalMap = new Map<string, PositionBalances>();
    for (const b of portfolioBalances) {
      portBalMap.set(b.position_id, b);
    }

    const portValMap = new Map<
      string,
      { value: string; method: string | null }
    >();
    for (const v of portfolioValuations) {
      portValMap.set(v.position_id, v);
    }

    // Fetch assets for portfolio positions to accurately recognize cash assets
    const assetIds = portfolioPositions
      .map((p) => p.asset_id)
      .filter((id): id is string => Boolean(id));
    let rawAssets: Tables<'fl_assets'>[] = [];
    if (assetIds.length > 0 && typeof (this.assetRepo as any).findByIds === 'function') {
      rawAssets = await (this.assetRepo as any).findByIds(workspaceId, assetIds, executor);
    }
    if (rawAssets.length === 0 && assetIds.length > 0 && typeof this.assetRepo.findById === 'function') {
      const fetched = await Promise.all(assetIds.map((id) => this.assetRepo.findById(workspaceId, id, executor)));
      rawAssets = fetched.filter((a): a is Tables<'fl_assets'> => Boolean(a));
    }
    if (rawAssets.length === 0 && typeof this.assetRepo.findByWorkspaceId === 'function') {
      rawAssets = await this.assetRepo.findByWorkspaceId(workspaceId, executor);
    }
    const assetMap = new Map<string, Tables<'fl_assets'>>();
    for (const a of rawAssets) {
      assetMap.set(a.id, a);
    }
    const enrichedPortfolioPositions = portfolioPositions.map((p) => ({
      ...p,
      asset: p.asset_id ? assetMap.get(p.asset_id) : (p as any).asset,
    }));

    const isCashPos = (pos: (typeof enrichedPortfolioPositions)[0]) => {
      const bal = portBalMap.get(pos.id);
      return pos.asset?.asset_kind === 'cash' || bal?.asset_kind === 'cash';
    };
    const investmentPositions = enrichedPortfolioPositions.filter((p) => !isCashPos(p));
    const cashPositions = enrichedPortfolioPositions.filter(isCashPos);

    const portfolioRecords: PortfolioPositionRecord[] = investmentPositions.map(
      (pos) => {
        const bal = portBalMap.get(pos.id);
        const val = portValMap.get(pos.id);
        const investedCapital = bal ? bal.contributed : '0.00000000';

        return {
          position_id: pos.id,
          asset_id: pos.asset_id,
          fund_id: pos.fund_id,
          quantity: bal?.quantity ?? '0.00000000',
          invested_capital: investedCapital,
          current_value: val?.value ?? '0.00000000',
          valuation_method: val?.method ?? null,
        };
      },
    );

    const totalInvested = flSum(portfolioRecords.map((r) => r.invested_capital));
    const positionValuesSum = flSum(portfolioRecords.map((r) => r.current_value));

    // Fetch date-sliced ledger entries for all portfolio positions
    const portPositionIds = portfolioPositions.map((p) => p.id);
    const allPortEntries =
      portPositionIds.length > 0
        ? typeof (this.ledgerRepo as any).findAllByPositionIds === 'function'
          ? await (this.ledgerRepo as any).findAllByPositionIds(workspaceId, portPositionIds, executor)
          : typeof this.ledgerRepo.findByPositionIds === 'function'
            ? await this.ledgerRepo.findByPositionIds(workspaceId, portPositionIds, undefined, executor)
            : []
        : [];
    const dateSlicedEntries = asOfDate
      ? allPortEntries.filter((e) => e.entry_date <= asOfDate)
      : allPortEntries;

    const cashSummary = computeFundCashSummary({
      fund,
      positions: enrichedPortfolioPositions as any,
      balances: portfolioBalances,
      entries: dateSlicedEntries,
      asOfDate,
    });

    const totalRetainedProceeds = '0.00000000';
    let totalCashBalance: string | null = '0.00000000';
    let totalValue: string | null = positionValuesSum;
    let totalValueAvailable = true;
    const fxStatus: 'available' | 'pending_fx' = cashSummary.fx_status;
    const reportingTotalAvailable = cashSummary.reporting_total_available;
    const cashBalances: Array<{ currency: string; amount: string }> = cashSummary.cash_balances;

    if (cashSummary.reporting_total_available && cashSummary.reporting_total !== null) {
      totalCashBalance = cashSummary.reporting_total;
      totalValue = flAdd(positionValuesSum, totalCashBalance);
      totalValueAvailable = true;
    } else {
      // Multi-currency pending FX: DO NOT SUM NOMINALLY! Total value is unavailable.
      totalCashBalance = null;
      totalValue = null;
      totalValueAvailable = false;
    }

    return {
      fund,
      as_of_date: asOfDate ?? null,
      cash_balance: totalCashBalance,
      cash_balances: cashBalances,
      retained_proceeds: totalRetainedProceeds,
      reporting_total_available: reportingTotalAvailable,
      fx_status: fxStatus,
      total_value_available: totalValueAvailable,
      lp_registry: {
        total_committed: totalCommitted,
        total_contributed: totalContributed,
        total_unfunded: totalUnfunded,
        total_distributed: totalDistributed,
        total_units: totalUnits,
        lps,
      },
      portfolio: {
        total_invested: totalInvested,
        total_value: totalValue,
        total_value_available: totalValueAvailable,
        positions: portfolioRecords,
      },
    };
  }
}
