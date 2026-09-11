"use client";

import React, { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ReviewValuation } from "./types";
import {
  formatValuationNumber,
  formatValuationStake,
  VALUATION_METHODS,
} from "./constants";
import { applyCommas, parseCurrencyInput } from "@/lib/numberFormat";
import { cn } from "@/lib/utils";
import { compareSortValues, SortableHeader, type SortDirection } from "./SortableHeader";
import { ReasonCell } from "./ReasonCell";
import { TooltipProvider } from "@/components/ui/tooltip";

type ValuationSortKey = "assetName" | "asOfDate" | "periodLabel" | "marketValue" | "pricePerShare" | "shareholdingPct" | "valuationMethod" | "status";

interface ValuationNumberInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function ValuationNumberInput({
  value,
  onChange,
  placeholder,
  className,
  disabled,
  ariaLabel,
}: ValuationNumberInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const formattedDisplay =
    value != null && Number.isFinite(value) ? applyCommas(value.toFixed(2)) : "";

  const handleFocus = () => {
    setIsFocused(true);
    setDraft(value != null && Number.isFinite(value) ? String(value) : "");
  };

  const handleBlur = () => {
    setIsFocused(false);
    const trimmed = draft.trim();
    if (trimmed === "") {
      onChange(null);
    } else {
      const parsed = parseCurrencyInput(trimmed);
      if (parsed !== null && Number.isFinite(parsed)) {
        onChange(parsed);
      } else {
        // Unparseable noise reverts to previous valid value
        setDraft(value != null && Number.isFinite(value) ? String(value) : "");
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setIsFocused(false);
      setDraft(value != null && Number.isFinite(value) ? String(value) : "");
    }
  };

  return (
    <Input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={isFocused ? draft : formattedDisplay}
      placeholder={placeholder}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "h-6 px-1.5 py-0 text-[11px] md:text-[11px] font-mono text-right bg-transparent",
        className,
      )}
    />
  );
}

interface ValuationsTableProps {
  valuations: ReviewValuation[];
  onToggleSelect: (id: string, selected: boolean) => void;
  onUpdateValuation: (id: string, updates: Partial<ReviewValuation>) => void;
  readOnly?: boolean;
}

