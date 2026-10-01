import { PAID_IN_WRITEOFF_SUBTYPE } from '@/lib/fundLedger/paidInAdjustment';
import { resolveFundVehiclesEnabled, resolveTargetKind } from "@/lib/features/fundVehicles";
import { createHash } from "node:crypto";
import type {
  DbClient,
  FlAllocationRepository,
  FlAssetRepository,
  FlFundingSourceRepository,
  FlFundRepository,
  FlInvestorRepository,
  FlLedgerEntryRepository,
  FlPositionRepository,
  FlSourceRecordRepository,
  FlValuationRepository,
  Tables,
} from "@/lib/repositories";
import type {
  FundCatalogItem,
  FundUpdateProposal,
  FundUpdateTwoStepReview,
  ParsedAsset,
  ParsedCommitmentEvent,
  ParsedTxn,
  ParsedValuation,
  ReconciliationResult,
  ReviewProposalItem,
  SubmittedRowFamily,
  SubmittedRowDisposition,
  SubmittedRowOutcome,
} from "@/lib/fund_updates";
import {
  FUND_CATALOG,
  NANJING_TEMPLATE_ID,
  OTHERS_GROUP,
  TransferInReplayGuard,
  UNATTRIBUTED_ENTITY,
  buildAdjustmentDedupKey,
  buildCommitmentEventDedupKey,
  buildCommitmentTransferDedupKey,
  buildLedgerEntryCommitmentDedupKey,
  buildNormalizedTwoStepReview,
  commitmentEventKey,
  fundUpdateTxnKey,
  isNanjingAssetCode,
  isSameBusinessIdentity,
  normalizeCanonicalName,
  normalizeInvestorName,
  sortFundUpdateReviewAssets,
  validateTransferCounterparty,
} from "@/lib/fund_updates";
import { earliestFundUpdatePositionDate, normalizeParsedAssets } from "@/lib/fund_updates/normalizeParsedAsset";
import { classifyFundUpdateTxn } from "@/lib/fund_updates/canonicalEvent";
import {
  buildManagedFundNameKeys,
  crossBookFlowKindForTxn,
  formatWan,
  isManagedFundCrossBookAsset,
  isManagedFundName,
  managedFundCrossBookNote,
  type CrossBookFlowKind,
} from "@/lib/fund_updates/managedFundCrossBook";
import type { FlMasterDataService } from "./flMasterDataService";
import type { FlPositionService } from "./flPositionService";
import { type FlLedgerService, type FlEntryType, type FlLedgerEntryInput } from "./flLedgerService";
import type { FlValuationService, FlValuationMethod, UpdateValuationInput } from "./flValuationService";
import { FundUpdateValidationError } from "./flErrors";
import { flAbs, flAdd, flEq, flGt, flIsZero, flNeg, safeExactDecimalString, toDecimalString, toExactDecimalString } from "./flDecimal";
import { isPersistableFundUpdateValuation } from "@/lib/fund_updates/normalizeParsedAsset";
import type { CatalogLedgerCheckResult } from "@/lib/fund_updates/catalogLedgerCheck";
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  isSellProceedsDestination,
  toDivestmentSubType,
} from "@/lib/sellProceedsDestination";
import {
  DEFAULT_PROCEEDS_TREATMENT,
  PROCEEDS_TREATMENT_ENTRY_TYPES,
  demoteProceedsTreatment,
  isProceedsTreatmentApplicable,
  isUnresolvedDivestmentToken,
  resolveProceedsTreatment,
} from "@/lib/fundLedger/proceedsTreatment";
import {
  assertEligibleCashHolder,
  isEligibleCashHolder,
  type CashHolderCandidate,
} from "@/lib/fundLedger/cashOwnership";

export type FundUpdatePositionKind = "asset" | "fund";

export interface MappedTxnEntry {
  entryType: FlEntryType;
  cashDelta: string;
  quantityDelta?: string;
  pricePerUnit?: string | null;
  subType?: string | null;
}

export function normalizeExistingTxnType(entry: Tables<"fl_ledger_entries">): string {
  let semanticSubType: string | null = null;
  if (entry.sub_type) {
    const trimmed = entry.sub_type.trim();
    if (trimmed.endsWith(":cash_in_fund")) {
      const base = trimmed.slice(0, -":cash_in_fund".length).trim();
      semanticSubType = base.length > 0 ? base : null;
    } else if (trimmed.endsWith(":distributed_to_investor")) {
      const base = trimmed.slice(0, -":distributed_to_investor".length).trim();
      semanticSubType = base.length > 0 ? base : null;
    } else if (trimmed === "cash_in_fund" || trimmed === "distributed_to_investor") {
      semanticSubType = null;
    } else {
      semanticSubType = trimmed;
    }
  }
  const semanticTokens = semanticSubType
    ?.trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean) ?? [];
  const isDivestmentSemantic = semanticTokens.some((token) =>
    token === "divestment" ||
    token === "redemption" ||
    token === "exit" ||
    token === "sell"
  );
  const isOtherSemantic =
    semanticSubType != null &&
    (semanticSubType.trim().toLowerCase() === "other" ||
      semanticSubType.trim().toLowerCase() === "others");
  if (isOtherSemantic) {
    return "other";
  }
  const isOtherEntryType =
    entry.entry_type?.trim().toLowerCase() === "other" ||
    entry.entry_type?.trim().toLowerCase() === "others";
  if (isOtherEntryType) {
    return "other";
  }
  switch (entry.entry_type) {
    case "paid_in":
    case "buy":
      return "contribution";
    case "redemption":
    case "sell":
      return "divestment";
    case "distribution":
      // Value-only FoF exits are persisted as distributions. Fallback-v1
      // preserves its source action (for example asset_exit_distribution) in
      // sub_type, so recover the proposed divestment identity on replay.
      if (isDivestmentSemantic) return "divestment";
      return semanticSubType ?? "distribution";
    case "income":
      return semanticSubType ?? "income";
    case "expense":
      return semanticSubType ?? "expense";
    default:
      return semanticSubType ?? entry.entry_type;
  }
}

export function existingLedgerEntryTxnKey(entry: Tables<"fl_ledger_entries">): string {
  const normType = normalizeExistingTxnType(entry);
  const isExpenseOrOther = normType === "expense" || normType === "other" || normType === "management_fee";
  const valueAmount = entry.cash_delta
    ? (isExpenseOrOther ? entry.cash_delta : flAbs(entry.cash_delta))
    : null;

  return fundUpdateTxnKey({
    txn_date: entry.entry_date,
    value_amount: valueAmount,
    txn_type: normType,
    share_count: entry.quantity_delta && !flIsZero(entry.quantity_delta) ? flAbs(entry.quantity_delta) : null,
    price_per_share: entry.price_per_unit ?? null,
    currency: entry.currency ?? null,
    sub_type: entry.sub_type ?? null,
    notes: entry.notes ?? null,
  });
}

export function mapFundUpdateTxn(
  t: ParsedTxn,
  positionKind: FundUpdatePositionKind,
  holder: CashHolderCandidate | null,
): MappedTxnEntry {
  const rawType = (t.type as string);
  const txnType = rawType?.trim().toLowerCase();

  const amountStr = flAbs(toExactDecimalString(t.valueAmount));
  if (amountStr === "0.00000000") {
    throw new FundUpdateValidationError(`Cannot post zero-cash ledger event for transaction on ${t.date}`);
  }

  const shareCountStr = t.shareCount != null ? flAbs(toExactDecimalString(t.shareCount)) : "0.00000000";
  const hasPositiveShares = t.shareCount != null && flGt(shareCountStr, "0.00000000");
  const pricePerUnitStr = t.pricePerShare != null ? toExactDecimalString(t.pricePerShare) : null;
  if (
    t.sellProceedsDestination &&
    !isUnresolvedDivestmentToken(t.sellProceedsDestination) &&
    !isSellProceedsDestination(t.sellProceedsDestination)
  ) {
    throw new FundUpdateValidationError(
      `Invalid sell proceeds destination "${t.sellProceedsDestination}" for transaction on ${t.date}`,
    );
  }

  const rawStatedDest =
    t.sellProceedsDestination && !isUnresolvedDivestmentToken(t.sellProceedsDestination)
      ? t.sellProceedsDestination
      : null;
  const rawStatedLabel =
    t.subTypeLabel && !isUnresolvedDivestmentToken(t.subTypeLabel)
      ? t.subTypeLabel
      : null;
  const explicitSubType =
    toDivestmentSubType(rawStatedDest) ??
    toDivestmentSubType(rawStatedLabel);
  const statedTreatmentCandidate = explicitSubType ?? rawStatedDest ?? rawStatedLabel ?? null;

  const classification = classifyFundUpdateTxn({
    type: t.type,
    subTypeLabel: t.subTypeLabel,
    notes: t.notes,
    valueAmount: t.valueAmount,
    shareCount: t.shareCount,
    pricePerShare: t.pricePerShare,
    positionKind,
    reviewerResolvedType: t.reviewerResolvedType,
  });

  // Estimate wording blocks posting unless a reviewer explicitly reclassified the row,
  // which is the actual-event policy. `isEstimated` stays true for provenance either way.
  if (classification.isEstimated && !t.reviewerResolvedType) {
    throw new FundUpdateValidationError(
      classification.unresolvedReason || `Cannot post estimated transaction on ${t.date} without resolution`,
    );
  }

  if (classification.canonicalKind === "unknown") {
    throw new FundUpdateValidationError(
      `Cannot post transaction with unknown type "${t.type}" on ${t.date}: requires resolution before posting`,
    );
  }

  if (classification.canonicalKind === "other" && classification.isUnresolved) {
    throw new FundUpdateValidationError(
      classification.unresolvedReason || `Cannot post unexplained "other" transaction on ${t.date}: requires resolution before posting`,
    );
  }

  if (classification.canonicalKind === "expense") {
    return {
      entryType: "expense",
      cashDelta: flNeg(amountStr),
      quantityDelta: undefined,
      pricePerUnit: null,
      subType: t.subTypeLabel ?? t.notes ?? (txnType === "expense" ? null : txnType),
    };
  }

  if (positionKind === "fund") {
    if (
      txnType === "contribution" ||
      txnType === "investment" ||
      txnType === "capital_call" ||
      txnType === "buy" ||
      classification.canonicalKind === "buy" ||
      classification.canonicalKind === "paid_in"
    ) {
      return {
        entryType: "paid_in",
        cashDelta: flNeg(amountStr),
        quantityDelta: shareCountStr,
        pricePerUnit: pricePerUnitStr,
        subType: t.subTypeLabel ?? null,
      };
    }

    if (txnType === "divestment" || txnType === "sell" || classification.canonicalKind === "sell") {
      const entryType: FlEntryType = hasPositiveShares ? "redemption" : "distribution";
      const resolution = resolveProceedsTreatment({
        entryType,
        holder,
        statedSubType: statedTreatmentCandidate,
      });
      const subType =
        resolution.subType !== null
          ? resolution.subType
          : (demoteProceedsTreatment(statedTreatmentCandidate ?? t.subTypeLabel, entryType) ?? "divestment");

      if (hasPositiveShares) {
        return {
          entryType: "redemption",
          cashDelta: amountStr,
          quantityDelta: flNeg(shareCountStr),
          pricePerUnit: pricePerUnitStr,
          subType,
        };
      }
      return {
        entryType: "distribution",
        cashDelta: amountStr,
        quantityDelta: undefined,
        pricePerUnit: null,
        subType,
      };
    }

    if (
      txnType === "distribution" ||
      txnType === "dividend" ||
      txnType === "interest" ||
      txnType === "interest_income" ||
      txnType === "return_of_capital" ||
      txnType === "income" ||
      classification.canonicalKind === "distribution" ||
      classification.canonicalKind === "income"
    ) {
      let preservedSubType =
        t.subTypeLabel ??
        (txnType === "distribution" || txnType === "income" ? null : txnType);
      if (txnType === "distribution" || txnType === "income") {
        const resolution = resolveProceedsTreatment({
          entryType: "distribution",
          holder,
          statedSubType: statedTreatmentCandidate,
        });
        if (resolution.subType !== null) {
          preservedSubType = resolution.subType;
        } else {
          preservedSubType = demoteProceedsTreatment(preservedSubType, "distribution");
        }
      }
      return {
        entryType: "distribution",
        cashDelta: amountStr,
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: preservedSubType,
      };
    }

    if (txnType === "management_fee" || txnType === "fee" || txnType === "expense") {
      return {
        entryType: "expense",
        cashDelta: flNeg(amountStr),
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: t.subTypeLabel ?? (txnType === "expense" ? null : txnType),
      };
    }

    if (txnType === "other" || txnType === "others") {
      const rawVal = t.valueAmount as unknown;
      if (typeof rawVal === "number") {
        if (rawVal > 0) {
          return {
            entryType: "distribution",
            cashDelta: amountStr,
            quantityDelta: undefined,
            pricePerUnit: null,
            subType: t.subTypeLabel ?? "other",
          };
        }
        if (rawVal < 0) {
          return {
            entryType: "expense",
            cashDelta: flNeg(amountStr),
            quantityDelta: undefined,
            pricePerUnit: null,
            subType: t.subTypeLabel ?? "other",
          };
        }
        throw new FundUpdateValidationError(
          `Cannot post ambiguous zero-cash transaction for "other" type on ${t.date}`,
        );
      }
      if (typeof rawVal === "string") {
        if (rawVal.trim().startsWith("-")) {
          return {
            entryType: "expense",
            cashDelta: flNeg(amountStr),
            quantityDelta: undefined,
            pricePerUnit: null,
            subType: t.subTypeLabel ?? "other",
          };
        }
        return {
          entryType: "distribution",
          cashDelta: amountStr,
          quantityDelta: undefined,
          pricePerUnit: null,
          subType: t.subTypeLabel ?? "other",
        };
      }
    }

    throw new FundUpdateValidationError(
      `Cannot post unsupported fund transaction type "${t.type}" on ${t.date}`,
    );
  } else {
    if (
      txnType === "contribution" ||
      txnType === "investment" ||
      txnType === "capital_call" ||
      txnType === "buy" ||
      classification.canonicalKind === "buy"
    ) {
      return {
        entryType: "buy",
        cashDelta: flNeg(amountStr),
        quantityDelta: shareCountStr,
        pricePerUnit: pricePerUnitStr,
        subType: t.subTypeLabel ?? null,
      };
    }

    if (txnType === "divestment" || txnType === "sell" || classification.canonicalKind === "sell") {
      const resolution = resolveProceedsTreatment({
        entryType: "sell",
        holder,
        statedSubType: statedTreatmentCandidate,
      });
      const subType =
        resolution.subType !== null
          ? resolution.subType
          : (demoteProceedsTreatment(statedTreatmentCandidate ?? t.subTypeLabel, "sell") ?? "divestment");

      return {
        entryType: "sell",
        cashDelta: amountStr,
        quantityDelta: flNeg(shareCountStr),
        pricePerUnit: pricePerUnitStr,
        subType,
      };
    }

    if (
      txnType === "distribution" ||
      txnType === "dividend" ||
      txnType === "interest" ||
      txnType === "interest_income" ||
      txnType === "return_of_capital" ||
      txnType === "income" ||
      classification.canonicalKind === "distribution" ||
      classification.canonicalKind === "income"
    ) {
      const preservedSubType =
        t.subTypeLabel ??
        (txnType === "income" || txnType === "distribution" ? null : txnType);
      return {
        entryType: "income",
        cashDelta: amountStr,
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: preservedSubType,
      };
    }

    if (txnType === "management_fee" || txnType === "fee" || txnType === "expense") {
      return {
        entryType: "expense",
        cashDelta: flNeg(amountStr),
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: t.subTypeLabel ?? (txnType === "expense" ? null : txnType),
      };
    }

    if (txnType === "other" || txnType === "others") {
      const rawVal = t.valueAmount as unknown;
      if (typeof rawVal === "number") {
        if (rawVal > 0) {
          return {
            entryType: "income",
            cashDelta: amountStr,
            quantityDelta: undefined,
            pricePerUnit: null,
            subType: t.subTypeLabel ?? "other",
          };
        }
        if (rawVal < 0) {
          return {
            entryType: "expense",
            cashDelta: flNeg(amountStr),
            quantityDelta: undefined,
            pricePerUnit: null,
            subType: t.subTypeLabel ?? "other",
          };
        }
        throw new FundUpdateValidationError(
          `Cannot post ambiguous zero-cash transaction for "other" type on ${t.date}`,
        );
      }
      if (typeof rawVal === "string") {
        if (rawVal.trim().startsWith("-")) {
          return {
            entryType: "expense",
            cashDelta: flNeg(amountStr),
            quantityDelta: undefined,
            pricePerUnit: null,
            subType: t.subTypeLabel ?? "other",
          };
        }
        return {
          entryType: "income",
          cashDelta: amountStr,
          quantityDelta: undefined,
          pricePerUnit: null,
          subType: t.subTypeLabel ?? "other",
        };
      }
    }

    throw new FundUpdateValidationError(
      `Cannot post unsupported asset transaction type "${t.type}" on ${t.date}`,
    );
  }
}

export type FundUpdateCatalogKind = "asset" | "fund" | "investor" | "source";

export type FundUpdateCatalogMatchStatus = "new" | "existing";

export interface FundUpdateCatalogMatch {
  name: string;
  english_name?: string | null;
  status: FundUpdateCatalogMatchStatus;
  matched_id: string | null;
  asset_codes?: string[];
  auto_created?: boolean;
  role?: string | null;
}

export type FundUpdateAssetStatus = "new" | "unchanged" | "add_missing";

export interface FundUpdateAssetReview {
  code: string;
  name: string;
  fund: string;
  asset_type: ParsedAsset["assetType"];
  target_kind?: "fund" | "asset";
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
  /** Optional warnings such as source attribution conflicts on matching items. */
  warnings?: string[];
}

export interface FundUpdateFullReview {
  assets: FundUpdateAssetReview[];
  funds: FundUpdateCatalogMatch[];
  investors: FundUpdateCatalogMatch[];
  sources: FundUpdateCatalogMatch[];
  groups?: FundUpdateCatalogMatch[];
  reconciliation?: ReconciliationResult[];
  review_items?: ReviewProposalItem[];
  commitment_event_statuses?: Record<number, 'actionable' | 'duplicate'>;
  /** Canonical managed fund names; see the shared FundUpdateFullReview type. */
  managed_fund_keys?: string[];
  two_step_review?: FundUpdateTwoStepReview;
}

export type { SubmittedRowFamily, SubmittedRowDisposition, SubmittedRowOutcome };

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
  created_groups?: number;
  commitment_events_inserted?: number;
  commitment_events_skipped_duplicate?: number;
  commitment_events_skipped?: number;
  review_items_applied?: number;
  review_items_skipped_unresolved?: number;
  commitment_event_warnings?: string[];
  catalog_warnings?: string[];
  /** Post-import comparison of the written ledger with 基金汇总 (MB-642). */
  catalog_check?: CatalogLedgerCheckResult;
  outcomes?: SubmittedRowOutcome[];
}

export interface FundUpdateCommitmentApplyResult {
  events_inserted: number;
  events_skipped_duplicate: number;
  events_skipped: number;
  review_items_applied?: number;
  review_items_skipped_unresolved?: number;
  warnings: string[];
  outcomes?: SubmittedRowOutcome[];
}

export type FundUpdateReviewResolution =
  | {
      submittedId?: string;
      sourceRow: number;
      resolutionType: "non_cash_adjustment";
      investorName: string;
      fundName: string;
      date: string;
      amount: number;
      currency?: string;
      direction?: "reduction" | "addition";
      subType?: string;
      notes?: string | null;
    }
  | {
      submittedId?: string;
      sourceRow: number;
      resolutionType: "single_transfer";
      transferorName: string;
      transfereeName: string;
      fundName: string;
      date: string;
      amount: number;
      currency?: string;
      notes?: string | null;
    }
  | {
      submittedId?: string;
      sourceRow: number;
      resolutionType: "split_transfer";
      transfereeName: string;
      fundName: string;
      date: string;
      totalAmount: number;
      currency?: string;
      notes?: string | null;
      allocations: Array<{
        transferorName: string;
        amount: number;
      }>;
    };

/** Per-asset ledger subset + optional edited rows from HITL review. */
export interface FundUpdateAssetSelection {
  asset_code: string;
  /** When set, only these transactions are applied (edited values allowed). */
  txns?: ParsedTxn[];
  /** When set, only these valuations are applied (edited values allowed). */
  valuations?: ParsedValuation[];
  /** Optional explicit target ID when user remaps or matches the target fund/asset in review. */
  matched_target_id?: string | null;
  /** Optional remapped name when user renames/remaps the target fund/asset in review. */
  remapped_target_name?: string | null;
}

export interface FundUpdateApplyOptions {
  isV1?: boolean;
  fileId?: string;
  fundCatalogItems?: FundCatalogItem[];
  sourceRemaps?: Record<string, string> | Map<string, string>;
  investorRemaps?: Record<string, string> | Map<string, string>;
  fundRemaps?: Record<string, string> | Map<string, string>;
  /**
   * Commitment events applied in the same approval. A managed fund's 投资/退出
   * row into another managed fund posts nothing and is recorded from the target
   * fund's 实缴/分配 rows; these events tell apply whether that happens in this run.
   */
  commitmentEvents?: ParsedCommitmentEvent[];
  executor?: DbClient;
}

function typeDetailsSheetCode(terms: unknown): string | null {
  if (!terms || typeof terms !== "object") return null;
  const d = terms as Record<string, unknown>;
  return typeof d.sheetCode === "string" && d.sheetCode.trim() ? d.sheetCode.trim() : null;
}

function typeDetailsSourceRef(terms: unknown): string | null {
  if (!terms || typeof terms !== "object") return null;
  const d = terms as Record<string, unknown>;
  return typeof d.sourceRef === "string" && d.sourceRef.trim() ? d.sourceRef.trim() : null;
}

// Both helpers live in dependency-free modules so client-reachable callers
// (the fund-update review UI reaches `fund_updates/twoStepReview`) can import
// them without dragging this service — and therefore `createDb`/`auth` — into
// a browser bundle. Re-exported here to keep this module's public API stable.
export { toExactDecimalString, safeExactDecimalString, isPersistableFundUpdateValuation };

/** True for workbook placeholder rows that have neither cash nor share movement. */
export function isZeroEffectFundUpdateTxn(t: ParsedTxn): boolean {
  if (t.valueAmount == null) return false;
  const cash = flAbs(toExactDecimalString(t.valueAmount));
  const shares = t.shareCount == null
    ? "0.00000000"
    : flAbs(toExactDecimalString(t.shareCount));
  return cash === "0.00000000" && shares === "0.00000000";
}

function mapValuationMethod(rawMethod?: string | null): FlValuationMethod {
  if (!rawMethod) return "at_cost";
  const norm = rawMethod.trim().toLowerCase();
  if (
    norm === "at_cost" ||
    norm === "fundraise_round" ||
    norm === "secondary_sale" ||
    norm === "listed_price" ||
    norm === "comparables" ||
    norm === "capital_account_statement" ||
    norm === "appraisal" ||
    norm === "other"
  ) {
    return norm as FlValuationMethod;
  }
  if (norm === "nav" || norm === "capital_account" || norm === "capital_account_statement") {
    return "capital_account_statement";
  }
  if (norm === "stock_market_price" || norm === "market_price" || norm === "listed_price") {
    return "listed_price";
  }
  return "at_cost";
}

function computeCanonicalHash(payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  const canonicalObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    canonicalObj[k] = payload[k];
  }
  return createHash("sha256").update(JSON.stringify(canonicalObj)).digest("hex");
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
  const method = mapValuationMethod(v.valuationMethod ?? v.valuation_method);
  return [
    v.asOfDate ?? v.as_of_date ?? '',
    safeExactDecimalString(v.marketValue ?? v.market_value),
    safeExactDecimalString(v.pricePerShare ?? v.price_per_unit),
    safeExactDecimalString(v.sharesOutstanding ?? v.units_outstanding),
    method,
  ].join('|');
}

