import type { AssetTypeDetails } from '@/lib/db/schema';
import type {
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FundRepository,
  FundSourceRepository,
  HoldingEntityRepository,
  Tables,
  TablesInsert,
} from '@/lib/repositories';
import type { FundMetricsService } from '@/lib/services/fundMetricsService';
import type { ParsedAsset, ParsedTxn, ParsedValuation } from '@/lib/fund_updates';
import {
  FUND_CATALOG,
  fundUpdateTxnKey,
  sortFundUpdateReviewAssets,
} from '@/lib/fund_updates';

export type FundUpdateAssetStatus = 'new' | 'unchanged' | 'add_missing';

export interface FundUpdateAssetReview {
  code: string;
  name: string;
  fund: string;
  asset_type: ParsedAsset['assetType'];
  entity: string | null;
  funding_source: string | null;
  status: FundUpdateAssetStatus;
  matched_asset_id: string | null;
  proposed_txn_count: number;
  proposed_valuation_count: number;
  existing_txn_count: number;
  existing_valuation_count: number;
  missing_txn_count: number;
  missing_valuation_count: number;
  /** Full proposed asset (for Overview / tabs). */
  proposed: ParsedAsset;
  /** Txns that would be inserted on approve. */
  missing_txns: ParsedTxn[];
  /** Valuations whose as_of_date is not yet on the matched asset. */
  missing_valuations: ParsedValuation[];
}

export interface FundUpdateApplyResult {
  applied: number;
  created_assets: number;
  updated_assets: number;
  skipped: number;
  txns_inserted: number;
  valuations_upserted: number;
}

/** Per-asset ledger subset + optional edited rows from HITL review. */
export interface FundUpdateAssetSelection {
  asset_code: string;
  /** When set, only these transactions are applied (edited values allowed). */
  txns?: ParsedTxn[];
  /** When set, only these valuations are applied (edited values allowed). */
  valuations?: ParsedValuation[];
}

function typeDetailsSheetCode(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  return typeof d.sheetCode === 'string' && d.sheetCode.trim() ? d.sheetCode.trim() : null;
}

function typeDetailsSourceRef(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  return typeof d.sourceRef === 'string' && d.sourceRef.trim() ? d.sourceRef.trim() : null;
}

function buildTypeDetails(asset: ParsedAsset): AssetTypeDetails {
  const shared = {
    investingEntity: asset.entity ?? undefined,
    dealType: asset.dealType ?? undefined,
    sourceRef: asset.sourceRef ?? undefined,
    vintageYear: asset.vintageYear ?? undefined,
    sheetCode: asset.code,
  };
  if (asset.assetType === 'fund_of_funds') {
    return { targetFundName: asset.name, ...shared };
  }
  return {
    instrumentType: 'equity',
    ...shared,
    shareClass: asset.instrument ?? undefined,
    sharesOutstanding: asset.sharesOutstanding ?? undefined,
  };
}

/**
 * Diffes / applies STARTECH (etc.) fund-update proposals against workspace
 * fund_assets. Existing matched assets only receive **missing** txns/valuations.
 */
export class FundUpdateApplyService {
  constructor(
    private readonly fundRepo: FundRepository,
    private readonly fundAssetRepo: FundAssetRepository,
    private readonly txnRepo: FundAssetTransactionRepository,
    private readonly valuationRepo: FundAssetValuationRepository,
    private readonly holdingEntityRepo: HoldingEntityRepository,
    private readonly fundSourceRepo: FundSourceRepository,
    private readonly fundMetricsService: FundMetricsService,
  ) {}

