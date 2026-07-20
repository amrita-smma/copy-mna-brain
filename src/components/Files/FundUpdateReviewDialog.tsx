"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { AlertCircle, Check, ChevronDown, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  fundUpdateTxnKey,
  fundUpdateValKey,
  sortFundUpdateReviewAssets,
} from "@/lib/fund_updates";
import type { ParsedTxn, ParsedValuation, TxnTypeEnum, ValuationMethodEnum } from "@/lib/fund_updates";
import type { FundUpdateAssetSelection } from "@/lib/services/fundUpdateApplyService";

type AssetStatus = "new" | "unchanged" | "add_missing";

interface FundUpdateAssetReview {
  code: string;
  name: string;
  fund: string;
  asset_type: string;
  entity: string | null;
  funding_source: string | null;
  status: AssetStatus;
  matched_asset_id: string | null;
  proposed_txn_count: number;
  proposed_valuation_count: number;
  existing_txn_count: number;
  existing_valuation_count: number;
  missing_txn_count: number;
  missing_valuation_count: number;
  proposed: {
    code: string;
    name: string;
    legalName: string | null;
    country: string | null;
    investmentTypeLabel: string;
    entryDate: string | null;
    stakePct: number | null;
    sector: string | null;
    subSector: string | null;
    commitmentAmount: number | null;
    txns: ParsedTxn[];
    valuations: ParsedValuation[];
  };
  missing_txns: ParsedTxn[];
  missing_valuations: ParsedValuation[];
}

interface FundUpdateReviewData {
  kind: "fund_updates";
  file: { id: string; file_name: string; file_type: string | null };
  template_id: string | null;
  stats: {
    asset_count: number;
    direct_count: number;
    fund_of_funds_count: number;
    transaction_count: number;
    valuation_count: number;
  } | null;
  summary: string | null;
  assets: FundUpdateAssetReview[];
}

interface ItemSelection {
  txns: Set<string>;
  vals: Set<string>;
}

interface AssetEdits {
  txns: Map<string, ParsedTxn>;
  vals: Map<string, ParsedValuation>;
}

interface TxnRowView {
  txn: ParsedTxn;
  rowKey: string;
  originalKey: string;
  rowStatus: "actionable" | "existing";
}

interface ValRowView {
  val: ParsedValuation;
  rowKey: string;
  originalKey: string;
  rowStatus: "actionable" | "existing";
}

interface Props {
  fileId: string;
  open: boolean;
  onClose: () => void;
  onApproved: () => void;
  /** Browse-only: per-asset parsed data without approve / selection UI. */
  readOnly?: boolean;
}

const STATUS_LABEL: Record<AssetStatus, string> = {
  new: "New",
  add_missing: "Add missing",
  unchanged: "Unchanged",
};

const TXN_TYPE_OPTIONS: { value: TxnTypeEnum; label: string }[] = [
  { value: "contribution", label: "Contribution" },
  { value: "divestment", label: "Divestment" },
  { value: "distribution", label: "Distribution" },
  { value: "interest_income", label: "Interest income" },
  { value: "return_of_capital", label: "Return of capital" },
  { value: "other", label: "Other" },
];

function txnTypeLabel(type: string): string {
  return TXN_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;
}

const VALUATION_METHOD_OPTIONS: { value: ValuationMethodEnum; label: string }[] = [
  { value: "at_cost", label: "At cost" },
  { value: "fundraise_round", label: "Fundraise round" },
  { value: "secondary_sale", label: "Secondary sale" },
  { value: "stock_market_price", label: "Stock market price" },
  { value: "comparables", label: "Comparables" },
  { value: "capital_account_statement", label: "Capital account statement" },
  { value: "other", label: "Other" },
];

function valMethodLabel(method: string | null | undefined): string {
  if (!method) return "—";
  return VALUATION_METHOD_OPTIONS.find((o) => o.value === method)?.label ?? method;
}

const CURRENCY_OPTIONS = [
  "USD",
  "SGD",
  "IDR",
  "EUR",
  "GBP",
  "AUD",
  "JPY",
  "CNY",
  "MYR",
  "THB",
  "VND",
  "PHP",
  "HKD",
];

const TXN_NUMERIC_FIELDS = new Set(["valueAmount", "shareCount", "pricePerShare"]);
const VAL_NUMERIC_FIELDS = new Set(["marketValue", "pricePerShare", "shareholdingPct"]);

const REVIEW_CELL = "whitespace-nowrap px-2 py-1 align-middle text-xs";
const REVIEW_TH = "h-8 whitespace-nowrap px-2 text-left align-middle text-xs font-medium text-muted-foreground";
const REVIEW_INPUT =
  "h-7 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

/** Input width from the longest string in a column. */
function columnWidthCh(texts: string[], min = 6): number {
  const longest = texts.reduce((max, t) => Math.max(max, t.length), 0);
  return Math.max(min, longest + 1);
}

