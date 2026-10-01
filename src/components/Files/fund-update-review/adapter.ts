import type {
  FundUpdateReviewData,
  FundUpdateTwoStepReview,
  ReviewEntity,
  ReviewOption,
  ReviewTransaction,
  ReviewValuation,
} from "./types";
import type { FundUpdateApplyResult } from "@/lib/services/fundUpdateApplyService";

/**
 * Validates and deep-clones the canonical server-normalized review model.
 * The server normalizer (twoStepReview.ts) is authoritative.
 */
export function extractTwoStepReview(data: FundUpdateReviewData): FundUpdateTwoStepReview {
  if (!data?.two_step_review) {
    throw new Error("Invalid review data: missing canonical two_step_review payload");
  }

  const entities: ReviewEntity[] = (data.two_step_review.entities ?? []).map((e) => ({
    ...e,
    fields: [...(e.fields ?? [])],
    links: [...(e.links ?? [])],
    isStaged: e.status === "matched" ? true : (e.isStaged ?? true),
  }));

  const transactions: ReviewTransaction[] = (data.two_step_review.transactions ?? []).map((t) => ({
    ...t,
    allocations: t.allocations ? t.allocations.map((a) => ({ ...a })) : undefined,
    singleTransferState: t.singleTransferState ? { ...t.singleTransferState } : undefined,
    nonCashState: t.nonCashState ? { ...t.nonCashState } : undefined,
    legs: t.legs ? t.legs.map((l) => ({ ...l })) : undefined,
    selected: t.status === "actionable" ? (t.selected ?? true) : false,
  }));

  const valuations: ReviewValuation[] = (data.two_step_review.valuations ?? []).map((v) => ({
    ...v,
    selected: v.status === "actionable" ? (v.selected ?? true) : false,
  }));

  const reconciliation = [...(data.two_step_review.reconciliation ?? [])];

  return {
    entities,
    transactions,
    valuations,
    reconciliation,
  };
}

/**
 * Returns selectable entity options for transaction From / To / Source selectors.
 */
export function getEntityOptions(
  entities: ReviewEntity[],
  targetKind: "from" | "to" | "source" | "all" = "all",
): ReviewOption[] {
  const opts: ReviewOption[] = [];

  for (const e of entities) {
    if (targetKind === "source") {
      if (e.tab === "source") {
        opts.push({
          key: e.key,
          name: e.name + (e.status === "new" ? " (New)" : ""),
          englishName: e.englishName ?? null,
          group: "Sources of Fund",
          isNew: e.status === "new",
        });
      }
    } else {
      let group = "Assets";
      if (e.tab === "fund") group = "Funds";
      if (e.tab === "investor") group = "Investors";
      if (e.tab === "source") group = "Sources of Fund";

      opts.push({
        key: e.key,
        name: e.name + (e.status === "new" ? " (New)" : ""),
        englishName: e.englishName ?? null,
        group,
        isNew: e.status === "new",
      });
    }
  }

  return opts;
}

/**
 * Builds the canonical FundUpdateTwoStepApproval payload for final submission.
 */
