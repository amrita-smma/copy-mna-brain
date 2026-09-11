"use client";

import React, { useMemo, useState, useEffect, useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Split,
  Trash2,
  Plus,
  AlertTriangle,
  CheckCircle2,
  Info,
} from "lucide-react";
import type { ReviewOption, ReviewTransaction } from "./types";
import { formatMoney, formatMoneyExact, formatPrice, formatQty } from "./constants";
import { reviewRowIsExpandable } from "./validation";

import { entryTypeSpec, splitBilingual } from "@/lib/fundLedger";
import { validateTransferCounterparty } from "@/lib/fund_updates";
import { cn } from "@/lib/utils";
import { ReasonCell } from "./ReasonCell";
import {
  Chevron,
  FlowArrow,
  LedgerBadge,
  signClass,
} from "@/components/ledger/LedgerPrimitives";
import { compareSortValues, SortableHeader, type SortDirection } from "./SortableHeader";
import {
  SELL_PROCEEDS_DESTINATIONS,
  type SellProceedsDestination,
} from "@/lib/sellProceedsDestination";

/**
 * Clicks on these never toggle a row open or shut — they belong to the control
 * the reviewer aimed at. `[role="combobox"]` covers the Radix select triggers,
 * which render as buttons but are worth naming so the intent survives an
 * upgrade.
 */
const ROW_TOGGLE_IGNORES =
  'input, button, select, textarea, label, a, [role="combobox"], [role="checkbox"]';

/** Width the expanded resolution panel is sized by — the scroll container's. */
const DETAIL_WIDTH_VAR = "--review-detail-width";

type TransactionSortKey =
  | "date" | "from" | "to" | "source" | "type" | "subType"
  | "commitDelta" | "quantityDelta" | "pricePerShare" | "cashDelta" | "position";

const PROCEEDS_DESTINATION_LABELS: Record<SellProceedsDestination, string> = {
  cash_in_fund: "Cash in fund",
  distributed_to_investor: "Distributed",
};

function isDivestmentReviewRow(txn: ReviewTransaction): boolean {
  const type = (txn.type ?? "").trim().toLowerCase();
  return type === "sell" || type === "divestment";
}

export function CounterpartyCell({
  entityKey,
  entityOptions,
}: {
  entityKey: string;
  entityOptions: ReviewOption[];
}) {
  const option = entityOptions.find((o) => o.key === entityKey);
  const rawDisplayName =
    option?.name || (entityKey.includes(":") ? entityKey.split(":").slice(1).join(":") : entityKey);

  const split = splitBilingual(rawDisplayName);
  const primaryName = split.zh || rawDisplayName;
  const rawEnglish = option?.englishName || split.en || null;
  const englishName = rawEnglish?.trim() || null;

  const isDifferent =
    Boolean(englishName) &&
    englishName!.toLowerCase() !== primaryName.trim().toLowerCase();

  return (
    <div className="min-w-0 max-w-full">
      <span className="truncate block font-medium text-foreground text-xs" title={primaryName}>
        {primaryName}
      </span>
      {isDifferent && (
        <span className="truncate block text-[10px] text-muted-foreground leading-tight" title={englishName!}>
          {englishName}
        </span>
      )}
    </div>
  );
}

interface TransactionsTableProps {
  transactions: ReviewTransaction[];
  entityOptions: ReviewOption[];
  sourceOptions: ReviewOption[];
  onToggleSelect: (id: string, selected: boolean) => void;
  onUpdateTxn: (id: string, updates: Partial<ReviewTransaction>) => void;
  readOnly?: boolean;
}