function numericTexts(amounts: (number | null | undefined)[]): string[] {
  return amounts.map((n) => (n == null ? "" : String(n)));
}

function ReviewTableScroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!e.shiftKey) return;
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }

  return (
    <div className="space-y-1">
      <div ref={ref} className="overflow-x-auto" onWheel={onWheel}>
        {children}
      </div>
      <p className="text-[10px] text-muted-foreground">Shift + scroll to move horizontally</p>
    </div>
  );
}

function ReviewTextInput({
  value,
  onChange,
  widthCh,
  edited = false,
  type = "text",
}: {
  value: string;
  onChange: (value: string) => void;
  widthCh: number;
  edited?: boolean;
  type?: "text" | "date";
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: `calc(${widthCh}ch + 1.5rem)` }}
      className={cn(REVIEW_INPUT, edited && "border-amber-400")}
    />
  );
}

function ReviewCurrencySelect({
  value,
  onChange,
  edited = false,
}: {
  value: string;
  onChange: (value: string) => void;
  edited?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const options = useMemo(() => {
    const list = [...CURRENCY_OPTIONS];
    if (value && !list.includes(value)) list.unshift(value);
    return list;
  }, [value]);
  const showCustom = search.trim().length > 0 && !options.some((o) => o.toLowerCase() === search.trim().toLowerCase());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "h-7 w-full min-w-[75px] justify-between px-2 py-0 text-xs font-normal",
            !edited && "border-transparent bg-transparent hover:border-input hover:bg-transparent hover:text-current",
            edited && "border-amber-400 bg-amber-500/10 text-amber-900"
          )}
        >
          {value || "Ccy"}
          <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-[120px] p-0" 
        align="start"
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <Command>
          <CommandInput 
            placeholder="Search..." 
            className="h-8 py-1 text-xs" 
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[200px] overflow-y-auto overscroll-contain">
            <CommandEmpty>No currency found.</CommandEmpty>
            <CommandGroup>
              {options.map((ccy) => (
                <CommandItem
                  key={ccy}
                  value={ccy}
                  onSelect={() => {
                    onChange(ccy);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="text-xs py-1"
                >
                  <Check
                    className={cn(
                      "mr-2 h-3 w-3",
                      value === ccy ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {ccy}
                </CommandItem>
              ))}
              {showCustom && (
                <CommandItem
                  value={search}
                  onSelect={() => {
                    const upper = search.trim().toUpperCase();
                    onChange(upper);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="text-xs italic text-muted-foreground py-1"
                >
                  <Check className="mr-2 h-3 w-3 opacity-0" />
                  Use &quot;{search.trim().toUpperCase()}&quot;
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ReviewNumericInput({
  value,
  onChange,
  widthCh,
  edited = false,
}: {
  value: number | null;
  onChange: (raw: string) => void;
  widthCh: number;
  edited?: boolean;
}) {
  const external = value == null ? "" : String(value);
  const [text, setText] = useState(external);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(external);
  }, [external]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        onChange(text);
        setText(value == null ? "" : String(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value);
      }}
      style={{ width: `calc(${Math.max(widthCh, text.length + 1)}ch + 1.5rem)` }}
      className={cn(REVIEW_INPUT, "text-right tabular-nums", edited && "border-amber-400")}
    />
  );
}

function statusVariant(status: AssetStatus): "default" | "secondary" | "outline" {
  if (status === "new") return "default";
  if (status === "add_missing") return "secondary";
  return "outline";
}

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "—") return null;
  const n = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function defaultItemSelection(assets: FundUpdateAssetReview[]): Map<string, ItemSelection> {
  const map = new Map<string, ItemSelection>();
  for (const asset of assets) {
    if (asset.status === "unchanged") continue;
    const missingTxnKeys = new Set(asset.missing_txns.map((t) => fundUpdateTxnKey(t)));
    const missingValKeys = new Set(asset.missing_valuations.map((v) => fundUpdateValKey(v)));
    const txns =
      asset.status === "new"
        ? new Set(asset.proposed.txns.map((t) => fundUpdateTxnKey(t)))
        : missingTxnKeys;
    const vals =
      asset.status === "new"
        ? new Set(asset.proposed.valuations.map((v) => fundUpdateValKey(v)))
        : missingValKeys;
    map.set(asset.code, { txns, vals });
  }
  return map;
}

function buildTxnRows(asset: FundUpdateAssetReview): TxnRowView[] {
  const missingKeys = new Set(asset.missing_txns.map((t) => fundUpdateTxnKey(t)));
  return asset.proposed.txns.map((txn, index) => {
    const originalKey = fundUpdateTxnKey(txn);
    const rowStatus: TxnRowView["rowStatus"] =
      asset.status === "add_missing" && !missingKeys.has(originalKey) ? "existing" : "actionable";
    return {
      txn,
      originalKey,
      rowKey: `${originalKey}:${index}`,
      rowStatus,
    };
  });
}

function buildValRows(asset: FundUpdateAssetReview): ValRowView[] {
  const missingKeys = new Set(asset.missing_valuations.map((v) => fundUpdateValKey(v)));
  return asset.proposed.valuations.map((val, index) => {
    const originalKey = fundUpdateValKey(val);
    const rowStatus: ValRowView["rowStatus"] =
      asset.status === "add_missing" && !missingKeys.has(originalKey) ? "existing" : "actionable";
    return {
      val,
      originalKey,
      rowKey: `${originalKey}:${index}`,
      rowStatus,
    };
  });
}

function rowCaption(
  status: AssetStatus,
  rows: { rowStatus: "actionable" | "existing" }[],
): string {
  if (status === "add_missing") {
    const existing = rows.filter((r) => r.rowStatus === "existing").length;
    const actionable = rows.length - existing;
    return `${actionable} new · ${existing} in system (${rows.length} total)`;
  }
  return `All proposed (${rows.length})`;
}

function assetSubLabel(
  asset: FundUpdateAssetReview,
  sel: ItemSelection | undefined,
  readOnly: boolean,
): string {
  if (readOnly || asset.status === "unchanged") return "Nothing to apply";

  const totalTxns =
    asset.status === "new" ? asset.proposed_txn_count : asset.missing_txn_count;
  const totalVals =
    asset.status === "new" ? asset.proposed_valuation_count : asset.missing_valuation_count;

  if (sel) {
    const txnLabel =
      asset.status === "add_missing"
        ? `+${sel.txns.size}/${totalTxns} txns`
        : `${sel.txns.size}/${totalTxns} txns`;
    const valLabel =
      asset.status === "add_missing"
        ? `+${sel.vals.size}/${totalVals} vals`
        : `${sel.vals.size}/${totalVals} vals`;
    return `${txnLabel} · ${valLabel}`;
  }

  if (readOnly || asset.status === "new") {
    return `${asset.proposed_txn_count} txns · ${asset.proposed_valuation_count} vals`;
  }
  return `+${asset.missing_txn_count} txns · +${asset.missing_valuation_count} vals`;
}

export function FundUpdateReviewDialog({
  fileId,
  open,
  onClose,
  onApproved,
  readOnly = false,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FundUpdateReviewData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [itemSelection, setItemSelection] = useState<Map<string, ItemSelection>>(new Map());
  const [edits, setEdits] = useState<Map<string, AssetEdits>>(new Map());
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"overview" | "txn" | "vals">("overview");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/ai-file-dump/${fileId}/review`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load review");
        if (cancelled) return;
        const payload = json.data as FundUpdateReviewData;
        if (payload.kind !== "fund_updates") {
          throw new Error("This file is not a Fund Updates review");
        }
        const sorted = {
          ...payload,
          assets: sortFundUpdateReviewAssets(payload.assets),
        };
        setData(sorted);
        setEdits(new Map());
        if (!readOnly) {
          const defaults = new Set(
            sorted.assets
              .filter((a) => a.status === "new" || a.status === "add_missing")
              .map((a) => a.code),
          );
          setSelected(defaults);
          setItemSelection(defaultItemSelection(sorted.assets));
        } else {
          setSelected(new Set());
          setItemSelection(new Map());
        }
        setActiveCode(sorted.assets[0]?.code ?? null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, open, readOnly]);

  const active = useMemo(
    () => data?.assets.find((a) => a.code === activeCode) ?? null,
    [data, activeCode],
  );

  const activeTxnRows = useMemo(
    () => (active ? buildTxnRows(active) : []),
    [active],
  );

  const activeValRows = useMemo(
    () => (active ? buildValRows(active) : []),
    [active],
  );

  const counts = useMemo(() => {
    const assets = data?.assets ?? [];
    return {
      new: assets.filter((a) => a.status === "new").length,
      add_missing: assets.filter((a) => a.status === "add_missing").length,
      unchanged: assets.filter((a) => a.status === "unchanged").length,
      selected: selected.size,
    };
  }, [data, selected]);

  const approveCounts = useMemo(() => {
    let txns = 0;
    let vals = 0;
    for (const code of selected) {
      const sel = itemSelection.get(code);
      if (sel) {
        txns += sel.txns.size;
        vals += sel.vals.size;
      }
    }
    return { txns, vals };
  }, [selected, itemSelection]);

  const getEditedTxn = useCallback(
    (assetCode: string, originalKey: string, fallback: ParsedTxn): ParsedTxn => {
      return edits.get(assetCode)?.txns.get(originalKey) ?? fallback;
    },
    [edits],
  );

  const getEditedVal = useCallback(
    (assetCode: string, originalKey: string, fallback: ParsedValuation): ParsedValuation => {
      return edits.get(assetCode)?.vals.get(originalKey) ?? fallback;
    },
    [edits],
  );

  function toggle(code: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  }

  function selectAll() {
    if (!data) return;
    setSelected(
      new Set(
        data.assets
          .filter((a) => a.status === "new" || a.status === "add_missing")
          .map((a) => a.code),
      ),
    );
  }

  function toggleItemKeys(
    assetCode: string,
    kind: "txns" | "vals",
    keys: string[],
    checked: boolean,
  ) {
    setItemSelection((prev) => {
      const next = new Map(prev);
      const current = next.get(assetCode) ?? { txns: new Set<string>(), vals: new Set<string>() };
      const set = new Set(current[kind]);
      for (const key of keys) {
        if (checked) set.add(key);
        else set.delete(key);
      }
      next.set(assetCode, { ...current, [kind]: set });
      return next;
    });
  }

  

  function editField<T extends ParsedTxn | ParsedValuation>(
    assetCode: string,
    kind: "txns" | "vals",
    numericFields: Set<string>,
    originalKey: string,
    base: T,
    field: keyof T,
    raw: string,
  ) {
    setEdits((prev) => {
      const next = new Map(prev);
      const assetEdits = next.get(assetCode) ?? { txns: new Map(), vals: new Map() };
      const map = assetEdits[kind] as Map<string, T>;
      const current = map.get(originalKey) ?? { ...base };
      const updated = { ...current };
      (updated as unknown as Record<string, unknown>)[field as string] = numericFields.has(field as string)
        ? parseOptionalNumber(raw)
        : raw;
      const newMap = new Map(map);
      newMap.set(originalKey, updated);
      next.set(assetCode, { ...assetEdits, [kind]: newMap });
      return next;
    });
  }

  function editTxnField(
    assetCode: string,
    originalKey: string,
    base: ParsedTxn,
    field: keyof ParsedTxn,
    raw: string,
  ) {
    editField(assetCode, "txns", TXN_NUMERIC_FIELDS, originalKey, base, field, raw);
  }

  function editValField(
    assetCode: string,
    originalKey: string,
    base: ParsedValuation,
    field: keyof ParsedValuation,
    raw: string,
  ) {
    editField(assetCode, "vals", VAL_NUMERIC_FIELDS, originalKey, base, field, raw);
  }

  function buildSelections(): FundUpdateAssetSelection[] {
    if (!data) return [];
    return [...selected].map((code) => {
      const asset = data.assets.find((a) => a.code === code)!;
      const sel = itemSelection.get(code);
      const assetEdits = edits.get(code);
      const actionableTxns =
        asset.status === "new" ? asset.proposed.txns : asset.missing_txns;
      const actionableVals =
        asset.status === "new" ? asset.proposed.valuations : asset.missing_valuations;

      const selectedTxnKeys = sel?.txns ?? new Set(actionableTxns.map((t) => fundUpdateTxnKey(t)));
      const selectedValKeys =
        sel?.vals ?? new Set(actionableVals.map((v) => fundUpdateValKey(v)));

      const txns = actionableTxns
        .filter((t) => selectedTxnKeys.has(fundUpdateTxnKey(t)))
        .map((t) => {
          const key = fundUpdateTxnKey(t);
          return assetEdits?.txns.get(key) ?? t;
        });

      const valuations = actionableVals
        .filter((v) => selectedValKeys.has(fundUpdateValKey(v)))
        .map((v) => {
          const key = fundUpdateValKey(v);
          return assetEdits?.vals.get(key) ?? v;
        });

      return { asset_code: code, txns, valuations };
    });
  }

  async function handleApprove() {
    if (!data) return;
    setApproving(true);
    try {
      const selections = buildSelections();
      const res = await fetch(`/api/ai-file-dump/${fileId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_type: "fund_updates",
          matched_company_id: null,
          fund_update_asset_codes: selections.map((s) => s.asset_code),
          fund_update_selections: selections,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Approve failed");
      const result = json.data?.fund_update;
      toast.success(
        result
          ? `Applied ${result.applied} assets (+${result.txns_inserted} txns, +${result.valuations_upserted} vals)`
          : "Fund update approved",
      );
      onApproved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApproving(false);
    }
  }

  const activeItemSel = active ? itemSelection.get(active.code) : undefined;

  const { allTxnChecked, someTxnChecked, allValChecked, someValChecked } = useMemo(() => {
    const txnActionable = activeTxnRows.filter((r) => r.rowStatus === "actionable");
    const valActionable = activeValRows.filter((r) => r.rowStatus === "actionable");
    return {
      allTxnChecked:
        txnActionable.length > 0 &&
        txnActionable.every((r) => activeItemSel?.txns.has(r.originalKey)),
      someTxnChecked: txnActionable.some((r) => activeItemSel?.txns.has(r.originalKey)),
      allValChecked:
        valActionable.length > 0 &&
        valActionable.every((r) => activeItemSel?.vals.has(r.originalKey)),
      someValChecked: valActionable.some((r) => activeItemSel?.vals.has(r.originalKey)),
    };
  }, [activeTxnRows, activeValRows, activeItemSel]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="pr-8 text-base">
            {readOnly ? "Parsed Fund Updates" : "Review Fund Updates"}
            {data?.file.file_name ? (
              <span className="mt-1 block truncate text-sm font-normal text-muted-foreground">
                File name: {data.file.file_name}
              </span>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center py-24">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center gap-2 px-6 py-24 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : data ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-6 py-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                {data.template_id ? (
                  <span>
                    Format: <Badge variant="outline">{data.template_id}</Badge>
                  </span>
                ) : null}
                {!readOnly ? (
                  <>
                    {data.template_id ? <span className="text-border">·</span> : null}
                    <span>
                      {counts.new} new · {counts.add_missing} add missing · {counts.unchanged}{" "}
                      unchanged
                    </span>
                  </>
                ) : null}
              </div>
              {readOnly ? (
                <span>{data.assets.length} assets parsed</span>
              ) : null}
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] overflow-hidden">
              <div className="flex min-h-0 flex-col border-r">
                {!readOnly ? (
                  <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2.5">
                    <Checkbox
                      checked={
                        counts.selected === 0
                          ? false
                          : counts.selected === counts.new + counts.add_missing
                            ? true
                            : "indeterminate"
                      }
                      onCheckedChange={(c) => (c ? selectAll() : setSelected(new Set()))}
                      aria-label="Select all actionable assets"
                    />
                    <span className="text-xs font-medium text-foreground">
                      {counts.selected} selected
                    </span>
                  </div>
                ) : null}
                <div className="flex-1 overflow-y-auto overscroll-contain">
                {data.assets.map((asset) => {
                  const checked = selected.has(asset.code);
                  const isActive = activeCode === asset.code;
                  const sel = itemSelection.get(asset.code);
                  return (
                    <div
                      key={asset.code}
                      role="option"
                      aria-selected={isActive}
                      tabIndex={0}
                      onClick={() => {
                        setActiveCode(asset.code);
                        setDetailTab("overview");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setActiveCode(asset.code);
                          setDetailTab("overview");
                        }
                      }}
                      className={cn(
                        "flex w-full cursor-pointer items-start gap-2 border-b px-3 py-2.5 text-left hover:bg-muted/50",
                        isActive && "bg-muted",
                      )}
                    >
                      {!readOnly ? (
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => toggle(asset.code, Boolean(v))}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-0.5"
                          disabled={asset.status === "unchanged"}
                        />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{asset.code}</span>
                          {!readOnly ? (
                            <Badge variant={statusVariant(asset.status)} className="shrink-0 text-[10px]">
                              {STATUS_LABEL[asset.status]}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{asset.name}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {assetSubLabel(asset, sel, readOnly)}
                        </div>
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>

              <div className="flex min-h-0 flex-col overflow-hidden">
                {active ? (
                  <>
                    <div className="flex gap-1 border-b px-4 pt-2">
                      {(
                        [
                          ["overview", "Overview"],
                          ["txn", `Transactions (${activeTxnRows.length})`],
                          ["vals", `Valuations (${activeValRows.length})`],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setDetailTab(id)}
                          className={cn(
                            "border-b-2 px-3 py-2 text-sm",
                            detailTab === id
                              ? "border-foreground text-foreground"
                              : "border-transparent text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
                      {detailTab === "overview" && (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <KV label="Name" value={active.proposed.name} />
                          <KV label="Legal name" value={active.proposed.legalName} />
                          <KV label="Fund" value={active.fund} />
                          <KV label="Type" value={active.proposed.investmentTypeLabel} />
                          <KV label="Entity" value={active.entity} />
                          <KV label="Funding source" value={active.funding_source} />
                          <KV label="Country" value={active.proposed.country} />
                          <KV label="Entry date" value={active.proposed.entryDate} />
                          <KV
                            label="Stake %"
                            value={
                              active.proposed.stakePct == null
                                ? null
                                : `${active.proposed.stakePct.toFixed(2)}%`
                            }
                          />
                          <KV label="Sector" value={active.proposed.sector} />
                          <KV label="Commitment" value={money(active.proposed.commitmentAmount)} />
                          <KV
                            label="Matched asset"
                            value={active.matched_asset_id ? active.matched_asset_id.slice(0, 8) : "— (new)"}
                          />
                        </div>
                      )}
                      {detailTab === "txn" && (
                        <TxnTable
                          rows={activeTxnRows}
                          caption={rowCaption(active.status, activeTxnRows)}
                          readOnly={readOnly}
                          assetCode={active.code}
                          selectedKeys={activeItemSel?.txns}
                          allChecked={allTxnChecked}
                          someChecked={someTxnChecked}
                          onToggleAll={
                            readOnly
                              ? undefined
                              : (checked) => {
                                  const keys = buildTxnRows(active)
                                    .filter((r) => r.rowStatus === "actionable")
                                    .map((r) => r.originalKey);
                                  toggleItemKeys(active.code, "txns", keys, checked);
                                }
                          }
                          onToggle={
                            readOnly
                              ? undefined
                              : (originalKey, checked) =>
                                  toggleItemKeys(active.code, "txns", [originalKey], checked)
                          }
                          getEditedTxn={getEditedTxn}
                          onEdit={readOnly ? undefined : editTxnField}
                          edits={edits.get(active.code)?.txns}
                        />
                      )}
                      {detailTab === "vals" && (
                        <ValTable
                          rows={activeValRows}
                          caption={rowCaption(active.status, activeValRows)}
                          readOnly={readOnly}
                          assetCode={active.code}
                          selectedKeys={activeItemSel?.vals}
                          allChecked={allValChecked}
                          someChecked={someValChecked}
                          onToggleAll={
                            readOnly
                              ? undefined
                              : (checked) => {
                                  const keys = buildValRows(active)
                                    .filter((r) => r.rowStatus === "actionable")
                                    .map((r) => r.originalKey);
                                  toggleItemKeys(active.code, "vals", keys, checked);
                                }
                          }
                          onToggle={
                            readOnly
                              ? undefined
                              : (originalKey, checked) =>
                                  toggleItemKeys(active.code, "vals", [originalKey], checked)
                          }
                          getEditedVal={getEditedVal}
                          onEdit={readOnly ? undefined : editValField}
                          edits={edits.get(active.code)?.vals}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    No assets in proposal
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        <DialogFooter className="border-t px-6 py-3">
          {readOnly ? (
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onClose} disabled={approving}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleApprove}
                disabled={approving || loading || !!error || selected.size === 0}
              >
                {approving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Applying…
                  </>
                ) : (
                  `Approve ${selected.size} asset${selected.size === 1 ? "" : "s"} (+${approveCounts.txns} txns, +${approveCounts.vals} vals)`
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowStatusBadge({ isExisting, isEdited }: { isExisting: boolean; isEdited: boolean }) {
  if (isExisting) return <Badge variant="outline" className="text-[10px]">In system</Badge>;
  if (isEdited) return <Badge variant="secondary" className="text-[10px]">Edited</Badge>;
  return <Badge variant="default" className="text-[10px]">New</Badge>;
}

function KV({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value && value !== "" ? value : "—"}</div>
    </div>
  );
}

interface TxnTableProps {
  rows: TxnRowView[];
  caption: string;
  readOnly: boolean;
  assetCode: string;
  selectedKeys?: Set<string>;
  allChecked: boolean;
  someChecked: boolean;
  onToggleAll?: (checked: boolean) => void;
  onToggle?: (originalKey: string, checked: boolean) => void;
  getEditedTxn: (assetCode: string, originalKey: string, fallback: ParsedTxn) => ParsedTxn;
  onEdit?: (
    assetCode: string,
    originalKey: string,
    base: ParsedTxn,
    field: keyof ParsedTxn,
    raw: string,
  ) => void;
  edits?: Map<string, ParsedTxn>;
}

function TxnTable({
  rows,
  caption,
  readOnly,
  assetCode,
  selectedKeys,
  allChecked,
  someChecked,
  onToggleAll,
  onToggle,
  getEditedTxn,
  onEdit,
  edits,
}: TxnTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No transactions to show.</p>;
  }

  const selectable = !readOnly && Boolean(onToggle);

  const txns = rows.map((row) => getEditedTxn(assetCode, row.originalKey, row.txn));
  const dateWidthCh = columnWidthCh(txns.map((t) => t.date), 8);
  const valueWidthCh = columnWidthCh(numericTexts(txns.map((t) => t.valueAmount)), 10);
  const sharesWidthCh = columnWidthCh(numericTexts(txns.map((t) => t.shareCount)), 8);
  const ppsWidthCh = columnWidthCh(numericTexts(txns.map((t) => t.pricePerShare)), 8);
  const ccyWidthCh = columnWidthCh(txns.map((t) => t.currency), 4);

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">{caption}</p>
      <ReviewTableScroller>
        <table className="w-max caption-bottom text-sm">
          <thead className="[&_tr]:border-b">
            <tr className="border-b">
              {selectable ? (
                <th className={cn(REVIEW_TH, "w-10")}>
                  <Checkbox
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={(v) => onToggleAll?.(Boolean(v))}
                    aria-label="Select all new transactions"
                  />
                </th>
              ) : null}
              <th className={REVIEW_TH}>Date</th>
              <th className={cn(REVIEW_TH, "min-w-[9.5rem]")}>Type</th>
              <th className={cn(REVIEW_TH, "text-right")}>Value</th>
              <th className={cn(REVIEW_TH, "text-right")}>Shares</th>
              <th className={cn(REVIEW_TH, "text-right")}>PPS</th>
              <th className={REVIEW_TH}>Ccy</th>
              {!readOnly ? <th className={cn(REVIEW_TH, "w-28")}>Row</th> : null}
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {rows.map((row) => {
              const txn = getEditedTxn(assetCode, row.originalKey, row.txn);
              const isExisting = row.rowStatus === "existing";
              const isChecked = selectedKeys?.has(row.originalKey) ?? false;
              const isEdited = edits?.has(row.originalKey) ?? false;
              const canEdit = !readOnly && !isExisting && isChecked && Boolean(onEdit);

              return (
                <tr
                  key={row.rowKey}
                  className={cn(
                    "border-b transition-colors hover:bg-muted/50",
                    isExisting && "bg-muted/40 text-muted-foreground opacity-60",
                  )}
                >
                  {selectable ? (
                    <td className={REVIEW_CELL}>
                      <Checkbox
                        checked={isExisting ? false : isChecked}
                        disabled={isExisting}
                        onCheckedChange={(v) => onToggle?.(row.originalKey, Boolean(v))}
                        aria-label={`Select transaction ${row.originalKey}`}
                      />
                    </td>
                  ) : null}
                  <td className={REVIEW_CELL}>
                    {canEdit ? (
                      <ReviewTextInput
                        type="date"
                        value={txn.date}
                        widthCh={dateWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.txn, "date", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      txn.date
                    )}
                  </td>
                  <td className={REVIEW_CELL}>
                    {canEdit ? (
                      <Select
                        value={txn.type}
                        onValueChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.txn, "type", value)
                        }
                      >
                        <SelectTrigger
                          className={cn(
                            "h-7 w-full min-w-[9rem] text-xs [&>span]:line-clamp-none",
                            isEdited && "border-amber-400",
                          )}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TXN_TYPE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      txnTypeLabel(txn.type)
                    )}
                  </td>
                  <td className={cn(REVIEW_CELL, "text-right")}>
                    {canEdit ? (
                      <ReviewNumericInput
                        value={txn.valueAmount}
                        widthCh={valueWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.txn, "valueAmount", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      <span className="tabular-nums">{money(txn.valueAmount)}</span>
                    )}
                  </td>
                  <td className={cn(REVIEW_CELL, "text-right")}>
                    {canEdit ? (
                      <ReviewNumericInput
                        value={txn.shareCount}
                        widthCh={sharesWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.txn, "shareCount", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      <span className="tabular-nums">{money(txn.shareCount)}</span>
                    )}
                  </td>
                  <td className={cn(REVIEW_CELL, "text-right")}>
                    {canEdit ? (
                      <ReviewNumericInput
                        value={txn.pricePerShare}
                        widthCh={ppsWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.txn, "pricePerShare", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      <span className="tabular-nums">{money(txn.pricePerShare)}</span>
                    )}
                  </td>
                  <td className={REVIEW_CELL}>
                    {canEdit ? (
                      <ReviewCurrencySelect
                        value={txn.currency}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.txn, "currency", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      txn.currency
                    )}
                  </td>
                  {!readOnly ? (
                    <td className={REVIEW_CELL}>
                      <RowStatusBadge isExisting={isExisting} isEdited={isEdited} />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ReviewTableScroller>
    </div>
  );
}

interface ValTableProps {
  rows: ValRowView[];
  caption: string;
  readOnly: boolean;
  assetCode: string;
  selectedKeys?: Set<string>;
  allChecked: boolean;
  someChecked: boolean;
  onToggleAll?: (checked: boolean) => void;
  onToggle?: (originalKey: string, checked: boolean) => void;
  getEditedVal: (assetCode: string, originalKey: string, fallback: ParsedValuation) => ParsedValuation;
  onEdit?: (
    assetCode: string,
    originalKey: string,
    base: ParsedValuation,
    field: keyof ParsedValuation,
    raw: string,
  ) => void;
  edits?: Map<string, ParsedValuation>;
}

function ValTable({
  rows,
  caption,
  readOnly,
  assetCode,
  selectedKeys,
  allChecked,
  someChecked,
  onToggleAll,
  onToggle,
  getEditedVal,
  onEdit,
  edits,
}: ValTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No valuations to show.</p>;
  }

  const selectable = !readOnly && Boolean(onToggle);

  const vals = rows.map((row) => getEditedVal(assetCode, row.originalKey, row.val));
  const asOfWidthCh = columnWidthCh(vals.map((v) => v.asOfDate), 8);
  const periodWidthCh = columnWidthCh(vals.map((v) => v.periodLabel), 8);
  const marketWidthCh = columnWidthCh(numericTexts(vals.map((v) => v.marketValue)), 10);
  const ppsWidthCh = columnWidthCh(numericTexts(vals.map((v) => v.pricePerShare)), 8);
  const stakeWidthCh = columnWidthCh(
    vals.map((v) => (v.shareholdingPct == null ? "" : v.shareholdingPct.toFixed(2))),
    6,
  );

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">{caption}</p>
      <ReviewTableScroller>
        <table className="w-max caption-bottom text-sm">
          <thead className="[&_tr]:border-b">
            <tr className="border-b">
              {selectable ? (
                <th className={cn(REVIEW_TH, "w-10")}>
                  <Checkbox
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={(v) => onToggleAll?.(Boolean(v))}
                    aria-label="Select all new valuations"
                  />
                </th>
              ) : null}
              <th className={REVIEW_TH}>As of</th>
              <th className={REVIEW_TH}>Period</th>
              <th className={cn(REVIEW_TH, "text-right")}>Market value</th>
              <th className={cn(REVIEW_TH, "text-right")}>PPS</th>
              <th className={cn(REVIEW_TH, "text-right")}>Stake %</th>
              <th className={REVIEW_TH}>Method</th>
              {!readOnly ? <th className={cn(REVIEW_TH, "w-28")}>Row</th> : null}
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {rows.map((row) => {
              const val = getEditedVal(assetCode, row.originalKey, row.val);
              const isExisting = row.rowStatus === "existing";
              const isChecked = selectedKeys?.has(row.originalKey) ?? false;
              const isEdited = edits?.has(row.originalKey) ?? false;
              const canEdit = !readOnly && !isExisting && isChecked && Boolean(onEdit);

              return (
                <tr
                  key={row.rowKey}
                  className={cn(
                    "border-b transition-colors hover:bg-muted/50",
                    isExisting && "bg-muted/40 text-muted-foreground opacity-60",
                  )}
                >
                  {selectable ? (
                    <td className={REVIEW_CELL}>
                      <Checkbox
                        checked={isExisting ? false : isChecked}
                        disabled={isExisting}
                        onCheckedChange={(v) => onToggle?.(row.originalKey, Boolean(v))}
                        aria-label={`Select valuation ${row.originalKey}`}
                      />
                    </td>
                  ) : null}
                  <td className={REVIEW_CELL}>
                    {canEdit ? (
                      <ReviewTextInput
                        type="date"
                        value={val.asOfDate}
                        widthCh={asOfWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.val, "asOfDate", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      val.asOfDate
                    )}
                  </td>
                  <td className={REVIEW_CELL}>
                    {canEdit ? (
                      <ReviewTextInput
                        value={val.periodLabel}
                        widthCh={periodWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.val, "periodLabel", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      val.periodLabel
                    )}
                  </td>
                  <td className={cn(REVIEW_CELL, "text-right")}>
                    {canEdit ? (
                      <ReviewNumericInput
                        value={val.marketValue}
                        widthCh={marketWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.val, "marketValue", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      <span className="tabular-nums">{money(val.marketValue)}</span>
                    )}
                  </td>
                  <td className={cn(REVIEW_CELL, "text-right")}>
                    {canEdit ? (
                      <ReviewNumericInput
                        value={val.pricePerShare}
                        widthCh={ppsWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.val, "pricePerShare", value)
                        }
                        edited={isEdited}
                      />
                    ) : (
                      <span className="tabular-nums">{money(val.pricePerShare)}</span>
                    )}
                  </td>
                  <td className={cn(REVIEW_CELL, "text-right")}>
                    {canEdit ? (
                      <ReviewNumericInput
                        value={val.shareholdingPct}
                        widthCh={stakeWidthCh}
                        onChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.val, "shareholdingPct", value)
                        }
                        edited={isEdited}
                      />
                    ) : val.shareholdingPct == null ? (
                      "—"
                    ) : (
                      <span className="tabular-nums">{val.shareholdingPct.toFixed(2)}</span>
                    )}
                  </td>
                  <td className={REVIEW_CELL}>
                    {canEdit ? (
                      <Select
                        value={val.valuationMethod ?? ""}
                        onValueChange={(value) =>
                          onEdit?.(assetCode, row.originalKey, row.val, "valuationMethod", value)
                        }
                      >
                        <SelectTrigger
                          className={cn(
                            "h-7 w-full min-w-[140px] rounded-sm border px-2 py-0 text-xs",
                            isEdited ? "border-amber-400 bg-amber-500/10 text-amber-900" : "border-transparent",
                          )}
                        >
                          <SelectValue placeholder="Method" />
                        </SelectTrigger>
                        <SelectContent>
                          {VALUATION_METHOD_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      valMethodLabel(val.valuationMethod)
                    )}
                  </td>
                  {!readOnly ? (
                    <td className={REVIEW_CELL}>
                      <RowStatusBadge isExisting={isExisting} isEdited={isEdited} />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ReviewTableScroller>
    </div>
  );
}
