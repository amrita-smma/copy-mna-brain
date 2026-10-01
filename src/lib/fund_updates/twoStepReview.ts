import type { Tables } from '@/lib/repositories';
import {
  fundUpdateTxnKey,
  fundUpdateValKey,
  isPersistableV1AssetEventType,
  quarterPeriodLabel,
  validateTransferCounterparty,
  normalizeCanonicalName,
  normalizeInvestorName,
} from '@/lib/fund_updates';
import {
  classifyFundUpdateTxn,
  computeSignedCashDelta,
} from './canonicalEvent';
import type {
  ParsedAsset,
  ParsedTxn,
  ParsedValuation,
  ParsedCommitmentEvent,
  ReviewProposalItem,
  ReconciliationResult,
  FundUpdateProposal,
  LegacyAssetProposal,
  WorkbookFallbackProposalV1,
  ProposedEntity,
  ProposedEvent,
  ProposedValuation,
  FundUpdateAssetReview,
  FundUpdateCatalogMatch,
  FundUpdateCatalogMatchStatus,
  FundUpdateCatalogKind,
  EntityStatus,
  EntityTabKind,
  EntityLink,
  EntityField,
  ReviewEntity,
  StagedReviewEntityInput,
  ReviewTransactionLeg,
  MultiTransferAllocation,
  NonCashAdjustmentState,
  SingleTransferState,
  ReviewTransaction,
  ReviewValuation,
  ReviewReconciliation,
  FundUpdateTwoStepReview,
  FundUpdateFullReview,
} from '@/lib/fund_updates/types';
import { FundUpdateValidationError } from '@/lib/services/flErrors';
import { toExactDecimalString, safeExactDecimalString } from '@/lib/services/flDecimal';
import { isPersistableFundUpdateValuation } from './normalizeParsedAsset';
import {
  buildManagedFundNameKeys,
  crossBookFlowKindForTxn,
  isManagedFundCrossBookAsset,
  isManagedFundName,
  managedFundCrossBookNote,
} from './managedFundCrossBook';
import {
  isSellProceedsDestination,
  toDivestmentSubType,
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  type SellProceedsDestination,
} from '@/lib/sellProceedsDestination';

function statedSellProceedsDestination(
  txn: ParsedTxn,
): SellProceedsDestination | null {
  if (isSellProceedsDestination(txn.sellProceedsDestination)) {
    return txn.sellProceedsDestination;
  }
  const fromLabel = toDivestmentSubType(txn.subTypeLabel);
  if (fromLabel === SUB_TYPE_DIVESTMENT_CASH_IN_FUND) return 'cash_in_fund';
  if (fromLabel === SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR) {
    return 'distributed_to_investor';
  }
  return null;
}

function valuationContentKey(v: {
  asOfDate?: string | null;
  as_of_date?: string | null;
  marketValue?: number | string | null;
  market_value?: number | string | null;
  pricePerShare?: number | string | null;
  price_per_unit?: number | string | null;
  sharesOutstanding?: number | string | null;
  units_outstanding?: number | string | null;
  valuationMethod?: string | null;
  valuation_method?: string | null;
}): string {
  const method = (v.valuationMethod ?? v.valuation_method ?? 'at_cost').trim().toLowerCase();
  return [
    v.asOfDate ?? v.as_of_date ?? '',
    safeExactDecimalString(v.marketValue ?? v.market_value),
    safeExactDecimalString(v.pricePerShare ?? v.price_per_unit),
    safeExactDecimalString(v.sharesOutstanding ?? v.units_outstanding),
    method,
  ].join('|');
}

function entityRefToKey(ref: string, entities?: ProposedEntity[]): string {
  const clean = ref.trim();
  if (!clean) return '';
  if (entities) {
    const found = entities.find((e) => e.proposalId === clean || e.originalName === clean || e.englishName === clean);
    if (found) {
      const kind = found.entityType === 'fund' ? 'fund'
        : found.entityType === 'portfolio_company' || found.entityType === 'fund_or_partnership_asset' ? 'asset'
        : found.entityType === 'investment_vehicle' ? 'source'
        : 'investor';
      return `${kind}:${found.originalName || found.englishName || clean}`;
    }
  }
  return clean.includes(':') ? clean : `investor:${clean}`;
}

function mapTxnTypeToTwoStep(txnType: string): string {
  const lower = txnType.trim().toLowerCase();
  if (lower === 'contribution' || lower === 'buy' || lower === 'investment' || lower === 'asset_investment') return 'buy';
  if (lower === 'divestment' || lower === 'sell' || lower === 'exit' || lower === 'asset_exit') return 'sell';
  if (lower === 'distribution' || lower === 'investor_distribution') return 'distribution';
  if (lower === 'paid_in' || lower === 'capital_contribution') return 'paid_in';
  if (lower === 'interest_income' || lower === 'dividend' || lower === 'income') return 'income';
  if (lower === 'return_of_capital') return 'distribution';
  if (lower === 'fee' || lower === 'expense' || lower === 'management_fee') return 'expense';
  if (lower === 'adjustment' || lower === 'write_off') return 'adjustment';
  if (lower === 'commitment') return 'commitment';
  if (lower === 'commitment_reduction') return 'commitment';
  if (lower === 'commitment_transfer') return 'commitment_transfer';
  if (lower === 'other' || lower === 'others') return 'other';
  return 'unknown';
}

function targetsFund(asset: FundUpdateAssetReview): boolean {
  return asset.target_kind === 'fund' || (asset.target_kind == null &&
    (asset.asset_type === 'fund_of_funds' || asset.proposed?.assetType === 'fund_of_funds'));
}

