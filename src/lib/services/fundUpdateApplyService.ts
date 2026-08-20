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

export type FundUpdateCatalogKind = 'asset' | 'fund' | 'investor' | 'source';

export type FundUpdateCatalogMatchStatus = 'new' | 'existing';

export interface FundUpdateCatalogMatch {
  name: string;
  status: FundUpdateCatalogMatchStatus;
  matched_id: string | null;
  asset_codes?: string[];
  auto_created?: boolean;
}

export type FundUpdateAssetStatus = 'new' | 'unchanged' | 'add_missing';

export interface FundUpdateAssetReview {
  code: string;
  name: string;
  fund: string;
  asset_type: ParsedAsset['assetType'];
  entity: string | null;
  funding_source: string | null;
  matched_fund: FundUpdateCatalogMatch | null;
  matched_investor: FundUpdateCatalogMatch | null;
  matched_source: FundUpdateCatalogMatch | null;
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

export interface FundUpdateFullReview {
  assets: FundUpdateAssetReview[];
  funds: FundUpdateCatalogMatch[];
  investors: FundUpdateCatalogMatch[];
  sources: FundUpdateCatalogMatch[];
}

export interface FundUpdateApplyResult {
  applied: number;
  created_assets: number;
  updated_assets: number;
  skipped: number;
  txns_inserted: number;
  valuations_upserted: number;
  created_funds: number;
  created_investors: number;
  created_sources: number;
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
    const full = await this.buildFullReview(proposedAssets);
    return full.assets;
  }