  async buildReview(proposedAssets: ParsedAsset[]): Promise<FundUpdateAssetReview[]> {
    const existing = await this.fundAssetRepo.findAll();
    const bySheet = new Map<string, Tables<'fund_assets'>>();
    const bySourceRef = new Map<string, Tables<'fund_assets'>>();
    const byName = new Map<string, Tables<'fund_assets'>>();
    for (const row of existing) {
      const sheet = typeDetailsSheetCode(row.type_details);
      if (sheet && !bySheet.has(sheet.toLowerCase())) bySheet.set(sheet.toLowerCase(), row);
      const ref = typeDetailsSourceRef(row.type_details);
      if (ref && !bySourceRef.has(ref.toLowerCase())) bySourceRef.set(ref.toLowerCase(), row);
      const name = row.asset_name?.trim().toLowerCase();
      if (name && !byName.has(name)) byName.set(name, row);
    }

    const matchedIds = proposedAssets
      .map((a) => this.matchExisting(a, bySheet, bySourceRef, byName)?.id)
      .filter((id): id is string => Boolean(id));

    const [allTxns, allVals] = await Promise.all([
      this.txnRepo.findByFundAssetIds(matchedIds),
      this.valuationRepo.findByFundAssetIds(matchedIds),
    ]);
    const txnsByAsset = new Map<string, Tables<'fund_asset_transactions'>[]>();
    const valsByAsset = new Map<string, Tables<'fund_asset_valuations'>[]>();
    for (const t of allTxns) {
      const list = txnsByAsset.get(t.fund_asset_id) ?? [];
      list.push(t);
      txnsByAsset.set(t.fund_asset_id, list);
    }
    for (const v of allVals) {
      const list = valsByAsset.get(v.fund_asset_id) ?? [];
      list.push(v);
      valsByAsset.set(v.fund_asset_id, list);
    }

    const reviews = proposedAssets.map((proposed) => {
      const matched = this.matchExisting(proposed, bySheet, bySourceRef, byName);
      if (!matched) {
        return {
          code: proposed.code,
          name: proposed.name,
          fund: proposed.fund,
          asset_type: proposed.assetType,
          entity: proposed.entity,
          funding_source: proposed.fundingSource,
          status: 'new' as const,
          matched_asset_id: null,
          proposed_txn_count: proposed.txns.length,
          proposed_valuation_count: proposed.valuations.length,
          existing_txn_count: 0,
          existing_valuation_count: 0,
          missing_txn_count: proposed.txns.length,
          missing_valuation_count: proposed.valuations.length,
          proposed,
          missing_txns: proposed.txns,
          missing_valuations: proposed.valuations,
        };
      }

      const existingTxns = txnsByAsset.get(matched.id) ?? [];
      const existingVals = valsByAsset.get(matched.id) ?? [];
      const existingTxnKeys = new Set(existingTxns.map((t) => fundUpdateTxnKey(t)));
      const existingValDates = new Set(existingVals.map((v) => v.as_of_date));
      const missing_txns = proposed.txns.filter((t) => !existingTxnKeys.has(fundUpdateTxnKey(t)));
      const missing_valuations = proposed.valuations.filter((v) => !existingValDates.has(v.asOfDate));
      const status: FundUpdateAssetStatus =
        missing_txns.length === 0 && missing_valuations.length === 0 ? 'unchanged' : 'add_missing';

      return {
        code: proposed.code,
        name: proposed.name,
        fund: proposed.fund,
        asset_type: proposed.assetType,
        entity: proposed.entity,
        funding_source: proposed.fundingSource,
        status,
        matched_asset_id: matched.id,
        proposed_txn_count: proposed.txns.length,
        proposed_valuation_count: proposed.valuations.length,
        existing_txn_count: existingTxns.length,
        existing_valuation_count: existingVals.length,
        missing_txn_count: missing_txns.length,
        missing_valuation_count: missing_valuations.length,
        proposed,
        missing_txns,
        missing_valuations,
      };
    });
    return sortFundUpdateReviewAssets(reviews);
  }

  async applySelected(
    proposedAssets: ParsedAsset[],
    assetCodes: string[],
    selections?: FundUpdateAssetSelection[],
  ): Promise<FundUpdateApplyResult> {
    const codeSet = new Set(assetCodes);
    const selected = proposedAssets.filter((a) => codeSet.has(a.code));
    const review = await this.buildReview(selected);
    const selectionByCode = new Map((selections ?? []).map((s) => [s.asset_code, s]));

    const fundIdByName = await this.ensureFundCatalog();
    let created_assets = 0;
    let updated_assets = 0;
    let skipped = 0;
    let txns_inserted = 0;
    let valuations_upserted = 0;

    for (const item of review) {
      if (item.status === 'unchanged') {
        skipped += 1;
        continue;
      }

      const selection = selectionByCode.get(item.code);

      if (item.status === 'new') {
        const asset = await this.createAsset(item.proposed);
        created_assets += 1;
        const fundId = fundIdByName.get(item.proposed.fund) ?? fundIdByName.get('Others')!;
        const holdingEntityId = await this.resolveHoldingEntityId(item.proposed.entity);
        const fundingSourceId = await this.resolveFundingSourceId(item.proposed.fundingSource);
        const txns = selection?.txns ?? item.proposed.txns;
        const valuations = selection?.valuations ?? item.proposed.valuations;
        for (const t of txns) {
          await this.txnRepo.insert(this.toTxnInsert(asset.id, fundId, holdingEntityId, fundingSourceId, t));
          txns_inserted += 1;
        }
        for (const v of valuations) {
          await this.valuationRepo.upsert(this.toValuationInsert(asset.id, v));
          valuations_upserted += 1;
        }
        await this.fundMetricsService.recomputeAsset(asset.id);
        continue;
      }

      // add_missing
      const assetId = item.matched_asset_id!;
      const fundId = fundIdByName.get(item.proposed.fund) ?? fundIdByName.get('Others')!;
      const holdingEntityId = await this.resolveHoldingEntityId(item.proposed.entity);
      const fundingSourceId = await this.resolveFundingSourceId(item.proposed.fundingSource);
      const txns = selection?.txns ?? item.missing_txns;
      const valuations = selection?.valuations ?? item.missing_valuations;
      for (const t of txns) {
        await this.txnRepo.insert(this.toTxnInsert(assetId, fundId, holdingEntityId, fundingSourceId, t));
        txns_inserted += 1;
      }
      for (const v of valuations) {
        await this.valuationRepo.upsert(this.toValuationInsert(assetId, v));
        valuations_upserted += 1;
      }
      if (txns.length > 0 || valuations.length > 0) {
        updated_assets += 1;
        await this.fundMetricsService.recomputeAsset(assetId);
      } else {
        skipped += 1;
      }
    }

    return {
      applied: created_assets + updated_assets,
      created_assets,
      updated_assets,
      skipped,
      txns_inserted,
      valuations_upserted,
    };
  }