function compareSourceAllocations(
  entryAmount: string | number | null | undefined,
  posSourceId: string | null,
  entryAllocs: Array<{ funding_source_id: string; amount: string | number }>,
  incomingSourceId: string | null,
  incomingAllocs?: Array<{ funding_source_id?: string; fundingSourceId?: string; amount?: string | number }>,
): {
  hasConflict: boolean;
  ambiguityWarning?: string;
  conflictWarning?: string;
  existingDesc: string;
  incomingDesc: string;
} {
  const absCashStr = flAbs(toExactDecimalString(entryAmount ?? 0));

  // 1. Establish existing allocations
  let existingAllocList: Array<{ funding_source_id: string; amount: string }> = [];
  let ambiguityWarning: string | undefined;

  if (entryAllocs.length > 0) {
    existingAllocList = entryAllocs.map((a) => ({
      funding_source_id: a.funding_source_id,
      amount: toExactDecimalString(a.amount),
    }));
    // Check relation with position-level source
    if (posSourceId !== null) {
      const allMatchPos = existingAllocList.every((a) => a.funding_source_id === posSourceId);
      if (!allMatchPos) {
        ambiguityWarning = `Ambiguous existing source attribution: position source (${posSourceId}) differs from entry allocations (${existingAllocList.map((a) => `${a.funding_source_id}: ${a.amount}`).join(', ')}).`;
      }
    }
  } else if (posSourceId !== null) {
    existingAllocList = [{ funding_source_id: posSourceId, amount: absCashStr }];
  }

  // 2. Establish incoming allocations
  let incomingAllocList: Array<{ funding_source_id: string; amount: string }> = [];
  if (incomingAllocs && incomingAllocs.length > 0) {
    incomingAllocList = incomingAllocs.map((a) => ({
      funding_source_id: (a.funding_source_id ?? a.fundingSourceId)!,
      amount: toExactDecimalString(a.amount ?? 0),
    }));
  } else if (incomingSourceId !== null) {
    incomingAllocList = [{ funding_source_id: incomingSourceId, amount: absCashStr }];
  }

  // 3. Build aggregated decimal maps: funding_source_id -> sum of amounts
  const existingMap = new Map<string, string>();
  for (const a of existingAllocList) {
    const cur = existingMap.get(a.funding_source_id) ?? '0.00000000';
    existingMap.set(a.funding_source_id, flAdd(cur, a.amount));
  }

  const incomingMap = new Map<string, string>();
  for (const a of incomingAllocList) {
    const cur = incomingMap.get(a.funding_source_id) ?? '0.00000000';
    incomingMap.set(a.funding_source_id, flAdd(cur, a.amount));
  }

  // Format descriptions
  const formatMap = (m: Map<string, string>): string => {
    if (m.size === 0) return 'none';
    if (m.size === 1) {
      const [srcId] = m.keys();
      return srcId;
    }
    return `[${Array.from(m.entries()).map(([k, v]) => `${k}: ${v}`).join(', ')}]`;
  };

  const existingDesc = formatMap(existingMap);
  const incomingDesc = formatMap(incomingMap);

  // 4. Compare maps
  let hasConflict = false;
  if (existingMap.size !== incomingMap.size) {
    hasConflict = true;
  } else {
    for (const [srcId, extAmt] of existingMap.entries()) {
      const incAmt = incomingMap.get(srcId);
      if (incAmt === undefined || !flEq(extAmt, incAmt)) {
        hasConflict = true;
        break;
      }
    }
  }

  let conflictWarning: string | undefined;
  if (hasConflict) {
    conflictWarning = `differing source attribution (existing source: ${existingDesc}, incoming source: ${incomingDesc})`;
  }

  return {
    hasConflict,
    ambiguityWarning,
    conflictWarning,
    existingDesc,
    incomingDesc,
  };
}

/**
 * Diffs / applies STARTECH (etc.) fund-update proposals against workspace
 * fl_* ledger data. Existing matched assets receive append-only missing
 * business events / ledger entries and valuation records.
 */