export function ValuationsTable({
  valuations,
  onToggleSelect,
  onUpdateValuation,
  readOnly = false,
}: ValuationsTableProps) {
  const [sort, setSort] = useState<{ key: ValuationSortKey; direction: SortDirection } | null>(null);
  const toggleSort = (key: ValuationSortKey) => {
    setSort((current) => ({ key, direction: current?.key === key && current.direction === "asc" ? "desc" : "asc" }));
  };
  const sortedValuations = useMemo(() => {
    if (!sort) return valuations;
    return valuations
      .map((valuation, index) => ({ valuation, index }))
      .sort((a, b) => compareSortValues(a.valuation[sort.key], b.valuation[sort.key], sort.direction) || a.index - b.index)
      .map(({ valuation }) => valuation);
  }, [sort, valuations]);

  return (
    <TooltipProvider delayDuration={150}>
    <div className="w-full">
      <table className="w-full min-w-[1300px] border-collapse text-xs">
        <thead className="sticky top-0 z-20 bg-muted shadow-sm">
          <tr className="border-b border-border bg-muted text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="w-10 px-3 py-2 text-center"></th>
            <th className="w-12 px-2 py-2 text-center">#</th>
            <SortableHeader className="w-48 px-3 py-2 text-left" active={sort?.key === "assetName"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("assetName")}>Asset / Target</SortableHeader>
            <SortableHeader className="w-28 px-3 py-2 text-left" active={sort?.key === "asOfDate"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("asOfDate")}>As of Date</SortableHeader>
            <SortableHeader className="w-28 px-3 py-2 text-left" active={sort?.key === "periodLabel"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("periodLabel")}>Period</SortableHeader>
            <SortableHeader className="w-32 px-3 py-2 text-right" active={sort?.key === "marketValue"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("marketValue")}>Market Value</SortableHeader>
            <SortableHeader className="w-24 px-3 py-2 text-right" active={sort?.key === "pricePerShare"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("pricePerShare")}>PPS</SortableHeader>
            <SortableHeader className="w-24 px-3 py-2 text-right" active={sort?.key === "shareholdingPct"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("shareholdingPct")}>Stake %</SortableHeader>
            <SortableHeader className="w-44 px-3 py-2 text-left" active={sort?.key === "valuationMethod"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("valuationMethod")}>Method</SortableHeader>
            <SortableHeader className="w-24 px-3 py-2 text-center" active={sort?.key === "status"} direction={sort?.direction ?? "asc"} onClick={() => toggleSort("status")}>Status</SortableHeader>
            <th className="w-[220px] px-3 py-2 text-left">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {valuations.length === 0 ? (
            <tr>
              <td colSpan={11} className="py-12 text-center text-xs text-muted-foreground">
                No valuations found in this sheet.
              </td>
            </tr>
          ) : (
            sortedValuations.map((val, index) => {
              const isDuplicate = val.status === "duplicate";
              const isBlocked = val.status === "blocked";
              const canEdit = !readOnly && val.status === "actionable";

              return (
                <tr
                  key={val.id}
                  className={cn(
                    "transition-colors",
                    !isBlocked && "hover:bg-muted/30",
                    isDuplicate && "bg-muted/40 opacity-60 text-muted-foreground",
                    isBlocked && "bg-destructive/10 border-l-2 border-destructive hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-destructive/70",
                  )}
                  title={val.blockReason ?? undefined}
                >
                  {/* Checkbox */}
                  <td className="px-3 py-1.5 text-center">
                    <Checkbox
                      checked={isDuplicate ? false : val.selected}
                      disabled={isDuplicate || isBlocked || readOnly}
                      onCheckedChange={(c) => onToggleSelect(val.id, Boolean(c))}
                      aria-label={`Select valuation row ${index + 1}`}
                    />
                  </td>

                  {/* Sequential Row # */}
                  <td className="px-2 py-1.5 text-center font-mono text-[11px] text-muted-foreground">
                    {index + 1}
                  </td>

                  {/* Asset / Target */}
                  <td className="px-3 py-1.5">
                    <div className="font-medium text-foreground truncate max-w-[180px]">
                      {val.assetName}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">{val.assetCode}</div>
                  </td>

                  {/* As of Date */}
                  <td className="px-3 py-1.5">
                    {canEdit ? (
                      <Input
                        type="date"
                        value={val.asOfDate}
                        onChange={(e) => onUpdateValuation(val.id, { asOfDate: e.target.value })}
                        className="h-6 px-1.5 py-0 text-[11px] md:text-[11px] font-mono bg-transparent [&::-webkit-calendar-picker-indicator]:h-3.5 [&::-webkit-calendar-picker-indicator]:w-3.5 [&::-webkit-calendar-picker-indicator]:p-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100"
                      />
                    ) : (
                      <span className="font-mono text-xs text-foreground">{val.asOfDate}</span>
                    )}
                  </td>

                  {/* Period */}
                  <td className="px-3 py-1.5">
                    <span className="text-xs text-muted-foreground">{val.periodLabel || "—"}</span>
                  </td>

                  {/* Market Value */}
                  <td className="px-3 py-1.5 text-right font-mono text-xs font-medium">
                    {canEdit ? (
                      <ValuationNumberInput
                        value={val.marketValue}
                        onChange={(next) => onUpdateValuation(val.id, { marketValue: next })}
                        ariaLabel={`Market value for row ${index + 1}`}
                        placeholder="0.00"
                      />
                    ) : (
                      <span>{formatValuationNumber(val.marketValue)}</span>
                    )}
                  </td>

                  {/* PPS */}
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                    {canEdit ? (
                      <ValuationNumberInput
                        value={val.pricePerShare}
                        onChange={(next) => onUpdateValuation(val.id, { pricePerShare: next })}
                        ariaLabel={`PPS for row ${index + 1}`}
                        placeholder="0.00"
                      />
                    ) : (
                      <span>{formatValuationNumber(val.pricePerShare)}</span>
                    )}
                  </td>

                  {/* Stake % */}
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                    {canEdit ? (
                      <ValuationNumberInput
                        value={val.shareholdingPct}
                        onChange={(next) => onUpdateValuation(val.id, { shareholdingPct: next })}
                        ariaLabel={`Stake percentage for row ${index + 1}`}
                        placeholder="0.00"
                      />
                    ) : (
                      <span>{formatValuationStake(val.shareholdingPct)}</span>
                    )}
                  </td>

                  {/* Method */}
                  <td className="px-3 py-1.5">
                    {canEdit ? (
                      <Select
                        value={val.valuationMethod ?? "other"}
                        onValueChange={(v) => onUpdateValuation(val.id, { valuationMethod: v })}
                      >
                        <SelectTrigger className="h-7 text-xs bg-transparent">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-56">
                          {VALUATION_METHODS.map((m) => (
                            <SelectItem key={m.value} value={m.value} className="text-xs">
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        {VALUATION_METHODS.find((m) => m.value === val.valuationMethod)?.label ||
                          val.valuationMethod ||
                          "—"}
                      </Badge>
                    )}
                  </td>

                  {/* Status */}
                  <td className="px-3 py-1.5 text-center font-mono text-[11px]">
                    {isDuplicate ? (
                      <span className="text-muted-foreground">skipped</span>
                    ) : isBlocked ? (
                      <Badge variant="destructive" className="text-[10px] px-1 py-0" title={val.blockReason ?? "Blocked"}>
                        blocked
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">new</span>
                    )}
                  </td>

                  {/* Blocked / skipped reason */}
                  <td className="px-3 py-1.5">
                    <ReasonCell reason={val.blockReason} />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
    </TooltipProvider>
  );
}
