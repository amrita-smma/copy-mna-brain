import type {
  ReviewEntity,
  ReviewTransaction,
  ReviewValuation,
} from "./types";
import {
  validateTransferCounterparty,
  classifyFundUpdateTxn,
  SUPPORTED_CLASSIFICATION_TYPES,
} from "@/lib/fund_updates";

const RESOLVABLE_RAW_TYPES = new Set(['other', 'others', 'unknown']);

/**
 * True when the reviewer has explicitly reclassified an originally unresolved row
 * (Other / Others / Unknown) into a concrete supported economic type.
 */
/**
 * True when a review row expands into a resolution panel.
 *
 * Transfers and non-cash adjustments are the two kinds that carry one. Both the
 * expand affordance and the detail row read this, so a row can never show a
 * chevron it cannot open, or open into nothing.
 */
export function reviewRowIsExpandable(
  txn: Pick<ReviewTransaction, "isTransfer" | "isNonCashAdjustment">,
): boolean {
  return Boolean(txn.isTransfer || txn.isNonCashAdjustment);
}

export function isReviewerResolvedType(txn: {
  type?: string | null;
  rawTxn?: { type?: string | null } | null;
}): boolean {
  const rawType = (txn.rawTxn?.type ?? '').trim().toLowerCase();
  if (!RESOLVABLE_RAW_TYPES.has(rawType)) return false;
  return SUPPORTED_CLASSIFICATION_TYPES.has((txn.type ?? '').trim().toLowerCase());
}

const ESTIMATED_REGEX = /\b(estimate|estimated|accrual|forecast|provisional|tentative)\b/i;
const CONTRADICTORY_REGEX = /\b(refund|reversal|rebate|clawback|offset)\b/i;

export interface ValidationEntityLike {
  key: string;
  name: string;
  status: string;
  isStaged?: boolean;
}

export interface TransactionValidationResult {
  status: "actionable" | "duplicate" | "blocked";
  blockReason: string | null;
  isResolved: boolean;
}

/**
 * Pure transaction validation function.
 * Evaluates both:
 * 1. Step 1 entity dependencies (required From and To must be present and staged).
 * 2. Ambiguous event resolution (transfers and non-cash adjustments must have valid resolution fields).
 */