export function buildApprovePayload({
  entities,
  transactions,
  valuations,
}: {
  entities: ReviewEntity[];
  transactions: ReviewTransaction[];
  valuations: ReviewValuation[];
}) {
  const entityDecisions = entities.map((e) => {
    let action: "use_existing" | "create" | "omit" =
      e.status === "matched" ? "use_existing" : e.isStaged ? "create" : "omit";
    if (e.isRemapped && e.remappedTo) {
      action = e.remappedTo.isNew ? "create" : "use_existing";
    }
    return {
      key: e.key,
      action,
      matchedId: (e.isRemapped && e.remappedTo ? e.remappedTo.id : e.matchedId) ?? undefined,
      remappedName: e.isRemapped && e.remappedTo ? e.remappedTo.name : undefined,
    };
  });

  const transactionDecisions = transactions
    .filter((t) => t.selected && t.status === "actionable")
    .map((t) => ({
      id: t.id,
      edits: {
        type: t.type,
        subType: t.nonCashState?.subType ?? t.subType,
        subTypeLabel: t.subTypeLabel,
        notes: t.notes,
        date: t.date,
        amount: t.amount ?? undefined,
        currency: t.currency,
        pricePerShare: t.pricePerShare,
        quantityDelta: t.quantityDelta,
        cashDelta: t.cashDelta,
        transferorName: t.singleTransferState?.transferorName,
        allocations: t.allocations?.map((allocation) => ({
          transferorName: allocation.transferorName,
          amount: Number(allocation.amount),
        })),
        investorName: t.nonCashState?.investorName,
        direction: t.nonCashState?.direction,
        // Send a destination only when one is actually stated (from the source or set by
        // the reviewer). An unmarked sale sends nothing, so apply posts exactly what it
        // would have without this field.
        ...(t.sellProceedsDestination != null
          ? { sellProceedsDestination: t.sellProceedsDestination }
          : {}),
      },
    }));

  const valuationDecisions = valuations
    .filter((v) => v.selected && v.status === "actionable")
    .map((v) => ({
      id: v.id,
      edits: {
        asOfDate: v.asOfDate,
        marketValue: v.marketValue,
        pricePerShare: v.pricePerShare,
        sharesOutstanding: v.sharesOutstanding,
        shareholdingPct: v.shareholdingPct,
        valuationMethod: v.valuationMethod,
        notes: v.notes,
      },
    }));

  return {
    file_type: "fund_updates" as const,
    matched_company_id: null,
    two_step_approval: {
      entityDecisions,
      transactions: transactionDecisions,
      valuations: valuationDecisions,
    },
  };
}

export interface ApprovalFeedback {
  type: "success" | "warning";
  message: string;
  warningDetail?: string;
}

/**
 * Produces truthful, inspectable feedback from FundUpdateApplyResult and its per-row outcomes.
 * A zero-posted result emits a warning explaining why all rows were skipped, never a generic success message.
 */