export class FundUpdateApplyService {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
    private readonly flFundRepo: FlFundRepository,
    private readonly flAssetRepo: FlAssetRepository,
    private readonly flPositionRepo: FlPositionRepository,
    private readonly flInvestorRepo: FlInvestorRepository,
    private readonly flFundingSourceRepo: FlFundingSourceRepository,
    private readonly flMasterDataService: FlMasterDataService,
    private readonly flPositionService: FlPositionService,
    private readonly flLedgerService: FlLedgerService,
    private readonly flValuationService: FlValuationService,
    private readonly flValuationRepo: FlValuationRepository,
    private readonly flLedgerEntryRepo: FlLedgerEntryRepository,
    private readonly flSourceRecordRepo?: FlSourceRecordRepository,
    private readonly flAllocationRepo?: FlAllocationRepository,
  ) {}

  private async withExecutor<T>(
    executor: DbClient | undefined,
    fn: (exec: DbClient) => Promise<T>,
  ): Promise<T> {
    if (executor) {
      return fn(executor);
    }
    return (this.db as any).transaction(async (tx: unknown) => {
      return fn(tx as DbClient);
    });
  }

  async buildReview(proposedAssets: ParsedAsset[]): Promise<FundUpdateAssetReview[]> {
    const full = await this.buildFullReview(proposedAssets);
    return full.assets;
  }

  async buildFullReview(
    proposedAssets: ParsedAsset[],
    commitmentEvents?: ParsedCommitmentEvent[],
    options?: {
      reconciliation?: ReconciliationResult[];
      review_items?: ReviewProposalItem[];
      proposal?: FundUpdateProposal;
      fundCatalog?: string[];
    },
  ): Promise<FundUpdateFullReview> {
    proposedAssets = normalizeParsedAssets(proposedAssets);
    const fundVehiclesEnabled = await resolveFundVehiclesEnabled(this.workspaceId);
    const [existingAssets, existingFunds, existingInvestors, existingFundSources, allValuations] = await Promise.all([
      this.flAssetRepo.findByWorkspaceId(this.workspaceId),
      this.flFundRepo.findByWorkspaceId(this.workspaceId),
      this.flInvestorRepo.findByWorkspaceId(this.workspaceId),
      this.flFundingSourceRepo.findByWorkspaceId(this.workspaceId),
      this.flValuationRepo.findByWorkspaceId(this.workspaceId),
    ]);

    const bySheet = new Map<string, Tables<"fl_assets">>();
    const bySourceRef = new Map<string, Tables<"fl_assets">>();
    const byName = new Map<string, Tables<"fl_assets">>();
    for (const row of existingAssets) {
      const sheet = typeDetailsSheetCode(row.instrument_terms);
      if (sheet && !bySheet.has(sheet.toLowerCase())) bySheet.set(sheet.toLowerCase(), row);
      const ref = typeDetailsSourceRef(row.instrument_terms);
      if (ref && !bySourceRef.has(ref.toLowerCase())) bySourceRef.set(ref.toLowerCase(), row);
      const normName = normalizeCanonicalName(row.name);
      if (normName && !byName.has(normName)) byName.set(normName, row);
      if (row.legal_name) {
        const normLegal = normalizeCanonicalName(row.legal_name);
        if (normLegal && !byName.has(normLegal)) byName.set(normLegal, row);
      }
    }

    const fundByName = new Map<string, Tables<"fl_funds">>();
    const fofBySheet = new Map<string, Tables<"fl_funds">>();
    const fofBySourceRef = new Map<string, Tables<"fl_funds">>();
    const fofByName = new Map<string, Tables<"fl_funds">>();

    for (const f of existingFunds) {
      const normName = normalizeCanonicalName(f.name);
      if (normName && !fundByName.has(normName)) fundByName.set(normName, f);
      const lower = f.name?.trim().toLowerCase();
      if (lower && !fundByName.has(lower)) fundByName.set(lower, f);

      if (!f.managed) {
        if (f.registration_no && !fofBySheet.has(f.registration_no.toLowerCase())) {
          fofBySheet.set(f.registration_no.toLowerCase(), f);
        }
        if (f.description) {
          try {
            const meta = JSON.parse(f.description);
            if (meta.sheetCode && !fofBySheet.has(meta.sheetCode.toLowerCase())) {
              fofBySheet.set(meta.sheetCode.toLowerCase(), f);
            }
            if (meta.sourceRef && !fofBySourceRef.has(meta.sourceRef.toLowerCase())) {
              fofBySourceRef.set(meta.sourceRef.toLowerCase(), f);
            }
          } catch {
            // Non-JSON description
          }
        }
        if (normName && !fofByName.has(normName)) {
          fofByName.set(normName, f);
        }
        if (lower && !fofByName.has(lower)) {
          fofByName.set(lower, f);
        }
      }
    }

    const investorByName = new Map<string, Tables<"fl_investors">>();
    for (const e of existingInvestors) {
      const normName = normalizeCanonicalName(e.name);
      if (normName && !investorByName.has(normName)) investorByName.set(normName, e);
      const lower = e.name?.trim().toLowerCase();
      if (lower && !investorByName.has(lower)) investorByName.set(lower, e);
    }

    const fundSourceByName = new Map<string, Tables<"fl_funding_sources">>();
    for (const s of existingFundSources) {
      const normName = normalizeCanonicalName(s.name);
      if (normName && !fundSourceByName.has(normName)) fundSourceByName.set(normName, s);
      const lower = s.name?.trim().toLowerCase();
      if (lower && !fundSourceByName.has(lower)) fundSourceByName.set(lower, s);
    }

    const managedNames = buildManagedFundNameKeys([
      ...(options?.fundCatalog ?? options?.proposal?.fund_catalog ?? []),
      ...proposedAssets.filter((a) => a.holderKind !== "investor").map((a) => a.fund),
      ...(commitmentEvents ?? []).map((e) => e.fund),
      ...existingFunds.filter((f) => f.managed === true).map((f) => f.name),
    ]);
    const targetKindFor = (proposed: ParsedAsset): "fund" | "asset" => {
      const knownFund =
        fofBySheet.get(proposed.code.toLowerCase()) ??
        (proposed.sourceRef ? fofBySourceRef.get(proposed.sourceRef.toLowerCase()) : undefined) ??
        fundByName.get(normalizeCanonicalName(proposed.name)) ??
        fundByName.get(proposed.name.trim().toLowerCase());
      const isManagedTarget = knownFund?.managed === true || managedNames.has(normalizeCanonicalName(proposed.name));
      const targetKind = resolveTargetKind(proposed.assetType, fundVehiclesEnabled, isManagedTarget);
      if (!fundVehiclesEnabled && proposed.assetType === "fund_of_funds" && knownFund && !knownFund.managed) {
        throw new FundUpdateValidationError(
          `Cannot import "${proposed.name}" as an asset: an existing unmanaged fund already has this identity. Resolve the existing holding before importing to avoid double-counting.`,
        );
      }
      return targetKind;
    };

    const matchedAssetIds: string[] = [];
    const matchedFundIds: string[] = [];

    for (const a of proposedAssets) {
      if (targetKindFor(a) === "fund") {
        const hit =
          fofBySheet.get(a.code.toLowerCase()) ??
          (a.sourceRef ? fofBySourceRef.get(a.sourceRef.toLowerCase()) : undefined) ??
          fofByName.get(normalizeCanonicalName(a.name)) ??
          fofByName.get(a.name.trim().toLowerCase()) ??
          fundByName.get(normalizeCanonicalName(a.name)) ??
          fundByName.get(a.name.trim().toLowerCase());
        if (hit) matchedFundIds.push(hit.id);
      } else {
        const hit = this.matchExisting(a, bySheet, bySourceRef, byName);
        if (hit) matchedAssetIds.push(hit.id);
      }
    }

    const [positionsByAsset, positionsByFund] = await Promise.all([
      matchedAssetIds.length > 0 ? this.flPositionRepo.findByAssetIds(this.workspaceId, matchedAssetIds) : [],
      matchedFundIds.length > 0 ? this.flPositionRepo.findByFundIds(this.workspaceId, matchedFundIds) : [],
    ]);

    const allMatchedPositions = [...positionsByAsset, ...positionsByFund];
    const positionIds = allMatchedPositions.map((p) => p.id);
    const positionById = new Map(allMatchedPositions.map((p) => [p.id, p]));
    const entries =
      positionIds.length > 0
        ? await this.flLedgerEntryRepo.findAllByPositionIds(this.workspaceId, positionIds)
        : [];

    const txnsByAsset = new Map<string, Tables<"fl_ledger_entries">[]>();
    const txnsByFund = new Map<string, Tables<"fl_ledger_entries">[]>();
    for (const e of entries) {
      const pos = positionById.get(e.position_id);
      if (pos?.asset_id) {
        const list = txnsByAsset.get(pos.asset_id) ?? [];
        list.push(e);
        txnsByAsset.set(pos.asset_id, list);
      } else if (pos?.fund_id) {
        const list = txnsByFund.get(pos.fund_id) ?? [];
        list.push(e);
        txnsByFund.set(pos.fund_id, list);
      }
    }

    const valsByAsset = new Map<string, Tables<"fl_valuations">[]>();
    const valsByFund = new Map<string, Tables<"fl_valuations">[]>();
    for (const v of allValuations) {
      if (v.asset_id) {
        const list = valsByAsset.get(v.asset_id) ?? [];
        list.push(v);
        valsByAsset.set(v.asset_id, list);
      } else if (v.fund_id) {
        const list = valsByFund.get(v.fund_id) ?? [];
        list.push(v);
        valsByFund.set(v.fund_id, list);
      } else if (v.position_id) {
        const pos = positionById.get(v.position_id);
        if (pos?.asset_id) {
          const list = valsByAsset.get(pos.asset_id) ?? [];
          list.push(v);
          valsByAsset.set(pos.asset_id, list);
        } else if (pos?.fund_id) {
          const list = valsByFund.get(pos.fund_id) ?? [];
          list.push(v);
          valsByFund.set(pos.fund_id, list);
        }
      }
    }

    const uniqueFunds = new Map<string, FundUpdateCatalogMatch>();
    const uniqueInvestors = new Map<string, FundUpdateCatalogMatch>();
    const uniqueSources = new Map<string, FundUpdateCatalogMatch>();
    const uniqueGroups = new Map<string, FundUpdateCatalogMatch>();

    const matchCatalog = (
      rawName: string | null | undefined,
      existingMap: Map<string, { id: string; name: string }>,
      isFund?: boolean,
    ): FundUpdateCatalogMatch | null => {
      if (!rawName) return null;
      const clean = rawName.trim();
      if (!clean) return null;
      const normKey = normalizeCanonicalName(clean);
      const lowerKey = clean.toLowerCase();
      const hit = existingMap.get(normKey) ?? existingMap.get(lowerKey);
      const isAutoCreated =
        isFund &&
        FUND_CATALOG.some((c) => normalizeCanonicalName(c) === normKey || c.trim().toLowerCase() === lowerKey);
      if (hit) {
        return {
          name: hit.name.trim() || clean,
          status: "existing",
          matched_id: hit.id,
          ...(isAutoCreated ? { auto_created: true } : {}),
        };
      }
      return {
        name: clean,
        status: "new",
        matched_id: null,
        ...(isAutoCreated ? { auto_created: true } : {}),
      };
    };

    const upsertUnique = (map: Map<string, FundUpdateCatalogMatch>, match: FundUpdateCatalogMatch) => {
      const key = normalizeCanonicalName(match.name);
      const previous = map.get(key);
      if (!previous || (previous.status === "new" && match.status === "existing")) {
        map.set(key, match);
      }
    };

    const reviews: FundUpdateAssetReview[] = proposedAssets.map((proposed) => {
      const matched_fund = matchCatalog(proposed.fund, fundByName, true);
      const matched_investor = matchCatalog(proposed.holderName?.trim() || proposed.entity?.trim() || null, investorByName, false);
      const matched_source = matchCatalog(proposed.fundingSource, fundSourceByName, false);

      if (proposed.holderKind === "investor") {
        const groupRaw = proposed.group?.trim() || proposed.fund?.trim() || OTHERS_GROUP;
        const matched_group = matchCatalog(groupRaw, investorByName, false);
        if (matched_group) upsertUnique(uniqueGroups, matched_group);
      } else {
        if (matched_fund) upsertUnique(uniqueFunds, matched_fund);
      }
      if (matched_investor) upsertUnique(uniqueInvestors, matched_investor);
      if (matched_source) upsertUnique(uniqueSources, matched_source);

      const targetKind = targetKindFor(proposed);
      const isFundTarget = targetKind === "fund";
      let matchedTargetId: string | null = null;
      let matchedAsset: Tables<"fl_assets"> | undefined;
      let existingTxns: Tables<"fl_ledger_entries">[] = [];
      let existingVals: Tables<"fl_valuations">[] = [];

      if (isFundTarget) {
        const hit =
          fofBySheet.get(proposed.code.toLowerCase()) ??
          (proposed.sourceRef ? fofBySourceRef.get(proposed.sourceRef.toLowerCase()) : undefined) ??
          fofByName.get(normalizeCanonicalName(proposed.name)) ??
          fofByName.get(proposed.name.trim().toLowerCase()) ??
          fundByName.get(normalizeCanonicalName(proposed.name)) ??
          fundByName.get(proposed.name.trim().toLowerCase());
        if (hit) {
          matchedTargetId = hit.id;
          const isInvestorHolder = proposed.holderKind === "investor";
          const targetPositions = positionsByFund.filter((p) => p.fund_id === hit.id);
          let matchingPositions: Tables<"fl_positions">[] = [];
          if (isInvestorHolder) {
            if (matched_investor?.matched_id) {
              matchingPositions = targetPositions.filter(
                (p) => p.holder_investor_id === matched_investor.matched_id,
              );
            }
          } else {
            const isOthersOrEmpty = !proposed.fund || proposed.fund.trim().toLowerCase() === "others";
            if (isOthersOrEmpty) {
              matchingPositions = targetPositions.filter(
                (p) =>
                  (!p.holder_fund_id && !p.holder_investor_id) ||
                  (matched_fund?.matched_id ? p.holder_fund_id === matched_fund.matched_id : false),
              );
            } else if (matched_fund?.matched_id) {
              matchingPositions = targetPositions.filter(
                (p) => p.holder_fund_id === matched_fund.matched_id,
              );
            } else {
              matchingPositions = [];
            }
          }

          if (matchingPositions.length > 0) {
            const matchingPosIds = new Set(matchingPositions.map((p) => p.id));
            existingTxns = entries.filter((e) => matchingPosIds.has(e.position_id));
            existingVals = valsByFund.get(hit.id)?.filter(
              (v) => !v.position_id || matchingPosIds.has(v.position_id),
            ) ?? [];
          } else {
            existingTxns = [];
            existingVals = [];
          }
        }
        const matched_fof_target: FundUpdateCatalogMatch = {
          name: hit?.name?.trim() || proposed.name,
          english_name: hit?.english_name ?? proposed.englishName ?? null,
          status: hit ? "existing" : "new",
          matched_id: hit ? hit.id : null,
          role: "Fund of Funds",
        };
        upsertUnique(uniqueFunds, matched_fof_target);
      } else {
        const hit = this.matchExisting(proposed, bySheet, bySourceRef, byName);
        if (hit) {
          matchedTargetId = hit.id;
          matchedAsset = hit;
          const isInvestorHolder = proposed.holderKind === "investor";
          const targetPositions = positionsByAsset.filter((p) => p.asset_id === hit.id);
          let matchingPositions: Tables<"fl_positions">[] = [];
          if (isInvestorHolder) {
            if (matched_investor?.matched_id) {
              matchingPositions = targetPositions.filter(
                (p) => p.holder_investor_id === matched_investor.matched_id,
              );
            }
          } else {
            const isOthersOrEmpty = !proposed.fund || proposed.fund.trim().toLowerCase() === "others";
            if (isOthersOrEmpty) {
              matchingPositions = targetPositions.filter(
                (p) =>
                  (!p.holder_fund_id && !p.holder_investor_id) ||
                  (matched_fund?.matched_id ? p.holder_fund_id === matched_fund.matched_id : false),
              );
            } else if (matched_fund?.matched_id) {
              matchingPositions = targetPositions.filter(
                (p) => p.holder_fund_id === matched_fund.matched_id,
              );
            } else {
              matchingPositions = [];
            }
          }

          if (matchingPositions.length > 0) {
            const matchingPosIds = new Set(matchingPositions.map((p) => p.id));
            existingTxns = entries.filter((e) => matchingPosIds.has(e.position_id));
            existingVals = valsByAsset.get(hit.id)?.filter(
              (v) => !v.position_id || matchingPosIds.has(v.position_id),
            ) ?? [];
          } else {
            existingTxns = [];
            existingVals = [];
          }
        }
      }

      const isInvestorHolder = proposed.holderKind === "investor";
      const fundObj = matched_fund?.matched_id
        ? existingFunds.find((f) => f.id === matched_fund.matched_id)
        : undefined;
      const isManagedFund = fundObj ? fundObj.managed === true : false;
      const isUnresolvedFund = !isInvestorHolder && !fundObj;
      const reviewHolderCandidate: CashHolderCandidate = isInvestorHolder
        ? {
            holder_investor_id:
              matched_investor?.matched_id ??
              proposed.holderName?.trim() ??
              proposed.entity?.trim() ??
              null,
            holderFundManaged: false,
          }
        : {
            holder_fund_id: fundObj ? matched_fund?.matched_id ?? null : null,
            holderFundManaged: isUnresolvedFund ? true : isManagedFund,
          };
      const holderCandidate: CashHolderCandidate = isInvestorHolder
        ? reviewHolderCandidate
        : {
            holder_fund_id: fundObj ? matched_fund?.matched_id ?? null : null,
            holderFundManaged: isManagedFund,
          };

      const proposedTxns = proposed.txns ?? [];
      const proposedVals = proposed.valuations ?? [];
      const persistableValuations = proposedVals.filter(isPersistableFundUpdateValuation);

      const positionKind: FundUpdatePositionKind = targetKind === "fund" ? "fund" : "asset";
      for (const t of proposedTxns) {
        const rawType = (t.type as string)?.trim().toLowerCase();
        const shareCountStr = t.shareCount != null ? flAbs(toExactDecimalString(t.shareCount)) : "0.00000000";
        const hasPositiveShares = t.shareCount != null && flGt(shareCountStr, "0.00000000");
        const isDivestmentTxn = rawType === "divestment" || rawType === "sell" || rawType === "redemption";
        const entryType: FlEntryType = positionKind === "fund"
          ? (isDivestmentTxn ? (hasPositiveShares ? "redemption" : "distribution") : (rawType === "distribution" ? "distribution" : "paid_in"))
          : (isDivestmentTxn ? "sell" : (rawType === "distribution" ? "income" : "buy"));

        if ((PROCEEDS_TREATMENT_ENTRY_TYPES as readonly string[]).includes(entryType)) {
          const statedRaw =
            (t.sellProceedsDestination && !isUnresolvedDivestmentToken(t.sellProceedsDestination) ? t.sellProceedsDestination : null) ??
            (t.subTypeLabel && !isUnresolvedDivestmentToken(t.subTypeLabel) ? t.subTypeLabel : null);
          const proceedsRes = resolveProceedsTreatment({
            entryType,
            holder: reviewHolderCandidate,
            statedSubType: statedRaw,
          });

          if (isUnresolvedFund) {
            // A new fund has no persisted holder id yet, so it cannot satisfy the
            // application-level cash-owner predicate. Review still models the fund
            // that approval will create as managed: preserve an explicit source
            // treatment, otherwise surface the same retained-cash default posting uses.
            const statedDestination = toDivestmentSubType(statedRaw);
            t.sellProceedsDestination =
              statedDestination === SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR
                ? "distributed_to_investor"
                : "cash_in_fund";
          } else if (isProceedsTreatmentApplicable({ entryType, holder: reviewHolderCandidate })) {
            if (proceedsRes.defaulted) {
              // Unstated treatment on managed-fund sale defaults to retained and is surfaced in review
              t.sellProceedsDestination = "cash_in_fund";
            } else if (proceedsRes.subType !== null) {
              // Explicit document treatment is preserved
              t.sellProceedsDestination =
                proceedsRes.subType === SUB_TYPE_DIVESTMENT_CASH_IN_FUND
                  ? "cash_in_fund"
                  : "distributed_to_investor";
            }
          } else {
            // Investors and unmanaged funds have no tracked cash destination.
            t.sellProceedsDestination = null;
            t.subTypeLabel = demoteProceedsTreatment(t.subTypeLabel, entryType);
          }

          if (isUnresolvedFund) {
            const pendingNote = "pending fund match";
            if (!t.notes) {
              t.notes = pendingNote;
            } else if (!t.notes.includes(pendingNote)) {
              t.notes = `${t.notes} (${pendingNote})`;
            }
          }
        }
      }

      const assetWarnings: string[] = [];
      const isCashAsset =
        matchedAsset?.asset_kind === "cash" ||
        (proposed as any).asset_kind === "cash" ||
        proposed.assetType === ("cash" as any);
      if (isCashAsset && !isEligibleCashHolder(holderCandidate)) {
        const holderDesc = proposed.holderName?.trim() || proposed.entity?.trim() || proposed.fund?.trim() || "ineligible holder";
        assetWarnings.push(
          `Ineligible cash holder: cash tracking is exclusive to managed funds (holder: "${holderDesc}").`,
        );
      }

      if (!matchedTargetId) {
        return {
          code: proposed.code,
          name: proposed.name,
          fund: proposed.fund,
          asset_type: proposed.assetType,
          target_kind: targetKind,
          entity: proposed.entity,
          funding_source: proposed.fundingSource,
          matched_fund,
          matched_investor,
          matched_source,
          status: "new" as const,
          matched_asset_id: null,
          proposed_txn_count: proposedTxns.length,
          proposed_valuation_count: persistableValuations.length,
          existing_txn_count: 0,
          existing_valuation_count: 0,
          missing_txn_count: proposedTxns.length,
          missing_valuation_count: persistableValuations.length,
          proposed,
          missing_txns: proposedTxns,
          missing_valuations: persistableValuations,
          ...(assetWarnings.length > 0 ? { warnings: assetWarnings } : {}),
        };
      }

      const existingEntryByKey = new Map<string, Tables<"fl_ledger_entries">>();
      for (const e of existingTxns) {
        const k = existingLedgerEntryTxnKey(e);
        if (!existingEntryByKey.has(k)) {
          existingEntryByKey.set(k, e);
        }
      }
      const existingTxnKeys = new Set(existingEntryByKey.keys());
      const existingValKeys = new Set(existingVals.map(valuationContentKey));

      for (const t of proposedTxns) {
        const k = fundUpdateTxnKey(t);
        const matchedExisting = existingEntryByKey.get(k);
        if (matchedExisting) {
          const pos = positionById.get(matchedExisting.position_id);
          const existingSourceId = pos?.holder_source_of_fund_id ?? null;
          const incomingSourceId = matched_source?.matched_id ?? null;
          if (existingSourceId && incomingSourceId && existingSourceId !== incomingSourceId) {
            assetWarnings.push(
              `Matching transaction on ${t.date} (${t.type}, amount ${t.valueAmount}) has differing source attribution (existing source: ${existingSourceId}, incoming source: ${incomingSourceId}).`,
            );
          }
          const isDivestment =
            (t.type as string) === 'sell' ||
            t.type === 'divestment' ||
            matchedExisting.entry_type === 'sell' ||
            matchedExisting.entry_type === 'redemption' ||
            Boolean(matchedExisting.sub_type && matchedExisting.sub_type.startsWith('divestment'));
          if (isDivestment) {
            const rawType = (t.type as string)?.trim().toLowerCase();
            const shareCountStr = t.shareCount != null ? flAbs(toExactDecimalString(t.shareCount)) : "0.00000000";
            const hasPositiveShares = t.shareCount != null && flGt(shareCountStr, "0.00000000");
            const incomingEntryType: FlEntryType = positionKind === "fund"
              ? (hasPositiveShares ? "redemption" : "distribution")
              : "sell";

            const existingFundObj = pos?.holder_fund_id ? existingFunds.find((f) => f.id === pos.holder_fund_id) : undefined;
            const existingHolder: CashHolderCandidate = {
              holder_investor_id: pos?.holder_investor_id,
              holder_fund_id: pos?.holder_fund_id,
              holderFundManaged: existingFundObj ? existingFundObj.managed === true : false,
            };
            const existingDest = resolveProceedsTreatment({
              entryType: matchedExisting.entry_type,
              holder: existingHolder,
              statedSubType: matchedExisting.sub_type && !isUnresolvedDivestmentToken(matchedExisting.sub_type) ? matchedExisting.sub_type : null,
            }).subType;

            const incomingDest = resolveProceedsTreatment({
              entryType: incomingEntryType,
              holder: reviewHolderCandidate,
              statedSubType: (t.sellProceedsDestination && !isUnresolvedDivestmentToken(t.sellProceedsDestination) ? t.sellProceedsDestination : null) ??
                (t.subTypeLabel && !isUnresolvedDivestmentToken(t.subTypeLabel) ? t.subTypeLabel : null),
            }).subType;

            if (existingDest && incomingDest) {
              if (existingDest !== incomingDest) {
                assetWarnings.push(
                  `Matching divestment on ${t.date} (${t.type}, amount ${t.valueAmount}) has differing proceeds treatment (existing: ${existingDest}, incoming: ${incomingDest}).`,
                );
              }
            }
          }
        }
      }
      // Some older/imported rows (and repository projections) expose only the
      // target/date. Preserve replay compatibility for those sparse records;
      // fully populated records still use content-aware correction detection.
      const sparseExistingValDates = new Set(
        existingVals
          .filter((v) =>
            v.market_value == null &&
            v.price_per_unit == null &&
            v.units_outstanding == null &&
            v.valuation_method == null,
          )
          .map((v) => v.as_of_date),
      );
      const missing_txns = proposedTxns.filter((t) => !existingTxnKeys.has(fundUpdateTxnKey(t)));
      // A same-date mark with changed economics is a correction and must be
      // surfaced for review/upsert, not silently treated as unchanged.
      const missing_valuations = persistableValuations.filter(
        (v) => !existingValKeys.has(valuationContentKey(v)) && !sparseExistingValDates.has(v.asOfDate),
      );
      const status: FundUpdateAssetStatus =
        missing_txns.length === 0 && missing_valuations.length === 0 ? "unchanged" : "add_missing";

      return {
        code: proposed.code,
        name: proposed.name,
        fund: proposed.fund,
        asset_type: proposed.assetType,
        target_kind: targetKind,
        entity: proposed.entity,
        funding_source: proposed.fundingSource,
        matched_fund,
        matched_investor,
        matched_source,
        status,
        matched_asset_id: matchedTargetId,
        proposed_txn_count: proposedTxns.length,
        proposed_valuation_count: persistableValuations.length,
        existing_txn_count: existingTxns.length,
        existing_valuation_count: existingVals.length,
        missing_txn_count: missing_txns.length,
        missing_valuation_count: missing_valuations.length,
        proposed,
        missing_txns,
        missing_valuations,
        ...(assetWarnings.length > 0 ? { warnings: assetWarnings } : {}),
      };
    });

    const eventsToClassify =
      commitmentEvents ??
      (options?.proposal && "commitment_events" in options.proposal
        ? (options.proposal as any).commitment_events
        : undefined) ??
      [];

    if (eventsToClassify.length > 0) {
      for (const ev of eventsToClassify) {
        // A managed fund party is a fund holder, never an investor to create.
        const matched = isManagedFundName(ev.investorName, managedNames)
          ? null
          : matchCatalog(ev.investorName, investorByName);
        if (matched) upsertUnique(uniqueInvestors, matched);
        // A transfer's transferor is counterparty metadata only: the transfer
        // posts no leg on it, so it is not an investor to create.
      }
    }

    const commitmentEventStatuses = await this.classifyCommitmentEvents(
      eventsToClassify,
      existingFunds,
      existingInvestors,
      managedNames,
    );

    const baseReview: FundUpdateFullReview = {
      assets: sortFundUpdateReviewAssets(reviews),
      funds: Array.from(uniqueFunds.values()),
      investors: Array.from(uniqueInvestors.values()),
      sources: Array.from(uniqueSources.values()),
      groups: Array.from(uniqueGroups.values()),
      ...(options?.reconciliation ? { reconciliation: options.reconciliation } : {}),
      ...(options?.review_items ? { review_items: options.review_items } : {}),
      commitment_event_statuses: commitmentEventStatuses,
      managed_fund_keys: [...managedNames],
    };

    const effectiveProposal: FundUpdateProposal | undefined =
      options?.proposal ??
      (commitmentEvents && commitmentEvents.length > 0
        ? {
            template_id: NANJING_TEMPLATE_ID,
            stats: {
              asset_count: proposedAssets.length,
              direct_count: proposedAssets.length,
              fund_of_funds_count: 0,
              transaction_count: commitmentEvents.length,
              valuation_count: 0,
              commitment_event_count: commitmentEvents.length,
            },
            assets: proposedAssets,
            commitment_events: commitmentEvents,
          }
        : undefined);

    const twoStep = buildNormalizedTwoStepReview(baseReview, effectiveProposal);

    return {
      ...baseReview,
      two_step_review: twoStep,
    };
  }

  private async classifyCommitmentEvents(
    events: ParsedCommitmentEvent[],
    existingFunds: Tables<"fl_funds">[],
    existingInvestors: Tables<"fl_investors">[],
    managedFundKeys: ReadonlySet<string>,
  ): Promise<Record<number, "actionable" | "duplicate">> {
    if (events.length === 0) return {};

    const investorLookup = new Map<string, Tables<"fl_investors">>();
    for (const inv of existingInvestors) {
      const normInv = normalizeInvestorName(inv.name);
      if (normInv && !investorLookup.has(normInv)) investorLookup.set(normInv, inv);
      const normCanon = normalizeCanonicalName(inv.name);
      if (normCanon && !investorLookup.has(normCanon)) investorLookup.set(normCanon, inv);
      const lower = inv.name?.trim().toLowerCase();
      if (lower && !investorLookup.has(lower)) investorLookup.set(lower, inv);
    }

    const fundLookup = new Map<string, Tables<"fl_funds">>();
    for (const fund of existingFunds) {
      const normName = normalizeCanonicalName(fund.name);
      if (normName && !fundLookup.has(normName)) fundLookup.set(normName, fund);
      const lower = fund.name?.trim().toLowerCase();
      if (lower && !fundLookup.has(lower)) fundLookup.set(lower, fund);
    }

    const findInvestor = (name: string | null | undefined): Tables<"fl_investors"> | undefined => {
      if (!name) return undefined;
      const clean = name.trim();
      if (!clean) return undefined;
      return (
        investorLookup.get(normalizeInvestorName(clean)) ??
        investorLookup.get(normalizeCanonicalName(clean)) ??
        investorLookup.get(clean.toLowerCase())
      );
    };

    const findFund = (name: string | null | undefined): Tables<"fl_funds"> | undefined => {
      if (!name) return undefined;
      const clean = name.trim();
      if (!clean) return undefined;
      return (
        fundLookup.get(normalizeCanonicalName(clean)) ??
        fundLookup.get(clean.toLowerCase())
      );
    };

    // A party is a managed fund (fund-held position) or an outside investor.
    type PartyRef = { kind: "fund" | "investor"; id: string };
    const findParty = (name: string | null | undefined): PartyRef | undefined => {
      if (isManagedFundName(name, managedFundKeys)) {
        const fund = findFund(name);
        return fund ? { kind: "fund", id: fund.id } : undefined;
      }
      const investor = findInvestor(name);
      return investor ? { kind: "investor", id: investor.id } : undefined;
    };
    const partyKey = (party: PartyRef) => `${party.kind}:${party.id}`;
    const syntheticPartyKey = (party: PartyRef | undefined, name: string) =>
      party ? partyKey(party) : `${isManagedFundName(name, managedFundKeys) ? "fund" : "investor"}:${normalizeInvestorName(name)}`;

    const referencedInvestorIds = new Set<string>();
    const referencedHolderFundIds = new Set<string>();
    const referencedFundIds = new Set<string>();
    const referenceParty = (party: PartyRef | undefined) => {
      if (party?.kind === "investor") referencedInvestorIds.add(party.id);
      if (party?.kind === "fund") referencedHolderFundIds.add(party.id);
    };

    for (const ev of events) {
      const fund = findFund(ev.fund);
      if (fund) referencedFundIds.add(fund.id);

      referenceParty(findParty(ev.investorName));
    }

    const investorIds = Array.from(referencedInvestorIds);
    const holderFundIds = Array.from(referencedHolderFundIds);
    const [investorPositions, fundHeldPositions] = await Promise.all([
      investorIds.length > 0
        ? this.flPositionRepo.findByHolderInvestorIds(this.workspaceId, investorIds)
        : Promise.resolve([] as Tables<"fl_positions">[]),
      holderFundIds.length > 0
        ? this.flPositionRepo.findByHolderFundIds(this.workspaceId, holderFundIds)
        : Promise.resolve([] as Tables<"fl_positions">[]),
    ]);

    const relevantPositions = [...investorPositions, ...fundHeldPositions].filter(
      (p) => p.fund_id && !p.asset_id && referencedFundIds.has(p.fund_id),
    );

    const positionByPartyAndFund = new Map<string, Tables<"fl_positions">>();
    for (const pos of relevantPositions) {
      if (pos.holder_investor_id && pos.fund_id) {
        positionByPartyAndFund.set(`investor:${pos.holder_investor_id}:::${pos.fund_id}`, pos);
      } else if (pos.holder_fund_id && pos.fund_id) {
        positionByPartyAndFund.set(`fund:${pos.holder_fund_id}:::${pos.fund_id}`, pos);
      }
    }

    const positionIds = relevantPositions.map((p) => p.id);
    const ledgerEntries =
      positionIds.length > 0
        ? await this.flLedgerEntryRepo.findAllByPositionIds(this.workspaceId, positionIds)
        : [];

    const entriesByPositionId = new Map<string, Tables<"fl_ledger_entries">[]>();
    for (const entry of ledgerEntries) {
      const list = entriesByPositionId.get(entry.position_id) ?? [];
      list.push(entry);
      entriesByPositionId.set(entry.position_id, list);
    }

    const seenKeysByPosition = new Map<string, Set<string>>();
    for (const [posId, posEntries] of entriesByPositionId.entries()) {
      const keys = new Set<string>();
      for (const e of posEntries) {
        if (
          e.entry_type === "commitment" ||
          e.entry_type === "paid_in" ||
          e.entry_type === "distribution" ||
          e.entry_type === "adjustment"
        ) {
          keys.add(buildLedgerEntryCommitmentDedupKey(e));
        }
      }
      seenKeysByPosition.set(posId, keys);
    }

    const transferInGuard = new TransferInReplayGuard();
    const countLedgerMatches = (positionId: string | undefined, key: string) =>
      positionId
        ? (entriesByPositionId.get(positionId) ?? []).filter((e) => buildLedgerEntryCommitmentDedupKey(e) === key).length
        : 0;

    // Sort events to preserve deterministic source order for intra-file dedup
    const sortedEvents = [...events].sort((a, b) => {
      const fundCmp = (a.fund || "").localeCompare(b.fund || "");
      if (fundCmp !== 0) return fundCmp;
      const invCmp = (a.investorName || "").localeCompare(b.investorName || "");
      if (invCmp !== 0) return invCmp;
      const dateCmp = (a.date || "").localeCompare(b.date || "");
      if (dateCmp !== 0) return dateCmp;
      return a.sourceRow - b.sourceRow;
    });

    const result: Record<number, "actionable" | "duplicate"> = {};

    for (const event of sortedEvents) {
      if (event.amount == null || !Number.isFinite(event.amount) || event.amount <= 0 || !event.date) {
        continue;
      }

      const fund = findFund(event.fund);
      const fundKey = fund?.id ?? normalizeCanonicalName(event.fund);

      if (event.intent === "transfer_in") {
        const pairing = event.transferPairing;
        const transferorName = pairing?.transferorName?.trim() ?? event.counterpartyName?.trim();

        if (
          !pairing ||
          pairing.status === "missing_counterparty" ||
          pairing.status === "ambiguous" ||
          pairing.requiresReview ||
          !pairing.eligibleForTransferOut ||
          !transferorName ||
          !event.investorName?.trim()
        ) {
          // Unresolved / review-required transfer -> remains blocked at twoStepReview
          continue;
        }
        // Posted as the transferee's leg alone (see applyCommitmentEvents).
        const transferee = findParty(event.investorName);
        const transfereePos = transferee && fund
          ? positionByPartyAndFund.get(`${partyKey(transferee)}:::${fund.id}`)
          : undefined;
        const transfereePosKey = transfereePos
          ? transfereePos.id
          : `synthetic:${syntheticPartyKey(transferee, event.investorName)}:::${fundKey}`;
        const key = buildCommitmentEventDedupKey(event.intent, event.date, event.amount);
        result[event.sourceRow] =
          transferInGuard.check(
            transfereePosKey,
            key,
            normalizeInvestorName(transferorName),
            countLedgerMatches(transfereePos?.id, key),
          ) === "duplicate"
            ? "duplicate"
            : "actionable";
        continue;
      }

      // One-sided commitment events (increase, decrease, paid_in, distribution)
      const transferee = findParty(event.investorName);
      const pos = transferee && fund
        ? positionByPartyAndFund.get(`${partyKey(transferee)}:::${fund.id}`)
        : undefined;

      const posKey = pos
        ? pos.id
        : `synthetic:${syntheticPartyKey(transferee, event.investorName)}:::${fundKey}`;

      const key = buildCommitmentEventDedupKey(event.intent, event.date, event.amount);

      let seenKeys = seenKeysByPosition.get(posKey);
      if (!seenKeys) {
        seenKeys = new Set<string>();
        seenKeysByPosition.set(posKey, seenKeys);
      }

      if (seenKeys.has(key)) {
        result[event.sourceRow] = "duplicate";
      } else {
        result[event.sourceRow] = "actionable";
        seenKeys.add(key);
      }
    }

    return result;
  }

  async applySelected(
    proposedAssets: ParsedAsset[],
    assetCodes: string[],
    selections?: FundUpdateAssetSelection[],
    optionsOrCatalog?: FundUpdateApplyOptions | string[],
    catalogSelections?: { funds?: string[]; investors?: string[]; sources?: string[] },
    catalogArg?: string[],
  ): Promise<FundUpdateApplyResult> {
    const options = Array.isArray(optionsOrCatalog) ? undefined : optionsOrCatalog;
    const catalog = Array.isArray(optionsOrCatalog) ? optionsOrCatalog : catalogArg;
    proposedAssets = normalizeParsedAssets(proposedAssets);
    const codeSet = new Set(assetCodes);
    const selected = proposedAssets.filter((a) => codeSet.has(a.code));
    if (catalog) {
      if (catalog.length === 0) throw new FundUpdateValidationError("Explicit fund catalog cannot be empty");
      const catalogSet = new Set(catalog.map((c) => c.trim().toLowerCase()));
      for (const item of selected) {
        if ((item.holderKind ?? "fund") === "investor") continue;
        if (!item.fund || !catalogSet.has(item.fund.trim().toLowerCase())) {
          throw new FundUpdateValidationError(`Explicit fund catalog does not contain proposed fund "${item.fund}" for asset "${item.code}"`);
        }
      }
    }
    const managedTargetNames = new Set([
      ...(catalog ?? []),
      ...proposedAssets.filter((a) => a.holderKind !== "investor").map((a) => a.fund),
    ].filter(Boolean).map(normalizeCanonicalName));
    const review = (await this.buildFullReview(selected, undefined, { fundCatalog: [...managedTargetNames] })).assets;
    const selectionByCode = new Map((selections ?? []).map((s) => [s.asset_code, s]));
    const buildAllowList = (entries: string[] | undefined): Set<string> | undefined => {
      if (entries === undefined) return undefined;
      const set = new Set<string>();
      for (const entry of entries) {
        const clean = entry?.trim();
        if (!clean) continue;
        set.add(clean.toLowerCase());
        const normKey = normalizeCanonicalName(clean);
        if (normKey) {
          set.add(normKey);
        }
      }
      return set;
    };
    const fundsAllowList = buildAllowList(catalogSelections?.funds);
    const investorsAllowList = buildAllowList(catalogSelections?.investors);
    const sourcesAllowList = buildAllowList(catalogSelections?.sources);

    return this.withExecutor(options?.executor, async (tx: DbClient) => {
      const catalogCurrency = selected.find((a) => a.currency?.trim())?.currency?.trim()
        ?? selected.flatMap((a) => a.txns).find((t) => t.currency?.trim())?.currency?.trim()
        ?? "USD";
      const catalogWarnings: string[] = [];
      const outcomes: SubmittedRowOutcome[] = [];

      const hasInvestorHeld = selected.some((a) => a.holderKind === "investor");
      const hasFundHeld = selected.some((a) => (a.holderKind ?? "fund") !== "investor");

      const investorGroupKeys = new Set<string>();
      for (const a of proposedAssets) {
        if (a.holderKind === "investor") {
          const grp = a.group?.trim() || OTHERS_GROUP;
          investorGroupKeys.add(grp.toLowerCase());
          const normGrp = normalizeCanonicalName(grp);
          if (normGrp) investorGroupKeys.add(normGrp);
        }
      }

      const investorGroupNames = new Set<string>();
      if (hasInvestorHeld) {
        for (const a of selected) {
          if (a.holderKind === "investor") {
            const grp = a.group?.trim() || OTHERS_GROUP;
            const normGrp = normalizeCanonicalName(grp);

            const isGroupSelected =
              fundsAllowList === undefined ||
              fundsAllowList.has(grp.toLowerCase()) ||
              Boolean(normGrp && fundsAllowList.has(normGrp));

            if (isGroupSelected) {
              investorGroupNames.add(grp);
            }
          }
        }
      }

      let created_groups = 0;
      const groupInvestorMap = hasInvestorHeld
        ? await this.ensureGroupInvestors(investorGroupNames, tx, () => {
            created_groups += 1;
          })
        : new Map<string, string>();
      const groupInvestorIds = new Set(groupInvestorMap.values());

      const fundIdByName = (!hasFundHeld || fundsAllowList !== undefined)
        ? await this.getExistingFundMap(tx)
        : await this.ensureFundCatalog(
            catalog,
            tx,
            catalogCurrency,
            options?.fundCatalogItems,
            catalogWarnings,
          );

      if (options?.fundRemaps) {
        const remapEntries = options.fundRemaps instanceof Map
          ? Array.from(options.fundRemaps.entries())
          : Object.entries(options.fundRemaps);
        for (const [key, targetId] of remapEntries) {
          if (!targetId) continue;
          fundIdByName.set(targetId, targetId);
          const clean = key.replace(/^fund:/, '').trim();
          fundIdByName.set(clean.toLowerCase(), targetId);
          const norm = normalizeCanonicalName(clean);
          if (norm) fundIdByName.set(norm, targetId);
          fundIdByName.set(key.toLowerCase(), targetId);
        }
      }

      // Preload investors, funding sources, assets, and funds
      const allInvestors = await this.flInvestorRepo.findByWorkspaceId(this.workspaceId, tx);
      const investorMap = new Map<string, string>();
      const investorParentById = new Map<string, string | null>();
      for (const e of allInvestors) {
        const norm = normalizeCanonicalName(e.name);
        if (norm) investorMap.set(norm, e.id);
        const lower = e.name.trim().toLowerCase();
        if (lower) investorMap.set(lower, e.id);
        investorParentById.set(e.id, e.parent_investor_id ?? null);
      }
      for (const [key, id] of groupInvestorMap.entries()) {
        investorMap.set(key, id);
        if (!investorParentById.has(id)) {
          investorParentById.set(id, null);
        }
      }

      if (options?.investorRemaps) {
        const remapEntries = options.investorRemaps instanceof Map
          ? Array.from(options.investorRemaps.entries())
          : Object.entries(options.investorRemaps);
        for (const [key, targetId] of remapEntries) {
          if (!targetId) continue;
          investorMap.set(targetId, targetId);
          const clean = key.replace(/^investor:/, '').trim();
          investorMap.set(clean.toLowerCase(), targetId);
          const norm = normalizeCanonicalName(clean);
          if (norm) investorMap.set(norm, targetId);
          investorMap.set(key.toLowerCase(), targetId);
        }
      }

      const allFundSources = await this.flFundingSourceRepo.findByWorkspaceId(this.workspaceId, tx);
      const fundingSourceMap = new Map<string, string>();
      const existingSourceIds = new Set<string>();
      for (const s of allFundSources) {
        existingSourceIds.add(s.id);
        fundingSourceMap.set(s.id, s.id);
        const norm = normalizeCanonicalName(s.name);
        if (norm) fundingSourceMap.set(norm, s.id);
        const lower = s.name.trim().toLowerCase();
        if (lower) fundingSourceMap.set(lower, s.id);
      }
      if (options?.sourceRemaps) {
        const remapEntries = options.sourceRemaps instanceof Map
          ? Array.from(options.sourceRemaps.entries())
          : Object.entries(options.sourceRemaps);
        for (const [key, targetId] of remapEntries) {
          if (!targetId) continue;
          if (!existingSourceIds.has(targetId)) {
            throw new FundUpdateValidationError(
              `Cannot remap source "${key}": target source ID "${targetId}" does not exist in workspace.`,
            );
          }
          fundingSourceMap.set(targetId, targetId);
          const clean = key.replace(/^source:/, '').trim();
          fundingSourceMap.set(clean.toLowerCase(), targetId);
          const norm = normalizeCanonicalName(clean);
          if (norm) fundingSourceMap.set(norm, targetId);
          fundingSourceMap.set(key.toLowerCase(), targetId);
        }
      }

      // Pre-validate all allocation references on posting transactions before performing writes
      for (const item of review) {
        const selection = selectionByCode.get(item.code);
        const candidateTxns = selection?.txns ?? (item.status === "new" ? item.proposed.txns : item.missing_txns);
        for (const t of candidateTxns) {
          if (t.allowPost !== false && !isZeroEffectFundUpdateTxn(t) && t.allocations && t.allocations.length > 0) {
            for (let i = 0; i < t.allocations.length; i++) {
              const a = t.allocations[i];
              const rawSrc = (a.funding_source_id ?? a.fundingSourceId)?.trim();
              if (!rawSrc) {
                throw new FundUpdateValidationError(
                  `Transaction allocation at index ${i} on ${t.date} (${t.type}) is missing funding source reference.`,
                );
              }
              const resolved = this.resolveFundingSourceReference(rawSrc, fundingSourceMap);
              if (!resolved) {
                throw new FundUpdateValidationError(
                  `Cannot resolve funding source allocation reference "${rawSrc}" for transaction on ${t.date} (${t.type}): funding source does not exist in workspace.`,
                );
              }
              if (a.amount == null) {
                throw new FundUpdateValidationError(
                  `Transaction allocation for source "${rawSrc}" on ${t.date} (${t.type}) has missing amount.`,
                );
              }
            }
          }
        }
      }

      const allAssets = await this.flAssetRepo.findByWorkspaceId(this.workspaceId, tx);
      const assetMap = new Map<string, Tables<"fl_assets">>();
      for (const a of allAssets) {
        const norm = normalizeCanonicalName(a.name);
        if (norm) assetMap.set(norm, a);
        const lower = a.name.trim().toLowerCase();
        if (lower) assetMap.set(lower, a);
        if (a.legal_name) {
          const normLegal = normalizeCanonicalName(a.legal_name);
          if (normLegal) assetMap.set(normLegal, a);
        }
      }

      const allFunds = await this.flFundRepo.findByWorkspaceId(this.workspaceId, tx);
      const fofMap = new Map<string, Tables<"fl_funds">>();
      const fundById = new Map<string, Tables<"fl_funds">>();
      for (const f of allFunds) {
        fundById.set(f.id, f);
        // Fund identity is workspace-global. A managed fund may also appear as
        // another fund's FoF target, so reuse it instead of creating a second
        // unmanaged master row with the same canonical name.
        const norm = normalizeCanonicalName(f.name);
        if (norm) fofMap.set(norm, f);
        const lower = f.name.trim().toLowerCase();
        if (lower) fofMap.set(lower, f);
      }

      let created_assets = 0;
      let updated_assets = 0;
      let skipped = 0;
      let txns_inserted = 0;
      let valuations_upserted = 0;
      let created_funds = 0;
      let created_fof_funds = 0;
      let created_investors = 0;
      let created_sources = 0;

      if (catalogSelections?.funds) {
        for (const rawName of catalogSelections.funds) {
          const clean = rawName?.trim();
          if (!clean) continue;
          const key = clean.toLowerCase();
          const normKey = normalizeCanonicalName(clean);
          if (investorGroupKeys.has(key) || (normKey && investorGroupKeys.has(normKey))) continue;
          if (fundIdByName.has(key) || (normKey && fundIdByName.has(normKey))) continue;
          const itemMeta = options?.fundCatalogItems?.find(
            (ci) => ci.nameZh.trim().toLowerCase() === key || normalizeCanonicalName(ci.nameZh) === normKey,
          );
          const created = await this.flMasterDataService.getOrCreateFund(
            this.workspaceId,
            {
              name: clean,
              english_name: itemMeta?.nameEn ?? null,
              managed: true,
              ownership_basis: "commitment",
              base_currency: catalogCurrency,
            },
            tx,
          );
          fundById.set(created.id, created);
          fundIdByName.set(key, created.id);
          if (normKey) fundIdByName.set(normKey, created.id);
          fundIdByName.set(clean, created.id);
          fofMap.set(normKey, created);
          fofMap.set(key, created);
          created_funds += 1;
        }
      }

      // Managed funds for the cross-book rule: the catalog, every holder fund in the
      // proposal, and every managed fund already in the workspace.
      const crossBookManagedKeys = new Set([
        ...managedTargetNames,
        ...buildManagedFundNameKeys(allFunds.filter((f) => f.managed === true).map((f) => f.name)),
      ]);

      if (catalogSelections?.investors) {
        for (const rawName of catalogSelections.investors) {
          const clean = rawName?.trim();
          if (!clean) continue;
          const key = clean.toLowerCase();
          const normKey = normalizeCanonicalName(clean);
          if (isManagedFundName(clean, crossBookManagedKeys)) continue;
          if (investorMap.has(key) || investorMap.has(normKey)) continue;
          const created = await this.flMasterDataService.getOrCreateInvestor(
            this.workspaceId,
            { name: clean, investor_type: "institution" },
            tx,
          );
          investorMap.set(key, created.id);
          investorMap.set(normKey, created.id);
          created_investors += 1;
        }
      }

      if (catalogSelections?.sources) {
        for (const rawName of catalogSelections.sources) {
          const clean = rawName?.trim();
          if (!clean) continue;
          const key = clean.toLowerCase();
          const normKey = normalizeCanonicalName(clean);
          if (fundingSourceMap.has(key) || fundingSourceMap.has(normKey)) continue;
          const created = await this.flMasterDataService.getOrCreateFundingSource(
            this.workspaceId,
            { name: clean },
            tx,
          );
          fundingSourceMap.set(key, created.id);
          fundingSourceMap.set(normKey, created.id);
          created_sources += 1;
        }
      }

      const resolvedDirectAssetIdByCanonicalName = new Map<string, { assetCode: string; assetId: string }>();

      for (const item of review) {
        const selection = selectionByCode.get(item.code);
        const proposedCandidateTxns = selection?.txns ?? (item.status === "new" ? item.proposed.txns : item.missing_txns);
        const selectedValuations = selection?.valuations ?? (
          item.status === "new" ? item.proposed.valuations : item.missing_valuations
        );
        const valuations = selectedValuations.filter(isPersistableFundUpdateValuation);

        // A managed fund's 投资/退出 into another managed fund is recorded from the
        // target fund's 实缴/分配 rows (fund-held position, both cash legs). The
        // payer-side rows post nothing; each gets an annotated outcome.
        const crossBookTargetName = selection?.remapped_target_name?.trim() || item.proposed.name;
        const crossBookMatchedTarget = selection?.matched_target_id ? fundById.get(selection.matched_target_id) : undefined;
        // Only a Nanjing ledger import posts the receiving fund's book (commitment
        // events); a workbook-fallback (V1) import has no such rows, so its 投资
        // rows keep posting.
        const isCrossBook =
          !options?.isV1 &&
          proposedCandidateTxns.length > 0 &&
          (isManagedFundCrossBookAsset(
            { fund: item.proposed.fund, name: crossBookTargetName, holderKind: item.proposed.holderKind },
            crossBookManagedKeys,
          ) ||
            (crossBookMatchedTarget?.managed === true &&
              item.proposed.holderKind !== "investor" &&
              isManagedFundName(item.proposed.fund, crossBookManagedKeys) &&
              normalizeCanonicalName(crossBookMatchedTarget.name) !== normalizeCanonicalName(item.proposed.fund)));
        if (isCrossBook) {
          const targetFundName = crossBookMatchedTarget?.name ?? crossBookTargetName;
          const crossBookWarnings = await this.crossBookRecordingWarnings(
            item.proposed.fund,
            targetFundName,
            proposedCandidateTxns.filter((t) => t.allowPost !== false && !isZeroEffectFundUpdateTxn(t)),
            {
              holderFundId:
                fundIdByName.get(normalizeCanonicalName(item.proposed.fund)) ??
                fundIdByName.get(item.proposed.fund.trim().toLowerCase()) ??
                null,
              targetFundId:
                crossBookMatchedTarget?.id ??
                fofMap.get(normalizeCanonicalName(targetFundName))?.id ??
                null,
              commitmentEvents: options?.commitmentEvents ?? [],
            },
            tx,
          );
          catalogWarnings.push(...crossBookWarnings.all);
          for (const t of proposedCandidateTxns) {
            const kind = crossBookFlowKindForTxn(t);
            const rowWarnings = crossBookWarnings.byKind.get(kind) ?? [];
            outcomes.push({
              submittedId: t.submittedId ?? `txn:${item.code}:${t.date}:${t.type}`,
              family: 'transaction',
              disposition: 'stale',
              // The approval summary shows outcome reasons, so a recording gap
              // replaces the plain note there.
              reason: isZeroEffectFundUpdateTxn(t)
                ? 'Skipped: zero-effect placeholder transaction (neither cash nor share movement)'
                : rowWarnings[0] ?? managedFundCrossBookNote(targetFundName, kind),
              assetCode: item.code,
              targetId: crossBookMatchedTarget?.id ?? item.matched_asset_id ?? null,
              persistedId: null,
              persistedTable: null,
              ...(rowWarnings.length > 0 && !isZeroEffectFundUpdateTxn(t) ? { warnings: rowWarnings } : {}),
            });
          }
          if (valuations.length === 0) {
            skipped += 1;
            continue;
          }
        }
        const candidateTxns = isCrossBook ? [] : proposedCandidateTxns;
        const txns = candidateTxns.filter((t) => !isZeroEffectFundUpdateTxn(t));
        const hasPostingWork = txns.some((t) => t.allowPost !== false) || valuations.length > 0;
        const isVerifyOnlyItem = txns.length > 0 && txns.every((t) => t.allowPost === false) && valuations.length === 0;

        if (!isVerifyOnlyItem && item.matched_asset_id && item.proposed.englishName?.trim()) {
          const isFundTarget = item.target_kind === "fund";
          if (isFundTarget) {
            const existingFund = await this.flFundRepo.findById(this.workspaceId, item.matched_asset_id, tx);
            if (existingFund && !existingFund.english_name) {
              await this.flFundRepo.update(
                this.workspaceId,
                item.matched_asset_id,
                { english_name: item.proposed.englishName.trim() },
                tx,
              );
            }
          } else {
            const existingAsset = await this.flAssetRepo.findById(this.workspaceId, item.matched_asset_id, tx);
            if (existingAsset && !existingAsset.english_name) {
              await this.flAssetRepo.update(
                this.workspaceId,
                item.matched_asset_id,
                { english_name: item.proposed.englishName.trim() },
                tx,
              );
            }
          }
        }

        const hasExplicitSelections = Boolean(
          selection &&
            ((selection.txns && selection.txns.length > 0) ||
              (selection.valuations && selection.valuations.length > 0)),
        );
        if (item.status === "unchanged" && !hasExplicitSelections) {
          skipped += 1;
          continue;
        }

        const isInvestorPath = item.proposed.holderKind === "investor";

        let fundId: string | null = null;
        let holderInvestorId: string | null = null;

        if (isInvestorPath) {
          const rawHolderName = item.proposed.holderName?.trim() || item.proposed.entity?.trim() || UNATTRIBUTED_ENTITY;
          const isHolderSelected =
            investorsAllowList === undefined ||
            investorsAllowList.has(rawHolderName.toLowerCase()) ||
            Boolean(normalizeCanonicalName(rawHolderName) && investorsAllowList.has(normalizeCanonicalName(rawHolderName)));

          if (isHolderSelected) {
            if (hasPostingWork) {
              holderInvestorId = await this.resolveInvestorIdCached(
                rawHolderName,
                investorMap,
                tx,
                () => {
                  created_investors += 1;
                },
              );

              if (holderInvestorId) {
                const groupName = item.proposed.group?.trim() || OTHERS_GROUP;
                const isGroupSelected =
                  fundsAllowList === undefined ||
                  fundsAllowList.has(groupName.toLowerCase()) ||
                  Boolean(normalizeCanonicalName(groupName) && fundsAllowList.has(normalizeCanonicalName(groupName)));

                if (isGroupSelected) {
                  const normGroupName = normalizeCanonicalName(groupName);
                  const groupInvestorId =
                    (normGroupName ? groupInvestorMap.get(normGroupName) : undefined) ??
                    groupInvestorMap.get(groupName.toLowerCase()) ??
                    groupInvestorMap.get(groupName);

                  if (groupInvestorId && holderInvestorId !== groupInvestorId) {
                    const isGroupInvestor = groupInvestorIds.has(holderInvestorId);
                    if (!isGroupInvestor) {
                      const currentParent = investorParentById.get(holderInvestorId);
                      // First import wins: manual group assignment wins over the workbook,
                      // so later imports never overwrite an existing parent.
                      if (currentParent == null) {
                        await this.flInvestorRepo.update(
                          this.workspaceId,
                          holderInvestorId,
                          { parent_investor_id: groupInvestorId },
                          tx,
                        );
                        investorParentById.set(holderInvestorId, groupInvestorId);
                      }
                    }
                  }
                }
              }
            } else {
              holderInvestorId = this.resolveInvestorId(rawHolderName, investorMap);
            }
          }
        } else {
          const proposedFund = item.proposed.fund?.trim();
          if (!proposedFund) {
            if (options?.isV1) {
              throw new FundUpdateValidationError(`Cannot apply asset "${item.proposed.name}" with unresolved fund reference.`);
            }
          }

          if (proposedFund) {
            const isFundSelected =
              fundsAllowList === undefined ||
              fundsAllowList.has(proposedFund.toLowerCase()) ||
              fundsAllowList.has(normalizeCanonicalName(proposedFund));
            if (isFundSelected) {
              const hit =
                fundIdByName.get(normalizeCanonicalName(proposedFund)) ??
                fundIdByName.get(proposedFund.toLowerCase());
              if (hit) {
                fundId = hit;
              } else if (hasPostingWork) {
                if (catalog) {
                  throw new FundUpdateValidationError(`Explicit fund catalog does not contain proposed fund "${proposedFund}"`);
                } else {
                  const itemMeta = options?.fundCatalogItems?.find(
                    (ci) =>
                      normalizeCanonicalName(ci.nameZh) === normalizeCanonicalName(proposedFund) ||
                      ci.nameZh.trim().toLowerCase() === proposedFund.toLowerCase(),
                  );
                  const created = await this.flMasterDataService.getOrCreateFund(
                    this.workspaceId,
                    {
                      name: proposedFund,
                      english_name: itemMeta?.nameEn ?? null,
                      managed: true,
                      ownership_basis: "commitment",
                      base_currency: "USD",
                    },
                    tx,
                  );
                  fundId = created.id;
                  fundById.set(created.id, created);
                  fundIdByName.set(normalizeCanonicalName(proposedFund), fundId);
                  fundIdByName.set(proposedFund.toLowerCase(), fundId);
                }
              }
            } else {
              fundId = null;
            }
          } else {
            fundId = fundIdByName.get("others") || fundIdByName.get("Others")!;
          }

          const proposedEntity = item.proposed.entity?.trim();
          let investorId: string | null = null;
          if (proposedEntity) {
            const isInvestorSelected =
              investorsAllowList === undefined ||
              investorsAllowList.has(proposedEntity.toLowerCase()) ||
              investorsAllowList.has(normalizeCanonicalName(proposedEntity));
            if (isInvestorSelected) {
              investorId = hasPostingWork
                ? await this.resolveInvestorIdCached(item.proposed.entity, investorMap, tx)
                : this.resolveInvestorId(item.proposed.entity, investorMap);
            }
          }
        }

        const proposedSource = item.proposed.fundingSource?.trim();
        let fundingSourceId: string | null = null;
        let isSourceSelected = true;
        if (proposedSource) {
          isSourceSelected =
            sourcesAllowList === undefined ||
            sourcesAllowList.has(proposedSource.toLowerCase()) ||
            sourcesAllowList.has(normalizeCanonicalName(proposedSource));
          if (isSourceSelected) {
            if (hasPostingWork) {
              fundingSourceId = await this.resolveFundingSourceIdCached(item.proposed.fundingSource, fundingSourceMap, tx);
            } else {
              fundingSourceId = this.resolveFundingSourceReference(item.proposed.fundingSource, fundingSourceMap);
            }
          }
        }

        const fundObj = fundId ? fundById.get(fundId) : undefined;
        const isManagedFund = fundObj ? fundObj.managed === true : false;

        const holderCandidate: CashHolderCandidate = isInvestorPath
          ? {
              holder_investor_id:
                holderInvestorId ??
                item.proposed.holderName?.trim() ??
                item.proposed.entity?.trim() ??
                null,
              holderFundManaged: false,
            }
          : {
              holder_fund_id: fundObj ? fundId ?? null : null,
              holderFundManaged: isManagedFund,
            };

        const explicitMatchedAssetId = selection?.matched_target_id ?? item.matched_asset_id;
        const explicitAssetTargetName = selection?.remapped_target_name?.trim() || item.proposed.name;
        const normAssetName = normalizeCanonicalName(explicitAssetTargetName);
        const normAssetLegal = item.proposed.legalName ? normalizeCanonicalName(item.proposed.legalName) : null;
        const existingAssetHit = !isInvestorPath && item.target_kind !== "fund"
          ? (explicitMatchedAssetId ? (allAssets.find((a) => a.id === explicitMatchedAssetId) ?? assetMap.get(explicitMatchedAssetId)) : undefined) ??
            assetMap.get(normAssetName) ??
            (normAssetLegal ? assetMap.get(normAssetLegal) : undefined) ??
            assetMap.get(explicitAssetTargetName.trim().toLowerCase())
          : undefined;

        const isCashAsset =
          existingAssetHit?.asset_kind === "cash" ||
          (item.proposed as any).asset_kind === "cash" ||
          item.proposed.assetType === ("cash" as any);

        if (isCashAsset) {
          assertEligibleCashHolder(holderCandidate, `Cannot apply cash asset "${item.proposed.name}"`);
        }

        if (options?.isV1 && hasPostingWork) {
          const assetCurrency = item.proposed.txns[0]?.currency?.trim() || selection?.txns?.[0]?.currency?.trim();
          if (!assetCurrency) {
            throw new FundUpdateValidationError(`Cannot apply asset "${item.proposed.name}" with unresolved currency.`);
          }
          const txnsToValidate = selection?.txns ?? item.proposed.txns;
          for (const t of txnsToValidate) {
            if (!t.currency?.trim()) {
              throw new FundUpdateValidationError(`Cannot apply transaction on "${item.proposed.name}" with unresolved currency.`);
            }
          }
        }

        const isFundTarget = item.target_kind === "fund";
        const assetCurrency =
          item.proposed.currency?.trim() ||
          item.proposed.txns[0]?.currency?.trim() ||
          (options?.isV1 ? "" : "USD");

        const validTxnDates = txns
          .map((t) => t.date)
          .filter((d): d is string => Boolean(d && d.trim()))
          .sort();
        const earliestPositionDate = earliestFundUpdatePositionDate({
          entryDate: item.proposed.entryDate,
          txnDates: validTxnDates,
          valuationDates: valuations.map((v) => v.asOfDate),
        });

        let targetId: string;
        let isNewlyCreated = false;

        if (isFundTarget) {
          const explicitMatchedId = selection?.matched_target_id ?? item.matched_asset_id;
          const explicitTargetName = selection?.remapped_target_name?.trim() || item.proposed.name;
          const normName = normalizeCanonicalName(explicitTargetName);
          const existingHit =
            (explicitMatchedId ? (await this.flFundRepo.findById(this.workspaceId, explicitMatchedId, tx)) : undefined) ??
            fofMap.get(normName) ??
            fofMap.get(explicitTargetName.trim().toLowerCase());

          if (selection?.matched_target_id && existingHit?.id !== selection.matched_target_id) {
            throw new FundUpdateValidationError(
              `Cannot remap fund "${explicitTargetName}": target fund ID "${selection.matched_target_id}" does not exist in workspace.`,
            );
          }

          if (existingHit) {
            if (!existingHit.managed && !(await resolveFundVehiclesEnabled(this.workspaceId))) {
              throw new FundUpdateValidationError('Fund Vehicle View is disabled. Cannot remap to an unmanaged fund.');
            }
            targetId = existingHit.id;
            if (hasPostingWork && !existingHit.english_name && item.proposed.englishName?.trim()) {
              await this.flFundRepo.update(
                this.workspaceId,
                existingHit.id,
                { english_name: item.proposed.englishName.trim() },
                tx,
              );
              existingHit.english_name = item.proposed.englishName.trim();
            }
          } else if (!isVerifyOnlyItem) {
            const externalFund = await this.flMasterDataService.getOrCreateFund(
              this.workspaceId,
              {
                name: explicitTargetName,
                legal_name: item.proposed.legalName ?? null,
                english_name: item.proposed.englishName ?? null,
                registration_no: item.proposed.code,
                description: JSON.stringify({
                  sheetCode: item.proposed.code,
                  sourceRef: item.proposed.sourceRef ?? null,
                }),
                managed: managedTargetNames.has(normName),
                ownership_basis: managedTargetNames.has(normName) ? "commitment" : "capital_account",
                base_currency: assetCurrency,
              },
              tx,
            );
            targetId = externalFund.id;
            fundById.set(externalFund.id, externalFund);
            isNewlyCreated = true;
            created_funds += 1;
            created_fof_funds += 1;
            fofMap.set(normName, externalFund);
            fofMap.set(explicitTargetName.trim().toLowerCase(), externalFund);
          } else {
            for (const t of candidateTxns) {
              outcomes.push({
                submittedId: t.submittedId ?? `txn:${item.code}:${t.date}:${t.type}`,
                family: 'transaction',
                disposition: 'stale',
                reason: isZeroEffectFundUpdateTxn(t)
                  ? 'Skipped: zero-effect placeholder transaction (neither cash nor share movement)'
                  : 'Transaction not found in ledger (stale verify-only row: target fund not found in ledger)',
                assetCode: item.code,
                targetId: null,
                persistedTable: null,
                persistedId: null,
              });
            }
            if (!isNewlyCreated) {
              skipped += 1;
            }
            continue;
          }
        } else {
          const explicitMatchedId = selection?.matched_target_id ?? item.matched_asset_id;
          const explicitTargetName = selection?.remapped_target_name?.trim() || item.proposed.name;
          const normName = normalizeCanonicalName(explicitTargetName);
          const normLegal = item.proposed.legalName ? normalizeCanonicalName(item.proposed.legalName) : null;
          if (item.proposed.assetType === "fund_of_funds" && fofMap.has(normName)) {
            throw new FundUpdateValidationError(
              `Cannot remap "${item.proposed.name}" to asset "${explicitTargetName}": a fund with this identity already exists. Rebuild the review with the correct target.`,
            );
          }
          const existingHit =
            (explicitMatchedId ? (await this.flAssetRepo.findById(this.workspaceId, explicitMatchedId, tx)) : undefined) ??
            assetMap.get(normName) ??
            (normLegal ? assetMap.get(normLegal) : undefined) ??
            assetMap.get(explicitTargetName.trim().toLowerCase());

          if (selection?.matched_target_id && existingHit?.id !== selection.matched_target_id) {
            throw new FundUpdateValidationError(
              `Cannot remap asset "${item.code}": target asset ID "${selection.matched_target_id}" does not exist in workspace.`,
            );
          }

          if (existingHit) {
            targetId = existingHit.id;
            if (!isVerifyOnlyItem && !existingHit.english_name && item.proposed.englishName?.trim()) {
              await this.flAssetRepo.update(
                this.workspaceId,
                existingHit.id,
                { english_name: item.proposed.englishName.trim() },
                tx,
              );
              existingHit.english_name = item.proposed.englishName.trim();
            }
          } else if (!isVerifyOnlyItem) {
            const assetToCreate = selection?.remapped_target_name
              ? { ...item.proposed, name: explicitTargetName }
              : item.proposed;
            const asset = await this.createAsset(assetToCreate, options, isSourceSelected, tx);
            targetId = asset.id;
            isNewlyCreated = true;
            created_assets += 1;
            assetMap.set(normName, asset);
            if (normLegal) assetMap.set(normLegal, asset);
            assetMap.set(explicitTargetName.trim().toLowerCase(), asset);
          } else {
            for (const t of candidateTxns) {
              outcomes.push({
                submittedId: t.submittedId ?? `txn:${item.code}:${t.date}:${t.type}`,
                family: 'transaction',
                disposition: 'stale',
                reason: isZeroEffectFundUpdateTxn(t)
                  ? 'Skipped: zero-effect placeholder transaction (neither cash nor share movement)'
                  : 'Transaction not found in ledger (stale verify-only row: target asset not found in ledger)',
                assetCode: item.code,
                targetId: null,
                persistedTable: null,
                persistedId: null,
              });
            }
            if (!isNewlyCreated) {
              skipped += 1;
            }
            continue;
          }

          // Safety invariant: Direct assets with the same canonical identity must resolve to the exact same fl_assets ID
          const normCanonical = normalizeCanonicalName(explicitTargetName) || normalizeCanonicalName(item.proposed.name);
          const prev = resolvedDirectAssetIdByCanonicalName.get(normCanonical);
          if (prev) {
            if (prev.assetId !== targetId) {
              throw new FundUpdateValidationError(
                `Safety invariant violation: Proposed direct assets "${prev.assetCode}" and "${item.code}" share canonical identity "${explicitTargetName}" but resolved to separate asset IDs ("${prev.assetId}" and "${targetId}"). Direct assets with the same canonical identity must resolve to the same asset ID.`,
              );
            }
          } else {
            resolvedDirectAssetIdByCanonicalName.set(normCanonical, { assetCode: item.code, assetId: targetId });
          }
        }

        for (const t of candidateTxns) {
          if (isZeroEffectFundUpdateTxn(t)) {
            outcomes.push({
              submittedId: t.submittedId ?? `txn:${item.code}:${t.date}:${t.type}`,
              family: 'transaction',
              disposition: 'stale',
              reason: 'Skipped: zero-effect placeholder transaction (neither cash nor share movement)',
              assetCode: item.code,
              targetId,
              persistedTable: null,
              persistedId: null,
            });
          }
        }

        let positionId: string | null = null;
        const isInvestor = item.proposed.holderKind === "investor";
        const targetPositions = isFundTarget
          ? await this.flPositionRepo.findByFundIds(this.workspaceId, [targetId], tx)
          : await this.flPositionRepo.findByAssetIds(this.workspaceId, [targetId], tx);
        const holderTargetPositions = targetPositions.filter((p) =>
          isInvestor
            ? p.holder_investor_id === holderInvestorId
            : fundId
              ? p.holder_fund_id === fundId
              : !p.holder_fund_id && !p.holder_investor_id,
        );

        if (hasPostingWork) {
          if (isInvestorPath) {
            if (holderInvestorId) {
              const position = await this.flPositionService.getOrOpenPosition(
                this.workspaceId,
                isFundTarget
                  ? {
                      holder_investor_id: holderInvestorId,
                      fund_id: targetId,
                      holder_source_of_fund_id: fundingSourceId,
                      opened_at: earliestPositionDate,
                    }
                  : {
                      holder_investor_id: holderInvestorId,
                      asset_id: targetId,
                      holder_source_of_fund_id: fundingSourceId,
                      opened_at: earliestPositionDate,
                    },
                tx,
              );
              positionId = position.id;
            }
          } else if (fundId) {
            const position = await this.flPositionService.getOrOpenPosition(
              this.workspaceId,
              isFundTarget
                ? { holder_fund_id: fundId, fund_id: targetId, holder_source_of_fund_id: fundingSourceId, opened_at: earliestPositionDate }
                : { holder_fund_id: fundId, asset_id: targetId, holder_source_of_fund_id: fundingSourceId, opened_at: earliestPositionDate },
              tx,
            );
            positionId = position.id;
          }
        } else {
          if (holderTargetPositions.length > 0) {
            positionId = holderTargetPositions[0].id;
          }
        }

        if (!positionId && txns.some((t) => t.allowPost !== false)) {
          const rawHolderName = isInvestorPath
            ? (item.proposed.holderName?.trim() || item.proposed.entity?.trim() || UNATTRIBUTED_ENTITY)
            : (item.proposed.fund?.trim() || UNATTRIBUTED_ENTITY);
          throw new FundUpdateValidationError(
            `Cannot apply ${txns.length} selected transaction(s) for asset "${item.code}" (${item.proposed.name}): unresolved position for holder "${rawHolderName}".`,
          );
        }

        // Workbook market values are position-scoped (Q4). A valuation-only approval with no
        // resolvable holder must block — never fall through to an instrument-wide mark.
        if (!positionId && valuations.length > 0) {
          const rawHolderName = isInvestorPath
            ? (item.proposed.holderName?.trim() || item.proposed.entity?.trim() || UNATTRIBUTED_ENTITY)
            : (item.proposed.fund?.trim() || UNATTRIBUTED_ENTITY);
          throw new FundUpdateValidationError(
            `Cannot apply ${valuations.length} selected valuation(s) for asset "${item.code}" (${item.proposed.name}): unresolved position for holder "${rawHolderName}".`,
          );
        }

        if (!positionId && !hasPostingWork) {
          for (const t of txns) {
            outcomes.push({
              submittedId: t.submittedId ?? `txn:${item.code}:${t.date}:${t.type}`,
              family: 'transaction',
              disposition: 'stale',
              reason: 'Transaction not found in ledger (stale verify-only row: no position exists)',
              assetCode: item.code,
              targetId,
              persistedId: null,
              persistedTable: null,
            });
          }
          if (!isNewlyCreated) {
            skipped += 1;
          }
          continue;
        }

        const positionKind: FundUpdatePositionKind = item.proposed.assetType === "fund_of_funds" ? "fund" : "asset";
        let itemTxnsInserted = 0;
        let itemValuationsUpserted = 0;

        if (positionId && txns.length > 0) {
          const targetPositionIds = Array.from(
            new Set([positionId, ...holderTargetPositions.map((p) => p.id)]),
          );

          const existingPositionEntries = await this.flLedgerEntryRepo.findAllByPositionIds(
            this.workspaceId,
            targetPositionIds,
            tx,
          );

          const existingEntryByKey = new Map<string, Tables<"fl_ledger_entries">>();
          for (const e of existingPositionEntries) {
            const k = existingLedgerEntryTxnKey(e);
            if (!existingEntryByKey.has(k)) {
              existingEntryByKey.set(k, e);
            }
          }

          const existingTxnKeys = new Set(existingEntryByKey.keys());
          const entryAllocsById = new Map<string, Array<{ funding_source_id: string; amount: string | number }>>();
          const batchPostedEntryIds = new Set<string>();

          for (const t of txns) {
            const k = fundUpdateTxnKey(t);
            const submittedId = t.submittedId ?? `txn:${item.code}:${t.date}:${t.type}`;
            const matchedExisting = existingEntryByKey.get(k);

            if (matchedExisting) {
              const pos = targetPositions.find((p) => p.id === matchedExisting.position_id);
              const posSourceId = pos?.holder_source_of_fund_id ?? null;

              let entryAllocs: Array<{ funding_source_id: string; amount: string | number }> = [];
              if (entryAllocsById.has(matchedExisting.id)) {
                entryAllocs = entryAllocsById.get(matchedExisting.id)!;
              } else if (this.flAllocationRepo && matchedExisting.id) {
                try {
                  const dbAllocs = await this.flAllocationRepo.findByLedgerEntryIds(
                    this.workspaceId,
                    [matchedExisting.id],
                    tx,
                  );
                  entryAllocs = dbAllocs.map((a) => ({ funding_source_id: a.funding_source_id, amount: a.amount }));
                  entryAllocsById.set(matchedExisting.id, entryAllocs);
                } catch (err: any) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  throw new Error(`Allocation lookup unavailable for existing ledger entry ${matchedExisting.id}: ${errMsg}`);
                }
              }

              // Read-only resolution for duplicate checks - DO NOT call resolveFundingSourceIdCached!
              let incomingSourceId: string | null = null;
              const rawTxnSource = t.fundingSourceId ?? t.fundingSource ?? fundingSourceId;
              if (rawTxnSource) {
                incomingSourceId = this.resolveFundingSourceReference(rawTxnSource, fundingSourceMap) ?? rawTxnSource;
              }

              let resolvedIncomingAllocs: Array<{ funding_source_id: string; amount: string | number }> | undefined;
              if (t.allocations && t.allocations.length > 0) {
                resolvedIncomingAllocs = [];
                for (const a of t.allocations) {
                  const rawSrc = (a.funding_source_id ?? a.fundingSourceId)!;
                  const resolvedId = this.resolveFundingSourceReference(rawSrc, fundingSourceMap) ?? rawSrc;
                  resolvedIncomingAllocs.push({
                    funding_source_id: resolvedId,
                    amount: a.amount ?? 0,
                  });
                }
              }

              const rowWarnings: string[] = [];

              const sourceComp = compareSourceAllocations(
                t.valueAmount,
                posSourceId,
                entryAllocs,
                incomingSourceId,
                resolvedIncomingAllocs,
              );

              if (sourceComp.ambiguityWarning) {
                catalogWarnings.push(sourceComp.ambiguityWarning);
                rowWarnings.push(sourceComp.ambiguityWarning);
              }

              if (sourceComp.hasConflict) {
                const warningMsg = `Matching transaction on ${t.date} (${t.type}, amount ${t.valueAmount} ${t.currency || ""}) has ${sourceComp.conflictWarning}. Retained existing attribution without duplicating event.`;
                catalogWarnings.push(warningMsg);
                rowWarnings.push(warningMsg);
              }

              const isDivestment =
                (t.type as string) === 'sell' ||
                t.type === 'divestment' ||
                matchedExisting.entry_type === 'sell' ||
                matchedExisting.entry_type === 'redemption' ||
                Boolean(matchedExisting.sub_type && matchedExisting.sub_type.startsWith('divestment'));

              if (isDivestment) {
                const existingFundObj = pos?.holder_fund_id ? fundById.get(pos.holder_fund_id) : undefined;
                const existingHolder: CashHolderCandidate = {
                  holder_investor_id: pos?.holder_investor_id,
                  holder_fund_id: pos?.holder_fund_id,
                  holderFundManaged: existingFundObj ? existingFundObj.managed === true : false,
                };
                const existingDest = resolveProceedsTreatment({
                  entryType: matchedExisting.entry_type,
                  holder: existingHolder,
                  statedSubType:
                    matchedExisting.sub_type && !isUnresolvedDivestmentToken(matchedExisting.sub_type)
                      ? matchedExisting.sub_type
                      : null,
                }).subType;

                const incomingShareCountStr =
                  t.shareCount != null ? flAbs(toExactDecimalString(t.shareCount)) : "0.00000000";
                const incomingHasPositiveShares =
                  t.shareCount != null && flGt(incomingShareCountStr, "0.00000000");
                const incomingEntryType: FlEntryType =
                  positionKind === "fund"
                    ? incomingHasPositiveShares
                      ? "redemption"
                      : "distribution"
                    : "sell";

                const incomingDest = resolveProceedsTreatment({
                  entryType: incomingEntryType,
                  holder: holderCandidate,
                  statedSubType:
                    (t.sellProceedsDestination && !isUnresolvedDivestmentToken(t.sellProceedsDestination)
                      ? t.sellProceedsDestination
                      : null) ??
                    (t.subTypeLabel && !isUnresolvedDivestmentToken(t.subTypeLabel) ? t.subTypeLabel : null),
                }).subType;

                if (existingDest && incomingDest) {
                  if (existingDest !== incomingDest) {
                    const warningMsg = `Matching divestment on ${t.date} (${t.type}, amount ${t.valueAmount} ${t.currency || ""}) has differing proceeds treatment (existing: ${existingDest}, incoming: ${incomingDest}). Retained existing treatment without duplicating event.`;
                    catalogWarnings.push(warningMsg);
                    rowWarnings.push(warningMsg);
                  }
                }
              }

              const defaultReason = batchPostedEntryIds.has(matchedExisting.id)
                ? 'Skipped: duplicate transaction within batch or already applied'
                : 'Skipped: matching transaction already recorded in ledger';

              outcomes.push({
                submittedId,
                family: 'transaction',
                disposition: 'duplicate',
                reason: rowWarnings.length > 0
                  ? `Skipped duplicate: ${rowWarnings.join(' · ')}`
                  : defaultReason,
                assetCode: item.code,
                targetId,
                persistedId: matchedExisting.id,
                persistedTable: 'fl_ledger_entries',
                warnings: rowWarnings.length > 0 ? rowWarnings : undefined,
              });
              continue;
            }

            const allowPost = t.allowPost !== false;

            if (!allowPost) {
              outcomes.push({
                submittedId,
                family: 'transaction',
                disposition: 'stale',
                reason: 'Transaction not found in ledger (stale verify-only row)',
                assetCode: item.code,
                targetId,
                persistedId: null,
                persistedTable: null,
              });
              continue;
            }

            if (!existingTxnKeys.has(k) && allowPost) {
              let effectiveTxnSourceId: string | null = fundingSourceId;
              if (t.fundingSourceId) {
                effectiveTxnSourceId = this.resolveFundingSourceReference(t.fundingSourceId, fundingSourceMap) ?? t.fundingSourceId;
              } else if (t.fundingSource) {
                effectiveTxnSourceId = this.resolveFundingSourceReference(t.fundingSource, fundingSourceMap);
                if (!effectiveTxnSourceId) {
                  effectiveTxnSourceId = await this.resolveFundingSourceIdCached(t.fundingSource, fundingSourceMap, tx);
                }
              }

              let resolvedPostingAllocs: Array<{ funding_source_id: string; amount: string }> | undefined;
              if (t.allocations && t.allocations.length > 0) {
                resolvedPostingAllocs = [];
                for (const a of t.allocations) {
                  const rawSrc = (a.funding_source_id ?? a.fundingSourceId)!;
                  const resolvedId = this.resolveFundingSourceReference(rawSrc, fundingSourceMap);
                  if (!resolvedId) {
                    throw new FundUpdateValidationError(
                      `Cannot resolve funding source allocation reference "${rawSrc}" for transaction on ${t.date} (${t.type}): funding source does not exist in workspace.`,
                    );
                  }
                  resolvedPostingAllocs.push({
                    funding_source_id: resolvedId,
                    amount: toExactDecimalString(a.amount ?? 0),
                  });
                }
              }

              const postResult = await this.applyTxn(
                positionId,
                effectiveTxnSourceId,
                t,
                positionKind,
                options,
                tx,
                resolvedPostingAllocs,
                holderCandidate,
              );
              txns_inserted += 1;
              itemTxnsInserted += 1;
              existingTxnKeys.add(k);

              const postedEntry = postResult?.entries?.[0];
              if (postedEntry) {
                existingEntryByKey.set(k, postedEntry);
                batchPostedEntryIds.add(postedEntry.id);
                const postedAllocs = resolvedPostingAllocs && resolvedPostingAllocs.length > 0
                  ? resolvedPostingAllocs
                  : effectiveTxnSourceId
                    ? [{ funding_source_id: effectiveTxnSourceId, amount: flAbs(toExactDecimalString(t.valueAmount ?? 0)) }]
                    : [];
                entryAllocsById.set(postedEntry.id, postedAllocs);
              }

              const childLegs: SubmittedRowOutcome[] | undefined =
                postResult?.entries && postResult.entries.length > 1
                  ? postResult.entries.map((entry, idx) => ({
                      submittedId,
                      family: 'transaction',
                      disposition: 'posted',
                      reason:
                        idx === 0
                          ? 'Transaction posted to ledger'
                          : 'Balancing cash leg posted to ledger',
                      assetCode: item.code,
                      targetId: entry.position_id ?? targetId,
                      persistedId: entry.id,
                      persistedTable: 'fl_ledger_entries',
                    }))
                  : undefined;

              outcomes.push({
                submittedId,
                family: 'transaction',
                disposition: 'posted',
                reason: 'Transaction posted to ledger',
                assetCode: item.code,
                targetId,
                persistedId: postResult?.entries?.[0]?.id ?? null,
                persistedTable: 'fl_ledger_entries',
                childOutcomes: childLegs,
              });
            } else {
              outcomes.push({
                submittedId,
                family: 'transaction',
                disposition: 'duplicate',
                reason: 'Skipped: duplicate transaction within batch or already applied',
                assetCode: item.code,
                targetId,
                persistedTable: 'fl_ledger_entries',
              });
            }
          }
        }

        const fallbackValCurrency =
          item.proposed.currency?.trim() ||
          item.proposed.txns[0]?.currency ||
          txns[0]?.currency ||
          (options?.isV1 ? "" : "USD");
        const persistableSelectedVals = selectedValuations.filter(isPersistableFundUpdateValuation);
        const existingPositionMarks =
          positionId && persistableSelectedVals.length > 0
            ? await this.flValuationRepo.findByPositionIdsAndAsOfDates(
                this.workspaceId,
                [positionId],
                persistableSelectedVals.map((v) => v.asOfDate),
                tx,
              )
            : [];
        const existingMarkByDate = new Map<string, Tables<"fl_valuations">>();
        for (const mark of existingPositionMarks) {
          if (mark.as_of_date) existingMarkByDate.set(mark.as_of_date, mark);
        }

        for (const v of selectedValuations) {
          const submittedId = v.submittedId ?? `val:${item.code}:${v.asOfDate}:${v.marketValue}`;
          if (!isPersistableFundUpdateValuation(v)) {
            outcomes.push({
              submittedId,
              family: 'valuation',
              disposition: 'stale',
              reason: 'Skipped: null market value cannot be persisted to valuation ledger (unsupported mark)',
              assetCode: item.code,
              targetId,
              persistedId: null,
              persistedTable: null,
            });
            continue;
          }
          const valRecord = await this.applyValuation(
            isFundTarget,
            targetId,
            v,
            isNewlyCreated ? assetCurrency : fallbackValCurrency,
            options,
            positionId,
            tx,
            existingMarkByDate.get(v.asOfDate) ?? null,
          );
          if (valRecord?.valuation && v.asOfDate) {
            existingMarkByDate.set(v.asOfDate, valRecord.valuation);
          }
          if (valRecord?.isDuplicate) {
            outcomes.push({
              submittedId,
              family: 'valuation',
              disposition: 'duplicate',
              reason: 'Skipped: identical valuation mark already recorded in ledger',
              assetCode: item.code,
              targetId,
              persistedId: valRecord.valuation?.id ?? null,
              persistedTable: 'fl_valuations',
            });
          } else {
            valuations_upserted += 1;
            itemValuationsUpserted += 1;

            outcomes.push({
              submittedId,
              family: 'valuation',
              disposition: 'posted',
              reason: 'Valuation mark recorded in ledger',
              assetCode: item.code,
              targetId,
              persistedId: valRecord?.valuation?.id ?? null,
              persistedTable: 'fl_valuations',
            });
          }
        }

        if (!isNewlyCreated) {
          if (itemTxnsInserted > 0 || itemValuationsUpserted > 0) {
            updated_assets += 1;
          } else {
            skipped += 1;
          }
        }
      }

      return {
        applied: created_assets + created_fof_funds + updated_assets,
        created_assets,
        updated_assets,
        skipped,
        txns_inserted,
        valuations_upserted,
        created_funds,
        created_investors,
        created_sources,
        created_groups,
        ...(catalogWarnings.length > 0 ? { catalog_warnings: catalogWarnings } : {}),
        outcomes,
      };
    });
  }

  async applyCommitmentEvents(
    events: ParsedCommitmentEvent[],
    options?: {
      source?: string;
      createdBy?: string | null;
      fundCatalog?: string[];
      fundCatalogItems?: FundCatalogItem[];
      fileId?: string;
      catalogSelections?: { funds?: string[]; investors?: string[]; sources?: string[] };
      reviewResolutions?: FundUpdateReviewResolution[];
      reviewItems?: ReviewProposalItem[];
      executor?: DbClient;
    },
  ): Promise<FundUpdateCommitmentApplyResult> {
    const resolutions = options?.reviewResolutions ?? [];
    if (events.length === 0 && resolutions.length === 0) {
      return {
        events_inserted: 0,
        events_skipped_duplicate: 0,
        events_skipped: 0,
        review_items_applied: 0,
        review_items_skipped_unresolved: options?.reviewItems?.length ?? 0,
        warnings: [],
        outcomes: [],
      };
    }

    // Treat the workbook proposal as the authority for immutable transaction
    // facts. Review resolutions may supply only the human decisions needed to
    // resolve a row; they must not be able to invent a different fund, date,
    // party, or amount by modifying the approval request.
    const reviewItemByRow = new Map(
      (options?.reviewItems ?? []).map((item) => [item.sourceRow, item]),
    );
    const resolutionRows = new Set<number>();
    const sameAmount = (left: number, right: number) =>
      toExactDecimalString(left) === toExactDecimalString(right);
    const sameName = (left: string, right: string) =>
      normalizeInvestorName(left) === normalizeInvestorName(right);
    const sameFund = (left: string, right: string) =>
      left.trim().toLowerCase() === right.trim().toLowerCase();

    for (const res of resolutions) {
      if (!Number.isInteger(res.sourceRow) || res.sourceRow <= 0) {
        throw new FundUpdateValidationError(`Invalid review resolution source row: ${res.sourceRow}`);
      }
      if (resolutionRows.has(res.sourceRow)) {
        throw new FundUpdateValidationError(`Multiple review resolutions supplied for row ${res.sourceRow}.`);
      }
      resolutionRows.add(res.sourceRow);

      if (res.resolutionType === "non_cash_adjustment") {
        const source = reviewItemByRow.get(res.sourceRow);
        const isNonCashSource = source && (
          source.category === "non_cash_adjustment" ||
          source.action === "实缴调整" ||
          source.nature === "损益核销" ||
          source.direction === "非现金调整"
        );
        if (!source || !isNonCashSource || source.amount == null || !source.date) {
          throw new FundUpdateValidationError(
            `Row ${res.sourceRow} is not a resolvable non-cash adjustment from this workbook.`,
          );
        }
        if (
          !sameFund(res.fundName, source.fund) ||
          res.date !== source.date ||
          !sameAmount(res.amount, source.amount) ||
          (res.currency ?? "CNY") !== source.currency
        ) {
          throw new FundUpdateValidationError(
            `Non-cash adjustment resolution for row ${res.sourceRow} does not match the source fund, date, amount, or currency.`,
          );
        }
      } else {
        const source = reviewItemByRow.get(res.sourceRow);
        const isTransferSource = source && (
          source.action === "Commitment transfer" ||
          source.category === "truncated_transfer" ||
          source.category === "multi_party_transfer" ||
          source.category === "missing_counterparty"
        );
        if (!source || !isTransferSource || source.amount == null || !source.date || !source.investorName) {
          throw new FundUpdateValidationError(
            `Row ${res.sourceRow} is not a resolvable commitment transfer from this workbook.`,
          );
        }
        const sourceValidation = validateTransferCounterparty(source.counterpartyRaw);

        const total = res.resolutionType === "single_transfer" ? res.amount : res.totalAmount;
        if (
          !sameFund(res.fundName, source.fund) ||
          res.date !== source.date ||
          !sameName(res.transfereeName, source.investorName) ||
          !sameAmount(total, source.amount) ||
          (res.currency ?? "CNY") !== source.currency
        ) {
          throw new FundUpdateValidationError(
            `Transfer resolution for row ${res.sourceRow} does not match the source fund, date, transferee, amount, or currency.`,
          );
        }
        if (res.resolutionType === "single_transfer" && sourceValidation.isMultiParty) {
          throw new FundUpdateValidationError(
            `Multi-party transfer row ${res.sourceRow} must use a split-transfer resolution.`,
          );
        }
        if (res.resolutionType === "split_transfer" && !sourceValidation.isMultiParty) {
          throw new FundUpdateValidationError(
            `Single-counterparty transfer row ${res.sourceRow} cannot use a split-transfer resolution.`,
          );
        }
      }
    }

    let events_inserted = 0;
    let events_skipped_duplicate = 0;
    let events_skipped = 0;
    let review_items_applied = 0;
    let review_items_skipped_unresolved = 0;
    const warnings: string[] = [];
    const outcomes: SubmittedRowOutcome[] = [];

    return this.withExecutor(options?.executor, async (tx: DbClient) => {
      // When the caller supplies an explicit fund selection (two-step review),
      // the workbook catalog is NOT a create list: seeding it here created every
      // fund in the sheet even though the reviewer staged only some of them.
      // Mirror applySelected — start from what already exists and create only
      // the staged funds.
      const fundIdByName =
        options?.catalogSelections?.funds !== undefined
          ? await this.getExistingFundMap(tx)
          : await this.ensureFundCatalog(
              options?.fundCatalog,
              tx,
              "CNY",
              options?.fundCatalogItems,
              warnings,
            );

      if (options?.catalogSelections?.funds) {
        for (const rawName of options.catalogSelections.funds) {
          const clean = rawName?.trim();
          if (!clean) continue;
          const key = clean.toLowerCase();
          const normKey = normalizeCanonicalName(clean);
          if (fundIdByName.has(key) || fundIdByName.has(normKey)) continue;
          const itemMeta = options?.fundCatalogItems?.find(
            (ci) => ci.nameZh.trim().toLowerCase() === key || normalizeCanonicalName(ci.nameZh) === normKey,
          );
          const created = await this.flMasterDataService.getOrCreateFund(
            this.workspaceId,
            {
              name: clean,
              english_name: itemMeta?.nameEn?.trim() || null,
              managed: true,
              ownership_basis: "commitment",
              base_currency: "CNY",
              registration_no: itemMeta?.filingCode?.trim() || null,
            },
            tx,
          );
          fundIdByName.set(key, created.id);
          fundIdByName.set(normKey, created.id);
          fundIdByName.set(clean, created.id);
        }
      }

      // A managed fund that is a party to a commitment-path row (the LP of another
      // managed fund, or a transferor/transferee inside one) posts on the
      // fund-held position {holder_fund_id, fund_id}, never on an fl_investors row.
      // Exact canonical-name match against the managed catalog only.
      const workspaceFunds = await this.flFundRepo.findByWorkspaceId(this.workspaceId, tx);
      const managedFundKeys = buildManagedFundNameKeys([
        ...(options?.fundCatalog ?? []),
        ...(options?.fundCatalogItems ?? []).map((ci) => ci.nameZh),
        ...events.map((e) => e.fund),
        ...resolutions.map((r) => r.fundName),
        ...workspaceFunds.filter((f) => f.managed === true).map((f) => f.name),
      ]);
      const isManagedParty = (name: string | null | undefined) => isManagedFundName(name, managedFundKeys);
      const resolveManagedFundId = (name: string): string | undefined =>
        fundIdByName.get(normalizeCanonicalName(name)) ??
        fundIdByName.get(name.trim().toLowerCase()) ??
        fundIdByName.get(name.trim());

      const allInvestors = await this.flInvestorRepo.findByWorkspaceId(this.workspaceId, tx);
      const investorMap = new Map<string, { id: string; english_name: string | null }>(
        allInvestors.map((e) => [normalizeInvestorName(e.name), { id: e.id, english_name: e.english_name ?? null }]),
      );

      if (options?.catalogSelections?.investors) {
        for (const rawName of options.catalogSelections.investors) {
          const clean = rawName?.trim();
          if (!clean) continue;
          if (isManagedParty(clean)) continue;
          const key = normalizeInvestorName(clean);
          if (investorMap.has(key)) continue;
          const created = await this.flMasterDataService.createInvestor(
            this.workspaceId,
            { name: clean, investor_type: "institution" },
            tx,
          );
          investorMap.set(key, { id: created.id, english_name: created.english_name ?? null });
        }
      }

      const ensureInvestor = async (name: string, typeLabel?: string | null, englishName?: string | null) => {
        const clean = name.trim();
        const key = normalizeInvestorName(clean);
        const existing = investorMap.get(key);
        if (existing) {
          if (!existing.english_name && englishName?.trim()) {
            await this.flInvestorRepo.update(
              this.workspaceId,
              existing.id,
              { english_name: englishName.trim() },
              tx,
            );
            existing.english_name = englishName.trim();
          }
          return existing.id;
        }
        const created = await this.flMasterDataService.createInvestor(
          this.workspaceId,
          {
            name: clean,
            english_name: englishName ?? null,
            investor_type: typeLabel === "Individual Investor" ? "individual" : "institution",
          },
          tx,
        );
        investorMap.set(key, { id: created.id, english_name: created.english_name ?? null });
        return created.id;
      };

      const sortedEvents = [...events].sort((a, b) => {
        const fundCmp = a.fund.localeCompare(b.fund);
        if (fundCmp !== 0) return fundCmp;
        const invCmp = a.investorName.localeCompare(b.investorName);
        if (invCmp !== 0) return invCmp;
        const dateCmp = a.date.localeCompare(b.date);
        if (dateCmp !== 0) return dateCmp;
        return a.sourceRow - b.sourceRow;
      });

      // Ensure all transferee investors (from col 3) exist in master data.
      // Managed funds are holders, not investors.
      for (const event of sortedEvents) {
        if (isManagedParty(event.investorName)) continue;
        await ensureInvestor(event.investorName, event.investorTypeLabel, event.investorEnglishName);
      }

      type CommitmentHolder = { kind: "investor" | "fund"; id: string };
      /** Resolves (creating an outside investor when needed) the holder a row posts for. */
      const resolveHolder = async (
        name: string,
        typeLabel?: string | null,
        englishName?: string | null,
      ): Promise<CommitmentHolder | null> => {
        if (isManagedParty(name)) {
          const fundId = resolveManagedFundId(name);
          return fundId ? { kind: "fund", id: fundId } : null;
        }
        return { kind: "investor", id: await ensureInvestor(name, typeLabel, englishName) };
      };
      /** Resolves an existing holder without creating anything (transferor lookup). */
      const findHolder = (name: string): CommitmentHolder | null => {
        if (isManagedParty(name)) {
          const fundId = resolveManagedFundId(name);
          return fundId ? { kind: "fund", id: fundId } : null;
        }
        const investorId = investorMap.get(normalizeInvestorName(name))?.id;
        return investorId ? { kind: "investor", id: investorId } : null;
      };
      const unresolvedManagedHolderWarning = (name: string, fundName: string) =>
        `Cannot post for managed fund "${name.trim()}" in "${fundName.trim()}": the holder fund is not in the fund catalog or was not selected in Step 1.`;
      const selfHoldingWarning = (name: string) =>
        `Cannot post a commitment-path row where fund "${name.trim()}" holds itself.`;

      const positionCache = new Map<string, Tables<"fl_positions">>();
      const getPosition = async (holder: CommitmentHolder, fundId: string, eventDate: string) => {
        const key = `${holder.kind}:${holder.id}:::${fundId}`;
        let pos = positionCache.get(key);
        if (!pos) {
          pos = await this.flPositionService.getOrOpenPosition(
            this.workspaceId,
            holder.kind === "fund"
              ? {
                  holder_fund_id: holder.id,
                  fund_id: fundId,
                  opened_at: eventDate || null,
                }
              : {
                  holder_investor_id: holder.id,
                  fund_id: fundId,
                  opened_at: eventDate || null,
                },
            tx,
          );
          positionCache.set(key, pos);
        }
        return pos;
      };

      // A managed fund can only transfer commitment it holds. When the workbook
      // has no commitment for it in the target fund (and the ledger has none),
      // posting the transfer_out would open a fund-held position with only a
      // negative commitment — a phantom fund-of-funds holding in the transferor.
      const batchCommitmentKeys = new Set(
        events
          .filter((e) => e.intent === "increase" || e.intent === "transfer_in")
          .map((e) => `${normalizeCanonicalName(e.investorName)}|${normalizeCanonicalName(e.fund)}`),
      );
      const fundHolderHasCommitment = async (
        transferorName: string,
        holderFundId: string,
        fundName: string,
        fundId: string,
      ): Promise<boolean> => {
        if (batchCommitmentKeys.has(`${normalizeCanonicalName(transferorName)}|${normalizeCanonicalName(fundName)}`)) {
          return true;
        }
        const heldPositions = await this.flPositionRepo.findByHolderFundIds(this.workspaceId, [holderFundId], tx);
        const existing = heldPositions.find((p) => p.fund_id === fundId && !p.asset_id);
        if (!existing) return false;
        const entries = await getPositionEntries(existing.id);
        const net = entries.reduce((sum, e) => flAdd(sum, e.commitment_delta ?? "0"), "0.00000000");
        return flGt(net, "0.00000000");
      };
      const phantomTransferWarning = (transferorName: string, fundName: string, date: string) =>
        `Blocked transfer from managed fund "${transferorName.trim()}" in "${fundName.trim()}" on ${date}: it has no commitment in "${fundName.trim()}" to transfer, so the transfer-out would create a phantom fund-of-funds holding. Record ${transferorName.trim()}'s commitment first or resolve the row manually.`;

      const positionEntriesCache = new Map<string, Tables<"fl_ledger_entries">[]>();
      const getPositionEntries = async (positionId: string) => {
        let list = positionEntriesCache.get(positionId);
        if (!list) {
          list = await this.flLedgerEntryRepo.findAllByPositionIds(
            this.workspaceId,
            [positionId],
            tx,
          );
          positionEntriesCache.set(positionId, list);
        }
        return list;
      };

      const seenKeysByPosition = new Map<string, Set<string>>();
      const getSeenKeys = async (positionId: string) => {
        let keys = seenKeysByPosition.get(positionId);
        if (!keys) {
          const entries = await getPositionEntries(positionId);
          keys = new Set(
            entries.map((e) => buildLedgerEntryCommitmentDedupKey(e)),
          );
          seenKeysByPosition.set(positionId, keys);
        }
        return keys;
      };

      const seenTransferKeys = new Set<string>();
      const transferInGuard = new TransferInReplayGuard();

      const getFundId = async (fundName: string) => {
        const fundKey = fundName.trim().toLowerCase();
        let fundId = fundIdByName.get(fundKey) ?? fundIdByName.get(normalizeCanonicalName(fundName));
        if (!fundId) {
          // With an explicit selection, a fund that is not already resolved was
          // never staged in Step 1. Creating it here would silently reintroduce
          // the unapproved-fund leak, so fail loudly instead.
          if (options?.catalogSelections?.funds !== undefined) {
            throw new FundUpdateValidationError(
              `Cannot post commitment events for fund "${fundName.trim()}": it was not selected for creation in Step 1.`,
            );
          }
          const itemMeta = options?.fundCatalogItems?.find(
            (ci) => ci.nameZh.trim().toLowerCase() === fundKey,
          );
          const created = await this.flMasterDataService.createFund(
            this.workspaceId,
            {
              name: fundName.trim(),
              managed: true,
              ownership_basis: "commitment",
              base_currency: "CNY",
              registration_no: itemMeta?.filingCode || null,
            },
            tx,
          );
          fundId = created.id;
          fundIdByName.set(fundKey, fundId);
          fundIdByName.set(fundName.trim(), fundId);
        }
        return fundId;
      };

      const resolvedRows = new Set<number>();

      // 1. Process explicit review resolutions
      for (const res of resolutions) {
        if (res.resolutionType === "non_cash_adjustment") {
          if (!res.investorName?.trim()) {
            throw new FundUpdateValidationError(
              `Non-cash adjustment resolution for row ${res.sourceRow} is missing investor name.`,
            );
          }
          if (!res.fundName?.trim()) {
            throw new FundUpdateValidationError(
              `Non-cash adjustment resolution for row ${res.sourceRow} is missing fund name.`,
            );
          }
          if (!res.amount || res.amount <= 0) {
            throw new FundUpdateValidationError(
              `Non-cash adjustment resolution for row ${res.sourceRow} requires a positive amount.`,
            );
          }
          if (res.direction && res.direction !== "reduction" && res.direction !== "addition") {
            throw new FundUpdateValidationError(
              `Invalid direction "${res.direction}" for row ${res.sourceRow}`,
            );
          }

          const fundId = await getFundId(res.fundName);
          const holder = await resolveHolder(res.investorName);
          if (!holder) {
            throw new FundUpdateValidationError(unresolvedManagedHolderWarning(res.investorName, res.fundName));
          }
          if (holder.kind === "fund" && holder.id === fundId) {
            throw new FundUpdateValidationError(selfHoldingWarning(res.investorName));
          }
          const pos = await getPosition(holder, fundId, res.date);

          const amtStr = toExactDecimalString(res.amount);
          const paidInAdjustmentDelta = res.direction === "addition" ? amtStr : flNeg(amtStr);
          const subType = PAID_IN_WRITEOFF_SUBTYPE;

          let sourceRecordId: string | null = null;
          if (options?.fileId && this.flSourceRecordRepo && res.sourceRow) {
            const canonicalPayload = {
              sourceRow: res.sourceRow,
              fund: res.fundName,
              investorName: res.investorName,
              date: res.date,
              amount: res.amount,
              currency: res.currency || "CNY",
              subType,
              direction: res.direction ?? "reduction",
              action: "实缴调整",
              nature: "损益核销",
              directionRaw: "非现金调整",
              notes: res.notes ?? null,
            };
            const payloadHash = computeCanonicalHash(canonicalPayload);
            const sourceRec = await this.flSourceRecordRepo.upsertByHash(
              {
                workspace_id: this.workspaceId,
                file_id: options.fileId,
                sheet_name: "基金流水明细",
                row_number: res.sourceRow,
                raw_payload: canonicalPayload,
                payload_hash: payloadHash,
                created_by: options?.createdBy ?? null,
              },
              tx,
            );
            sourceRecordId = sourceRec.id;

            const existingEntries = await getPositionEntries(pos.id);
            if (existingEntries.some((e) => e.source_record_id === sourceRecordId)) {
              events_skipped_duplicate += 1;
              resolvedRows.add(res.sourceRow);
              outcomes.push({
                submittedId: res.submittedId ?? `review-item:${res.sourceRow}`,
                family: 'review_resolution',
                disposition: 'duplicate',
                reason: 'Skipped: non-cash adjustment already recorded in ledger (source record replay)',
                assetCode: res.fundName,
                targetId: pos.id,
                persistedTable: 'fl_ledger_entries',
              });
              continue;
            }
          }

          const adjDedupKey = buildAdjustmentDedupKey(res.date, "0.00000000", "0.00000000", paidInAdjustmentDelta);
          const seenKeys = await getSeenKeys(pos.id);
          if (seenKeys.has(adjDedupKey)) {
            events_skipped_duplicate += 1;
            resolvedRows.add(res.sourceRow);
            outcomes.push({
              submittedId: res.submittedId ?? `review-item:${res.sourceRow}`,
              family: 'review_resolution',
              disposition: 'duplicate',
              reason: 'Skipped: non-cash adjustment already recorded in ledger',
              assetCode: res.fundName,
              targetId: pos.id,
              persistedTable: 'fl_ledger_entries',
            });
            continue;
          }

          try {
            const postResult = await this.flLedgerService.postEvent(
              this.workspaceId,
              {
                event_date: res.date,
                description: res.notes ?? `Non-cash adjustment (${subType}) for ${res.investorName} in ${res.fundName}`,
                source_record_id: sourceRecordId,
                created_by: options?.createdBy ?? null,
                entries: [
                  {
                    position_id: pos.id,
                    entry_type: "adjustment",
                    sub_type: subType,
                    commitment_delta: "0.00000000",
                    quantity_delta: "0.00000000",
                    valuation_delta: paidInAdjustmentDelta,
                    cash_delta: "0.00000000",
                    currency: res.currency || "CNY",
                    notes: res.notes ?? null,
                    data_status: "verified",
                    source_record_id: sourceRecordId,
                    created_by: options?.createdBy ?? null,
                  },
                ],
              },
              tx,
            );

            events_inserted += 1;
            review_items_applied += 1;
            resolvedRows.add(res.sourceRow);
            seenKeys.add(adjDedupKey);
            outcomes.push({
              submittedId: res.submittedId ?? `review-item:${res.sourceRow}`,
              family: 'review_resolution',
              disposition: 'posted',
              reason: 'Non-cash adjustment posted to ledger',
              assetCode: res.fundName,
              targetId: pos.id,
              persistedId: postResult?.entries?.[0]?.id ?? null,
              persistedTable: 'fl_ledger_entries',
            });
            if (postResult?.entries) {
              const entriesList = await getPositionEntries(pos.id);
              entriesList.push(...postResult.entries);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `Failed to apply non-cash adjustment for "${res.investorName}" in "${res.fundName}" on ${res.date} (${res.amount} CNY): ${errMsg}`,
            );
          }
        } else if (res.resolutionType === "single_transfer") {
          if (!res.transferorName?.trim()) {
            throw new FundUpdateValidationError(
              `Single transfer resolution for row ${res.sourceRow} is missing transferor name.`,
            );
          }
          const valRes = validateTransferCounterparty(res.transferorName);
          if (!valRes.valid) {
            throw new FundUpdateValidationError(
              `Invalid transferor name "${res.transferorName}" for row ${res.sourceRow}: ${valRes.reason}`,
            );
          }
          if (!res.transfereeName?.trim()) {
            throw new FundUpdateValidationError(
              `Single transfer resolution for row ${res.sourceRow} is missing transferee name.`,
            );
          }
          if (normalizeInvestorName(res.transferorName) === normalizeInvestorName(res.transfereeName)) {
            throw new FundUpdateValidationError(
              `Transferor and transferee cannot be the same investor at row ${res.sourceRow}.`,
            );
          }
          if (!res.amount || res.amount <= 0) {
            throw new FundUpdateValidationError(
              `Single transfer resolution for row ${res.sourceRow} requires a positive amount.`,
            );
          }

          const fundId = await getFundId(res.fundName);
          const transfereeHolder = await resolveHolder(res.transfereeName);
          const transferorHolder = await resolveHolder(res.transferorName);
          if (!transfereeHolder || !transferorHolder) {
            throw new FundUpdateValidationError(
              unresolvedManagedHolderWarning(!transfereeHolder ? res.transfereeName : res.transferorName, res.fundName),
            );
          }
          for (const [holder, name] of [[transfereeHolder, res.transfereeName], [transferorHolder, res.transferorName]] as const) {
            if (holder.kind === "fund" && holder.id === fundId) {
              throw new FundUpdateValidationError(selfHoldingWarning(name));
            }
          }
          if (
            transferorHolder.kind === "fund" &&
            !(await fundHolderHasCommitment(res.transferorName, transferorHolder.id, res.fundName, fundId))
          ) {
            const warn = phantomTransferWarning(res.transferorName, res.fundName, res.date);
            events_skipped += 1;
            warnings.push(warn);
            outcomes.push({
              submittedId: res.submittedId ?? `transfer:${res.sourceRow}`,
              family: 'review_resolution',
              disposition: 'rejected',
              reason: warn,
              assetCode: res.fundName,
            });
            continue;
          }

          const transfereePos = await getPosition(transfereeHolder, fundId, res.date);
          const transferorPos = await getPosition(transferorHolder, fundId, res.date);

          const amtStr = toExactDecimalString(res.amount);
          const transferDedupKey = buildCommitmentTransferDedupKey(
            res.date,
            amtStr,
            transferorPos.id,
            transfereePos.id,
          );

          const transfereeEntries = await getPositionEntries(transfereePos.id);
          const transferorEntries = await getPositionEntries(transferorPos.id);

          const hasExistingTransfer =
            seenTransferKeys.has(transferDedupKey) ||
            transfereeEntries.some(
              (e) =>
                e.entry_type === "commitment_transfer" &&
                e.entry_date === res.date &&
                e.counterparty_position_id === transferorPos.id &&
                toExactDecimalString(e.commitment_delta ?? "0") === amtStr,
            );

          if (hasExistingTransfer) {
            events_skipped_duplicate += 1;
            resolvedRows.add(res.sourceRow);
            outcomes.push({
              submittedId: res.submittedId ?? `transfer:${res.sourceRow}`,
              family: 'review_resolution',
              disposition: 'duplicate',
              reason: 'Skipped: commitment transfer already recorded in ledger',
              assetCode: res.fundName,
              targetId: transfereePos.id,
              persistedTable: 'fl_ledger_entries',
            });
            continue;
          }

          let sourceRecordId: string | null = null;
          if (options?.fileId && this.flSourceRecordRepo && res.sourceRow) {
            const canonicalPayload = {
              sourceRow: res.sourceRow,
              fund: res.fundName,
              transfereeName: res.transfereeName,
              transferorName: res.transferorName,
              date: res.date,
              amount: res.amount,
              currency: res.currency || "CNY",
              intent: "transfer_in",
              notes: res.notes ?? null,
            };
            const payloadHash = computeCanonicalHash(canonicalPayload);
            const sourceRec = await this.flSourceRecordRepo.upsertByHash(
              {
                workspace_id: this.workspaceId,
                file_id: options.fileId,
                sheet_name: "基金流水明细",
                row_number: res.sourceRow,
                raw_payload: canonicalPayload,
                payload_hash: payloadHash,
                created_by: options?.createdBy ?? null,
              },
              tx,
            );
            sourceRecordId = sourceRec.id;

            if (transfereeEntries.some((e) => e.source_record_id === sourceRecordId)) {
              events_skipped_duplicate += 1;
              resolvedRows.add(res.sourceRow);
              outcomes.push({
                submittedId: res.submittedId ?? `transfer:${res.sourceRow}`,
                family: 'review_resolution',
                disposition: 'duplicate',
                reason: 'Skipped: commitment transfer already recorded in ledger (source record replay)',
                assetCode: res.fundName,
                targetId: transfereePos.id,
                persistedTable: 'fl_ledger_entries',
              });
              continue;
            }
          }

          try {
            const postResult = await this.flLedgerService.postEvent(
              this.workspaceId,
              {
                event_date: res.date,
                description: res.notes ?? `Commitment transfer of ${amtStr} CNY from ${res.transferorName} to ${res.transfereeName} in ${res.fundName}`,
                source_record_id: sourceRecordId,
                created_by: options?.createdBy ?? null,
                entries: [
                  {
                    position_id: transferorPos.id,
                    counterparty_position_id: transfereePos.id,
                    entry_type: "commitment_transfer",
                    sub_type: "transfer_out",
                    commitment_delta: flNeg(amtStr),
                    quantity_delta: "0.00000000",
                    valuation_delta: "0.00000000",
                    cash_delta: "0.00000000",
                    currency: res.currency || "CNY",
                    notes: res.notes ?? null,
                    data_status: "verified",
                    source_record_id: sourceRecordId,
                    created_by: options?.createdBy ?? null,
                  },
                  {
                    position_id: transfereePos.id,
                    counterparty_position_id: transferorPos.id,
                    entry_type: "commitment_transfer",
                    sub_type: "transfer_in",
                    commitment_delta: amtStr,
                    quantity_delta: "0.00000000",
                    valuation_delta: "0.00000000",
                    cash_delta: "0.00000000",
                    currency: res.currency || "CNY",
                    notes: res.notes ?? null,
                    data_status: "verified",
                    source_record_id: sourceRecordId,
                    created_by: options?.createdBy ?? null,
                  },
                ],
              },
              tx,
            );

            events_inserted += 1;
            review_items_applied += 1;
            resolvedRows.add(res.sourceRow);
            seenTransferKeys.add(transferDedupKey);
            outcomes.push({
              submittedId: res.submittedId ?? `transfer:${res.sourceRow}`,
              family: 'review_resolution',
              disposition: 'posted',
              reason: 'Commitment transfer posted to ledger',
              assetCode: res.fundName,
              targetId: transfereePos.id,
              persistedId: postResult?.entries?.[0]?.id ?? null,
              persistedTable: 'fl_ledger_entries',
            });
            if (postResult?.entries) {
              transfereeEntries.push(...postResult.entries.filter((e) => e.position_id === transfereePos.id));
              transferorEntries.push(...postResult.entries.filter((e) => e.position_id === transferorPos.id));
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `Failed to apply transfer from "${res.transferorName}" to "${res.transfereeName}" on ${res.date} (${res.amount} CNY): ${errMsg}`,
            );
          }
        } else if (res.resolutionType === "split_transfer") {
          if (!res.allocations || res.allocations.length === 0) {
            throw new FundUpdateValidationError(
              `Multi-party split transfer resolution for row ${res.sourceRow} requires at least one allocation.`,
            );
          }
          if (!res.transfereeName?.trim()) {
            throw new FundUpdateValidationError(
              `Split transfer resolution for row ${res.sourceRow} is missing transferee name.`,
            );
          }
          if (!res.totalAmount || res.totalAmount <= 0) {
            throw new FundUpdateValidationError(
              `Split transfer resolution for row ${res.sourceRow} requires positive total amount.`,
            );
          }

          let allocSum = 0;
          const allocationTransferors = new Set<string>();
          for (const alloc of res.allocations) {
            if (!alloc.transferorName?.trim()) {
              throw new FundUpdateValidationError(
                `Allocation transferor name is required for split transfer at row ${res.sourceRow}.`,
              );
            }
            const valRes = validateTransferCounterparty(alloc.transferorName);
            if (!valRes.valid) {
              throw new FundUpdateValidationError(
                `Invalid allocation transferor name "${alloc.transferorName}" at row ${res.sourceRow}: ${valRes.reason}`,
              );
            }
            if (!alloc.amount || alloc.amount <= 0) {
              throw new FundUpdateValidationError(
                `Allocation amount must be positive for split transfer at row ${res.sourceRow}.`,
              );
            }
            const transferorKey = normalizeInvestorName(alloc.transferorName);
            if (allocationTransferors.has(transferorKey)) {
              throw new FundUpdateValidationError(
                `Duplicate transferor "${alloc.transferorName}" in split transfer at row ${res.sourceRow}. Combine it into one allocation.`,
              );
            }
            if (transferorKey === normalizeInvestorName(res.transfereeName)) {
              throw new FundUpdateValidationError(
                `Transferor and transferee cannot be the same investor at row ${res.sourceRow}.`,
              );
            }
            allocationTransferors.add(transferorKey);
            allocSum += alloc.amount;
          }

          if (Math.abs(allocSum - res.totalAmount) > 0.01) {
            throw new FundUpdateValidationError(
              `Split transfer allocations sum (${allocSum}) does not equal source total amount (${res.totalAmount}) at row ${res.sourceRow}.`,
            );
          }

          const fundId = await getFundId(res.fundName);
          const transfereeHolder = await resolveHolder(res.transfereeName);
          if (!transfereeHolder) {
            throw new FundUpdateValidationError(unresolvedManagedHolderWarning(res.transfereeName, res.fundName));
          }
          if (transfereeHolder.kind === "fund" && transfereeHolder.id === fundId) {
            throw new FundUpdateValidationError(selfHoldingWarning(res.transfereeName));
          }
          const transfereePos = await getPosition(transfereeHolder, fundId, res.date);
          const transfereeEntries = await getPositionEntries(transfereePos.id);

          let splitCompleted = 0;
          const allocOutcomes: SubmittedRowOutcome[] = [];
          for (let aIdx = 0; aIdx < res.allocations.length; aIdx++) {
            const alloc = res.allocations[aIdx];
            const transferorHolder = await resolveHolder(alloc.transferorName);
            if (!transferorHolder) {
              throw new FundUpdateValidationError(unresolvedManagedHolderWarning(alloc.transferorName, res.fundName));
            }
            if (transferorHolder.kind === "fund" && transferorHolder.id === fundId) {
              throw new FundUpdateValidationError(selfHoldingWarning(alloc.transferorName));
            }
            if (
              transferorHolder.kind === "fund" &&
              !(await fundHolderHasCommitment(alloc.transferorName, transferorHolder.id, res.fundName, fundId))
            ) {
              const warn = phantomTransferWarning(alloc.transferorName, res.fundName, res.date);
              warnings.push(warn);
              allocOutcomes.push({
                submittedId: res.submittedId ?? `transfer:${res.sourceRow}`,
                family: 'review_resolution',
                disposition: 'rejected',
                reason: warn,
                assetCode: res.fundName,
                targetId: transfereePos.id,
              });
              continue;
            }
            const transferorPos = await getPosition(transferorHolder, fundId, res.date);
            const transferorEntries = await getPositionEntries(transferorPos.id);

            const allocAmtStr = toExactDecimalString(alloc.amount);
            const transferDedupKey = buildCommitmentTransferDedupKey(
              res.date,
              allocAmtStr,
              transferorPos.id,
              transfereePos.id,
            );

            const hasExistingTransfer =
              seenTransferKeys.has(transferDedupKey) ||
              transfereeEntries.some(
                (e) =>
                  e.entry_type === "commitment_transfer" &&
                  e.entry_date === res.date &&
                  e.counterparty_position_id === transferorPos.id &&
                  toExactDecimalString(e.commitment_delta ?? "0") === allocAmtStr,
              );

            if (hasExistingTransfer) {
              events_skipped_duplicate += 1;
              splitCompleted += 1;
              allocOutcomes.push({
                submittedId: res.submittedId ?? `transfer:${res.sourceRow}`,
                family: 'review_resolution',
                disposition: 'duplicate',
                reason: `Skipped: allocation transfer from "${alloc.transferorName}" already recorded in ledger`,
                assetCode: res.fundName,
                targetId: transfereePos.id,
                persistedTable: 'fl_ledger_entries',
              });
              continue;
            }

            let sourceRecordId: string | null = null;
            if (options?.fileId && this.flSourceRecordRepo && res.sourceRow) {
              const canonicalPayload = {
                sourceRow: res.sourceRow,
                allocationIndex: aIdx,
                fund: res.fundName,
                transfereeName: res.transfereeName,
                transferorName: alloc.transferorName,
                date: res.date,
                amount: alloc.amount,
                totalAmount: res.totalAmount,
                currency: res.currency || "CNY",
                intent: "transfer_in",
                notes: res.notes ?? null,
              };
              const payloadHash = computeCanonicalHash(canonicalPayload);
              const sourceRec = await this.flSourceRecordRepo.upsertByHash(
                {
                  workspace_id: this.workspaceId,
                  file_id: options.fileId,
                  sheet_name: "基金流水明细",
                  row_number: res.sourceRow,
                  raw_payload: canonicalPayload,
                  payload_hash: payloadHash,
                  created_by: options?.createdBy ?? null,
                },
                tx,
              );
              sourceRecordId = sourceRec.id;
            }

            try {
              const postResult = await this.flLedgerService.postEvent(
                this.workspaceId,
                {
                  event_date: res.date,
                  description: res.notes ?? `Commitment transfer of ${allocAmtStr} CNY from ${alloc.transferorName} to ${res.transfereeName} in ${res.fundName}`,
                  source_record_id: sourceRecordId,
                  created_by: options?.createdBy ?? null,
                  entries: [
                    {
                      position_id: transferorPos.id,
                      counterparty_position_id: transfereePos.id,
                      entry_type: "commitment_transfer",
                      sub_type: "transfer_out",
                      commitment_delta: flNeg(allocAmtStr),
                      quantity_delta: "0.00000000",
                      valuation_delta: "0.00000000",
                      cash_delta: "0.00000000",
                      currency: res.currency || "CNY",
                      notes: res.notes ?? null,
                      data_status: "verified",
                      source_record_id: sourceRecordId,
                      created_by: options?.createdBy ?? null,
                    },
                    {
                      position_id: transfereePos.id,
                      counterparty_position_id: transferorPos.id,
                      entry_type: "commitment_transfer",
                      sub_type: "transfer_in",
                      commitment_delta: allocAmtStr,
                      quantity_delta: "0.00000000",
                      valuation_delta: "0.00000000",
                      cash_delta: "0.00000000",
                      currency: res.currency || "CNY",
                      notes: res.notes ?? null,
                      data_status: "verified",
                      source_record_id: sourceRecordId,
                      created_by: options?.createdBy ?? null,
                    },
                  ],
                },
                tx,
              );

              events_inserted += 1;
              splitCompleted += 1;
              seenTransferKeys.add(transferDedupKey);
              allocOutcomes.push({
                submittedId: res.submittedId ?? `transfer:${res.sourceRow}`,
                family: 'review_resolution',
                disposition: 'posted',
                reason: `Commitment transfer allocation from "${alloc.transferorName}" posted to ledger`,
                assetCode: res.fundName,
                targetId: transfereePos.id,
                persistedId: postResult?.entries?.[0]?.id ?? null,
                persistedTable: 'fl_ledger_entries',
              });
              if (postResult?.entries) {
                transfereeEntries.push(...postResult.entries.filter((e) => e.position_id === transfereePos.id));
                transferorEntries.push(...postResult.entries.filter((e) => e.position_id === transferorPos.id));
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              throw new Error(
                `Failed to apply split transfer from "${alloc.transferorName}" to "${res.transfereeName}" on ${res.date} (${alloc.amount} CNY): ${errMsg}`,
              );
            }
          }

          // Aggregate allocation outcomes into a single business-row outcome
          const postedAllocs = allocOutcomes.filter((o) => o.disposition === 'posted');
          const dupAllocs = allocOutcomes.filter((o) => o.disposition === 'duplicate');
          const rejAllocs = allocOutcomes.filter((o) => o.disposition === 'rejected');

          let rowDisposition: SubmittedRowDisposition;
          let rowReason: string | null = null;
          if (postedAllocs.length > 0 && rejAllocs.length > 0) {
            rowDisposition = 'partial';
            const parts: string[] = [];
            if (postedAllocs.length > 0) parts.push(`${postedAllocs.length} posted`);
            if (dupAllocs.length > 0) parts.push(`${dupAllocs.length} duplicate`);
            if (rejAllocs.length > 0) parts.push(`${rejAllocs.length} rejected`);
            const failReasons = allocOutcomes
              .filter((o) => o.disposition !== 'posted' && o.reason)
              .map((o) => o.reason)
              .join('; ');
            rowReason = `Partial split transfer (${parts.join(', ')})${failReasons ? `: ${failReasons}` : ''}`;
          } else if (postedAllocs.length > 0) {
            rowDisposition = 'posted';
            rowReason = `Commitment split transfer posted to ledger (${postedAllocs.length} allocations posted${dupAllocs.length > 0 ? `, ${dupAllocs.length} duplicate` : ''})`;
          } else if (dupAllocs.length === allocOutcomes.length && allocOutcomes.length > 0) {
            rowDisposition = 'duplicate';
            rowReason = `Skipped: all split transfer allocations already recorded in ledger`;
          } else {
            rowDisposition = 'rejected';
            const failReasons = allocOutcomes
              .filter((o) => o.reason)
              .map((o) => o.reason)
              .join('; ');
            rowReason = `Split transfer failed (${rejAllocs.length} rejected${dupAllocs.length > 0 ? `, ${dupAllocs.length} duplicate` : ''})${failReasons ? `: ${failReasons}` : ''}`;
          }

          const firstPersistedId = postedAllocs[0]?.persistedId ?? null;
          const rowWarnings = rejAllocs.map((o) => o.reason as string);

          outcomes.push({
            submittedId: res.submittedId ?? `transfer:${res.sourceRow}`,
            family: 'review_resolution',
            disposition: rowDisposition,
            reason: rowReason,
            assetCode: res.fundName,
            targetId: transfereePos.id,
            persistedId: firstPersistedId,
            persistedTable: firstPersistedId ? 'fl_ledger_entries' : null,
            warnings: rowWarnings.length > 0 ? rowWarnings : undefined,
            childOutcomes: allocOutcomes,
          });

          if (splitCompleted === res.allocations.length) {
            review_items_applied += 1;
            resolvedRows.add(res.sourceRow);
          }
        }
      }

      // 2. Count unconfigured / unresolved review items
      if (options?.reviewItems) {
        for (const ri of options.reviewItems) {
          if (!resolvedRows.has(ri.sourceRow)) {
            review_items_skipped_unresolved += 1;
          }
        }
      }

      // 3. Process remaining commitment events
      for (const event of sortedEvents) {
        if (resolvedRows.has(event.sourceRow)) {
          continue;
        }
        if (event.amount == null || !Number.isFinite(event.amount)) {
          events_skipped += 1;
          const warn = `Skipping commitment event with missing/invalid amount at row ${event.sourceRow}`;
          warnings.push(warn);
          outcomes.push({
            submittedId: event.submittedId ?? `commitment:${event.sourceRow}`,
            family: 'commitment_event',
            disposition: 'rejected',
            reason: warn,
            assetCode: event.fund,
          });
          continue;
        }

        const eventAmtStr = flAbs(toExactDecimalString(event.amount));
        if (eventAmtStr === "0.00000000") {
          events_skipped += 1;
          const warn = `Skipping zero-cash commitment event for fund "${event.fund}", investor "${event.investorName}" on ${event.date}`;
          warnings.push(warn);
          outcomes.push({
            submittedId: event.submittedId ?? `commitment:${event.sourceRow}`,
            family: 'commitment_event',
            disposition: 'stale',
            reason: warn,
            assetCode: event.fund,
          });
          continue;
        }

        const fundKey = event.fund.trim().toLowerCase();
        let fundId = fundIdByName.get(fundKey) ?? fundIdByName.get(normalizeCanonicalName(event.fund));
        if (!fundId) {
          if (options?.fundCatalog !== undefined) {
            events_skipped += 1;
            const warn = `Explicit fund catalog does not contain proposed fund "${event.fund}" for event at row ${event.sourceRow}`;
            warnings.push(warn);
            outcomes.push({
              submittedId: event.submittedId ?? `commitment:${event.sourceRow}`,
              family: 'commitment_event',
              disposition: 'rejected',
              reason: warn,
              assetCode: event.fund,
            });
            continue;
          }
          const itemMeta = options?.fundCatalogItems?.find(
            (ci) => ci.nameZh.trim().toLowerCase() === fundKey,
          );
          const created = await this.flMasterDataService.createFund(
            this.workspaceId,
            {
              name: event.fund.trim(),
              english_name: event.fundEnglishName ?? itemMeta?.nameEn ?? null,
              managed: true,
              ownership_basis: "commitment",
              base_currency: "CNY",
              registration_no: itemMeta?.filingCode || null,
            },
            tx,
          );
          fundId = created.id;
          fundIdByName.set(fundKey, fundId);
          fundIdByName.set(event.fund.trim(), fundId);
        }

        const transfereeHolder = await resolveHolder(event.investorName, event.investorTypeLabel, event.investorEnglishName);
        if (!transfereeHolder || (transfereeHolder.kind === "fund" && transfereeHolder.id === fundId)) {
          events_skipped += 1;
          const warn = !transfereeHolder
            ? unresolvedManagedHolderWarning(event.investorName, event.fund)
            : selfHoldingWarning(event.investorName);
          warnings.push(warn);
          outcomes.push({
            submittedId: event.submittedId ?? (event.intent === 'transfer_in' ? `transfer:${event.sourceRow}` : `commitment:${event.sourceRow}`),
            family: 'commitment_event',
            disposition: 'rejected',
            reason: warn,
            assetCode: event.fund,
          });
          continue;
        }
        const transfereePos = await getPosition(transfereeHolder, fundId, event.date);

        // Currency guard on transferee position
        const transfereeEntries = await getPositionEntries(transfereePos.id);
        const investorLifecycleEntries = transfereeEntries.filter((e) =>
          e.entry_type === "commitment" || e.entry_type === "commitment_transfer" || e.entry_type === "paid_in" || e.entry_type === "distribution",
        );
        if (investorLifecycleEntries.length > 0 && (investorLifecycleEntries[0].currency || "USD") !== "CNY") {
          const existingCurrency = investorLifecycleEntries[0].currency || "USD";
          events_skipped += 1;
          const warn = `Existing commitment ledger for fund "${event.fund}" and investor "${event.investorName}" is in ${existingCurrency}; cannot apply CNY commitment events.`;
          warnings.push(warn);
          outcomes.push({
            submittedId: event.submittedId ?? `commitment:${event.sourceRow}`,
            family: 'commitment_event',
            disposition: 'rejected',
            reason: warn,
            assetCode: event.fund,
            targetId: transfereePos.id,
          });
          continue;
        }

        // Upsert provenance source record if fileId and sourceRow are present
        let sourceRecordId: string | null = null;
        if (options?.fileId && this.flSourceRecordRepo && event.sourceRow) {
          const canonicalPayload = {
            sourceRow: event.sourceRow,
            fund: event.fund,
            investorName: event.investorName,
            date: event.date,
            intent: event.intent,
            amount: event.amount,
            currency: event.currency,
            notes: event.notes ?? null,
            transferPairing: event.transferPairing ?? null,
            dataStatus: event.dataStatus ?? 'verified',
          };
          const payloadHash = computeCanonicalHash(canonicalPayload);
          const sourceRec = await this.flSourceRecordRepo.upsertByHash(
            {
              workspace_id: this.workspaceId,
              file_id: options.fileId,
              sheet_name: event.sourceSheet ?? "基金流水明细",
              row_number: event.sourceRow,
              raw_payload: canonicalPayload,
              payload_hash: payloadHash,
              created_by: options?.createdBy ?? null,
            },
            tx,
          );
          sourceRecordId = sourceRec.id;

          // Check if this exact source record is already attached to an entry on this position (same-file replay dedup)
          if (transfereeEntries.some((e) => e.source_record_id === sourceRecordId)) {
            events_skipped_duplicate += 1;
            outcomes.push({
              submittedId: event.submittedId ?? (event.intent === 'transfer_in' ? `transfer:${event.sourceRow}` : `commitment:${event.sourceRow}`),
              family: 'commitment_event',
              disposition: 'duplicate',
              reason: 'Skipped: commitment event already recorded in ledger (source record replay)',
              assetCode: event.fund,
              targetId: transfereePos.id,
              persistedTable: 'fl_ledger_entries',
            });
            continue;
          }
        }

        // Handle transfer_in
        if (event.intent === "transfer_in") {
          const pairing = event.transferPairing;
          const transferorName = pairing?.transferorName?.trim();

          // Keep unresolved/ambiguous transfers quarantined: without a verified
          // transferor the row cannot be told apart from an ordinary increase.
          if (
            !pairing ||
            pairing.status === "missing_counterparty" ||
            pairing.status === "ambiguous" ||
            pairing.requiresReview ||
            !pairing.eligibleForTransferOut ||
            !transferorName
          ) {
            events_skipped += 1;
            const warn = `Blocked unresolved transfer-in for fund "${event.fund}", investor "${event.investorName}" on ${event.date} (${pairing?.status ?? "unresolved"}).`;
            warnings.push(warn);
            outcomes.push({
              submittedId: event.submittedId ?? `transfer:${event.sourceRow}`,
              family: 'commitment_event',
              disposition: 'rejected',
              reason: warn,
              assetCode: event.fund,
              targetId: transfereePos.id,
            });
            continue;
          }

          // The workbook records a commitment transfer only as the transferee's
          // 受让额度 row: the transferor's original commitment and its reduction
          // are never recorded, and the catalog's fund size counts every 受让 row
          // as new commitment. So post the transferee leg alone (a commitment
          // increase tagged `transfer_in`) and keep the transferor as metadata —
          // debiting it would leave a negative commitment and understate the fund.
          // The transferee leg of a two-legged transfer from an earlier import
          // matches the same key, so a re-import does not post it twice.
          const transferKey = buildCommitmentEventDedupKey(event.intent, event.date, event.amount);
          const replay = transferInGuard.check(
            transfereePos.id,
            transferKey,
            normalizeInvestorName(transferorName),
            transfereeEntries.filter((e) => buildLedgerEntryCommitmentDedupKey(e) === transferKey).length,
          );
          if (replay === "duplicate") {
            events_skipped_duplicate += 1;
            outcomes.push({
              submittedId: event.submittedId ?? `transfer:${event.sourceRow}`,
              family: 'commitment_event',
              disposition: 'duplicate',
              reason: 'Skipped: commitment transfer already recorded in ledger',
              assetCode: event.fund,
              targetId: transfereePos.id,
              persistedTable: 'fl_ledger_entries',
            });
            continue;
          }
        }

        // Standard one-sided commitment increase / decrease / paid_in / distribution
        const entryType: FlEntryType = event.intent === "paid_in"
          ? "paid_in"
          : event.intent === "distribution"
            ? "distribution"
            : "commitment";
        const key = buildCommitmentEventDedupKey(event.intent, event.date, event.amount);
        const fallbackSubmittedId =
          event.intent === "transfer_in" ? `transfer:${event.sourceRow}` : `commitment:${event.sourceRow}`;
        const postedReason =
          event.intent === "transfer_in"
            ? "Commitment transfer (transferee leg) posted to ledger"
            : `${entryType} event posted to ledger`;

        const seenKeys = await getSeenKeys(transfereePos.id);
        // transfer_in replay was settled by transferInGuard above.
        if (event.intent !== "transfer_in" && seenKeys.has(key)) {
          events_skipped_duplicate += 1;
          outcomes.push({
            submittedId: event.submittedId ?? fallbackSubmittedId,
            family: 'commitment_event',
            disposition: 'duplicate',
            reason: `Skipped: ${entryType} event already recorded in ledger`,
            assetCode: event.fund,
            targetId: transfereePos.id,
            persistedTable: 'fl_ledger_entries',
          });
          continue;
        }

        try {
          const deltaAmount = event.intent === "decrease" ? flNeg(eventAmtStr) : eventAmtStr;
          const entry: FlLedgerEntryInput = entryType === "commitment"
            ? {
                position_id: transfereePos.id,
                entry_type: "commitment",
                ...(event.intent === "transfer_in" ? { sub_type: "transfer_in" } : {}),
                commitment_delta: deltaAmount,
                currency: "CNY",
                notes: event.notes ?? null,
                data_status: event.dataStatus ?? 'verified',
                source_record_id: sourceRecordId,
                created_by: options?.createdBy ?? null,
              }
            : entryType === "paid_in"
              ? {
                  position_id: transfereePos.id,
                  entry_type: "paid_in",
                  cash_delta: flNeg(eventAmtStr),
                  quantity_delta: "0.00000000",
                  currency: "CNY",
                  notes: event.notes ?? null,
                  data_status: event.dataStatus ?? 'verified',
                  source_record_id: sourceRecordId,
                  created_by: options?.createdBy ?? null,
                }
              : {
                  position_id: transfereePos.id,
                  entry_type: "distribution",
                  // A managed holder fund retains the proceeds: state the treatment on
                  // the row so it is persisted, not only resolved at cash-leg derivation.
                  ...(transfereeHolder.kind === "fund" ? { sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND } : {}),
                  cash_delta: eventAmtStr,
                  currency: "CNY",
                  notes: event.notes ?? null,
                  data_status: event.dataStatus ?? 'verified',
                  source_record_id: sourceRecordId,
                  created_by: options?.createdBy ?? null,
                };

          const postResult = await this.flLedgerService.postEvent(
            this.workspaceId,
            {
              event_date: event.date,
              description:
                event.notes ??
                (event.intent === "transfer_in"
                  ? `Commitment transfer of ${eventAmtStr} CNY from ${event.transferPairing?.transferorName?.trim()} to ${event.investorName} in ${event.fund}`
                  : `${entryType} for ${event.investorName} in ${event.fund}`),
              source_record_id: sourceRecordId,
              created_by: options?.createdBy ?? null,
              entries: [entry],
            },
            tx,
          );

          events_inserted += 1;
          seenKeys.add(key);
          const childLegs: SubmittedRowOutcome[] | undefined =
            postResult?.entries && postResult.entries.length > 1
              ? postResult.entries.map((entry, idx) => ({
                  submittedId: event.submittedId ?? fallbackSubmittedId,
                  family: 'commitment_event' as const,
                  disposition: 'posted' as const,
                  reason:
                    idx === 0
                      ? `${entryType} event posted to ledger`
                      : 'Balancing cash leg posted to ledger',
                  assetCode: event.fund,
                  targetId: entry.position_id ?? transfereePos.id,
                  persistedId: entry.id,
                  persistedTable: 'fl_ledger_entries',
                }))
              : undefined;

          outcomes.push({
            submittedId: event.submittedId ?? fallbackSubmittedId,
            family: 'commitment_event',
            disposition: 'posted',
            reason: postedReason,
            assetCode: event.fund,
            targetId: transfereePos.id,
            persistedId: postResult?.entries?.[0]?.id ?? null,
            persistedTable: 'fl_ledger_entries',
            childOutcomes: childLegs,
          });
          if (postResult?.entries) {
            transfereeEntries.push(...postResult.entries);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to apply commitment event for fund "${event.fund}", investor "${event.investorName}" on ${event.date} (${event.amount} CNY): ${errMsg}`,
          );
        }
      }

      return {
        events_inserted,
        events_skipped_duplicate,
        events_skipped,
        review_items_applied,
        review_items_skipped_unresolved,
        warnings,
        outcomes,
      };
    });
  }

  /**
   * For a managed → managed 投资/退出 proposal, confirms the money is recorded from
   * the target fund's book: the target's 实缴/分配 rows from the holder, in this
   * approval or already in the ledger. Totals are compared, never single rows.
   */
  private async crossBookRecordingWarnings(
    holderFundName: string,
    targetFundName: string,
    payerTxns: ParsedTxn[],
    context: {
      holderFundId: string | null;
      targetFundId: string | null;
      commitmentEvents: ParsedCommitmentEvent[];
    },
    executor: DbClient,
  ): Promise<{ all: string[]; byKind: Map<CrossBookFlowKind, string[]> }> {
    const payerTotals = new Map<CrossBookFlowKind, number>();
    for (const t of payerTxns) {
      if (t.type !== "contribution" && t.type !== "divestment") continue;
      const kind = crossBookFlowKindForTxn(t);
      payerTotals.set(kind, (payerTotals.get(kind) ?? 0) + Math.abs(t.valueAmount ?? 0));
    }
    const byKind = new Map<CrossBookFlowKind, string[]>();
    if (payerTotals.size === 0) return { all: [], byKind };

    // Receiver-side amounts keyed by the commitment dedup key, so a row that is
    // both in this approval and already in the ledger counts once.
    const recorded = new Map<CrossBookFlowKind, Map<string, number>>();
    const record = (kind: CrossBookFlowKind, key: string, amount: number) => {
      const map = recorded.get(kind) ?? new Map<string, number>();
      map.set(key, amount);
      recorded.set(kind, map);
    };
    const holderKey = normalizeCanonicalName(holderFundName);
    const targetKey = normalizeCanonicalName(targetFundName);
    for (const ev of context.commitmentEvents) {
      if (ev.intent !== "paid_in" && ev.intent !== "distribution") continue;
      if (normalizeCanonicalName(ev.investorName) !== holderKey || normalizeCanonicalName(ev.fund) !== targetKey) continue;
      record(ev.intent, buildCommitmentEventDedupKey(ev.intent, ev.date, ev.amount), Math.abs(ev.amount));
    }
    if (context.holderFundId && context.targetFundId) {
      const held = await this.flPositionRepo.findByHolderFundIds(this.workspaceId, [context.holderFundId], executor);
      const positionIds = held.filter((p) => p.fund_id === context.targetFundId && !p.asset_id).map((p) => p.id);
      const entries = positionIds.length > 0
        ? await this.flLedgerEntryRepo.findAllByPositionIds(this.workspaceId, positionIds, executor)
        : [];
      for (const e of entries) {
        if (e.entry_type !== "paid_in" && e.entry_type !== "distribution") continue;
        record(e.entry_type, buildLedgerEntryCommitmentDedupKey(e), Math.abs(Number(e.cash_delta ?? 0)));
      }
    }

    const all: string[] = [];
    for (const [kind, payerTotal] of payerTotals) {
      const receiverLabel = kind === "paid_in" ? "paid-in" : "distribution";
      const recordedTotal = [...(recorded.get(kind)?.values() ?? [])].reduce((sum, v) => sum + v, 0);
      let warning: string | null = null;
      if (recordedTotal === 0) {
        warning = `${holderFundName} → ${targetFundName} ${formatWan(payerTotal)}: recorded from ${targetFundName}'s ${receiverLabel} rows, which are not part of this import. Nothing is posted for this money until they are.`;
      } else if (Math.abs(recordedTotal - payerTotal) >= 0.01) {
        warning = `${holderFundName} → ${targetFundName}: ${formatWan(payerTotal)} in ${holderFundName}'s book but ${formatWan(recordedTotal)} in ${targetFundName}'s ${receiverLabel} rows (this import plus the ledger); ${targetFundName}'s book is posted.`;
      }
      if (warning) {
        all.push(warning);
        byKind.set(kind, [warning]);
      }
    }
    return { all, byKind };
  }

  private matchExisting(
    proposed: ParsedAsset,
    bySheet: Map<string, Tables<"fl_assets">>,
    bySourceRef: Map<string, Tables<"fl_assets">>,
    byName: Map<string, Tables<"fl_assets">>,
  ): Tables<"fl_assets"> | undefined {
    const sheetHit = bySheet.get(proposed.code.toLowerCase());
    if (sheetHit) return sheetHit;
    if (proposed.sourceRef) {
      const refHit = bySourceRef.get(proposed.sourceRef.toLowerCase());
      if (refHit) return refHit;
    }
    const nameHit =
      byName.get(normalizeCanonicalName(proposed.name)) ??
      byName.get(proposed.name.trim().toLowerCase());
    if (nameHit) return nameHit;
    if (proposed.legalName) {
      const legalHit =
        byName.get(normalizeCanonicalName(proposed.legalName)) ??
        byName.get(proposed.legalName.trim().toLowerCase());
      if (legalHit) return legalHit;
    }
    return undefined;
  }

  private async ensureFundCatalog(
    catalog?: string[],
    executor?: DbClient,
    baseCurrency = "USD",
    catalogItems?: FundCatalogItem[],
    warnings?: string[],
  ): Promise<Map<string, string>> {
    const isExplicit = catalog !== undefined;
    const names = catalog ?? [
      ...FUND_CATALOG,
      ...(catalogItems ?? []).map((ci) => ci.nameZh),
    ];
    const existing = await this.flFundRepo.findByWorkspaceId(this.workspaceId, executor);
    const byName = new Map<string, Tables<"fl_funds">>();
    for (const f of existing) {
      const norm = normalizeCanonicalName(f.name);
      if (norm) byName.set(norm, f);
      const lower = f.name.trim().toLowerCase();
      if (lower) byName.set(lower, f);
    }
    const catalogItemByName = new Map<string, FundCatalogItem>();
    for (const ci of catalogItems ?? []) {
      const norm = normalizeCanonicalName(ci.nameZh);
      if (norm) catalogItemByName.set(norm, ci);
      const lower = ci.nameZh.trim().toLowerCase();
      if (lower) catalogItemByName.set(lower, ci);
    }

    const out = new Map<string, string>();
    for (const name of names) {
      const normKey = normalizeCanonicalName(name);
      const lowerKey = name.toLowerCase();
      const hit = byName.get(normKey) ?? byName.get(lowerKey);
      const itemMeta = catalogItemByName.get(normKey) ?? catalogItemByName.get(lowerKey);
      const filingCode = itemMeta?.filingCode?.trim() || null;
      const englishName = itemMeta?.nameEn?.trim() || null;

      if (hit) {
        out.set(lowerKey, hit.id);
        out.set(normKey, hit.id);
        out.set(name, hit.id);

        // Persist catalog filingCode and englishName to managed fl_funds on match
        if (hit.managed && (filingCode || englishName)) {
          const updates: { registration_no?: string; english_name?: string } = {};
          if (filingCode && !hit.registration_no) {
            updates.registration_no = filingCode;
            hit.registration_no = filingCode;
          } else if (filingCode && hit.registration_no && hit.registration_no.trim() !== filingCode) {
            warnings?.push(
              `Registration number conflict for fund "${hit.name}": existing "${hit.registration_no}" does not match catalog filing code "${filingCode}". Not overwritten.`,
            );
          }
          if (englishName && !hit.english_name) {
            updates.english_name = englishName;
            hit.english_name = englishName;
          }
          if (Object.keys(updates).length > 0) {
            await this.flFundRepo.update(this.workspaceId, hit.id, updates, executor);
          }
        }
      } else {
        const created = await this.flMasterDataService.getOrCreateFund(
          this.workspaceId,
          {
            name,
            english_name: englishName,
            managed: true,
            ownership_basis: "commitment",
            base_currency: baseCurrency,
            registration_no: filingCode,
          },
          executor,
        );
        out.set(lowerKey, created.id);
        out.set(normKey, created.id);
        out.set(name, created.id);
        byName.set(lowerKey, created);
        byName.set(normKey, created);
      }
    }
    if (!isExplicit) {
      for (const f of existing) {
        const normKey = normalizeCanonicalName(f.name);
        const lowerKey = f.name.toLowerCase();
        if (!out.has(lowerKey) && !out.has(normKey)) {
          out.set(lowerKey, f.id);
          out.set(normKey, f.id);
          out.set(f.name, f.id);
          const itemMeta = catalogItemByName.get(normKey) ?? catalogItemByName.get(lowerKey);
          const filingCode = itemMeta?.filingCode?.trim() || null;
          const englishName = itemMeta?.nameEn?.trim() || null;
          if (f.managed && (filingCode || englishName)) {
            const updates: { registration_no?: string; english_name?: string } = {};
            if (filingCode && !f.registration_no) {
              updates.registration_no = filingCode;
              f.registration_no = filingCode;
            } else if (filingCode && f.registration_no && f.registration_no.trim() !== filingCode) {
              warnings?.push(
                `Registration number conflict for fund "${f.name}": existing "${f.registration_no}" does not match catalog filing code "${filingCode}". Not overwritten.`,
              );
            }
            if (englishName && !f.english_name) {
              updates.english_name = englishName;
              f.english_name = englishName;
            }
            if (Object.keys(updates).length > 0) {
              await this.flFundRepo.update(this.workspaceId, f.id, updates, executor);
            }
          }
        }
      }
    }
    return out;
  }

  private async getExistingFundMap(executor?: DbClient): Promise<Map<string, string>> {
    const existing = await this.flFundRepo.findByWorkspaceId(this.workspaceId, executor);
    const out = new Map<string, string>();
    for (const fund of existing) {
      const norm = normalizeCanonicalName(fund.name);
      if (norm) out.set(norm, fund.id);
      out.set(fund.name.trim().toLowerCase(), fund.id);
      out.set(fund.name, fund.id);
    }
    return out;
  }

  private async ensureGroupInvestors(
    groupNames: Iterable<string>,
    executor?: DbClient,
    onCreated?: () => void,
  ): Promise<Map<string, string>> {
    const existing = await this.flInvestorRepo.findByWorkspaceId(this.workspaceId, executor);
    const byName = new Map<string, Tables<"fl_investors">>();
    for (const inv of existing) {
      const norm = normalizeCanonicalName(inv.name);
      if (norm) byName.set(norm, inv);
      const lower = inv.name.trim().toLowerCase();
      if (lower) byName.set(lower, inv);
    }

    const out = new Map<string, string>();
    for (const name of groupNames) {
      const clean = name?.trim();
      if (!clean) continue;
      const normKey = normalizeCanonicalName(clean);
      const lowerKey = clean.toLowerCase();

      if (out.has(lowerKey) || (normKey && out.has(normKey))) continue;

      const hit = (normKey ? byName.get(normKey) : undefined) ?? byName.get(lowerKey);
      if (hit) {
        out.set(lowerKey, hit.id);
        if (normKey) out.set(normKey, hit.id);
        out.set(clean, hit.id);
      } else {
        const created = await this.flMasterDataService.getOrCreateInvestor(
          this.workspaceId,
          {
            name: clean,
            investor_type: "internal_entity",
          },
          executor,
        );
        onCreated?.();
        out.set(lowerKey, created.id);
        if (normKey) out.set(normKey, created.id);
        out.set(clean, created.id);
        byName.set(lowerKey, created);
        if (normKey) byName.set(normKey, created);
      }
    }
    return out;
  }

  private async resolveInvestorIdCached(
    name: string | null,
    cache: Map<string, string>,
    executor?: DbClient,
    onCreated?: () => void,
  ): Promise<string | null> {
    if (!name) return null;
    const clean = name.trim();
    const key = clean.toLowerCase();
    const normKey = normalizeCanonicalName(clean);
    const hit = (normKey ? cache.get(normKey) : undefined) ?? cache.get(key);
    if (hit) return hit;
    const created = await this.flMasterDataService.getOrCreateInvestor(
      this.workspaceId,
      { name: clean, investor_type: "institution" },
      executor,
    );
    cache.set(key, created.id);
    if (normKey) cache.set(normKey, created.id);
    onCreated?.();
    return created.id;
  }

  resolveFundingSourceReference(
    rawRef: string | null | undefined,
    fundingSourceMap: Map<string, string>,
  ): string | null {
    if (!rawRef) return null;
    const clean = rawRef.trim();
    if (!clean) return null;
    if (fundingSourceMap.has(clean)) return fundingSourceMap.get(clean)!;
    const lower = clean.toLowerCase();
    if (fundingSourceMap.has(lower)) return fundingSourceMap.get(lower)!;
    const norm = normalizeCanonicalName(clean);
    if (norm && fundingSourceMap.has(norm)) return fundingSourceMap.get(norm)!;
    if (clean.startsWith('source:')) {
      const withoutPrefix = clean.replace(/^source:/, '').trim();
      if (fundingSourceMap.has(withoutPrefix)) return fundingSourceMap.get(withoutPrefix)!;
      if (fundingSourceMap.has(withoutPrefix.toLowerCase())) return fundingSourceMap.get(withoutPrefix.toLowerCase())!;
      const normWithout = normalizeCanonicalName(withoutPrefix);
      if (normWithout && fundingSourceMap.has(normWithout)) return fundingSourceMap.get(normWithout)!;
    }
    return null;
  }

  private resolveInvestorId(
    name: string | null | undefined,
    investorMap: Map<string, string>,
  ): string | null {
    if (!name) return null;
    const clean = name.trim();
    if (!clean) return null;
    return investorMap.get(clean) ?? investorMap.get(normalizeCanonicalName(clean)) ?? investorMap.get(clean.toLowerCase()) ?? null;
  }

  private async resolveFundingSourceIdCached(
    name: string | null,
    cache: Map<string, string>,
    executor?: DbClient,
  ): Promise<string | null> {
    if (!name) return null;
    const clean = name.trim();
    const key = clean.toLowerCase();
    const normKey = normalizeCanonicalName(clean);
    const hit = cache.get(clean) ?? (normKey ? cache.get(normKey) : undefined) ?? cache.get(key);
    if (hit) return hit;
    const created = await this.flMasterDataService.getOrCreateFundingSource(
      this.workspaceId,
      { name: clean },
      executor,
    );
    cache.set(created.id, created.id);
    cache.set(key, created.id);
    if (normKey) cache.set(normKey, created.id);
    cache.set(clean, created.id);
    return created.id;
  }

  private async createAsset(
    a: ParsedAsset,
    options?: { isV1?: boolean; fileId?: string },
    isSourceSelected: boolean = true,
    executor?: DbClient,
  ): Promise<Tables<"fl_assets">> {
    const rawCurrency = a.currency?.trim() || a.txns[0]?.currency?.trim();
    if (options?.isV1 && !rawCurrency) {
      throw new FundUpdateValidationError(`Cannot create asset "${a.name}" with unresolved currency.`);
    }
    const currency = rawCurrency || (options?.isV1 ? "" : "USD");
    return this.flMasterDataService.getOrCreateAsset(
      this.workspaceId,
      {
        asset_kind: "equity",
        name: a.name,
        legal_name: a.legalName,
        english_name: a.englishName ?? null,
        country: a.country,
        sector: a.sector,
        sub_sector: a.subSector,
        instrument_terms: {
          sheetCode: a.code,
          sourceRef: a.sourceRef ?? null,
          investmentTypeLabel: a.assetType === "fund_of_funds" ? "Fund of Funds" : a.investmentTypeLabel ?? null,
          fundingSource: isSourceSelected ? a.fundingSourceRaw : null,
          entryDate: a.entryDate ?? null,
          commitmentAmount: safeExactDecimalString(a.commitmentAmount),
          mgmtFeeRatePct: a.mgmtFeeRatePct ?? null,
          currentPricePerShare: safeExactDecimalString(a.currentPricePerShare),
          sharesOutstanding: safeExactDecimalString(a.sharesOutstanding),
          dealType: a.dealType ?? null,
          instrument: a.instrument ?? null,
          vintageYear: a.vintageYear ?? null,
          entity: a.entity ?? null,
          currency,
        },
      },
      executor,
    );
  }

  private async applyTxn(
    positionId: string,
    fundingSourceId: string | null,
    t: ParsedTxn,
    positionKind: FundUpdatePositionKind,
    options?: { isV1?: boolean; fileId?: string },
    executor?: DbClient,
    resolvedAllocations?: Array<{ funding_source_id: string; amount: string }>,
    holder: CashHolderCandidate | null = null,
  ): Promise<{ event: Tables<"fl_business_events">; entries: Tables<"fl_ledger_entries">[] }> {
    const rawCurrency = t.currency?.trim();
    if (options?.isV1 && !rawCurrency) {
      throw new FundUpdateValidationError("Cannot insert transaction with unresolved currency in v1 apply.");
    }
    const currency = rawCurrency || (options?.isV1 ? "" : "USD");

    const mapped = mapFundUpdateTxn(t, positionKind, holder);
    const fxRateStr = t.fxRate != null ? toExactDecimalString(t.fxRate) : null;
    const amountStr = flAbs(mapped.cashDelta);

    const allocations = resolvedAllocations && resolvedAllocations.length > 0
      ? resolvedAllocations
      : t.allocations && t.allocations.length > 0
        ? t.allocations.map((a) => ({
            funding_source_id: (a.funding_source_id ?? a.fundingSourceId)!,
            amount: toExactDecimalString(a.amount ?? 0),
          }))
        : fundingSourceId
          ? [{ funding_source_id: fundingSourceId, amount: amountStr }]
          : undefined;

    let sourceRecordId: string | null = null;
    const sourceRow = (t as { sourceRow?: number }).sourceRow;
    if (options?.fileId && this.flSourceRecordRepo && sourceRow) {
      const canonicalPayload = {
        positionId,
        sourceSheet: t.sourceSheet ?? null,
        sourceRow,
        date: t.date,
        type: t.type,
        subTypeLabel: t.subTypeLabel ?? null,
        valueAmount: t.valueAmount,
        shareCount: t.shareCount ?? null,
        pricePerShare: t.pricePerShare ?? null,
        currency,
        notes: t.notes ?? null,
      };
      const payloadHash = computeCanonicalHash(canonicalPayload);
      const record = await this.flSourceRecordRepo.upsertByHash(
        {
          workspace_id: this.workspaceId,
          file_id: options.fileId,
          sheet_name: t.sourceSheet ?? "基金流水明细",
          row_number: sourceRow,
          raw_payload: canonicalPayload,
          payload_hash: payloadHash,
        },
        executor,
      );
      sourceRecordId = record.id;
    }

    return await this.flLedgerService.postEvent(
      this.workspaceId,
      {
        event_date: t.date,
        description: `${t.type} on position`,
        source_record_id: sourceRecordId,
        entries: [
          {
            position_id: positionId,
            entry_type: mapped.entryType,
            sub_type: mapped.subType,
            cash_delta: mapped.cashDelta,
            quantity_delta: mapped.quantityDelta,
            price_per_unit: mapped.pricePerUnit,
            currency,
            fx_rate: fxRateStr,
            notes: t.notes ?? null,
            data_status: t.dataStatus ?? 'verified',
            source_record_id: sourceRecordId,
            allocations,
          },
        ],
      },
      executor,
    );
  }

  private async applyValuation(
    isFundOfFunds: boolean,
    targetId: string,
    v: ParsedValuation,
    fallbackCurrency: string = "USD",
    options?: { isV1?: boolean; fileId?: string },
    positionId?: string | null,
    executor?: DbClient,
    preloadedExisting?: Tables<"fl_valuations"> | null,
  ): Promise<{ valuation: Tables<"fl_valuations">; isDuplicate?: boolean } | undefined> {
    // Workbook marks are always position-scoped (Q4). The applySelected guard must
    // have blocked unresolved holders; never fall back to asset/fund scope here.
    if (!positionId) {
      throw new FundUpdateValidationError(
        "Cannot record workbook valuation without resolved investor-position scope.",
      );
    }

    const rawCurrency = fallbackCurrency?.trim();
    if (options?.isV1 && !rawCurrency) {
      throw new FundUpdateValidationError("Cannot insert valuation with unresolved currency in v1 apply.");
    }
    const currency = rawCurrency || (options?.isV1 ? "" : "USD");
    const marketValueStr = toExactDecimalString(v.marketValue);
    const grossValueStr = v.investedCapitalCum !== undefined
      ? safeExactDecimalString(v.investedCapitalCum)
      : undefined;
    const pricePerUnitStr = v.pricePerShare !== undefined
      ? safeExactDecimalString(v.pricePerShare)
      : undefined;
    const unitsOutstandingStr = v.sharesOutstanding !== undefined
      ? safeExactDecimalString(v.sharesOutstanding)
      : undefined;
    const valuationMethod = v.valuationMethod !== undefined
      ? (v.valuationMethod ? mapValuationMethod(v.valuationMethod) : null)
      : undefined;

    let sourceRecordId: string | null = null;
    if (options?.fileId && this.flSourceRecordRepo && v.sourceRow) {
      const canonicalPayload = {
        positionId,
        targetId,
        targetKind: isFundOfFunds ? 'fund' : 'asset',
        sourceSheet: v.sourceSheet ?? null,
        sourceRow: v.sourceRow,
        asOfDate: v.asOfDate,
        marketValue: v.marketValue,
        pricePerShare: v.pricePerShare ?? null,
        sharesOutstanding: v.sharesOutstanding ?? null,
        valuationMethod: v.valuationMethod ?? null,
        currency,
      };
      const record = await this.flSourceRecordRepo.upsertByHash({
        workspace_id: this.workspaceId,
        file_id: options.fileId,
        sheet_name: v.sourceSheet ?? 'Market Value Tracker',
        row_number: v.sourceRow,
        raw_payload: canonicalPayload,
        payload_hash: computeCanonicalHash(canonicalPayload),
      }, executor);
      sourceRecordId = record.id;
    }

    // Preserve non-native source metrics in notes without losing user notes
    const meta: Record<string, unknown> = {};
    if (v.periodLabel) meta.period_label = v.periodLabel;
    if (v.shareholdingPct != null) meta.shareholding_pct = v.shareholdingPct;
    if (v.investedCapitalCum != null) meta.invested_capital_cum = safeExactDecimalString(v.investedCapitalCum);
    if (v.grossMoic != null) meta.gross_moic = v.grossMoic;
    if (v.grossXirr != null) meta.gross_xirr = v.grossXirr;

    let combinedNotes: string | null | undefined = undefined;
    const userNotes = v.notes !== undefined ? (v.notes !== null ? v.notes.trim() : null) : undefined;
    const hasMeta = Object.keys(meta).length > 0;
    if (userNotes !== undefined) {
      if (userNotes && hasMeta) {
        combinedNotes = `${userNotes} | source_meta: ${JSON.stringify(meta)}`;
      } else if (userNotes) {
        combinedNotes = userNotes;
      } else if (hasMeta) {
        combinedNotes = `source_meta: ${JSON.stringify(meta)}`;
      } else {
        combinedNotes = null;
      }
    } else if (hasMeta) {
      combinedNotes = `source_meta: ${JSON.stringify(meta)}`;
    }

    const valuationInput = {
      position_id: positionId,
      as_of_date: v.asOfDate,
      market_value: marketValueStr,
      currency,
      valuation_method: valuationMethod ?? null,
      price_per_unit: pricePerUnitStr ?? null,
      units_outstanding: unitsOutstandingStr ?? null,
      gross_value: grossValueStr ?? null,
      notes: combinedNotes ?? null,
      data_status: v.dataStatus ?? 'verified',
      source_record_id: sourceRecordId,
    };

    // Correction identity: same position + date + currency (+ scope). A same
    // position/date mark in a different currency is an explicit conflict.
    // Newest upload wins on value change; no history is retained (Q11).
    const existing =
      preloadedExisting !== undefined
        ? (preloadedExisting ?? undefined)
        : (
            await this.flValuationRepo.findByPositionIdsAndAsOfDates(
              this.workspaceId,
              [positionId],
              [v.asOfDate],
              executor,
            )
          ).find((row) => row.position_id === positionId && row.as_of_date === v.asOfDate);

    if (existing) {
      const normCurrency = (c: string | null | undefined) => (c || "").trim().toUpperCase();
      const currencyMatch = normCurrency(existing.currency) === normCurrency(currency);

      if (!currencyMatch) {
        throw new FundUpdateValidationError(
          `Valuation currency conflict for position ${positionId} as of ${v.asOfDate}: existing mark is ${existing.currency ?? "unknown"}, incoming is ${currency || "unknown"}.`,
        );
      }

      const decimalMatch = (
        existingVal: string | number | null | undefined,
        incomingVal: string | number | null | undefined,
      ): boolean => {
        if (incomingVal === undefined) return true;
        if (incomingVal === null) return existingVal == null;
        if (existingVal == null) return false;
        return toExactDecimalString(existingVal) === toExactDecimalString(incomingVal);
      };

      const notesMatch = (
        existingNotes: string | null | undefined,
        incomingNotes: string | null | undefined,
      ): boolean => {
        if (incomingNotes === undefined) return true;
        const normExisting = existingNotes?.trim() || null;
        const normIncoming = incomingNotes?.trim() || null;
        return normExisting === normIncoming;
      };

      const methodMatch = (
        existingMethod: string | null | undefined,
        incomingMethod: string | null | undefined,
      ): boolean => {
        if (incomingMethod === undefined) return true;
        const normExisting = existingMethod || null;
        const normIncoming = incomingMethod || null;
        return normExisting === normIncoming;
      };

      const dataStatusMatch = (existingStatus: string | null | undefined, incomingStatus: string): boolean => {
        return (existingStatus || "verified") === (incomingStatus || "verified");
      };

      const isIdentical =
        decimalMatch(existing.market_value, marketValueStr) &&
        methodMatch(existing.valuation_method, valuationMethod) &&
        decimalMatch(existing.price_per_unit, pricePerUnitStr) &&
        decimalMatch(existing.units_outstanding, unitsOutstandingStr) &&
        decimalMatch(existing.gross_value, grossValueStr) &&
        notesMatch(existing.notes, combinedNotes) &&
        dataStatusMatch(existing.data_status, v.dataStatus ?? 'verified');

      if (isIdentical) {
        return { valuation: existing, isDuplicate: true };
      }

      const valuationUpdates: UpdateValuationInput = {
        as_of_date: v.asOfDate,
        market_value: marketValueStr,
        currency,
        valuation_method: valuationMethod !== undefined ? valuationMethod : (existing.valuation_method ?? null),
        price_per_unit: pricePerUnitStr !== undefined ? pricePerUnitStr : (existing.price_per_unit ?? null),
        units_outstanding: unitsOutstandingStr !== undefined ? unitsOutstandingStr : (existing.units_outstanding ?? null),
        gross_value: grossValueStr !== undefined ? grossValueStr : (existing.gross_value ?? null),
        notes: combinedNotes !== undefined ? combinedNotes : (existing.notes ?? null),
        data_status: (v.dataStatus ?? 'verified') as any,
        source_record_id: sourceRecordId,
      };

      const updated = await this.flValuationService.update(
        this.workspaceId,
        existing.id,
        valuationUpdates,
        executor,
      );
      return { valuation: updated ?? existing, isDuplicate: false };
    } else {
      const created = await this.flValuationService.record(this.workspaceId, valuationInput, executor);
      return { valuation: created, isDuplicate: false };
    }
  }
}