export function validateTransactionStatus(
  txn: ReviewTransaction,
  entityMap: Map<string, ValidationEntityLike> | Record<string, ValidationEntityLike>,
): TransactionValidationResult {
  if (txn.status === "duplicate") {
    return {
      status: "duplicate",
      blockReason: "Already in the ledger — skipped",
      isResolved: false,
    };
  }

  const getEntity = (key: string | null | undefined): ValidationEntityLike | undefined => {
    if (!key) return undefined;
    if (entityMap instanceof Map) return entityMap.get(key);
    return entityMap[key];
  };

  const isStaged = (ent: ValidationEntityLike | undefined): boolean => {
    if (!ent) return false;
    return ent.status === "matched" || ent.isStaged !== false;
  };

  // 1. Validate required From entity
  if (!txn.fromKey || !txn.fromKey.trim()) {
    return {
      status: "blocked",
      blockReason: "Required From entity is missing",
      isResolved: false,
    };
  }

  const fromEntity = getEntity(txn.fromKey);
  if (!fromEntity) {
    return {
      status: "blocked",
      blockReason: `Required From entity "${txn.fromKey}" is missing`,
      isResolved: false,
    };
  }
  if (!isStaged(fromEntity)) {
    return {
      status: "blocked",
      blockReason: `${fromEntity.name || txn.fromKey} is not being added in Step 1`,
      isResolved: false,
    };
  }

  // 2. Validate required To entity
  if (!txn.toKey || !txn.toKey.trim()) {
    return {
      status: "blocked",
      blockReason: "Required To entity is missing",
      isResolved: false,
    };
  }

  const toEntity = getEntity(txn.toKey);
  if (!toEntity) {
    return {
      status: "blocked",
      blockReason: `Required To entity "${txn.toKey}" is missing`,
      isResolved: false,
    };
  }
  if (!isStaged(toEntity)) {
    return {
      status: "blocked",
      blockReason: `${toEntity.name || txn.toKey} is not being added in Step 1`,
      isResolved: false,
    };
  }

  // 3. Validate Non-Cash Adjustments
  if (txn.isNonCashAdjustment) {
    if (!txn.nonCashState?.enabled) {
      return {
        status: "blocked",
        blockReason: "Non-cash adjustment requires review resolution",
        isResolved: false,
      };
    }
    const invName = txn.nonCashState?.investorName?.trim();
    const dir = txn.nonCashState?.direction;
    const subType = txn.nonCashState?.subType?.trim();

    if (!invName || !dir || !subType) {
      return {
        status: "blocked",
        blockReason: "Non-cash adjustment requires a valid investor, direction, and subtype",
        isResolved: false,
      };
    }

    return {
      status: "actionable",
      blockReason: null,
      isResolved: true,
    };
  }

  // 4. Validate Transfers (Single and Multi-Party)
  if (txn.isTransfer) {
    if (txn.isMultiPartyTransfer) {
      const allocs = txn.allocations ?? [];
      if (allocs.length === 0) {
        return {
          status: "blocked",
          blockReason: "Multi-party transfer requires split allocations to be configured",
          isResolved: false,
        };
      }

      let totalAlloc = 0;
      for (const alloc of allocs) {
        const tName = alloc.transferorName?.trim();
        if (!tName) {
          return {
            status: "blocked",
            blockReason: "Each split allocation must have a non-blank transferor name",
            isResolved: false,
          };
        }
        const valRes = validateTransferCounterparty(tName);
        if (!valRes.valid) {
          return {
            status: "blocked",
            blockReason: valRes.reason || `Invalid transferor "${tName}" in allocation`,
            isResolved: false,
          };
        }
        const amt = typeof alloc.amount === "number" ? alloc.amount : Number(alloc.amount);
        if (!amt || !isFinite(amt) || amt <= 0) {
          return {
            status: "blocked",
            blockReason: `Each allocation must have a positive amount`,
            isResolved: false,
          };
        }
        totalAlloc += amt;
      }

      const expected =
        txn.amount ??
        txn.commitDelta ??
        txn.cashDelta ??
        txn.rawCommitmentEvent?.amount ??
        txn.rawReviewItem?.amount ??
        0;

      if (expected > 0 && Math.abs(totalAlloc - expected) > 0.01) {
        return {
          status: "blocked",
          blockReason: `Multi-party transfer allocations sum (${totalAlloc}) does not match expected amount (${expected})`,
          isResolved: false,
        };
      }

      return {
        status: "actionable",
        blockReason: null,
        isResolved: true,
      };
    }

    // Single Transfer
    // Review-item transfers carry an explicit resolution state and require a
    // user edit. Deterministically paired commitment events do not: their
    // verified transferor lives in transferPairing metadata.
    if (txn.singleTransferState && !txn.singleTransferState.enabled) {
      return {
        status: "blocked",
        blockReason: "Transfer requires review resolution",
        isResolved: false,
      };
    }
    const transferorName =
      txn.singleTransferState?.transferorName?.trim() ||
      txn.rawCommitmentEvent?.transferPairing?.transferorName?.trim() ||
      (txn.fromKey.startsWith("investor:")
        ? txn.fromKey.replace(/^investor:/, "").trim()
        : "");

    if (!transferorName) {
      return {
        status: "blocked",
        blockReason: "Transfer requires a valid transferor name",
        isResolved: false,
      };
    }

    const valRes = validateTransferCounterparty(transferorName);
    if (!valRes.valid) {
      return {
        status: "blocked",
        blockReason: valRes.reason || "Invalid transferor name",
        isResolved: false,
      };
    }

    return {
      status: "actionable",
      blockReason: null,
      isResolved: Boolean(txn.singleTransferState?.enabled),
    };
  }

  // 5. Check for estimated / projected transactions
  const descriptor = `${txn.subTypeLabel || ''} ${txn.notes || ''} ${txn.subType || ''}`.trim();
  const isEstimated =
    (descriptor && ESTIMATED_REGEX.test(descriptor)) ||
    Boolean(txn.blockReason && /estimate|projection/i.test(txn.blockReason)) ||
    Boolean(txn.rawTxn && classifyFundUpdateTxn(txn.rawTxn).isEstimated);

  // A reviewer who reclassified the row into a concrete supported type has supplied the
  // actual-event policy, so the estimate wording no longer blocks it.
  if (isEstimated && !isReviewerResolvedType(txn)) {
    return {
      status: "blocked",
      blockReason: txn.blockReason || `Estimated transaction ("${descriptor}") is a projection/estimate and requires resolution before cash posting`,
      isResolved: false,
    };
  }

  // 6. Check for contradictory positive fee-refund
  const signedCash =
    txn.cashDelta != null
      ? txn.cashDelta
      : txn.rawTxn?.valueAmount != null
        ? Number(txn.rawTxn.valueAmount)
        : null;

  const isPositive = signedCash != null && signedCash > 0;
  const isNegative = signedCash != null && signedCash < 0;

  const hasContradictory = Boolean(descriptor && CONTRADICTORY_REGEX.test(descriptor));
  if (hasContradictory && isPositive) {
    return {
      status: "blocked",
      blockReason: txn.blockReason || `Contradictory or uncertain descriptors on positive receipt ("${descriptor}") require resolution before posting`,
      isResolved: false,
    };
  }

  // 7. Check for unresolved 'other' or 'unknown'
  const rawType = (txn.type ?? '').trim().toLowerCase();
  if (rawType === 'other' || rawType === 'others') {
    const classification = classifyFundUpdateTxn({
      type: txn.type,
      subTypeLabel: txn.subTypeLabel,
      notes: txn.notes,
      valueAmount: txn.cashDelta != null ? txn.cashDelta : txn.amount,
    });
    if (classification.isUnresolved) {
      return {
        status: "blocked",
        blockReason: txn.blockReason || classification.unresolvedReason || 'Unexplained "Other" transaction requires classification before posting',
        isResolved: false,
      };
    }
  }

  if (rawType === 'unknown') {
    return {
      status: "blocked",
      blockReason: txn.blockReason || `Unknown transaction type "${txn.type}" requires resolution before posting`,
      isResolved: false,
    };
  }

  // 8. Check direction compatibility
  const isInflowType = rawType === 'income' || rawType === 'sell' || rawType === 'distribution';
  const isOutflowType = rawType === 'expense' || rawType === 'buy' || rawType === 'paid_in';

  if (isNegative && isInflowType) {
    return {
      status: "blocked",
      blockReason: `Cannot classify negative cash transaction as inflow type "${txn.type}"`,
      isResolved: false,
    };
  }

  if (isPositive && isOutflowType) {
    return {
      status: "blocked",
      blockReason: `Cannot classify positive cash transaction as outflow type "${txn.type}"`,
      isResolved: false,
    };
  }

  // 9. Normal actionable transaction
  const isResolvedOther =
    (txn.rawTxn?.type?.toLowerCase() === 'other' || txn.rawTxn?.type?.toLowerCase() === 'others') &&
    rawType !== 'other';

  return {
    status: "actionable",
    blockReason: null,
    isResolved: Boolean(txn.isResolved || isResolvedOther),
  };
}