export function buildNormalizedTwoStepReview(
  fullReview: FundUpdateFullReview,
  proposal?: FundUpdateProposal,
): FundUpdateTwoStepReview {
  const entities: ReviewEntity[] = [];
  const entityMap = new Map<string, ReviewEntity>();
  const transactions: ReviewTransaction[] = [];
  const valuations: ReviewValuation[] = [];
  const reconciliation: ReviewReconciliation[] = [];

  const isV1 = Boolean(proposal && 'schema_version' in proposal && proposal.schema_version === 'workbook_fallback_v1');
  const v1Proposal = isV1 ? (proposal as WorkbookFallbackProposalV1) : null;
  const legacyProposal = !isV1 ? (proposal as LegacyAssetProposal | undefined) : undefined;

  // Managed funds, by canonical name. A managed fund on a commitment-path row is
  // the fund holder of a fund-held position; a managed fund's 投资/退出 into
  // another managed fund is recorded from the target's book.
  const managedFundKeys = new Set([
    ...(fullReview.managed_fund_keys ?? []),
    ...buildManagedFundNameKeys([
      ...(legacyProposal?.fund_catalog ?? []),
      ...(legacyProposal?.fund_catalog_items ?? []).map((c) => c.nameZh),
      ...(legacyProposal?.commitment_events ?? []).map((e) => e.fund),
      ...(legacyProposal?.assets ?? []).filter((a) => a.holderKind !== 'investor').map((a) => a.fund),
    ]),
  ]);

  // -------------------------------------------------------------
  // Step 1: Normalize Entities (Assets, Funds, Investors, Sources)
  // -------------------------------------------------------------

  // 1. Assets (Direct Investments only; fund_of_funds targets become Fund-tab entities)
  const assetEntityMap = new Map<string, ReviewEntity>();

  for (const asset of fullReview.assets ?? []) {
    if (targetsFund(asset)) {
      continue;
    }

    const normNameKey = normalizeCanonicalName(asset.name);
    const normLegalKey = asset.proposed?.legalName ? normalizeCanonicalName(asset.proposed.legalName) : null;
    const rawNameLower = asset.name.trim().toLowerCase();
    const rawLegalLower = asset.proposed?.legalName ? asset.proposed.legalName.trim().toLowerCase() : null;
    const rawName = asset.name.trim();
    const rawLegal = asset.proposed?.legalName ? asset.proposed.legalName.trim() : null;
    const codeKey = asset.code;

    const aliasKeys = [
      normNameKey,
      normLegalKey,
      rawNameLower,
      rawLegalLower,
      rawName,
      rawLegal,
      codeKey,
      `asset:${codeKey}`,
    ].filter((k): k is string => Boolean(k && k.trim()));

    // Find all previously built entities matching any alias key
    const matchingEntities = new Set<ReviewEntity>();
    for (const k of aliasKeys) {
      const hit = assetEntityMap.get(k);
      if (hit) matchingEntities.add(hit);
    }

    // If identity aliases point to different already-built entities, fail/surface ambiguity rather than silently choosing
    if (matchingEntities.size > 1) {
      throw new FundUpdateValidationError(
        `Ambiguous canonical identity for asset "${asset.name}" (${asset.code}): aliases point to multiple distinct entities (${Array.from(matchingEntities).map((e) => e.key).join(', ')}).`,
      );
    }

    const isMatched = asset.matched_asset_id != null || asset.status !== 'new';
    const existingAssetEnt = matchingEntities.size === 1 ? Array.from(matchingEntities)[0] : undefined;
    const assetGroupName =
      asset.proposed?.group?.trim() ||
      asset.proposed?.fund?.trim() ||
      asset.fund?.trim() ||
      null;

    if (existingAssetEnt) {
      if (!existingAssetEnt.groupName && assetGroupName) {
        existingAssetEnt.groupName = assetGroupName;
      }
      // Check for conflicting non-null matched_asset_id values among constituents
      const existingId = existingAssetEnt.matchedId;
      const incomingId = asset.matched_asset_id;

      if (existingId && incomingId && existingId !== incomingId) {
        existingAssetEnt.matchedIdConflict = { id1: existingId, id2: incomingId };
        existingAssetEnt.status = 'blocked';
        existingAssetEnt.blockReason = `Constituents of canonical asset "${existingAssetEnt.name}" have conflicting matched asset IDs (${existingId} vs ${incomingId}).`;
      } else if (incomingId && !existingId) {
        existingAssetEnt.matchedId = incomingId;
        if (isMatched) existingAssetEnt.status = 'matched';
      }

      if (!existingAssetEnt.englishName && asset.proposed?.englishName) {
        existingAssetEnt.englishName = asset.proposed.englishName;
      }
      if (isMatched && existingAssetEnt.status === 'new' && !existingAssetEnt.matchedIdConflict) {
        existingAssetEnt.status = 'matched';
      }

      existingAssetEnt.rawAssets = existingAssetEnt.rawAssets || (existingAssetEnt.rawAsset ? [existingAssetEnt.rawAsset] : []);
      if (!existingAssetEnt.rawAssets.some((a) => a.code === asset.code)) {
        existingAssetEnt.rawAssets.push(asset);
      }

      // Merge links
      if (asset.fund) {
        const fundKey = `fund:${asset.fund}`;
        if (!existingAssetEnt.links.some((l) => l.key === fundKey)) {
          existingAssetEnt.links.push({
            key: fundKey,
            kind: 'Fund',
            name: asset.fund,
            status: asset.matched_fund?.status === 'existing' ? 'matched' : 'new',
          });
        }
      }
      const rawEntity = asset.proposed?.holderName?.trim() || asset.proposed?.entity?.trim() || asset.entity?.trim();
      if (rawEntity) {
        const invKey = `investor:${rawEntity}`;
        if (!existingAssetEnt.links.some((l) => l.key === invKey)) {
          existingAssetEnt.links.push({
            key: invKey,
            kind: 'Holding Entity',
            name: rawEntity,
            status: asset.matched_investor?.status === 'existing' ? 'matched' : 'new',
          });
        }
      }
      const rawSource = asset.funding_source?.trim() || asset.proposed?.fundingSource?.trim();
      if (rawSource) {
        const srcKey = `source:${rawSource}`;
        if (!existingAssetEnt.links.some((l) => l.key === srcKey)) {
          existingAssetEnt.links.push({
            key: srcKey,
            kind: 'Source of Fund',
            name: rawSource,
            status: asset.matched_source?.status === 'existing' ? 'matched' : 'new',
          });
        }
      }

      // Aggregate counts in fields
      const propTxnField = existingAssetEnt.fields.find((f) => f.label === 'Proposed Transactions');
      if (propTxnField && typeof propTxnField.value === 'number') {
        propTxnField.value += asset.proposed_txn_count;
      }
      const propValField = existingAssetEnt.fields.find((f) => f.label === 'Proposed Valuations');
      if (propValField && typeof propValField.value === 'number') {
        propValField.value += asset.proposed_valuation_count;
      }
      const missTxnField = existingAssetEnt.fields.find((f) => f.label === 'Missing Transactions');
      if (missTxnField && typeof missTxnField.value === 'number') {
        missTxnField.value += asset.missing_txn_count;
      }
      const missValField = existingAssetEnt.fields.find((f) => f.label === 'Missing Valuations');
      if (missValField && typeof missValField.value === 'number') {
        missValField.value += asset.missing_valuation_count;
      }

      // Funds aggregation in fields
      if (asset.fund) {
        const fundField = existingAssetEnt.fields.find((f) => f.label === 'Fund' || f.label === 'Funds');
        if (fundField) {
          const funds = String(fundField.value || '').split(', ').filter(Boolean);
          if (!funds.includes(asset.fund)) {
            funds.push(asset.fund);
            fundField.label = funds.length > 1 ? 'Funds' : 'Fund';
            fundField.value = funds.join(', ');
          }
        } else {
          existingAssetEnt.fields.push({ label: 'Fund', value: asset.fund });
        }
      }

      // Asset Code aggregation in fields
      const codeField = existingAssetEnt.fields.find((f) => f.label === 'Asset Code' || f.label === 'Asset Codes');
      if (codeField) {
        const codes = String(codeField.value || '').split(', ').filter(Boolean);
        if (!codes.includes(asset.code)) {
          codes.push(asset.code);
          codeField.label = codes.length > 1 ? 'Asset Codes' : 'Asset Code';
          codeField.value = codes.join(', ');
        }
      }

      // Surface ID conflict in fields if present
      if (existingAssetEnt.matchedIdConflict) {
        const conflictField = existingAssetEnt.fields.find((f) => f.label === 'ID Conflict');
        const conflictVal = `Conflicting matched IDs: ${existingAssetEnt.matchedIdConflict.id1} vs ${existingAssetEnt.matchedIdConflict.id2}`;
        if (conflictField) {
          conflictField.value = conflictVal;
        } else {
          existingAssetEnt.fields.push({ label: 'ID Conflict', value: conflictVal });
        }
      }

      for (const k of aliasKeys) {
        assetEntityMap.set(k, existingAssetEnt);
      }
      assetEntityMap.set(`asset:${asset.code}`, existingAssetEnt);
    } else {
      const key = `asset:${asset.code}`;
      const links: EntityLink[] = [];
      if (asset.fund) {
        links.push({
          key: `fund:${asset.fund}`,
          kind: 'Fund',
          name: asset.fund,
          status: asset.matched_fund?.status === 'existing' ? 'matched' : 'new',
        });
      }
      const rawEntity = asset.proposed?.holderName?.trim() || asset.proposed?.entity?.trim() || asset.entity?.trim();
      if (rawEntity) {
        links.push({
          key: `investor:${rawEntity}`,
          kind: 'Holding Entity',
          name: rawEntity,
          status: asset.matched_investor?.status === 'existing' ? 'matched' : 'new',
        });
      }
      const rawSource = asset.funding_source?.trim() || asset.proposed?.fundingSource?.trim();
      if (rawSource) {
        links.push({
          key: `source:${rawSource}`,
          kind: 'Source of Fund',
          name: rawSource,
          status: asset.matched_source?.status === 'existing' ? 'matched' : 'new',
        });
      }

      const fields: EntityField[] = [
        { label: 'Asset Code', value: asset.code },
        { label: 'Asset Name', value: asset.name },
        { label: 'Asset Type', value: asset.asset_type },
        { label: 'Fund', value: asset.fund },
        { label: 'Holding Entity', value: rawEntity || asset.entity },
        { label: 'Source of Fund', value: rawSource || asset.funding_source },
        { label: 'Status', value: asset.status },
        { label: 'Matched Asset ID', value: asset.matched_asset_id },
        { label: 'Proposed Transactions', value: asset.proposed_txn_count },
        { label: 'Proposed Valuations', value: asset.proposed_valuation_count },
        { label: 'Missing Transactions', value: asset.missing_txn_count },
        { label: 'Missing Valuations', value: asset.missing_valuation_count },
      ];

      const entity: ReviewEntity = {
        key,
        tab: 'asset',
        code: asset.code,
        name: asset.name,
        englishName: asset.proposed?.englishName ?? null,
        status: isMatched ? 'matched' : 'new',
        matchedId: asset.matched_asset_id ?? null,
        groupName: assetGroupName,
        txnsCount: 0,
        valsCount: 0,
        fields,
        links,
        isStaged: true,
        rawAsset: asset,
        rawAssets: [asset],
      };
      entities.push(entity);
      entityMap.set(key, entity);

      for (const k of aliasKeys) {
        assetEntityMap.set(k, entity);
      }
      assetEntityMap.set(`asset:${asset.code}`, entity);
    }
  }

  // 2. Funds (Catalog Funds + Managing Funds + Fund-of-Funds Targets)
  const fundEntityMap = new Map<string, ReviewEntity>();

  for (const fund of fullReview.funds ?? []) {
    const normKey = normalizeCanonicalName(fund.name) || fund.name.trim().toLowerCase();
    const rawLower = fund.name.trim().toLowerCase();
    const raw = fund.name.trim();

    const aliasKeys = [normKey, rawLower, raw].filter(Boolean);
    const matchingEntities = new Set<ReviewEntity>();
    for (const k of aliasKeys) {
      const hit = fundEntityMap.get(k);
      if (hit) matchingEntities.add(hit);
    }

    if (matchingEntities.size > 1) {
      throw new FundUpdateValidationError(
        `Ambiguous canonical identity for fund "${fund.name}": aliases point to multiple distinct fund entities (${Array.from(matchingEntities).map((e) => e.key).join(', ')}).`,
      );
    }

    const existingFundEnt = matchingEntities.size === 1 ? Array.from(matchingEntities)[0] : undefined;

    if (existingFundEnt) {
      if (!existingFundEnt.matchedId && fund.matched_id) {
        existingFundEnt.matchedId = fund.matched_id;
        if (fund.status === 'existing') existingFundEnt.status = 'matched';
      }
      for (const k of aliasKeys) {
        fundEntityMap.set(k, existingFundEnt);
      }
      continue;
    }

    const key = `fund:${fund.name}`;
    const links: EntityLink[] = (fund.asset_codes ?? [])
      .map((code) => {
        const a = (fullReview.assets ?? []).find(
          (item) => item.code === code && !targetsFund(item),
        );
        if (!a) return null;
        const normTarget = normalizeCanonicalName(a.name) || normalizeCanonicalName(a.proposed?.legalName) || a.name.trim().toLowerCase();
        const targetEnt = assetEntityMap.get(normTarget) ?? assetEntityMap.get(a.code);
        return {
          key: targetEnt?.key ?? `asset:${a.code}`,
          kind: 'Asset',
          name: targetEnt?.name ?? a.name,
          status: (targetEnt?.status ?? (a.status === 'new' ? 'new' : 'matched')) as EntityStatus,
        };
      })
      .filter((l): l is EntityLink => l !== null);

    const fields: EntityField[] = [
      { label: 'Fund Name', value: fund.name },
      { label: 'Status', value: fund.status },
      { label: 'Matched Fund ID', value: fund.matched_id },
      { label: 'Auto Created', value: fund.auto_created ? 'Yes' : 'No' },
    ];
    if (fund.role) {
      fields.push({ label: 'Role', value: fund.role });
    }

    const entity: ReviewEntity = {
      key,
      tab: 'fund',
      code: '',
      name: fund.name,
      englishName: fund.english_name ?? null,
      status: fund.status === 'existing' ? 'matched' : 'new',
      matchedId: fund.matched_id,
      autoCreated: fund.auto_created,
      role: fund.role,
      txnsCount: 0,
      valsCount: 0,
      fields,
      links,
      isStaged: true,
      rawCatalog: fund,
    };
    entities.push(entity);
    entityMap.set(key, entity);
    for (const k of aliasKeys) {
      fundEntityMap.set(k, entity);
    }
  }

  // Ensure managed funds link to all their held direct assets
  for (const a of fullReview.assets ?? []) {
    if (a.fund && !targetsFund(a)) {
      const normFund = normalizeCanonicalName(a.fund) || a.fund.trim().toLowerCase();
      const fundEnt = fundEntityMap.get(normFund) ?? fundEntityMap.get(a.fund);
      const targetAssetEnt = assetEntityMap.get(normalizeCanonicalName(a.name) || normalizeCanonicalName(a.proposed?.legalName) || a.name.trim().toLowerCase()) ?? assetEntityMap.get(a.code);
      if (fundEnt && targetAssetEnt) {
        if (!fundEnt.links.some((l) => l.key === targetAssetEnt.key)) {
          fundEnt.links.push({
            key: targetAssetEnt.key,
            kind: 'Asset',
            name: targetAssetEnt.name,
            status: targetAssetEnt.status,
          });
        }
      }
    }
  }

  // Merge or create FoF target fund entities
  const fofAssets = (fullReview.assets ?? []).filter(
    (a) => targetsFund(a),
  );

  for (const fof of fofAssets) {
    const normNameKey = normalizeCanonicalName(fof.name);
    const rawNameLower = fof.name.trim().toLowerCase();
    const rawName = fof.name.trim();

    const aliasKeys = [
      normNameKey,
      rawNameLower,
      rawName,
    ].filter((k): k is string => Boolean(k && k.trim()));

    const matchingEntities = new Set<ReviewEntity>();
    for (const k of aliasKeys) {
      const hit = fundEntityMap.get(k);
      if (hit) matchingEntities.add(hit);
    }

    if (matchingEntities.size > 1) {
      throw new FundUpdateValidationError(
        `Ambiguous canonical identity for FoF fund "${fof.name}" (${fof.code}): aliases point to multiple distinct fund entities (${Array.from(matchingEntities).map((e) => e.key).join(', ')}).`,
      );
    }

    const existingFundEnt = matchingEntities.size === 1 ? Array.from(matchingEntities)[0] : undefined;
    const isMatched = fof.matched_asset_id != null || fof.status !== 'new';

    // Resolve owning fund canonically
    let canonicalHoldingFundKey: string | null = null;
    let canonicalHoldingFundName: string | null = null;
    let canonicalHoldingFundStatus: EntityStatus = 'new';

    if (fof.fund) {
      const normOwning = normalizeCanonicalName(fof.fund) || fof.fund.trim().toLowerCase();
      const owningEnt =
        fundEntityMap.get(normOwning) ??
        fundEntityMap.get(fof.fund.trim().toLowerCase()) ??
        fundEntityMap.get(fof.fund);
      if (owningEnt) {
        canonicalHoldingFundKey = owningEnt.key;
        canonicalHoldingFundName = owningEnt.name;
        canonicalHoldingFundStatus = owningEnt.status;
      } else {
        canonicalHoldingFundKey = `fund:${fof.fund}`;
        canonicalHoldingFundName = fof.fund;
        canonicalHoldingFundStatus = fof.matched_fund?.status === 'existing' ? 'matched' : 'new';
      }
    }

    if (existingFundEnt) {
      // Check for conflicting matched IDs among FoF constituents
      const existingId = existingFundEnt.matchedId;
      const incomingId = fof.matched_asset_id;
      if (existingId && incomingId && existingId !== incomingId) {
        existingFundEnt.matchedIdConflict = { id1: existingId, id2: incomingId };
        existingFundEnt.status = 'blocked';
        existingFundEnt.blockReason = `Constituents of canonical fund "${existingFundEnt.name}" have conflicting matched fund IDs (${existingId} vs ${incomingId}).`;
      } else if (incomingId && !existingId) {
        existingFundEnt.matchedId = incomingId;
        if (isMatched) existingFundEnt.status = 'matched';
      }

      if (!existingFundEnt.englishName && fof.proposed.englishName) {
        existingFundEnt.englishName = fof.proposed.englishName;
      }
      if (isMatched && existingFundEnt.status === 'new' && !existingFundEnt.matchedIdConflict) {
        existingFundEnt.status = 'matched';
      }
      if (!existingFundEnt.role) {
        existingFundEnt.role = 'Fund of Funds';
      }
      existingFundEnt.rawAsset = existingFundEnt.rawAsset || fof;
      existingFundEnt.rawAssets = existingFundEnt.rawAssets || (existingFundEnt.rawAsset ? [existingFundEnt.rawAsset] : []);
      if (!existingFundEnt.rawAssets.some((a) => a.code === fof.code)) {
        existingFundEnt.rawAssets.push(fof);
      }

      // Add holding fund link, avoiding self-referential links
      if (canonicalHoldingFundKey && canonicalHoldingFundKey !== existingFundEnt.key) {
        if (!existingFundEnt.links.some((l) => l.key === canonicalHoldingFundKey)) {
          existingFundEnt.links.push({
            key: canonicalHoldingFundKey,
            kind: 'Fund',
            name: canonicalHoldingFundName!,
            status: canonicalHoldingFundStatus,
          });
        }
      }

      // Aggregate counts in fields
      const propTxnField = existingFundEnt.fields.find((f) => f.label === 'Proposed Transactions');
      if (propTxnField && typeof propTxnField.value === 'number') {
        propTxnField.value += fof.proposed_txn_count;
      } else if (!propTxnField) {
        existingFundEnt.fields.push({ label: 'Proposed Transactions', value: fof.proposed_txn_count });
      }

      const propValField = existingFundEnt.fields.find((f) => f.label === 'Proposed Valuations');
      if (propValField && typeof propValField.value === 'number') {
        propValField.value += fof.proposed_valuation_count;
      } else if (!propValField) {
        existingFundEnt.fields.push({ label: 'Proposed Valuations', value: fof.proposed_valuation_count });
      }

      const missTxnField = existingFundEnt.fields.find((f) => f.label === 'Missing Transactions');
      if (missTxnField && typeof missTxnField.value === 'number') {
        missTxnField.value += fof.missing_txn_count;
      } else if (!missTxnField) {
        existingFundEnt.fields.push({ label: 'Missing Transactions', value: fof.missing_txn_count });
      }

      const missValField = existingFundEnt.fields.find((f) => f.label === 'Missing Valuations');
      if (missValField && typeof missValField.value === 'number') {
        missValField.value += fof.missing_valuation_count;
      } else if (!missValField) {
        existingFundEnt.fields.push({ label: 'Missing Valuations', value: fof.missing_valuation_count });
      }

      if (fof.fund && canonicalHoldingFundKey !== existingFundEnt.key) {
        const hfField = existingFundEnt.fields.find((f) => f.label === 'Holding Fund' || f.label === 'Holding Funds');
        if (hfField) {
          const funds = String(hfField.value || '').split(', ').filter(Boolean);
          if (!funds.includes(fof.fund)) {
            funds.push(fof.fund);
            hfField.label = funds.length > 1 ? 'Holding Funds' : 'Holding Fund';
            hfField.value = funds.join(', ');
          }
        } else {
          existingFundEnt.fields.push({ label: 'Holding Fund', value: fof.fund });
        }
      }
      if (!existingFundEnt.fields.some((f) => f.label === 'Asset Type')) {
        existingFundEnt.fields.push({ label: 'Asset Type', value: 'Fund of Funds' });
      }

      // Surface ID conflict in fields if present
      if (existingFundEnt.matchedIdConflict) {
        const conflictField = existingFundEnt.fields.find((f) => f.label === 'ID Conflict');
        const conflictVal = `Conflicting matched IDs: ${existingFundEnt.matchedIdConflict.id1} vs ${existingFundEnt.matchedIdConflict.id2}`;
        if (conflictField) {
          conflictField.value = conflictVal;
        } else {
          existingFundEnt.fields.push({ label: 'ID Conflict', value: conflictVal });
        }
      }

      for (const k of aliasKeys) {
        fundEntityMap.set(k, existingFundEnt);
      }
    } else {
      const key = `fund:${fof.name}`;
      const links: EntityLink[] = [];
      if (canonicalHoldingFundKey && canonicalHoldingFundKey !== key) {
        links.push({
          key: canonicalHoldingFundKey,
          kind: 'Fund',
          name: canonicalHoldingFundName!,
          status: canonicalHoldingFundStatus,
        });
      }

      const fields: EntityField[] = [
        { label: 'Fund Name', value: fof.name },
        { label: 'Asset Type', value: 'Fund of Funds' },
      ];
      if (fof.fund && canonicalHoldingFundKey !== key) {
        fields.push({ label: 'Holding Fund', value: fof.fund });
      }
      fields.push(
        { label: 'Status', value: fof.status },
        { label: 'Matched Fund ID', value: fof.matched_asset_id },
        { label: 'Proposed Transactions', value: fof.proposed_txn_count },
        { label: 'Proposed Valuations', value: fof.proposed_valuation_count },
        { label: 'Missing Transactions', value: fof.missing_txn_count },
        { label: 'Missing Valuations', value: fof.missing_valuation_count },
      );

      const entity: ReviewEntity = {
        key,
        tab: 'fund',
        code: '',
        name: fof.name,
        englishName: fof.proposed.englishName ?? null,
        status: isMatched ? 'matched' : 'new',
        matchedId: fof.matched_asset_id ?? null,
        role: 'Fund of Funds',
        txnsCount: 0,
        valsCount: 0,
        fields,
        links,
        isStaged: true,
        rawAsset: fof,
        rawAssets: [fof],
      };
      entities.push(entity);
      entityMap.set(key, entity);
      for (const k of aliasKeys) {
        fundEntityMap.set(k, entity);
      }
    }
  }

  // 3. Investors
  const investorEntityMap = new Map<string, ReviewEntity>();

  const investorToGroupMap = new Map<string, string>();
  for (const a of fullReview.assets ?? []) {
    const rawHolder = a.proposed?.holderName?.trim() || a.proposed?.entity?.trim() || a.entity?.trim();
    const rawGroup = a.proposed?.group?.trim() || a.proposed?.fund?.trim() || a.fund?.trim();
    if (rawHolder && rawGroup) {
      const norm = normalizeCanonicalName(rawHolder);
      if (norm) investorToGroupMap.set(norm, rawGroup);
      investorToGroupMap.set(rawHolder.toLowerCase(), rawGroup);
      investorToGroupMap.set(rawHolder, rawGroup);
    }
  }

  for (const inv of fullReview.investors ?? []) {
    const normKey = normalizeCanonicalName(inv.name);
    const rawLower = inv.name.trim().toLowerCase();
    const raw = inv.name.trim();

    const aliasKeys = [normKey, rawLower, raw].filter(Boolean);
    const matchingEntities = new Set<ReviewEntity>();
    for (const k of aliasKeys) {
      const hit = investorEntityMap.get(k);
      if (hit) matchingEntities.add(hit);
    }

    if (matchingEntities.size > 1) {
      throw new FundUpdateValidationError(
        `Ambiguous canonical identity for investor "${inv.name}": aliases point to multiple distinct investor entities (${Array.from(matchingEntities).map((e) => e.key).join(', ')}).`,
      );
    }

    const existingInvEnt = matchingEntities.size === 1 ? Array.from(matchingEntities)[0] : undefined;

    const invClean = inv.name.trim();
    const invNorm = normalizeCanonicalName(invClean);
    const invLower = invClean.toLowerCase();
    let invGroupName =
      investorToGroupMap.get(invNorm) ??
      investorToGroupMap.get(invLower) ??
      investorToGroupMap.get(invClean);

    if (!invGroupName && inv.asset_codes?.length) {
      for (const code of inv.asset_codes) {
        const a = (fullReview.assets ?? []).find((item) => item.code === code);
        const grp = a?.proposed?.group?.trim() || a?.proposed?.fund?.trim() || a?.fund?.trim();
        if (grp) {
          invGroupName = grp;
          break;
        }
      }
    }

    if (existingInvEnt) {
      const existingId = existingInvEnt.matchedId;
      const incomingId = inv.matched_id;
      if (existingId && incomingId && existingId !== incomingId) {
        existingInvEnt.matchedIdConflict = { id1: existingId, id2: incomingId };
        existingInvEnt.status = 'blocked';
        existingInvEnt.blockReason = `Constituents of canonical investor "${existingInvEnt.name}" have conflicting matched investor IDs (${existingId} vs ${incomingId}).`;
      } else if (incomingId && !existingId) {
        existingInvEnt.matchedId = incomingId;
        if (inv.status === 'existing') existingInvEnt.status = 'matched';
      }

      if (!existingInvEnt.englishName && inv.english_name) {
        existingInvEnt.englishName = inv.english_name;
      }
      if (!existingInvEnt.groupName && invGroupName) {
        existingInvEnt.groupName = invGroupName;
      }
      for (const code of inv.asset_codes ?? []) {
        const a = (fullReview.assets ?? []).find((item) => item.code === code);
        if (!a) continue;
        const isFundTarget = targetsFund(a);
        const targetEnt = isFundTarget
          ? (fundEntityMap.get(normalizeCanonicalName(a.name) || a.name.trim().toLowerCase()) ?? fundEntityMap.get(a.name))
          : (assetEntityMap.get(normalizeCanonicalName(a.name) || normalizeCanonicalName(a.proposed?.legalName) || a.name.trim().toLowerCase()) ?? assetEntityMap.get(a.code));
        const linkKey = targetEnt?.key ?? (isFundTarget ? `fund:${a.name}` : `asset:${a.code}`);
        const linkKind = isFundTarget ? 'Fund' : 'Asset';
        if (!existingInvEnt.links.some((l) => l.key === linkKey)) {
          existingInvEnt.links.push({
            key: linkKey,
            kind: linkKind,
            name: targetEnt?.name ?? a.name,
            status: (targetEnt?.status ?? (a.status === 'new' ? 'new' : 'matched')) as 'new' | 'matched',
          });
        }
      }
      for (const k of aliasKeys) {
        investorEntityMap.set(k, existingInvEnt);
      }
      continue;
    }

    const key = `investor:${inv.name}`;
    const links: EntityLink[] = (inv.asset_codes ?? [])
      .map((code) => {
        const a = (fullReview.assets ?? []).find((item) => item.code === code);
        if (!a) return null;
        const isFundTarget = targetsFund(a);
        const targetEnt = isFundTarget
          ? (fundEntityMap.get(normalizeCanonicalName(a.name) || a.name.trim().toLowerCase()) ?? fundEntityMap.get(a.name))
          : (assetEntityMap.get(normalizeCanonicalName(a.name) || normalizeCanonicalName(a.proposed?.legalName) || a.name.trim().toLowerCase()) ?? assetEntityMap.get(a.code));
        return {
          key: targetEnt?.key ?? (isFundTarget ? `fund:${a.name}` : `asset:${a.code}`),
          kind: isFundTarget ? 'Fund' : 'Asset',
          name: targetEnt?.name ?? a.name,
          status: (targetEnt?.status ?? (a.status === 'new' ? 'new' : 'matched')) as EntityStatus,
        };
      })
      .filter((l): l is EntityLink => l !== null);

    const fields: EntityField[] = [
      { label: 'Investor Name', value: inv.name },
      { label: 'Status', value: inv.status },
      { label: 'Matched Investor ID', value: inv.matched_id },
      { label: 'Role', value: inv.role ?? 'Investor' },
    ];

    const entity: ReviewEntity = {
      key,
      tab: 'investor',
      code: '',
      name: inv.name,
      englishName: inv.english_name ?? null,
      status: inv.status === 'existing' ? 'matched' : 'new',
      matchedId: inv.matched_id,
      role: inv.role,
      groupName: invGroupName ?? null,
      txnsCount: 0,
      valsCount: 0,
      fields,
      links,
      isStaged: true,
      rawCatalog: inv,
    };
    entities.push(entity);
    entityMap.set(key, entity);
    for (const k of aliasKeys) {
      investorEntityMap.set(k, entity);
    }
  }

  // 3b. Investor Groups
  for (const group of fullReview.groups ?? []) {
    const key = `group:${group.name}`;
    if (entityMap.has(key)) continue;

    const normGroupName = normalizeCanonicalName(group.name);
    const lowerGroupName = group.name.trim().toLowerCase();

    // Member investors are investor entities (!isGroup) whose groupName matches this group
    const memberInvestors = entities.filter(
      (e) =>
        e.tab === 'investor' &&
        !e.isGroup &&
        Boolean(
          e.groupName &&
          (normalizeCanonicalName(e.groupName) === normGroupName ||
           e.groupName.trim().toLowerCase() === lowerGroupName),
        ),
    );

    const memberLinks: EntityLink[] = memberInvestors.map((m) => ({
      key: m.key,
      kind: 'Investor',
      name: m.name,
      status: m.status,
    }));

    const fields: EntityField[] = [
      { label: 'Group Name', value: group.name },
      { label: 'Status', value: group.status },
      { label: 'Matched Investor ID', value: group.matched_id },
      { label: 'Entities', value: memberInvestors.length },
    ];

    const groupEntity: ReviewEntity = {
      key,
      tab: 'investor',
      code: '',
      name: group.name,
      englishName: group.english_name ?? null,
      status: group.status === 'existing' ? 'matched' : 'new',
      matchedId: group.matched_id,
      isGroup: true,
      role: 'Group',
      groupName: group.name,
      txnsCount: 0,
      valsCount: 0,
      fields,
      links: memberLinks,
      isStaged: true,
      rawCatalog: group,
    };

    entities.push(groupEntity);
    entityMap.set(key, groupEntity);
  }

  // 4. Sources of Fund
  const sourceEntityMap = new Map<string, ReviewEntity>();

  for (const src of fullReview.sources ?? []) {
    const normKey = normalizeCanonicalName(src.name);
    const rawLower = src.name.trim().toLowerCase();
    const raw = src.name.trim();

    const aliasKeys = [normKey, rawLower, raw].filter(Boolean);
    const matchingEntities = new Set<ReviewEntity>();
    for (const k of aliasKeys) {
      const hit = sourceEntityMap.get(k);
      if (hit) matchingEntities.add(hit);
    }

    if (matchingEntities.size > 1) {
      throw new FundUpdateValidationError(
        `Ambiguous canonical identity for source "${src.name}": aliases point to multiple distinct source entities (${Array.from(matchingEntities).map((e) => e.key).join(', ')}).`,
      );
    }

    const existingSrcEnt = matchingEntities.size === 1 ? Array.from(matchingEntities)[0] : undefined;

    if (existingSrcEnt) {
      const existingId = existingSrcEnt.matchedId;
      const incomingId = src.matched_id;
      if (existingId && incomingId && existingId !== incomingId) {
        existingSrcEnt.matchedIdConflict = { id1: existingId, id2: incomingId };
        existingSrcEnt.status = 'blocked';
        existingSrcEnt.blockReason = `Constituents of canonical source "${existingSrcEnt.name}" have conflicting matched source IDs (${existingId} vs ${incomingId}).`;
      } else if (incomingId && !existingId) {
        existingSrcEnt.matchedId = incomingId;
        if (src.status === 'existing') existingSrcEnt.status = 'matched';
      }

      if (!existingSrcEnt.englishName && src.english_name) {
        existingSrcEnt.englishName = src.english_name;
      }
      for (const code of src.asset_codes ?? []) {
        const a = (fullReview.assets ?? []).find((item) => item.code === code);
        if (!a) continue;
        const isFundTarget = targetsFund(a);
        const targetEnt = isFundTarget
          ? (fundEntityMap.get(normalizeCanonicalName(a.name) || a.name.trim().toLowerCase()) ?? fundEntityMap.get(a.name))
          : (assetEntityMap.get(normalizeCanonicalName(a.name) || normalizeCanonicalName(a.proposed?.legalName) || a.name.trim().toLowerCase()) ?? assetEntityMap.get(a.code));
        const linkKey = targetEnt?.key ?? (isFundTarget ? `fund:${a.name}` : `asset:${a.code}`);
        const linkKind = isFundTarget ? 'Fund' : 'Asset';
        if (!existingSrcEnt.links.some((l) => l.key === linkKey)) {
          existingSrcEnt.links.push({
            key: linkKey,
            kind: linkKind,
            name: targetEnt?.name ?? a.name,
            status: (targetEnt?.status ?? (a.status === 'new' ? 'new' : 'matched')) as 'new' | 'matched',
          });
        }
      }
      for (const k of aliasKeys) {
        sourceEntityMap.set(k, existingSrcEnt);
      }
      continue;
    }

    const key = `source:${src.name}`;
    const links: EntityLink[] = (src.asset_codes ?? [])
      .map((code) => {
        const a = (fullReview.assets ?? []).find((item) => item.code === code);
        if (!a) return null;
        const isFundTarget = targetsFund(a);
        const targetEnt = isFundTarget
          ? (fundEntityMap.get(normalizeCanonicalName(a.name) || a.name.trim().toLowerCase()) ?? fundEntityMap.get(a.name))
          : (assetEntityMap.get(normalizeCanonicalName(a.name) || normalizeCanonicalName(a.proposed?.legalName) || a.name.trim().toLowerCase()) ?? assetEntityMap.get(a.code));
        return {
          key: targetEnt?.key ?? (isFundTarget ? `fund:${a.name}` : `asset:${a.code}`),
          kind: isFundTarget ? 'Fund' : 'Asset',
          name: targetEnt?.name ?? a.name,
          status: (targetEnt?.status ?? (a.status === 'new' ? 'new' : 'matched')) as EntityStatus,
        };
      })
      .filter((l): l is EntityLink => l !== null);

    const fields: EntityField[] = [
      { label: 'Source Name', value: src.name },
      { label: 'Status', value: src.status },
      { label: 'Matched Source ID', value: src.matched_id },
    ];

    const entity: ReviewEntity = {
      key,
      tab: 'source',
      code: '',
      name: src.name,
      englishName: src.english_name ?? null,
      status: src.status === 'existing' ? 'matched' : 'new',
      matchedId: src.matched_id,
      txnsCount: 0,
      valsCount: 0,
      fields,
      links,
      isStaged: true,
      rawCatalog: src,
    };
    entities.push(entity);
    entityMap.set(key, entity);
    for (const k of aliasKeys) {
      sourceEntityMap.set(k, entity);
    }
  }

  // -------------------------------------------------------------
  // Step 2: Normalize Transactions & Valuations
  // -------------------------------------------------------------

  // Path A: Asset Transactions & Valuations (STARTECH / Asset Proposals)
  for (const asset of fullReview.assets ?? []) {
    const isFundTarget = targetsFund(asset);
    const normTarget = normalizeCanonicalName(asset.name) || normalizeCanonicalName(asset.proposed?.legalName) || asset.name.trim().toLowerCase();
    const targetFundEnt =
      fundEntityMap.get(normTarget) ??
      fundEntityMap.get(asset.name.trim().toLowerCase()) ??
      fundEntityMap.get(asset.name);
    const targetFundKey = targetFundEnt?.key ?? `fund:${asset.name}`;

    const targetAssetEnt =
      assetEntityMap.get(normTarget) ??
      assetEntityMap.get(asset.name.trim().toLowerCase()) ??
      assetEntityMap.get(asset.name) ??
      assetEntityMap.get(asset.code);
    const targetAssetKey = targetAssetEnt?.key ?? `asset:${asset.code}`;

    let owningFundKey: string | null = null;
    const rawFundName = asset.proposed?.fund?.trim() || asset.fund?.trim();
    if (rawFundName) {
      const normOwning = normalizeCanonicalName(rawFundName) || rawFundName.toLowerCase();
      const owningFundEnt =
        fundEntityMap.get(normOwning) ??
        fundEntityMap.get(rawFundName.toLowerCase()) ??
        fundEntityMap.get(rawFundName);
      owningFundKey = owningFundEnt?.key ?? `fund:${rawFundName}`;
    }

    let holdingEntityKey: string | null = null;
    const rawHolderName = asset.proposed?.holderName?.trim() || asset.proposed?.entity?.trim() || asset.entity?.trim();
    if (rawHolderName) {
      const normInv = normalizeCanonicalName(rawHolderName) || rawHolderName.toLowerCase();
      const invEnt =
        investorEntityMap.get(normInv) ??
        investorEntityMap.get(rawHolderName.toLowerCase()) ??
        investorEntityMap.get(rawHolderName);
      holdingEntityKey = invEnt?.key ?? `investor:${rawHolderName}`;
    }

    let sourceKey: string | null = null;
    const rawSource = asset.funding_source?.trim() || asset.proposed?.fundingSource?.trim();
    if (rawSource) {
      const normSrc = normalizeCanonicalName(rawSource) || rawSource.toLowerCase();
      const srcEnt =
        sourceEntityMap.get(normSrc) ??
        sourceEntityMap.get(rawSource.toLowerCase()) ??
        sourceEntityMap.get(rawSource);
      sourceKey = srcEnt?.key ?? `source:${rawSource}`;
    }

    const isInvestorHolder = (asset.proposed?.holderKind ?? (asset as any).holderKind ?? 'fund') === 'investor';

    const holderKey = isInvestorHolder
      ? (holdingEntityKey ?? '')
      : (owningFundKey ?? (rawFundName ? `fund:${rawFundName}` : ''));

    const proposedTxns = asset.proposed?.txns ?? [];
    const missingTxnKeys = new Set((asset.missing_txns ?? []).map(fundUpdateTxnKey));

    proposedTxns.forEach((txn, idx) => {
      const origKey = fundUpdateTxnKey(txn);
      const isMissing = missingTxnKeys.has(origKey);
      const classification = classifyFundUpdateTxn({
        type: txn.type,
        subTypeLabel: txn.subTypeLabel,
        notes: txn.notes,
        valueAmount: txn.valueAmount,
        shareCount: txn.shareCount,
        pricePerShare: txn.pricePerShare,
        positionKind: asset.proposed?.assetType === 'fund_of_funds' ? 'fund' : 'asset',
      });

      const isOutflow = classification.direction === 'outflow';
      const targetKey = isFundTarget ? targetFundKey : targetAssetKey;

      const fromKey = isOutflow ? holderKey : targetKey;
      const toKey = isOutflow ? targetKey : holderKey;

      const srcKey = sourceKey;
      const amt = txn.valueAmount != null ? Math.abs(txn.valueAmount) : null;
      const cashDelta = computeSignedCashDelta(txn.valueAmount, classification);

      let status: 'actionable' | 'duplicate' | 'blocked' = isMissing ? 'actionable' : 'duplicate';
      let blockReason: string | null = null;

      if (!isMissing) {
        status = 'duplicate';
      } else if (classification.isUnresolved) {
        status = 'blocked';
        blockReason = classification.unresolvedReason;
      }

      const reviewType =
        classification.canonicalKind === 'buy' ||
        classification.canonicalKind === 'sell' ||
        classification.canonicalKind === 'distribution' ||
        classification.canonicalKind === 'paid_in' ||
        classification.canonicalKind === 'income' ||
        classification.canonicalKind === 'expense'
          ? classification.canonicalKind
          : mapTxnTypeToTwoStep(txn.type);

      const isSellRow =
        reviewType === 'sell' || classification.canonicalKind === 'sell';
      // Only the *stated* destination is carried. An unmarked sale leaves this null; the
      // review UI renders the effective default (distributed) at display time, and apply
      // leaves sub_type untouched, so nothing is persisted that the source did not say.
      const sellProceedsDestination: SellProceedsDestination | null = isSellRow
        ? statedSellProceedsDestination(txn)
        : null;

      // Review annotates, apply decides: a managed fund's 投资/退出 into another
      // managed fund stays visible and selectable, and apply posts nothing for it.
      const crossBookNote =
        !isV1 && asset.proposed && isManagedFundCrossBookAsset(asset.proposed, managedFundKeys)
          ? managedFundCrossBookNote(asset.proposed.name, crossBookFlowKindForTxn(txn))
          : null;

      const transaction: ReviewTransaction = {
        id: `txn:${asset.code}:${idx}:${txn.date}:${txn.type}`,
        sheetRow: idx + 1,
        date: txn.date,
        fromKey,
        toKey,
        srcKey,
        sourceKey: srcKey,
        type: reviewType,
        subType: txn.subTypeLabel || txn.notes || txn.type,
        notes: txn.notes ?? null,
        ...(crossBookNote ? { reviewNote: crossBookNote } : {}),
        commitDelta: null,
        quantityDelta: txn.shareCount ?? null,
        pricePerShare: txn.pricePerShare ?? null,
        cashDelta,
        amount: amt,
        currency: txn.currency || asset.proposed?.currency || 'USD',
        positionRef: asset.matched_asset_id,
        status,
        blockReason,
        selected: isMissing,
        isTransfer: false,
        backingRef: { kind: 'asset_txn', assetCode: asset.code, txnIndex: idx, originalKey: origKey },
        assetCode: asset.code,
        originalKey: origKey,
        sellProceedsDestination,
        rawTxn: txn,
      };
      transactions.push(transaction);

      if (fromKey && entityMap.has(fromKey)) {
        const ent = entityMap.get(fromKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
      if (toKey && entityMap.has(toKey)) {
        const ent = entityMap.get(toKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
      if (srcKey && entityMap.has(srcKey)) {
        const ent = entityMap.get(srcKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
    });

    // Asset Valuations
    const proposedVals = asset.proposed?.valuations ?? [];
    const missingValKeys = new Set((asset.missing_valuations ?? []).map(valuationContentKey));

    proposedVals.forEach((val, idx) => {
      if (!isPersistableFundUpdateValuation(val)) return;

      const valContent = valuationContentKey(val);
      const isMissing = missingValKeys.has(valContent);
      const targetKey = isFundTarget ? targetFundKey : targetAssetKey;

      let status: 'actionable' | 'duplicate' | 'blocked' = isMissing ? 'actionable' : 'duplicate';
      let blockReason: string | null = null;

      if (!isMissing) {
        status = 'duplicate';
      } else if (!holderKey) {
        // Workbook market values are position-scoped (Q4). Missing holder must not
        // silently become an instrument-wide mark — block for the reviewer.
        status = 'blocked';
        blockReason = `Valuation for "${asset.name}" as of ${val.asOfDate || 'unknown date'} requires a holder; missing holder cannot become an instrument-wide mark.`;
      }

      const valuation: ReviewValuation = {
        id: `val:${asset.code}:${val.asOfDate}:${val.marketValue}`,
        sheetRow: idx + 1,
        targetKey,
        holderKey: holderKey || '',
        assetCode: asset.code,
        assetName: asset.name,
        asOfDate: val.asOfDate || '',
        periodLabel: quarterPeriodLabel(val.asOfDate),
        marketValue: val.marketValue,
        pricePerShare: val.pricePerShare ?? null,
        sharesOutstanding: val.sharesOutstanding ?? null,
        shareholdingPct: val.shareholdingPct ?? null,
        valuationMethod: val.valuationMethod ?? null,
        currency: asset.proposed?.currency || 'USD',
        notes: val.notes ?? null,
        status,
        blockReason,
        selected: isMissing && status !== 'blocked',
        backingRef: { kind: 'asset_valuation', assetCode: asset.code, valIndex: idx, originalKey: fundUpdateValKey(val) },
        originalKey: fundUpdateValKey(val),
        rawVal: val,
      };
      valuations.push(valuation);

      if (targetKey && entityMap.has(targetKey)) {
        const ent = entityMap.get(targetKey)!;
        ent.valsCount = (ent.valsCount || 0) + 1;
      }
      if (!isFundTarget && owningFundKey && entityMap.has(owningFundKey)) {
        const fundEnt = entityMap.get(owningFundKey)!;
        fundEnt.valsCount = (fundEnt.valsCount || 0) + 1;
      }
    });
  }

  // Path B: Nanjing Commitment Events & Review Items
  const commitmentEvents = !isV1 ? (legacyProposal?.commitment_events ?? []) : [];
  // The party entity of a commitment-path row: the managed fund's Fund-tab entity
  // when the party is one of our managed funds, otherwise the investor.
  const commitmentPartyKey = (name: string | null | undefined): string => {
    const clean = name?.trim() ?? '';
    if (clean && isManagedFundName(clean, managedFundKeys)) {
      const fundEnt =
        fundEntityMap.get(normalizeCanonicalName(clean) || clean.toLowerCase()) ??
        fundEntityMap.get(clean.toLowerCase()) ??
        fundEntityMap.get(clean);
      return fundEnt?.key ?? `fund:${clean}`;
    }
    return `investor:${clean}`;
  };
  // Commitment each party holds in each fund according to this workbook, used to
  // flag a managed-fund transferor that has nothing to transfer.
  const workbookCommitmentKeys = new Set(
    commitmentEvents
      .filter((e) => e.intent === 'increase' || e.intent === 'transfer_in')
      .map((e) => `${normalizeCanonicalName(e.investorName)}|${normalizeCanonicalName(e.fund)}`),
  );
  for (const ev of commitmentEvents) {
    if (['increase', 'decrease', 'paid_in', 'distribution'].includes(ev.intent)) {
      const isDistribution = ev.intent === 'distribution';
      const isPaidIn = ev.intent === 'paid_in';
      const isDecrease = ev.intent === 'decrease';
      const isCommitment = ev.intent === 'increase';

      const fromKey = isDistribution ? `fund:${ev.fund}` : commitmentPartyKey(ev.investorName);
      const toKey = isDistribution ? commitmentPartyKey(ev.investorName) : `fund:${ev.fund}`;
      const type = isPaidIn ? 'paid_in' : isDistribution ? 'distribution' : isDecrease ? 'commitment_reduction' : 'commitment';

      const commitDelta = isCommitment ? ev.amount : isDecrease ? (ev.amount ? -ev.amount : null) : null;
      const cashDelta = isPaidIn ? (ev.amount ? -ev.amount : null) : isDistribution ? ev.amount : null;

      const isValid = Boolean(ev.investorName?.trim() && ev.fund?.trim() && (ev.amount ?? 0) > 0);
      const isDuplicate = isValid && fullReview.commitment_event_statuses?.[ev.sourceRow] === 'duplicate';
      const status: 'actionable' | 'duplicate' | 'blocked' = !isValid
        ? 'blocked'
        : isDuplicate
          ? 'duplicate'
          : 'actionable';
      const blockReason = !ev.investorName?.trim() ? "Missing required investor" : !ev.fund?.trim() ? "Missing required fund" : null;

      const transaction: ReviewTransaction = {
        id: `commitment:${ev.sourceRow}`,
        sheetRow: ev.sourceRow,
        date: ev.date || '',
        fromKey,
        toKey,
        srcKey: null,
        sourceKey: null,
        type,
        subType: ev.natureRaw || ev.directionRaw || ev.intent,
        commitDelta,
        quantityDelta: null,
        pricePerShare: null,
        cashDelta,
        amount: ev.amount ?? null,
        currency: ev.currency || 'CNY',
        positionRef: null,
        status,
        blockReason,
        selected: status === 'actionable',
        isTransfer: false,
        backingRef: { kind: 'commitment_event', sourceRow: ev.sourceRow, intent: ev.intent },
        rawCommitmentEvent: ev,
      };
      transactions.push(transaction);

      if (fromKey && entityMap.has(fromKey)) {
        const ent = entityMap.get(fromKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
      if (toKey && entityMap.has(toKey)) {
        const ent = entityMap.get(toKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
    } else if (ev.intent === 'transfer_in') {
      const transferorName = ev.transferPairing?.transferorName ?? ev.counterpartyName ?? '';
      const transfereeName = ev.investorName ?? '';
      const isEligible = Boolean(
        transferorName &&
        transfereeName &&
        ev.transferPairing?.eligibleForTransferOut &&
        !ev.transferPairing?.requiresReview &&
        (ev.amount ?? 0) > 0,
      );
      const isDuplicate = isEligible && fullReview.commitment_event_statuses?.[ev.sourceRow] === 'duplicate';

      const fromKey = commitmentPartyKey(transferorName);
      const toKey = commitmentPartyKey(transfereeName);
      const status: 'actionable' | 'duplicate' | 'blocked' = !isEligible
        ? 'blocked'
        : isDuplicate
          ? 'duplicate'
          : 'actionable';
      // A managed fund can only transfer commitment it holds. With none in this
      // workbook, apply rejects the row unless the ledger already has it.
      const phantomTransferNote =
        isEligible &&
        isManagedFundName(transferorName, managedFundKeys) &&
        !workbookCommitmentKeys.has(`${normalizeCanonicalName(transferorName)}|${normalizeCanonicalName(ev.fund)}`)
          ? `Transferor ${transferorName} is a managed fund with no commitment in ${ev.fund} in this workbook; apply rejects this transfer unless that commitment is already in the ledger, so no phantom fund-of-funds holding is created.`
          : null;
      const blockReason = !isEligible
        ? (ev.transferPairing?.reviewReason ?? 'Transfer counterparty could not be verified automatically')
        : null;

      const legs: ReviewTransactionLeg[] = isEligible
        ? [
            { from: transferorName, to: ev.fund, type: 'transfer_out', amount: ev.amount ?? 0 },
            { from: ev.fund, to: transfereeName, type: 'transfer_in', amount: ev.amount ?? 0 },
          ]
        : [];

      const transaction: ReviewTransaction = {
        id: `transfer:${ev.sourceRow}`,
        sheetRow: ev.sourceRow,
        date: ev.date || '',
        fromKey,
        toKey,
        srcKey: null,
        sourceKey: null,
        type: 'commitment_transfer',
        subType: 'commitment_transfer',
        commitDelta: null,
        quantityDelta: null,
        pricePerShare: null,
        cashDelta: 0,
        amount: ev.amount ?? null,
        currency: ev.currency || 'CNY',
        positionRef: null,
        status,
        blockReason,
        selected: status === 'actionable',
        isTransfer: true,
        isMultiPartyTransfer: false,
        legs,
        ...(phantomTransferNote ? { reviewNote: phantomTransferNote } : {}),
        backingRef: { kind: 'commitment_event', sourceRow: ev.sourceRow, intent: ev.intent },
        rawCommitmentEvent: ev,
      };
      transactions.push(transaction);

      if (fromKey && entityMap.has(fromKey)) {
        const ent = entityMap.get(fromKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
      if (toKey && entityMap.has(toKey)) {
        const ent = entityMap.get(toKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
    }
  }

  // Review Items (Non-Cash Adjustments & Review Transfers)
  const reviewItems = fullReview.review_items ?? [];
  for (const item of reviewItems) {
    const isNonCash =
      item.category === 'non_cash_adjustment' ||
      item.action === '实缴调整' ||
      item.nature === '损益核销' ||
      item.direction === '非现金调整';

    if (isNonCash) {
      const investorName = item.investorName || item.targetRaw || item.entityRaw || '';
      const fromKey = commitmentPartyKey(investorName);
      const toKey = `fund:${item.fund}`;

      const nonCashState: NonCashAdjustmentState = {
        enabled: false,
        investorName,
        direction: 'reduction',
        subType: 'paid_in_writeoff',
      };

      const transaction: ReviewTransaction = {
        id: `review-item:${item.sourceRow}`,
        sheetRow: item.sourceRow,
        date: item.date || '',
        fromKey,
        toKey,
        srcKey: null,
        sourceKey: null,
        type: 'adjustment',
        subType: item.nature || item.action || '损益核销',
        commitDelta: null,
        quantityDelta: null,
        pricePerShare: null,
        cashDelta: 0,
        amount: item.amount ?? null,
        currency: item.currency || 'CNY',
        positionRef: null,
        status: 'blocked',
        blockReason: item.explanation || 'Non-cash adjustment requires review resolution before approval',
        selected: false,
        isTransfer: false,
        isNonCashAdjustment: true,
        nonCashState,
        backingRef: { kind: 'review_item', sourceRow: item.sourceRow, category: item.category },
        rawReviewItem: item,
      };
      transactions.push(transaction);
    } else {
      const counterpartyRaw = item.counterpartyRaw ?? '';
      const validation = counterpartyRaw ? validateTransferCounterparty(counterpartyRaw) : { isMultiParty: false };
      const isMultiParty = item.category === 'multi_party_transfer' || validation.isMultiParty;
      const transfereeName = item.investorName || item.targetRaw || item.entityRaw || '';

      const fromKey = counterpartyRaw ? commitmentPartyKey(counterpartyRaw) : '';
      const toKey = commitmentPartyKey(transfereeName);

      let allocations: MultiTransferAllocation[] | undefined;
      let singleTransferState: SingleTransferState | undefined;

      if (isMultiParty) {
        const parts = counterpartyRaw ? counterpartyRaw.split(/[、,，;；+＋&/\\]/).map((s) => s.trim()).filter(Boolean) : [];
        const count = Math.max(parts.length, 2);
        const splitAmt = item.amount ? item.amount / count : 0;
        allocations = Array.from({ length: count }, (_, i) => ({
          id: `alloc-${i + 1}`,
          transferorName: parts[i] || '',
          amount: splitAmt,
        }));
      } else {
        singleTransferState = {
          enabled: false,
          transferorName: counterpartyRaw,
        };
      }

      const transaction: ReviewTransaction = {
        id: `review-item:${item.sourceRow}`,
        sheetRow: item.sourceRow,
        date: item.date || '',
        fromKey,
        toKey,
        srcKey: null,
        sourceKey: null,
        type: 'commitment_transfer',
        subType: item.action || 'Commitment transfer',
        commitDelta: null,
        quantityDelta: null,
        pricePerShare: null,
        cashDelta: 0,
        amount: item.amount ?? null,
        currency: item.currency || 'CNY',
        positionRef: null,
        status: 'blocked',
        blockReason: item.explanation || 'Transfer requires review resolution before approval',
        selected: false,
        isTransfer: true,
        isMultiPartyTransfer: isMultiParty,
        allocations,
        singleTransferState,
        backingRef: { kind: 'review_item', sourceRow: item.sourceRow, category: item.category },
        rawReviewItem: item,
      };
      transactions.push(transaction);
    }
  }

  // Path C: Workbook Fallback v1
  if (v1Proposal) {
    const v1Events = v1Proposal.events ?? [];
    v1Events.forEach((ev, idx) => {
      // Persistable asset events are rendered from Path A, which carries the
      // database-backed duplicate status. Do not render them a second time as
      // generic v1 events.
      if (
        isPersistableV1AssetEventType(ev.eventType) &&
        fullReview.assets.some((asset) =>
          (asset.proposed?.txns ?? []).some((txn) =>
            txn.sourceSheet === ev.sourceLocation?.sheet &&
            txn.sourceRow === ev.sourceLocation?.row,
          ),
        )
      ) {
        return;
      }
      let fromKey = ev.fromEntityRef ? entityRefToKey(ev.fromEntityRef, v1Proposal.entities) : '';
      let toKey = ev.toEntityRef ? entityRefToKey(ev.toEntityRef, v1Proposal.entities) : '';
      let srcKey = ev.relatedFundRef ? `source:${ev.relatedFundRef}` : null;

      // Canonical resolution for toKey
      if (toKey.startsWith('asset:')) {
        const raw = toKey.replace(/^asset:/, '');
        const targetEnt =
          assetEntityMap.get(normalizeCanonicalName(raw) || raw.trim().toLowerCase()) ??
          assetEntityMap.get(raw.trim().toLowerCase()) ??
          assetEntityMap.get(raw);
        if (targetEnt) toKey = targetEnt.key;
      } else if (toKey.startsWith('fund:')) {
        const raw = toKey.replace(/^fund:/, '');
        const targetEnt =
          fundEntityMap.get(normalizeCanonicalName(raw) || raw.trim().toLowerCase()) ??
          fundEntityMap.get(raw.trim().toLowerCase()) ??
          fundEntityMap.get(raw) ??
          assetEntityMap.get(normalizeCanonicalName(raw)) ??
          assetEntityMap.get(raw);
        if (targetEnt) toKey = targetEnt.key;
      } else if (toKey.startsWith('investor:')) {
        const raw = toKey.replace(/^investor:/, '');
        const targetEnt =
          investorEntityMap.get(normalizeCanonicalName(raw) || raw.trim().toLowerCase()) ??
          investorEntityMap.get(raw.trim().toLowerCase()) ??
          investorEntityMap.get(raw);
        if (targetEnt) toKey = targetEnt.key;
      }

      // Canonical resolution for fromKey
      if (fromKey.startsWith('asset:')) {
        const raw = fromKey.replace(/^asset:/, '');
        const targetEnt =
          assetEntityMap.get(normalizeCanonicalName(raw) || raw.trim().toLowerCase()) ??
          assetEntityMap.get(raw.trim().toLowerCase()) ??
          assetEntityMap.get(raw);
        if (targetEnt) fromKey = targetEnt.key;
      } else if (fromKey.startsWith('fund:')) {
        const raw = fromKey.replace(/^fund:/, '');
        const targetEnt =
          fundEntityMap.get(normalizeCanonicalName(raw) || raw.trim().toLowerCase()) ??
          fundEntityMap.get(raw.trim().toLowerCase()) ??
          fundEntityMap.get(raw) ??
          assetEntityMap.get(normalizeCanonicalName(raw)) ??
          assetEntityMap.get(raw);
        if (targetEnt) fromKey = targetEnt.key;
      } else if (fromKey.startsWith('investor:')) {
        const raw = fromKey.replace(/^investor:/, '');
        const targetEnt =
          investorEntityMap.get(normalizeCanonicalName(raw) || raw.trim().toLowerCase()) ??
          investorEntityMap.get(raw.trim().toLowerCase()) ??
          investorEntityMap.get(raw);
        if (targetEnt) fromKey = targetEnt.key;
      }

      // Canonical resolution for srcKey
      if (srcKey && srcKey.startsWith('source:')) {
        const raw = srcKey.replace(/^source:/, '');
        const targetEnt =
          sourceEntityMap.get(normalizeCanonicalName(raw) || raw.trim().toLowerCase()) ??
          sourceEntityMap.get(raw.trim().toLowerCase()) ??
          sourceEntityMap.get(raw);
        if (targetEnt) srcKey = targetEnt.key;
      }

      const amt = ev.normalizedAmount ?? ev.sourceAmount ?? null;
      const type = mapTxnTypeToTwoStep(ev.eventType);

      const isValid = Boolean(fromKey && toKey);
      const status: 'actionable' | 'duplicate' | 'blocked' = isValid ? 'actionable' : 'blocked';
      const blockReason = !fromKey ? "Missing required 'from' entity" : !toKey ? "Missing required 'to' entity" : null;

      const transaction: ReviewTransaction = {
        id: `v1-evt:${ev.proposalId || idx}`,
        sheetRow: ev.sourceLocation?.row ?? idx + 1,
        date: ev.date || '',
        fromKey,
        toKey,
        srcKey,
        sourceKey: srcKey,
        type,
        subType: ev.sourceNature || ev.sourceAction || ev.eventType,
        commitDelta: type === 'commitment' ? amt : null,
        quantityDelta: null,
        pricePerShare: null,
        cashDelta: type === 'paid_in' ? (amt ? -amt : null) : type === 'distribution' ? amt : null,
        amount: amt,
        currency: ev.normalizedCurrency ?? ev.sourceCurrency ?? 'CNY',
        positionRef: null,
        status,
        blockReason,
        selected: status === 'actionable',
        isTransfer: ev.eventType === 'commitment_transfer',
        backingRef: { kind: 'v1_event', proposalId: ev.proposalId, eventType: ev.eventType },
        rawEvent: ev,
      };
      transactions.push(transaction);

      if (fromKey && entityMap.has(fromKey)) {
        const ent = entityMap.get(fromKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
      if (toKey && entityMap.has(toKey)) {
        const ent = entityMap.get(toKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
      if (srcKey && entityMap.has(srcKey)) {
        const ent = entityMap.get(srcKey)!;
        ent.txnsCount = (ent.txnsCount || 0) + 1;
      }
    });

    const v1Valuations = v1Proposal.valuations ?? [];
    v1Valuations.forEach((val, idx) => {
      const matchedEntity = v1Proposal.entities?.find(
        (e) => e.proposalId === val.entityRef || e.originalName === val.entityRef || e.englishName === val.entityRef
      );
      const entityName = matchedEntity?.originalName || matchedEntity?.englishName || val.entityRef;
      const matchedAsset = fullReview.assets.find(
        (a) => a.code === val.entityRef || a.name === entityName || a.code === entityName || (matchedEntity && a.name === matchedEntity.originalName)
      );
      const assetCode = matchedAsset ? matchedAsset.code : entityName;
      const assetName = matchedAsset ? matchedAsset.name : entityName;
      const targetEnt = matchedAsset
        ? (assetEntityMap.get(normalizeCanonicalName(matchedAsset.name) || normalizeCanonicalName(matchedAsset.proposed?.legalName) || matchedAsset.name.trim().toLowerCase()) ?? assetEntityMap.get(matchedAsset.code))
        : (assetEntityMap.get(normalizeCanonicalName(entityName) || entityName.trim().toLowerCase()) ?? assetEntityMap.get(entityName));
      const targetKey = targetEnt ? targetEnt.key : (matchedAsset ? `asset:${matchedAsset.code}` : (val.entityRef ? entityRefToKey(val.entityRef, v1Proposal.entities) : ''));
      const isValid = Boolean(targetKey);
      const status: 'actionable' | 'duplicate' | 'blocked' = isValid ? 'actionable' : 'blocked';
      const blockReason = !isValid ? "Missing target entity for valuation" : null;

      const valuation: ReviewValuation = {
        id: `v1-val:${val.proposalId || idx}`,
        sheetRow: val.sourceLocation?.row ?? idx + 1,
        targetKey,
        assetCode,
        assetName,
        asOfDate: val.asOfDate || '',
        periodLabel: quarterPeriodLabel(val.asOfDate),
        marketValue: val.normalizedMarketValue ?? val.sourceMarketValue ?? null,
        pricePerShare: val.pricePerShare ?? null,
        sharesOutstanding: val.sharesOutstanding ?? null,
        shareholdingPct: val.shareholdingPct ?? null,
        valuationMethod: val.valuationMethod ?? null,
        currency: val.normalizedCurrency ?? val.sourceCurrency ?? 'CNY',
        status,
        blockReason,
        selected: status === 'actionable',
        backingRef: { kind: 'v1_valuation', proposalId: val.proposalId },
        originalKey: val.proposalId || `v1-val-${idx}`,
        rawValuation: val,
      };
      valuations.push(valuation);

      if (targetKey && entityMap.has(targetKey)) {
        const ent = entityMap.get(targetKey)!;
        ent.valsCount = (ent.valsCount || 0) + 1;
      }
    });
  }

  // Reconciliation
  const rawReconciliation = fullReview.reconciliation ?? proposal?.reconciliation ?? [];
  for (const r of rawReconciliation) {
    reconciliation.push({
      fund: r.fund ?? null,
      metricName: r.metricName,
      sourceValue: r.sourceValue,
      calculatedValue: r.calculatedValue,
      diff: r.diff,
      diffPct: r.diffPct,
      currency: r.currency ?? undefined,
      isReconciled: r.isReconciled,
      notes: r.notes ?? null,
    });
  }

  return {
    entities,
    transactions,
    valuations,
    reconciliation,
  };
}

/**
 * Validates dependencies between staged Step 1 entities and selected Step 2 transactions / valuations.
 * Rules:
 * 1. Required from/to dependencies must be present and staged. If missing or deselected, event is server-invalid.
 * 2. Optional source of fund dependency: if missing or deselected, event remains valid and posts with null source.
 * 3. Transfers: must be posted as a complete business event with all internal legs; partial legs are rejected.
 * 4. Valuations: required target asset or fund must be present and staged.
 */
export function validateTwoStepDependencies(
  paramsOrStaged:
    | {
        stagedEntities:
          | Map<string, StagedReviewEntityInput | ReviewEntity>
          | Set<string>
          | Array<StagedReviewEntityInput | ReviewEntity | { key: string; isStaged?: boolean }>;
        transactions: ReviewTransaction[];
        valuations: ReviewValuation[];
      }
    | Map<string, StagedReviewEntityInput | ReviewEntity>
    | Set<string>
    | Array<StagedReviewEntityInput | ReviewEntity | { key: string; isStaged?: boolean }>,
  transactionsArg?: ReviewTransaction[],
  valuationsArg?: ReviewValuation[],
): {
  isValid: boolean;
  errors: string[];
  validatedTransactions: ReviewTransaction[];
  validatedValuations: ReviewValuation[];
} {
  let stagedEntitiesInput:
    | Map<string, StagedReviewEntityInput | ReviewEntity>
    | Set<string>
    | Array<StagedReviewEntityInput | ReviewEntity | { key: string; isStaged?: boolean }>;
  let transactions: ReviewTransaction[];
  let valuations: ReviewValuation[];

  if (
    paramsOrStaged &&
    typeof paramsOrStaged === 'object' &&
    'transactions' in paramsOrStaged &&
    'valuations' in paramsOrStaged &&
    'stagedEntities' in paramsOrStaged
  ) {
    stagedEntitiesInput = paramsOrStaged.stagedEntities;
    transactions = paramsOrStaged.transactions;
    valuations = paramsOrStaged.valuations;
  } else {
    stagedEntitiesInput = paramsOrStaged as any;
    transactions = transactionsArg ?? [];
    valuations = valuationsArg ?? [];
  }

  const errors: string[] = [];

  // Check for entity-level conflicts (e.g. conflicting matched_asset_id among constituents)
  const checkEntityConflicts = (ent: any) => {
    if (ent && ent.isStaged !== false) {
      if (ent.matchedIdConflict) {
        const conflict = ent.matchedIdConflict;
        const err = `Entity "${ent.name ?? ent.key}" (${ent.key}) has conflicting matched IDs (${conflict.id1} vs ${conflict.id2}) across its constituents.`;
        errors.push(err);
      } else if (ent.status === 'blocked' && ent.blockReason) {
        errors.push(`Entity "${ent.name ?? ent.key}" (${ent.key}) is blocked: ${ent.blockReason}`);
      }
    }
  };

  if (Array.isArray(stagedEntitiesInput)) {
    for (const ent of stagedEntitiesInput) {
      checkEntityConflicts(ent);
    }
  } else if (stagedEntitiesInput instanceof Map) {
    for (const ent of stagedEntitiesInput.values()) {
      checkEntityConflicts(ent);
    }
  }

  const isEntityStaged = (key: string | null | undefined): boolean => {
    if (!key) return false;
    if (stagedEntitiesInput instanceof Set) {
      return stagedEntitiesInput.has(key);
    }
    if (stagedEntitiesInput instanceof Map) {
      const ent = stagedEntitiesInput.get(key);
      return Boolean(ent && ent.isStaged !== false);
    }
    if (Array.isArray(stagedEntitiesInput)) {
      const found = stagedEntitiesInput.find((e) => e.key === key);
      return Boolean(found && found.isStaged !== false);
    }
    return false;
  };

  const validatedTransactions = transactions.map((txn) => {
    if (!txn.selected) return txn;

    // Check from entity (required for transactions)
    if (!txn.fromKey || !isEntityStaged(txn.fromKey)) {
      const err = `Transaction "${txn.id}" (date: ${txn.date}, type: ${txn.type}) requires 'from' entity "${txn.fromKey}", which is missing or deselected in Step 1.`;
      errors.push(err);
      return { ...txn, status: 'blocked' as const, blockReason: err };
    }

    // Check to entity (required for transactions)
    if (!txn.toKey || !isEntityStaged(txn.toKey)) {
      const err = `Transaction "${txn.id}" (date: ${txn.date}, type: ${txn.type}) requires 'to' entity "${txn.toKey}", which is missing or deselected in Step 1.`;
      errors.push(err);
      return { ...txn, status: 'blocked' as const, blockReason: err };
    }

    // Check if txn is blocked/unresolved
    if (txn.status === 'blocked' && !txn.isTransfer && !txn.isNonCashAdjustment) {
      const err = `Transaction "${txn.id}" is blocked and cannot be approved: ${txn.blockReason || 'Unresolved transaction requires review'}`;
      errors.push(err);
      return { ...txn, status: 'blocked' as const, blockReason: err };
    }

    // Non-Cash Adjustments: validate resolution fields
    if (txn.isNonCashAdjustment) {
      if (!txn.nonCashState?.enabled) {
        const err = `Non-cash adjustment "${txn.id}" requires an accepted review resolution before approval.`;
        errors.push(err);
        return { ...txn, status: 'blocked' as const, blockReason: err };
      }
      const invName = txn.nonCashState?.investorName?.trim();
      const dir = txn.nonCashState?.direction;
      const subType = txn.nonCashState?.subType?.trim();
      if (!invName || !dir || !subType) {
        const err = `Non-cash adjustment "${txn.id}" requires a valid investor, direction, and subtype before approval.`;
        errors.push(err);
        return { ...txn, status: 'blocked' as const, blockReason: err };
      }
    }

    // Transfers: validate all internal legs together
    if (txn.isTransfer) {
      if (txn.isMultiPartyTransfer) {
        const allocs = txn.allocations ?? [];
        if (allocs.length === 0) {
          const err = `Multi-party transfer "${txn.id}" has no split allocations configured.`;
          errors.push(err);
          return { ...txn, status: 'blocked' as const, blockReason: err };
        }
        let totalAlloc = 0;
        for (const alloc of allocs) {
          const tName = alloc.transferorName?.trim();
          if (!tName) {
            const err = `Multi-party transfer "${txn.id}" has an empty transferor in split allocations.`;
            errors.push(err);
            return { ...txn, status: 'blocked' as const, blockReason: err };
          }
          const valRes = validateTransferCounterparty(tName);
          if (!valRes.valid) {
            const err = `Multi-party transfer "${txn.id}" has invalid transferor "${tName}": ${valRes.reason}`;
            errors.push(err);
            return { ...txn, status: 'blocked' as const, blockReason: err };
          }
          const amt = typeof alloc.amount === 'number' ? alloc.amount : Number(alloc.amount);
          if (!amt || !isFinite(amt) || amt <= 0) {
            const err = `Multi-party transfer "${txn.id}" has invalid allocation amount (${alloc.amount}) for "${alloc.transferorName}".`;
            errors.push(err);
            return { ...txn, status: 'blocked' as const, blockReason: err };
          }
          totalAlloc += amt;
        }
        const expected = (txn.amount ?? txn.rawCommitmentEvent?.amount ?? txn.rawReviewItem?.amount ?? 0);
        if (expected > 0 && Math.abs(totalAlloc - expected) > 0.01) {
          const err = `Multi-party transfer "${txn.id}" allocations sum (${totalAlloc}) does not match expected amount (${expected}).`;
          errors.push(err);
          return { ...txn, status: 'blocked' as const, blockReason: err };
        }
      } else {
        if (txn.singleTransferState && !txn.singleTransferState.enabled) {
          const err = `Transfer "${txn.id}" requires an accepted review resolution before approval.`;
          errors.push(err);
          return { ...txn, status: 'blocked' as const, blockReason: err };
        }
        const transferor =
          txn.singleTransferState?.transferorName?.trim() ||
          txn.rawCommitmentEvent?.transferPairing?.transferorName?.trim() ||
          (txn.fromKey.startsWith('investor:') || txn.fromKey.startsWith('fund:')
            ? txn.fromKey.replace(/^(investor|fund):/, '').trim()
            : '');
        if (!transferor) {
          const err = `Transfer "${txn.id}" requires a valid transferor name.`;
          errors.push(err);
          return { ...txn, status: 'blocked' as const, blockReason: err };
        }
        const valRes = validateTransferCounterparty(transferor);
        if (!valRes.valid) {
          const err = `Transfer "${txn.id}" has invalid transferor "${transferor}": ${valRes.reason}`;
          errors.push(err);
          return { ...txn, status: 'blocked' as const, blockReason: err };
        }
      }
    }

    // Optional source of fund: if missing or deselected, remains valid and posts with null source
    return txn;
  });

  const validatedValuations = valuations.map((val) => {
    if (!val.selected) return val;

    const targetKey = val.targetKey || `asset:${val.assetCode}`;
    const fundCodeKey = `fund:${val.assetCode}`;
    const fundNameKey = `fund:${val.assetName}`;
    const isTargetStaged =
      isEntityStaged(targetKey) ||
      isEntityStaged(fundCodeKey) ||
      isEntityStaged(fundNameKey) ||
      isEntityStaged(val.assetCode);

    if (!isTargetStaged) {
      const err = `Valuation "${val.id}" (as of: ${val.asOfDate}, market value: ${val.marketValue}) requires target "${val.targetKey || val.assetCode}", which is missing or deselected in Step 1.`;
      errors.push(err);
      return { ...val, status: 'blocked' as const, blockReason: err };
    }

    // Path A workbook vals set holderKey to '' when the holder is absent. That must
    // block — Q4 forbids treating a missing holder as an instrument-wide mark.
    // V1 valuations omit holderKey (undefined) and are unaffected.
    if (val.holderKey === '') {
      const err = `Valuation "${val.id}" (as of: ${val.asOfDate}) requires a holder; missing holder cannot become an instrument-wide mark.`;
      errors.push(err);
      return { ...val, status: 'blocked' as const, blockReason: err };
    }

    if (val.holderKey && !isEntityStaged(val.holderKey)) {
      const err = `Valuation "${val.id}" (as of: ${val.asOfDate}) requires holder "${val.holderKey}", which is missing or deselected in Step 1.`;
      errors.push(err);
      return { ...val, status: 'blocked' as const, blockReason: err };
    }

    if (val.status === 'blocked') {
      const err = `Valuation "${val.id}" is blocked and cannot be approved: ${val.blockReason || 'Unresolved valuation requires review'}`;
      errors.push(err);
      return { ...val, status: 'blocked' as const, blockReason: err };
    }

    return val;
  });

  return {
    isValid: errors.length === 0,
    errors,
    validatedTransactions,
    validatedValuations,
  };
}