export function formatApprovalFeedback(result: FundUpdateApplyResult): ApprovalFeedback {
  const outcomes = result.outcomes ?? [];
  const postedCount = outcomes.filter((o) => o.disposition === "posted").length;
  const duplicateCount = outcomes.filter((o) => o.disposition === "duplicate").length;
  const staleCount = outcomes.filter((o) => o.disposition === "stale").length;
  const rejectedCount = outcomes.filter((o) => o.disposition === "rejected").length;
  const partialCount = outcomes.filter((o) => o.disposition === "partial").length;

  const totalPosted =
    outcomes.length > 0
      ? postedCount + partialCount
      : (result.txns_inserted ?? 0) +
        (result.valuations_upserted ?? 0) +
        (result.commitment_events_inserted ?? 0);

  if (outcomes.length > 0 && totalPosted === 0) {
    const reasons: string[] = [];
    if (duplicateCount > 0) reasons.push(`${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}`);
    if (staleCount > 0) reasons.push(`${staleCount} unsupported/stale`);
    if (rejectedCount > 0) reasons.push(`${rejectedCount} rejected`);
    const summary = reasons.length > 0 ? reasons.join(", ") : "no changes to post";

    const details = Array.from(
      new Set([
        ...outcomes
          .filter((o) => o.disposition !== "posted" && o.reason)
          .map((o) => o.reason as string),
        ...outcomes
          .flatMap((o) => o.childOutcomes ?? [])
          .filter((c) => c.disposition !== "posted" && c.reason)
          .map((c) => c.reason as string),
      ]),
    ).slice(0, 2);

    return {
      type: "warning",
      message: `No new rows posted: all ${outcomes.length} row${outcomes.length === 1 ? " was" : "s were"} skipped (${summary})`,
      warningDetail: details.length > 0 ? details.join(" · ") : undefined,
    };
  }

  const parts: string[] = [];
  if (result.applied > 0 || result.txns_inserted > 0 || result.valuations_upserted > 0) {
    parts.push(
      `Applied ${result.applied} assets (+${result.txns_inserted} txns, +${result.valuations_upserted} vals)`,
    );
  }
  if (result.commitment_events_inserted && result.commitment_events_inserted > 0) {
    parts.push(`${result.commitment_events_inserted} commitment events posted`);
  }
  if (result.review_items_applied && result.review_items_applied > 0) {
    parts.push(`${result.review_items_applied} review items resolved & posted`);
  }

  const createdParts: string[] = [];
  if ((result.created_funds ?? 0) > 0) createdParts.push(`${result.created_funds} funds`);
  if ((result.created_investors ?? 0) > 0) createdParts.push(`${result.created_investors} investors`);
  if ((result.created_sources ?? 0) > 0) createdParts.push(`${result.created_sources} sources`);
  if (createdParts.length > 0) parts.push(`Created ${createdParts.join(", ")}`);

  let warningDetail: string | undefined = undefined;
  const skippedCount = duplicateCount + staleCount + rejectedCount;
  if (outcomes.length > 0 && (skippedCount > 0 || partialCount > 0)) {
    const skipReasons: string[] = [];
    if (partialCount > 0) skipReasons.push(`${partialCount} partial`);
    if (duplicateCount > 0) skipReasons.push(`${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}`);
    if (staleCount > 0) skipReasons.push(`${staleCount} unsupported/stale`);
    if (rejectedCount > 0) skipReasons.push(`${rejectedCount} rejected`);
    const details = Array.from(
      new Set([
        ...outcomes
          .filter((o) => o.disposition !== "posted" && o.reason)
          .map((o) => o.reason as string),
        ...outcomes
          .flatMap((o) => o.childOutcomes ?? [])
          .filter((c) => c.disposition !== "posted" && c.reason)
          .map((c) => c.reason as string),
      ]),
    ).slice(0, 2);

    if (partialCount > 0 && skippedCount === 0) {
      warningDetail = `${partialCount} row${partialCount === 1 ? "" : "s"} partially posted (${skipReasons.join(", ")})${details.length > 0 ? `: ${details.join(" · ")}` : ""}`;
    } else if (partialCount > 0) {
      warningDetail = `${skippedCount + partialCount} row${(skippedCount + partialCount) === 1 ? "" : "s"} skipped or partial (${skipReasons.join(", ")})${details.length > 0 ? `: ${details.join(" · ")}` : ""}`;
    } else {
      warningDetail = `${skippedCount} row${skippedCount === 1 ? "" : "s"} skipped (${skipReasons.join(", ")})${details.length > 0 ? `: ${details.join(" · ")}` : ""}`;
    }
  } else {
    const skipped = result.commitment_events_skipped ?? 0;
    const warnings: string[] = result.commitment_event_warnings ?? [];
    if (skipped > 0 || warnings.length > 0) {
      const detail = warnings.slice(0, 3).join(" · ");
      warningDetail = `${skipped} commitment row${skipped === 1 ? "" : "s"} were not posted${detail ? `: ${detail}` : ""}`;
    }
  }

  // Post-import check of the written ledger (advisory). Posting differences
  // lead; differences the review step already flagged are only counted.
  const catalogWarnings = result.catalog_check?.warnings ?? [];
  const catalogDetails: string[] = [];
  if (catalogWarnings.length > 0) {
    const more = catalogWarnings.length > 2 ? ` (+${catalogWarnings.length - 2} more)` : "";
    catalogDetails.push(
      `${catalogWarnings.length} posting difference${catalogWarnings.length === 1 ? "" : "s"} in the written ledger: ${catalogWarnings.slice(0, 2).join(" · ")}${more}`,
    );
  }
  const flaggedInReview =
    result.catalog_check?.differences?.filter((d) => d.kind === "review").length ?? 0;
  if (flaggedInReview > 0) {
    catalogDetails.push(
      `${flaggedInReview} difference${flaggedInReview === 1 ? "" : "s"} against 基金汇总 already flagged in review`,
    );
  }
  const uncheckedFunds = result.catalog_check?.skipped_funds?.length ?? 0;
  if (uncheckedFunds > 0) {
    catalogDetails.push(`${uncheckedFunds} fund${uncheckedFunds === 1 ? "" : "s"} not checked (partial import)`);
  }
  if (catalogDetails.length > 0) {
    const catalogDetail = catalogDetails.join(" · ");
    warningDetail = warningDetail ? `${warningDetail} · ${catalogDetail}` : catalogDetail;
  }

  return {
    type: "success",
    message: parts.length > 0 ? parts.join(" · ") : "Fund update approved",
    warningDetail,
  };
}