  private matchExisting(
    proposed: ParsedAsset,
    bySheet: Map<string, Tables<'fund_assets'>>,
    bySourceRef: Map<string, Tables<'fund_assets'>>,
    byName: Map<string, Tables<'fund_assets'>>,
  ): Tables<'fund_assets'> | undefined {
    const sheetHit = bySheet.get(proposed.code.toLowerCase());
    if (sheetHit) return sheetHit;
    if (proposed.sourceRef) {
      const refHit = bySourceRef.get(proposed.sourceRef.toLowerCase());
      if (refHit) return refHit;
    }
    return byName.get(proposed.name.trim().toLowerCase());
  }

  private async ensureFundCatalog(): Promise<Map<string, string>> {
    const existing = await this.fundRepo.findAll();
    const byName = new Map(existing.map((f) => [f.name.trim().toLowerCase(), f]));
    const out = new Map<string, string>();
    for (const name of FUND_CATALOG) {
      const hit = byName.get(name.toLowerCase());
      if (hit) {
        out.set(name, hit.id);
      } else {
        const created = await this.fundRepo.insert({ name });
        out.set(name, created.id);
        byName.set(name.toLowerCase(), created);
      }
    }
    // Also map any proposed fund names that fall outside the catalog (shouldn't).
    for (const f of existing) {
      if (!out.has(f.name)) out.set(f.name, f.id);
    }
    return out;
  }

  private async resolveHoldingEntityId(name: string | null): Promise<string | null> {
    if (!name) return null;
    const existing = await this.holdingEntityRepo.findAll();
    const hit = existing.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (hit) return hit.id;
    const created = await this.holdingEntityRepo.insert({ name: name.trim() });
    return created.id;
  }

  private async resolveFundingSourceId(name: string | null): Promise<string | null> {
    if (!name) return null;
    const existing = await this.fundSourceRepo.findAll();
    const hit = existing.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (hit) return hit.id;
    const created = await this.fundSourceRepo.insert({ name: name.trim() });
    return created.id;
  }

  private async createAsset(a: ParsedAsset): Promise<Tables<'fund_assets'>> {
    return this.fundAssetRepo.insert({
      asset_type: a.assetType,
      asset_name: a.name,
      legal_name: a.legalName,
      country: a.country,
      funding_source: a.fundingSourceRaw,
      investment_type: a.investmentTypeLabel,
      entry_date: a.entryDate,
      stake_pct: a.stakePct,
      commitment_amount: a.commitmentAmount,
      mgmt_fee_rate_pct: a.mgmtFeeRatePct,
      sector: a.sector,
      sub_sector: a.subSector,
      current_price_per_share: a.currentPricePerShare,
      investment_currency: 'USD',
      report_currency: 'USD',
      type_details: buildTypeDetails(a),
      status: 'active',
    });
  }

  private toTxnInsert(
    assetId: string,
    fundId: string,
    holdingEntityId: string | null,
    fundingSourceId: string | null,
    t: ParsedTxn,
  ): TablesInsert<'fund_asset_transactions'> {
    return {
      fund_asset_id: assetId,
      fund_id: fundId,
      holding_entity_id: holdingEntityId,
      funding_source_id: fundingSourceId,
      txn_date: t.date,
      txn_type: t.type,
      sub_type_label: t.subTypeLabel,
      price_per_share: t.pricePerShare,
      share_count: t.shareCount,
      value_amount: t.valueAmount,
      txn_currency: t.currency,
      fx_rate: t.fxRate,
      notes: t.notes,
    };
  }

  private toValuationInsert(
    assetId: string,
    v: ParsedValuation,
  ): TablesInsert<'fund_asset_valuations'> {
    return {
      fund_asset_id: assetId,
      as_of_date: v.asOfDate,
      period_label: v.periodLabel,
      valuation_method: v.valuationMethod,
      currency: 'USD',
      market_value_amount: v.marketValue,
      price_per_share: v.pricePerShare,
      shares_outstanding: v.sharesOutstanding,
      shareholding_pct: v.shareholdingPct,
      invested_capital_cum_amount: v.investedCapitalCum,
      gross_moic: v.grossMoic,
      gross_xirr: v.grossXirr,
      notes: v.notes,
    };
  }
}