/**
 * Pure helper to apply an in-cell or configuration update to a transaction,
 * managing the live blocked <-> actionable state transition and selection.
 *
 * Rules:
 * - Transition from blocked -> actionable auto-selects the row once (selected = true).
 * - Transition to blocked deselects the row (selected = false).
 * - Actionable -> actionable preserves the user's manual selection choice.
 */
export function applyTransactionUpdate(
  prevTxn: ReviewTransaction,
  updates: Partial<ReviewTransaction>,
  entityMap: Map<string, ValidationEntityLike> | Record<string, ValidationEntityLike>,
): ReviewTransaction {
  const merged: ReviewTransaction = {
    ...prevTxn,
    ...updates,
  };

  if (updates.type !== undefined) {
    const isOutflow = updates.type === 'expense' || updates.type === 'buy' || updates.type === 'paid_in';
    const isInflow = updates.type === 'income' || updates.type === 'sell' || updates.type === 'distribution';
    if (updates.cashDelta === undefined) {
      const numAmt = Math.abs(merged.amount ?? merged.cashDelta ?? 0);
      if (isOutflow) {
        merged.cashDelta = -numAmt;
      } else if (isInflow) {
        merged.cashDelta = numAmt;
      }
    }
  }

  const validation = validateTransactionStatus(merged, entityMap);
  const wasBlocked = prevTxn.status === "blocked";
  const isNowActionable = validation.status === "actionable";
  const isNowBlocked = validation.status === "blocked";

  let nextSelected = prevTxn.selected;
  if (updates.selected !== undefined) {
    nextSelected = updates.selected;
  } else if (wasBlocked && isNowActionable) {
    // Unblocked by valid resolution / edit -> auto-select once
    nextSelected = true;
  } else if (isNowBlocked) {
    // Blocked / invalid -> deselect
    nextSelected = false;
  }

  return {
    ...merged,
    status: validation.status,
    blockReason: validation.blockReason,
    isResolved: validation.isResolved,
    selected: validation.status === "actionable" ? nextSelected : false,
  };
}