export function TransactionsTable({
  transactions,
  entityOptions,
  sourceOptions,
  onToggleSelect,
  onUpdateTxn,
  readOnly = false,
}: TransactionsTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: TransactionSortKey; direction: SortDirection } | null>(null);

  const toggleSort = (key: TransactionSortKey) => {
    setSort((current) => ({
      key,
      direction: current?.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const sortedTransactions = useMemo(() => {
    if (!sort) return transactions;
    const entityName = (key: string) => entityOptions.find((option) => option.key === key)?.name ?? key;
    const sourceName = (key: string | null) => key ? sourceOptions.find((option) => option.key === key)?.name ?? key : null;
    const value = (txn: ReviewTransaction): string | number | null | undefined => {
      switch (sort.key) {
        case "from": return entityName(txn.fromKey);
        case "to": return entityName(txn.toKey);
        case "source": return sourceName(txn.srcKey);
        case "position": return txn.status === "duplicate" ? "skipped" : txn.status === "blocked" ? "blocked" : txn.isResolved ? "resolved" : txn.positionRef ?? "new";
        default: return txn[sort.key];
      }
    };
    return transactions
      .map((txn, index) => ({ txn, index }))
      .sort((a, b) => compareSortValues(value(a.txn), value(b.txn), sort.direction) || a.index - b.index)
      .map(({ txn }) => txn);
  }, [entityOptions, sort, sourceOptions, transactions]);

  // The expanded resolution panel is sized to the visible width of the scroll
  // container rather than to the sheet, so it stays put and stays readable
  // while the columns behind it scroll sideways — the same treatment the Ledger
  // page's SheetTable gives its detail rows. Measured off this wrapper, which
  // is a `w-full` block inside the scrolling flex column and so shares that
  // container's visible width, rather than assumed: the dialog resizes.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const measure = () => setViewportWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function toggleExpand(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div
        ref={wrapperRef}
        className="w-full"
        style={
          viewportWidth === null
            ? undefined
            : ({ [DETAIL_WIDTH_VAR]: `${viewportWidth}px` } as React.CSSProperties)
        }
      >
      <table className="w-full min-w-[1500px] border-collapse text-xs">
        <thead className="sticky top-0 z-20 bg-muted shadow-sm">
          <tr className="border-b border-border bg-muted text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="w-10 px-3 py-2 text-center"></th>
            <th className="w-12 px-2 py-2 text-center">#</th>
            <SortableHeader className="w-28 px-3 py-2 text-left" active={sort?.key === "date"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("date")}>Date</SortableHeader>
            <SortableHeader className="w-44 px-3 py-2 text-left" active={sort?.key === "from"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("from")}>From</SortableHeader>
            <th className="w-6 px-1 py-2 text-center"></th>
            <SortableHeader className="w-44 px-3 py-2 text-left" active={sort?.key === "to"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("to")}>To</SortableHeader>
            <SortableHeader className="w-36 px-3 py-2 text-left" active={sort?.key === "source"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("source")}>Source</SortableHeader>
            <SortableHeader className="w-36 px-3 py-2 text-left" active={sort?.key === "type"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("type")}>Type</SortableHeader>
            <SortableHeader className="w-32 px-3 py-2 text-left" active={sort?.key === "subType"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("subType")}>Sub-type</SortableHeader>
            <SortableHeader className="w-28 px-3 py-2 text-right" active={sort?.key === "commitDelta"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("commitDelta")}>Commit Δ</SortableHeader>
            <SortableHeader className="w-28 px-3 py-2 text-right" active={sort?.key === "quantityDelta"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("quantityDelta")}>Qty Δ</SortableHeader>
            <SortableHeader className="w-24 px-3 py-2 text-right" active={sort?.key === "pricePerShare"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("pricePerShare")}>Price</SortableHeader>
            <SortableHeader className="min-w-[190px] px-3 py-2 text-right whitespace-nowrap" active={sort?.key === "cashDelta"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("cashDelta")}>Cash Δ</SortableHeader>
            <SortableHeader className="w-24 px-3 py-2 text-center whitespace-nowrap" active={sort?.key === "position"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("position")}>Position</SortableHeader>
            <th className="w-[220px] px-3 py-2 text-left">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {transactions.length === 0 ? (
            <tr>
              <td colSpan={15} className="py-12 text-center text-xs text-muted-foreground">
                No transactions found in this sheet.
              </td>
            </tr>
          ) : (
            sortedTransactions.map((txn, index) => {
              const isExpanded = expandedRows.has(txn.id);
              const isExpandable = reviewRowIsExpandable(txn);
              const isDuplicate = txn.status === "duplicate";
              const isBlocked = txn.status === "blocked";
              const canEditDate = !readOnly && !isDuplicate && !isBlocked;

              const typeDef = entryTypeSpec(txn.type);
              const rawType = (txn.rawTxn?.type ?? txn.type ?? "").toLowerCase();
              const descriptor = `${txn.subTypeLabel || ''} ${txn.notes || ''} ${txn.subType || ''}`.trim();
              const isEstimated =
                (descriptor && /\b(estimate|estimated|accrual|forecast|provisional|tentative)\b/i.test(descriptor)) ||
                Boolean(txn.blockReason && /estimate|projection/i.test(txn.blockReason));
              const isOtherRow =
                !txn.isTransfer &&
                !txn.isNonCashAdjustment &&
                (rawType === "other" || rawType === "others" || txn.type === "other" || txn.isResolved);
              const isNegative =
                (txn.cashDelta != null && txn.cashDelta < 0) ||
                (txn.rawTxn?.valueAmount != null && Number(txn.rawTxn.valueAmount) < 0) ||
                (txn.amount != null && (txn.type === "expense" || txn.type === "buy" || txn.type === "paid_in"));

              return (
                <React.Fragment key={txn.id}>
                  <tr
                    className={cn(
                      "transition-colors",
                      !isBlocked && "hover:bg-muted/30",
                      isExpandable && "cursor-pointer",
                      isDuplicate && "bg-muted/40 opacity-60 text-muted-foreground",
                      isBlocked && "bg-destructive/10 border-l-2 border-destructive hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-destructive/70",
                    )}
                    title={txn.blockReason ?? undefined}
                    onClick={
                      isExpandable
                        ? (event) => {
                            // Every control in the row keeps its own click: the
                            // select checkbox, the date picker, the type and
                            // destination selects. Only dead space toggles, so
                            // editing a field can never collapse the panel the
                            // reviewer is working in.
                            if (
                              (event.target as HTMLElement | null)?.closest(
                                ROW_TOGGLE_IGNORES,
                              )
                            ) {
                              return;
                            }
                            // Selecting one of these long legal names ends in a
                            // click on the row; copying a name must not collapse
                            // the panel.
                            if (window.getSelection()?.toString()) return;
                            toggleExpand(txn.id);
                          }
                        : undefined
                    }
                  >
                    {/* Checkbox */}
                    <td className="px-3 py-1.5 text-center">
                      <Checkbox
                        checked={isDuplicate ? false : txn.selected}
                        disabled={isDuplicate || isBlocked || readOnly}
                        onCheckedChange={(c) => onToggleSelect(txn.id, Boolean(c))}
                        aria-label={`Select transaction row ${index + 1}`}
                      />
                    </td>

                    {/* Sequential Row # */}
                    <td className="px-2 py-1.5 text-center font-mono text-[11px] text-muted-foreground">
                      <div className="flex items-center justify-center gap-1">
                        {isExpandable ? (
                          <button
                            type="button"
                            onClick={() => toggleExpand(txn.id)}
                            className="text-muted-foreground hover:text-foreground p-0.5"
                          >
                            <Chevron open={isExpanded} />
                          </button>
                        ) : null}
                        <span>{index + 1}</span>
                      </div>
                    </td>

                    {/* Date */}
                    <td className="px-3 py-1.5">
                      {canEditDate ? (
                        <Input
                          type="date"
                          value={txn.date}
                          onChange={(e) => onUpdateTxn(txn.id, { date: e.target.value })}
                          className="h-6 px-1.5 py-0 text-[11px] md:text-[11px] font-mono bg-transparent [&::-webkit-calendar-picker-indicator]:h-3.5 [&::-webkit-calendar-picker-indicator]:w-3.5 [&::-webkit-calendar-picker-indicator]:p-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100"
                        />
                      ) : (
                        <span className="font-mono text-xs text-foreground">{txn.date}</span>
                      )}
                    </td>

                    {/* From */}
                    <td className="px-3 py-1.5">
                      <CounterpartyCell entityKey={txn.fromKey} entityOptions={entityOptions} />
                    </td>

                    {/* Arrow */}
                    <td className="px-1 py-1.5 text-center font-mono">
                      <FlowArrow noCash={!txn.cashDelta} />
                    </td>

                    {/* To */}
                    <td className="px-3 py-1.5">
                      <CounterpartyCell entityKey={txn.toKey} entityOptions={entityOptions} />
                    </td>

                    {/* Source of Fund (Optional) */}
                    <td className="px-3 py-1.5">
                      <span className="text-muted-foreground truncate block">
                        {txn.srcKey
                          ? sourceOptions.find((o) => o.key === txn.srcKey)?.name || txn.srcKey
                          : "—"}
                      </span>
                    </td>

                    {/* Type */}
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {isOtherRow && !readOnly && !isDuplicate ? (
                        <Select
                          value={txn.type}
                          onValueChange={(val) => {
                            const isOutflowVal = val === "expense" || val === "buy" || val === "paid_in";
                            const isInflowVal = val === "income" || val === "sell" || val === "distribution";
                            let nextCashDelta = txn.cashDelta;
                            if (val === "other") {
                              nextCashDelta = isNegative
                                ? -Math.abs(txn.amount ?? txn.cashDelta ?? 0)
                                : Math.abs(txn.amount ?? txn.cashDelta ?? 0);
                            } else if (isOutflowVal) {
                              nextCashDelta = -Math.abs(txn.amount ?? txn.cashDelta ?? 0);
                            } else if (isInflowVal) {
                              nextCashDelta = Math.abs(txn.amount ?? txn.cashDelta ?? 0);
                            }
                            onUpdateTxn(txn.id, {
                              type: val,
                              cashDelta: nextCashDelta,
                            });
                          }}
                        >
                          <SelectTrigger className="h-6 text-[11px] w-[105px] font-medium py-0 px-2">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="other">Other</SelectItem>
                            {isNegative ? (
                              <>
                                <SelectItem value="expense">Expense</SelectItem>
                                <SelectItem value="buy">Buy</SelectItem>
                              </>
                            ) : (
                              <>
                                <SelectItem value="income">Income</SelectItem>
                                <SelectItem value="sell">Sell</SelectItem>
                                <SelectItem value="distribution">Distribution</SelectItem>
                              </>
                            )}
                          </SelectContent>
                        </Select>
                      ) : (
                        <LedgerBadge direction={typeDef?.direction} className="text-[10.5px]">
                          {typeDef?.label || txn.type}
                        </LedgerBadge>
                      )}
                    </td>

                    {/* Sub-type */}
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs text-muted-foreground truncate block">
                        {txn.subType || "—"}
                      </span>
                      {isEstimated && (
                        <span
                          className="mt-0.5 inline-block rounded bg-muted px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
                          title="The source describes this row as an estimate, accrual or projection. Classify it only if it represents an actual cash event."
                        >
                          estimate
                        </span>
                      )}
                    </td>

                    {/* Commitment Δ */}
                    <td className="px-3 py-1.5 text-right font-mono text-xs">
                      {txn.commitDelta != null && txn.commitDelta !== 0 ? (
                        <span>{formatMoney(txn.commitDelta, txn.currency)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>

                    {/* Quantity Δ */}
                    <td className={cn("px-3 py-1.5 text-right font-mono text-xs", signClass(txn.quantityDelta))}>
                      {formatQty(txn.quantityDelta)}
                    </td>

                    {/* Price */}
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                      {formatPrice(txn.pricePerShare, txn.currency) || "—"}
                    </td>

                    {/* Cash Δ — sales show +X with a destination badge (never 0.00) */}
                    <td className={cn("px-3 py-1.5 text-right font-mono text-xs font-medium whitespace-nowrap", signClass(txn.cashDelta))}>
                      {isDivestmentReviewRow(txn) && txn.sellProceedsDestination != null ? (
                        <div className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
                          <span>{formatMoney(txn.cashDelta, txn.currency)}</span>
                          {readOnly || isDuplicate ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] font-sans font-medium text-muted-foreground whitespace-nowrap shrink-0"
                              title="Proceeds destination"
                              data-testid={`proceeds-destination-${txn.id}`}
                            >
                              {PROCEEDS_DESTINATION_LABELS[txn.sellProceedsDestination]}
                            </span>
                          ) : (
                            <Select
                              value={txn.sellProceedsDestination}
                              onValueChange={(val) => {
                                if (
                                  val !== "cash_in_fund" &&
                                  val !== "distributed_to_investor"
                                ) {
                                  return;
                                }
                                // A reviewer choice makes the destination stated, so it is
                                // sent with the approval and posted explicitly.
                                onUpdateTxn(txn.id, { sellProceedsDestination: val });
                              }}
                            >
                              <SelectTrigger
                                className="h-6 w-[148px] bg-card text-[10px] font-sans py-0 px-2 shrink-0"
                                data-testid={`proceeds-destination-select-${txn.id}`}
                                title="Proceeds destination"
                              >
                                <SelectValue
                                  placeholder="Destination"
                                >
                                  {PROCEEDS_DESTINATION_LABELS[txn.sellProceedsDestination]}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent className="bg-card">
                                {SELL_PROCEEDS_DESTINATIONS.map((dest) => (
                                  <SelectItem key={dest} value={dest} className="text-[11px]">
                                    {PROCEEDS_DESTINATION_LABELS[dest]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      ) : (
                        formatMoney(txn.cashDelta, txn.currency)
                      )}
                    </td>

                    {/* Position / Status */}
                    <td className="px-3 py-1.5 text-center font-mono text-[11px] whitespace-nowrap">
                      {isDuplicate ? (
                        <span className="text-muted-foreground whitespace-nowrap">skipped</span>
                      ) : isBlocked ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="destructive"
                              className="cursor-help text-[10px] px-1.5 py-0.5 whitespace-nowrap"
                              title={txn.blockReason ?? "Blocked"}
                            >
                              blocked
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs text-xs">
                            {txn.blockReason ?? "This row cannot be posted until its missing details are resolved."}
                          </TooltipContent>
                        </Tooltip>
                      ) : txn.isResolved ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0.5 font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 whitespace-nowrap"
                        >
                          Resolved
                        </Badge>
                      ) : (
                        <span
                          className="text-muted-foreground inline-block max-w-[90px] truncate align-middle whitespace-nowrap"
                          title={txn.positionRef || "new"}
                        >
                          {txn.positionRef || "new"}
                        </span>
                      )}
                    </td>

                    {/* Blocked / skipped reason */}
                    <td className="px-3 py-1.5">
                      <ReasonCell reason={txn.blockReason} />
                    </td>
                  </tr>

                  {/* Expandable details for Transfers / Non-cash adjustments */}
                  {isExpanded && isExpandable && (
                    <tr className="border-b border-border bg-muted">
                      {/* `overflow-visible` matters: `overflow: hidden` on an
                          ancestor re-binds a sticky child to that ancestor
                          instead of the scroll container, which is what makes
                          the panel drift sideways with the columns. The row is
                          opaque for the same reason it is sticky — it sits over
                          the columns as they scroll underneath. */}
                      <td colSpan={15} className="overflow-visible p-0 whitespace-normal">
                        <div
                          className="sticky left-0 p-4"
                          style={{ width: `var(${DETAIL_WIDTH_VAR}, 100%)` }}
                        >
                          {txn.isTransfer ? (
                            <div className="space-y-3 rounded-lg border border-primary/20 bg-card p-3.5 text-xs">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 font-medium text-foreground">
                                  <Split className="h-4 w-4 text-primary" />
                                  <span>
                                    {txn.isMultiPartyTransfer
                                      ? "Multi-Party Commitment Transfer Split"
                                      : "Commitment Transfer Legs"}
                                  </span>
                                </div>
                                <span className="font-mono text-muted-foreground">
                                  Transferee: <strong>{entityOptions.find((o) => o.key === txn.toKey)?.name || txn.toKey}</strong>
                                </span>
                              </div>

                              {txn.isMultiPartyTransfer && txn.allocations ? (
                                <div className="space-y-2">
                                  {txn.allocations.map((alloc, aIdx) => (
                                    <div key={alloc.id || aIdx} className="flex items-center gap-2">
                                      <div className="flex-1">
                                        <Input
                                          value={alloc.transferorName}
                                          onChange={(e) => {
                                            const val = e.target.value;
                                            const newAllocs = (txn.allocations || []).map((a, i) =>
                                              i === aIdx ? { ...a, transferorName: val } : a,
                                            );
                                            onUpdateTxn(txn.id, { allocations: newAllocs });
                                          }}
                                          placeholder={`Transferor LP #${aIdx + 1}`}
                                          className="h-8 text-xs bg-background"
                                          disabled={readOnly}
                                        />
                                      </div>
                                      <div className="w-36">
                                        <Input
                                          type="number"
                                          value={alloc.amount}
                                          onChange={(e) => {
                                            const val = e.target.value;
                                            const newAllocs = (txn.allocations || []).map((a, i) =>
                                              i === aIdx ? { ...a, amount: val === "" ? "" : Number(val) } : a,
                                            );
                                            onUpdateTxn(txn.id, { allocations: newAllocs });
                                          }}
                                          placeholder="Amount"
                                          className="h-8 text-xs font-mono bg-background text-right"
                                          disabled={readOnly}
                                        />
                                      </div>
                                      {!readOnly && (txn.allocations?.length ?? 0) > 1 && (
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                          onClick={() => {
                                            const newAllocs = (txn.allocations || []).filter((_, i) => i !== aIdx);
                                            onUpdateTxn(txn.id, { allocations: newAllocs });
                                          }}
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                      )}
                                    </div>
                                  ))}

                                  {!readOnly && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 text-xs gap-1"
                                      onClick={() => {
                                        const newAllocs = [
                                          ...(txn.allocations || []),
                                          { id: `alloc-${Date.now()}`, transferorName: "", amount: 0 },
                                        ];
                                        onUpdateTxn(txn.id, { allocations: newAllocs });
                                      }}
                                    >
                                      <Plus className="h-3.5 w-3.5" />
                                      Add Transferor
                                    </Button>
                                  )}

                                  {(() => {
                                    const allocs = txn.allocations || [];
                                    const sum = allocs.reduce(
                                      (acc, a) => acc + (Number(a.amount) || 0),
                                      0,
                                    );
                                    const total = txn.amount ?? txn.commitDelta ?? txn.cashDelta ?? 0;
                                    const diff = total - sum;
                                    const isSumMatch = Math.abs(diff) < 0.01;

                                    let hasInvalidTransferor = false;
                                    let invalidReason: string | null = null;
                                    for (const a of allocs) {
                                      if (!a.transferorName?.trim()) {
                                        hasInvalidTransferor = true;
                                        invalidReason = "Transferor name cannot be blank";
                                        break;
                                      }
                                      const valRes = validateTransferCounterparty(a.transferorName);
                                      if (!valRes.valid) {
                                        hasInvalidTransferor = true;
                                        invalidReason = valRes.reason || "Invalid transferor name";
                                        break;
                                      }
                                      if (!a.amount || Number(a.amount) <= 0) {
                                        hasInvalidTransferor = true;
                                        invalidReason = "Each allocation amount must be greater than zero";
                                        break;
                                      }
                                    }

                                    if (hasInvalidTransferor) {
                                      return (
                                        <p className="text-amber-600 dark:text-amber-400 text-xs flex items-center gap-1">
                                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                          <span>{invalidReason}</span>
                                        </p>
                                      );
                                    }

                                    if (isSumMatch) {
                                      return (
                                        <p className="text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-1">
                                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                          <span>
                                            Allocations valid and sum exactly equals {formatMoney(total, txn.currency)}. Will post separate balanced transfer pairs for each transferor.
                                          </span>
                                        </p>
                                      );
                                    }
                                    return (
                                      <p className="text-amber-600 dark:text-amber-400 text-xs flex items-center gap-1">
                                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                        <span>
                                          Allocations sum ({formatMoney(sum, txn.currency)}) does not equal total ({formatMoney(total, txn.currency)}) — difference: {formatMoney(Math.abs(diff), txn.currency)}
                                        </span>
                                      </p>
                                    );
                                  })()}
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                      <label className="text-[11px] font-medium text-muted-foreground">Transferor (Source LP)</label>
                                      <Input
                                        value={txn.singleTransferState?.transferorName || ""}
                                        onChange={(e) =>
                                          onUpdateTxn(txn.id, {
                                            singleTransferState: {
                                              enabled: true,
                                              transferorName: e.target.value,
                                            },
                                          })
                                        }
                                        placeholder="Legal entity name"
                                        className="h-8 text-xs"
                                        disabled={readOnly}
                                      />
                                    </div>
                                    <div className="space-y-1">
                                      <label className="text-[11px] font-medium text-muted-foreground">Transferee (Recipient LP)</label>
                                      <Input
                                        value={entityOptions.find((o) => o.key === txn.toKey)?.name || txn.toKey}
                                        disabled
                                        className="h-8 text-xs bg-muted text-muted-foreground"
                                      />
                                    </div>
                                  </div>
                                  {(() => {
                                    const name = txn.singleTransferState?.transferorName?.trim() || "";
                                    if (!name) {
                                      return (
                                        <p className="text-amber-600 dark:text-amber-400 text-xs flex items-center gap-1">
                                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                          <span>Please enter a transferor entity name to resolve.</span>
                                        </p>
                                      );
                                    }
                                    const val = validateTransferCounterparty(name);
                                    if (!val.valid) {
                                      return (
                                        <p className="text-amber-600 dark:text-amber-400 text-xs flex items-center gap-1">
                                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                          <span>{val.reason || "Please enter a valid transferor name"}</span>
                                        </p>
                                      );
                                    }
                                    return (
                                      <p className="text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-1">
                                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                        <span>Valid transferor. Will generate balanced transfer legs on approval.</span>
                                      </p>
                                    );
                                  })()}
                                </div>
                              )}
                            </div>
                          ) : txn.isNonCashAdjustment ? (
                            <div className="space-y-3 rounded-lg border border-primary/20 bg-card p-3.5 text-xs">
                              <div className="flex items-center gap-2 font-medium text-foreground">
                                <Info className="h-4 w-4 text-primary" />
                                <span>Non-Cash Valuation Adjustment Configuration</span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                                <div className="space-y-1">
                                  <label className="text-[11px] font-medium text-muted-foreground">Target Investor LP</label>
                                  <Input
                                    value={txn.nonCashState?.investorName || ""}
                                    onChange={(e) =>
                                      onUpdateTxn(txn.id, {
                                        nonCashState: {
                                          enabled: true,
                                          investorName: e.target.value,
                                          direction: txn.nonCashState?.direction || "reduction",
                                          subType: txn.nonCashState?.subType || "paid_in_writeoff",
                                        },
                                      })
                                    }
                                    className="h-8 text-xs"
                                    disabled={readOnly}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[11px] font-medium text-muted-foreground">Direction / Sign</label>
                                  <Select
                                    value={txn.nonCashState?.direction || "reduction"}
                                    onValueChange={(val: "reduction" | "addition") =>
                                      onUpdateTxn(txn.id, {
                                        nonCashState: {
                                          enabled: true,
                                          investorName: txn.nonCashState?.investorName || "",
                                          direction: val,
                                          subType: txn.nonCashState?.subType || "paid_in_writeoff",
                                        },
                                      })
                                    }
                                    disabled={readOnly}
                                  >
                                    <SelectTrigger className="h-8 text-xs bg-background">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="reduction">Paid-in reduction (-)</SelectItem>
                                      <SelectItem value="addition">Paid-in addition (+)</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[11px] font-medium text-muted-foreground">Amount</label>
                                  <p
                                    className="h-8 flex items-center font-mono text-xs font-medium"
                                    data-testid={`non-cash-amount-${txn.id}`}
                                  >
                                    {/* Mirrors the amount the approval payload posts (fileService
                                        reads rawReviewItem.amount first), so the figure shown is
                                        the figure applied. Signed off the direction select, which
                                        is the only place the posted sign is decided — so this
                                        re-renders as the reviewer switches direction. */}
                                    {formatMoneyExact(
                                      (txn.nonCashState?.direction === "addition" ? 1 : -1) *
                                        Math.abs(
                                          txn.rawReviewItem?.amount ??
                                            (typeof txn.amount === "number" ? txn.amount : Number.NaN),
                                        ),
                                      txn.currency,
                                      { signed: true },
                                    )}
                                  </p>
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[11px] font-medium text-muted-foreground">Adjusts</label>
                                  <p className="h-8 flex items-center text-xs">Paid-in capital (non-cash)</p>
                                </div>
                              </div>
                              {(() => {
                                const invName = txn.nonCashState?.investorName?.trim();
                                const dir = txn.nonCashState?.direction;
                                const subType = txn.nonCashState?.subType?.trim();
                                const isValid = Boolean(invName && dir && subType);

                                if (isValid && !txn.nonCashState?.enabled) {
                                  return (
                                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                                      <p className="text-amber-700 dark:text-amber-300 text-xs flex items-center gap-1">
                                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                        <span>Values are valid. Accept this resolution to include the row.</span>
                                      </p>
                                      {!readOnly && (
                                        <Button
                                          type="button"
                                          size="sm"
                                          className="h-7 text-xs"
                                          onClick={() =>
                                            onUpdateTxn(txn.id, {
                                              nonCashState: {
                                                enabled: true,
                                                investorName: invName || "",
                                                direction: dir || "reduction",
                                                subType: subType || "paid_in_writeoff",
                                              },
                                            })
                                          }
                                        >
                                          <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                                          Accept resolution
                                        </Button>
                                      )}
                                    </div>
                                  );
                                }

                                if (isValid && txn.nonCashState?.enabled) {
                                  return (
                                    <p className="text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-1">
                                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                      <span>
                                        This adjusts paid-in capital by the row amount. Cash and commitment stay unchanged.
                                      </span>
                                    </p>
                                  );
                                }
                                return (
                                  <p className="text-amber-600 dark:text-amber-400 text-xs flex items-center gap-1">
                                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                    <span>
                                      Please provide a non-blank investor name, direction, and subtype to resolve.
                                    </span>
                                  </p>
                                );
                              })()}
                              <p className="text-[11px] text-muted-foreground">
                                Posts a zero-cash adjustment entry: paid-in capital moves by the signed amount above, while commitment and cash stay unchanged.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tbody>
      </table>
      </div>
    </TooltipProvider>
  );
}