  async buildFullReview(proposedAssets: ParsedAsset[]): Promise<FundUpdateFullReview> {
    const [existingAssets, existingFunds, existingHoldingEntities, existingFundSources] = await Promise.all([
      this.fundAssetRepo.findAll(),
      this.fundRepo.findAll(),
      this.holdingEntityRepo.findAll(),
      this.fundSourceRepo.findAll(),
    ]);

    const bySheet = new Map<string, Tables<'fund_assets'>>();
    const bySourceRef = new Map<string, Tables<'fund_assets'>>();
    const byName = new Map<string, Tables<'fund_assets'>>();
    for (const row of existingAssets) {
      const sheet = typeDetailsSheetCode(row.type_details);
      if (sheet && !bySheet.has(sheet.toLowerCase())) bySheet.set(sheet.toLowerCase(), row);
      const ref = typeDetailsSourceRef(row.type_details);
      if (ref && !bySourceRef.has(ref.toLowerCase())) bySourceRef.set(ref.toLowerCase(), row);
      const name = row.asset_name?.trim().toLowerCase();
      if (name && !byName.has(name)) byName.set(name, row);
    }

    const fundByName = new Map<string, Tables<'funds'>>();
    for (const f of existingFunds) {
      const name = f.name?.trim().toLowerCase();
      if (name && !fundByName.has(name)) fundByName.set(name, f);
    }

    const holdingEntityByName = new Map<string, Tables<'holding_entities'>>();
    for (const e of existingHoldingEntities) {
      const name = e.name?.trim().toLowerCase();
      if (name && !holdingEntityByName.has(name)) holdingEntityByName.set(name, e);
    }

    const fundSourceByName = new Map<string, Tables<'funding_sources'>>();
    for (const s of existingFundSources) {
      const name = s.name?.trim().toLowerCase();
      if (name && !fundSourceByName.has(name)) fundSourceByName.set(name, s);
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

    const uniqueFunds = new Map<string, FundUpdateCatalogMatch>();
    const uniqueInvestors = new Map<string, FundUpdateCatalogMatch>();
    const uniqueSources = new Map<string, FundUpdateCatalogMatch>();

    const matchCatalog = (
      rawName: string | null | undefined,
      existingMap: Map<string, { id: string; name: string }>,
      isFund?: boolean,
    ): FundUpdateCatalogMatch | null => {
      if (!rawName) return null;
      const clean = rawName.trim();
      if (!clean) return null;
      const key = clean.toLowerCase();
      const hit = existingMap.get(key);
      const isAutoCreated = isFund && FUND_CATALOG.some((c) => c.trim().toLowerCase() === key);
      if (hit) {
        return {
          name: hit.name.trim() || clean,
          status: 'existing',
          matched_id: hit.id,
          ...(isAutoCreated ? { auto_created: true } : {}),
        };
      }
      return {
        name: clean,
        status: 'new',
        matched_id: null,
        ...(isAutoCreated ? { auto_created: true } : {}),
      };
    };

    const upsertUnique = (map: Map<string, FundUpdateCatalogMatch>, match: FundUpdateCatalogMatch) => {
      const key = match.name.toLowerCase();
      const previous = map.get(key);
      if (!previous || (previous.status === 'new' && match.status === 'existing')) {
        map.set(key, match);
      }
    };

    const reviews: FundUpdateAssetReview[] = proposedAssets.map((proposed) => {
      const matched_fund = matchCatalog(proposed.fund, fundByName, true);
      const matched_investor = matchCatalog(proposed.entity, holdingEntityByName, false);
      const matched_source = matchCatalog(proposed.fundingSource, fundSourceByName, false);

      if (matched_fund) upsertUnique(uniqueFunds, matched_fund);
      if (matched_investor) upsertUnique(uniqueInvestors, matched_investor);
      if (matched_source) upsertUnique(uniqueSources, matched_source);

      const matched = this.matchExisting(proposed, bySheet, bySourceRef, byName);
      if (!matched) {
        return {
          code: proposed.code,
          name: proposed.name,
          fund: proposed.fund,
          asset_type: proposed.assetType,
          entity: proposed.entity,
          funding_source: proposed.fundingSource,
          matched_fund,
          matched_investor,
          matched_source,
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
        matched_fund,
        matched_investor,
        matched_source,
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

    return {
      assets: sortFundUpdateReviewAssets(reviews),
      funds: Array.from(uniqueFunds.values()),
      investors: Array.from(uniqueInvestors.values()),
      sources: Array.from(uniqueSources.values()),
    };
  }

  async applySelected(
    proposedAssets: ParsedAsset[],
    assetCodes: string[],
    selections?: FundUpdateAssetSelection[],
    options?: { isV1?: boolean },
    catalogSelections?: { funds?: string[]; investors?: string[]; sources?: string[] },
  ): Promise<FundUpdateApplyResult> {
    const codeSet = new Set(assetCodes);
    const selected = proposedAssets.filter((a) => codeSet.has(a.code));
    const review = await this.buildReview(selected);
    const selectionByCode = new Map((selections ?? []).map((s) => [s.asset_code, s]));

    const fundIdByName = await this.ensureFundCatalog();

    // Performance: Preload holding entities and funding sources to eliminate N+1 queries
    const allHoldingEntities = await this.holdingEntityRepo.findAll();
    const holdingEntityMap = new Map(allHoldingEntities.map((e) => [e.name.trim().toLowerCase(), e.id]));

    const allFundSources = await this.fundSourceRepo.findAll();
    const fundingSourceMap = new Map(allFundSources.map((s) => [s.name.trim().toLowerCase(), s.id]));

    const fundsAllowList =
      catalogSelections?.funds !== undefined
        ? new Set(catalogSelections.funds.map((f) => f.trim().toLowerCase()))
        : undefined;
    const investorsAllowList =
      catalogSelections?.investors !== undefined
        ? new Set(catalogSelections.investors.map((i) => i.trim().toLowerCase()))
        : undefined;
    const sourcesAllowList =
      catalogSelections?.sources !== undefined
        ? new Set(catalogSelections.sources.map((s) => s.trim().toLowerCase()))
        : undefined;

    let created_assets = 0;
    let updated_assets = 0;
    let skipped = 0;
    let txns_inserted = 0;
    let valuations_upserted = 0;
    let created_funds = 0;
    let created_investors = 0;
    let created_sources = 0;

    if (catalogSelections?.funds) {
      for (const rawName of catalogSelections.funds) {
        const clean = rawName?.trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (fundIdByName.has(key)) continue;
        const created = await this.fundRepo.insert({ name: clean });
        fundIdByName.set(key, created.id);
        fundIdByName.set(clean, created.id);
        created_funds += 1;
      }
    }

    if (catalogSelections?.investors) {
      for (const rawName of catalogSelections.investors) {
        const clean = rawName?.trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (holdingEntityMap.has(key)) continue;
        const created = await this.holdingEntityRepo.insert({ name: clean });
        holdingEntityMap.set(key, created.id);
        created_investors += 1;
      }
    }

    if (catalogSelections?.sources) {
      for (const rawName of catalogSelections.sources) {
        const clean = rawName?.trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (fundingSourceMap.has(key)) continue;
        const created = await this.fundSourceRepo.insert({ name: clean });
        fundingSourceMap.set(key, created.id);
        created_sources += 1;
      }
    }

    for (const item of review) {
      if (item.status === 'unchanged') {
        skipped += 1;
        continue;
      }

      const selection = selectionByCode.get(item.code);

      // Validate fund reference: do not silently map unresolved funds to Others in v1
      const proposedFund = item.proposed.fund?.trim();
      if (!proposedFund) {
        if (options?.isV1) {
          throw new Error(`Cannot apply asset "${item.proposed.name}" with unresolved fund reference.`);
        }
      }

      let fundId: string | null = null;
      if (proposedFund) {
        const isFundSelected = fundsAllowList === undefined || fundsAllowList.has(proposedFund.toLowerCase());
        if (isFundSelected) {
          const hit = fundIdByName.get(proposedFund.toLowerCase());
          if (hit) {
            fundId = hit;
          } else {
            const created = await this.fundRepo.insert({ name: proposedFund });
            fundId = created.id;
            fundIdByName.set(proposedFund.toLowerCase(), fundId);
          }
        } else {
          fundId = null;
        }
      } else {
        fundId = fundIdByName.get('others') || fundIdByName.get('Others')!;
      }

      const proposedEntity = item.proposed.entity?.trim();
      let holdingEntityId: string | null = null;
      if (proposedEntity) {
        const isInvestorSelected =
          investorsAllowList === undefined || investorsAllowList.has(proposedEntity.toLowerCase());
        if (isInvestorSelected) {
          holdingEntityId = await this.resolveHoldingEntityIdCached(item.proposed.entity, holdingEntityMap);
        }
      }

      // Keyed on `fundingSource` only, never `fundingSourceRaw`: buildFullReview
      // derives the reviewable source list from `fundingSource`, so a raw
      // placeholder that `meaningful()` nulls out ("N/A", "-") never gets a
      // checkbox and must not be read as a deselection.
      const proposedSource = item.proposed.fundingSource?.trim();
      let fundingSourceId: string | null = null;
      let isSourceSelected = true;
      if (proposedSource) {
        isSourceSelected = sourcesAllowList === undefined || sourcesAllowList.has(proposedSource.toLowerCase());
        if (isSourceSelected) {
          fundingSourceId = await this.resolveFundingSourceIdCached(item.proposed.fundingSource, fundingSourceMap);
        }
      }

      if (options?.isV1) {
        const assetCurrency = item.proposed.txns[0]?.currency?.trim() || selection?.txns?.[0]?.currency?.trim();
        if (!assetCurrency) {
          throw new Error(`Cannot apply asset "${item.proposed.name}" with unresolved currency.`);
        }
        const txnsToValidate = selection?.txns ?? item.proposed.txns;
        for (const t of txnsToValidate) {
          if (!t.currency?.trim()) {
            throw new Error(`Cannot apply transaction on "${item.proposed.name}" with unresolved currency.`);
          }
        }
      }

      if (item.status === 'new') {
        const asset = await this.createAsset(item.proposed, options, isSourceSelected);
        created_assets += 1;
        const txns = selection?.txns ?? item.proposed.txns;
        const valuations = selection?.valuations ?? item.proposed.valuations;
        for (const t of txns) {
          await this.txnRepo.insert(this.toTxnInsert(asset.id, fundId, holdingEntityId, fundingSourceId, t, options));
          txns_inserted += 1;
        }
        for (const v of valuations) {
          await this.valuationRepo.upsert(this.toValuationInsert(asset.id, v, asset.investment_currency, options));
          valuations_upserted += 1;
        }
        await this.fundMetricsService.recomputeAsset(asset.id);
        continue;
      }

      // add_missing
      const assetId = item.matched_asset_id!;
      const txns = selection?.txns ?? item.missing_txns;
      const valuations = selection?.valuations ?? item.missing_valuations;
      const fallbackValCurrency = item.proposed.txns[0]?.currency || txns[0]?.currency || (options?.isV1 ? '' : 'USD');
      for (const t of txns) {
        await this.txnRepo.insert(this.toTxnInsert(assetId, fundId, holdingEntityId, fundingSourceId, t, options));
        txns_inserted += 1;
      }
      for (const v of valuations) {
        await this.valuationRepo.upsert(this.toValuationInsert(assetId, v, fallbackValCurrency, options));
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
      created_funds,
      created_investors,
      created_sources,
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
        out.set(name.toLowerCase(), hit.id);
        out.set(name, hit.id);
      } else {
        const created = await this.fundRepo.insert({ name });
        out.set(name.toLowerCase(), created.id);
        out.set(name, created.id);
        byName.set(name.toLowerCase(), created);
      }
    }
    // Also map any proposed fund names that fall outside the catalog.
    for (const f of existing) {
      if (!out.has(f.name.toLowerCase())) {
        out.set(f.name.toLowerCase(), f.id);
        out.set(f.name, f.id);
      }
    }
    return out;
  }

  private async resolveHoldingEntityIdCached(
    name: string | null,
    cache: Map<string, string>,
  ): Promise<string | null> {
    if (!name) return null;
    const clean = name.trim();
    const key = clean.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const created = await this.holdingEntityRepo.insert({ name: clean });
    cache.set(key, created.id);
    return created.id;
  }

  private async resolveFundingSourceIdCached(
    name: string | null,
    cache: Map<string, string>,
  ): Promise<string | null> {
    if (!name) return null;
    const clean = name.trim();
    const key = clean.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const created = await this.fundSourceRepo.insert({ name: clean });
    cache.set(key, created.id);
    return created.id;
  }

  private async createAsset(
    a: ParsedAsset,
    options?: { isV1?: boolean },
    isSourceSelected: boolean = true,
  ): Promise<Tables<'fund_assets'>> {
    const rawCurrency = a.txns[0]?.currency?.trim();
    if (options?.isV1 && !rawCurrency) {
      throw new Error(`Cannot create asset "${a.name}" with unresolved currency.`);
    }
    const currency = rawCurrency || (options?.isV1 ? '' : 'USD');
    return this.fundAssetRepo.insert({
      asset_type: a.assetType,
      asset_name: a.name,
      legal_name: a.legalName,
      country: a.country,
      funding_source: isSourceSelected ? a.fundingSourceRaw : null,
      investment_type: a.investmentTypeLabel,
      entry_date: a.entryDate,
      stake_pct: a.stakePct,
      commitment_amount: a.commitmentAmount,
      mgmt_fee_rate_pct: a.mgmtFeeRatePct,
      sector: a.sector,
      sub_sector: a.subSector,
      current_price_per_share: a.currentPricePerShare,
      investment_currency: currency,
      report_currency: currency,
      type_details: buildTypeDetails(a),
      status: 'active',
    });
  }

  private toTxnInsert(
    assetId: string,
    fundId: string | null,
    holdingEntityId: string | null,
    fundingSourceId: string | null,
    t: ParsedTxn,
    options?: { isV1?: boolean },
  ): TablesInsert<'fund_asset_transactions'> {
    const rawCurrency = t.currency?.trim();
    if (options?.isV1 && !rawCurrency) {
      throw new Error('Cannot insert transaction with unresolved currency in v1 apply.');
    }
    const currency = rawCurrency || (options?.isV1 ? '' : 'USD');
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
      txn_currency: currency,
      fx_rate: t.fxRate,
      notes: t.notes,
    };
  }

  private toValuationInsert(
    assetId: string,
    v: ParsedValuation,
    fallbackCurrency: string = 'USD',
    options?: { isV1?: boolean },
  ): TablesInsert<'fund_asset_valuations'> {
    const rawCurrency = fallbackCurrency?.trim();
    if (options?.isV1 && !rawCurrency) {
      throw new Error('Cannot insert valuation with unresolved currency in v1 apply.');
    }
    const currency = rawCurrency || (options?.isV1 ? '' : 'USD');
    return {
      fund_asset_id: assetId,
      as_of_date: v.asOfDate,
      period_label: v.periodLabel,
      valuation_method: v.valuationMethod,
      currency,
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