/**
 * Pure helper to recompute all transactions and valuations when Step 1 staging changes.
 */
export function recomputeTransactionsAndValuations(
  currentTxns: ReviewTransaction[],
  currentVals: ReviewValuation[],
  entityMap: Map<string, ValidationEntityLike> | Record<string, ValidationEntityLike>,
): {
  transactions: ReviewTransaction[];
  valuations: ReviewValuation[];
} {
  const getEntity = (key: string | null | undefined): ValidationEntityLike | undefined => {
    if (!key) return undefined;
    if (entityMap instanceof Map) return entityMap.get(key);
    return entityMap[key];
  };

  const isStaged = (ent: ValidationEntityLike | undefined): boolean => {
    if (!ent) return false;
    return ent.status === "matched" || ent.isStaged !== false;
  };

  const transactions = currentTxns.map((txn) => {
    if (txn.status === "duplicate") return txn;
    const validation = validateTransactionStatus(txn, entityMap);
    const wasBlocked = txn.status === "blocked";
    const isNowActionable = validation.status === "actionable";
    const isNowBlocked = validation.status === "blocked";

    let nextSelected = txn.selected;
    if (wasBlocked && isNowActionable) {
      nextSelected = true;
    } else if (isNowBlocked) {
      nextSelected = false;
    }

    return {
      ...txn,
      status: validation.status,
      blockReason: validation.blockReason,
      isResolved: validation.isResolved,
      selected: validation.status === "actionable" ? nextSelected : false,
    };
  });

  const valuations = currentVals.map((val) => {
    if (val.status === "duplicate") return val;
    const targetKey = val.targetKey || `asset:${val.assetCode}`;
    const fundKey = `fund:${val.assetCode}`;
    const targetEntity = getEntity(targetKey) || getEntity(fundKey) || getEntity(val.assetCode);

    let isBlocked = false;
    let blockReason: string | null = null;

    if (!targetEntity) {
      isBlocked = true;
      blockReason = `Required valuation target "${val.assetCode}" is missing`;
    } else if (!isStaged(targetEntity)) {
      isBlocked = true;
      blockReason = `${targetEntity.name || val.assetCode} is not being added in Step 1`;
    }

    if (!isBlocked) {
      if (val.holderKey === "") {
        isBlocked = true;
        blockReason =
          val.blockReason ||
          `Valuation for "${val.assetName || val.assetCode}" as of ${val.asOfDate || "unknown date"} requires a holder; missing holder cannot become an instrument-wide mark.`;
      } else if (val.holderKey !== undefined) {
        const holderEntity = getEntity(val.holderKey);
        if (!holderEntity) {
          isBlocked = true;
          blockReason = `Required valuation holder "${val.holderKey}" is missing`;
        } else if (!isStaged(holderEntity)) {
          isBlocked = true;
          blockReason = `${holderEntity.name || val.holderKey} is not being added in Step 1`;
        }
      }
    }

    // Preserve unrelated blocking semantics: if the valuation was blocked for a
    // reason not related to target or holder staging, keep it blocked.
    if (!isBlocked && val.status === "blocked") {
      const isStagingReason =
        val.blockReason &&
        (val.blockReason.includes("is not being added in Step 1") ||
          val.blockReason.includes("missing or deselected in Step 1") ||
          val.blockReason.includes("Required valuation target") ||
          val.blockReason.includes("Required valuation holder") ||
          val.blockReason.includes("requires target") ||
          val.blockReason.includes("requires holder"));
      if (!isStagingReason) {
        isBlocked = true;
        blockReason = val.blockReason;
      }
    }

    const wasBlocked = val.status === "blocked";
    const isNowActionable = !isBlocked;

    let nextSelected = val.selected;
    if (wasBlocked && isNowActionable) {
      nextSelected = true;
    } else if (isBlocked) {
      nextSelected = false;
    }

    return {
      ...val,
      status: isBlocked ? ("blocked" as const) : ("actionable" as const),
      blockReason,
      selected: isBlocked ? false : nextSelected,
    };
  });

  return { transactions, valuations };
}
