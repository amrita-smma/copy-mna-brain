"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building, Loader2, Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getCompaniesLite } from "@/lib/api/pipeline";
import { companyDisplayName } from "@/lib/companyDisplay";

export interface MatchedCompanyChip {
  id?: string | null;
  name?: string;
  target?: string;
  type?: string;
}

interface Props {
  fileId: string;
  companies: MatchedCompanyChip[];
  onOpenCompany: (companyId: string) => void;
  /** Called after a successful add/remove so the parent can refetch. */
  onChanged: () => void;
  disabled?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

const PAGE_SIZE = 50;
const VISIBLE_LIMIT = 2;

function chipLabel(c: MatchedCompanyChip): string {
  return c.name?.trim() || c.target?.trim() || "Unnamed";
}

function isPipelineCompany(c: MatchedCompanyChip): boolean {
  return c.type === "company" && typeof c.id === "string" && c.id.length > 0;
}

function chipKey(c: MatchedCompanyChip, index: number): string {
  if (typeof c.id === "string" && c.id) return c.id;
  return `${chipLabel(c)}-${index}`;
}

const chipBase =
  "group inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 min-w-0 max-w-[10rem]";

export function MatchedCompaniesCell({
  fileId,
  companies,
  onOpenCompany,
  onChanged,
  disabled,
  expanded,
  onToggleExpand,
}: Props) {
  const safeCompanies = Array.isArray(companies) ? companies : [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<
    Array<{ id: string; target: string | null; project_name: string | null }>
  >([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<{
    type: "add" | "remove";
    key: string;
  } | null>(null);

  const linkedIds = new Set(
    safeCompanies
      .filter((c) => typeof c.id === "string" && c.id)
      .map((c) => c.id as string),
  );

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    loadingRef.current = true;
    (async () => {
      try {
        const rows = await getCompaniesLite({
          q: debouncedQuery || undefined,
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        setResults(rows);
        setHasMore(rows.length === PAGE_SIZE);
      } catch {
        if (!cancelled) {
          setResults([]);
          setHasMore(false);
        }
      } finally {
        if (!cancelled) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, debouncedQuery]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const rows = await getCompaniesLite({
        q: debouncedQuery || undefined,
        limit: PAGE_SIZE,
        offset: results.length,
      });
      setResults((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [debouncedQuery, hasMore, results.length]);

  const onListScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) void loadMore();
    },
    [loadMore],
  );

  const rematch = async (
    body: Record<string, unknown>,
    okMessage: string,
    actionKey: string,
    actionType: "add" | "remove",
    undoBody?: Record<string, unknown>,
  ) => {
    setPendingAction({ type: actionType, key: actionKey });
    try {
      const res = await fetch(`/api/smart-files/${fileId}/matched-companies`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to update matched companies");
      }
      if (undoBody) {
        toast.success(okMessage, {
          action: {
            label: "Undo",
            onClick: () => {
              void rematch(undoBody, "Reverted", actionKey, actionType === "add" ? "remove" : "add");
            },
          },
        });
      } else {
        toast.success(okMessage);
      }
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update match");
    } finally {
      setPendingAction(null);
    }
  };

  const handleAdd = async (companyId: string) => {
    setOpen(false);
    setQuery("");
    await rematch(
      { action: "add", company_id: companyId },
      "Company matched",
      companyId,
      "add",
      { action: "remove", company_id: companyId },
    );
  };

  const handleRemove = async (c: MatchedCompanyChip) => {
    const idx = safeCompanies.indexOf(c);
    const key = chipKey(c, idx >= 0 ? idx : 0);
    if (typeof c.id === "string" && c.id) {
      await rematch(
        { action: "remove", company_id: c.id },
        "Company unmatched",
        key,
        "remove",
        { action: "add", company_id: c.id },
      );
      return;
    }
    await rematch(
      { action: "remove", unmatched_name: chipLabel(c) },
      "Suggestion removed",
      key,
      "remove",
    );
  };

  const visible = expanded
    ? safeCompanies
    : safeCompanies.slice(0, VISIBLE_LIMIT);

  const isBusy = pendingAction !== null;
  const hasOverflow = safeCompanies.length > VISIBLE_LIMIT;

  const addPopover = (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        {safeCompanies.length === 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy}
            className="h-6 border-dashed px-2 text-xs text-muted-foreground hover:text-foreground hover:border-solid"
            aria-label="Add matched company"
          >
            {isBusy ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Plus className="mr-1 h-3 w-3" />
            )}
            Add company
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={isBusy}
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Add matched company"
          >
            {isBusy && pendingAction?.type === "add" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="start"
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search company..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList onScroll={onListScroll}>
            <CommandEmpty>
              {loading ? "Loading..." : "No companies found."}
            </CommandEmpty>
            <CommandGroup>
              {results
                .filter((c) => !linkedIds.has(c.id))
                .map((c) => {
                  const primary = companyDisplayName(c, "Unnamed");
                  const secondary =
                    c.target?.trim() && c.project_name?.trim()
                      ? c.project_name.trim()
                      : null;
                  return (
                    <CommandItem
                      key={c.id}
                      value={c.id}
                      onSelect={() => void handleAdd(c.id)}
                    >
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="truncate">{primary}</span>
                        {secondary && (
                          <span className="truncate text-xs text-muted-foreground">
                            {secondary}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  );
                })}
              {loading && results.length > 0 && (
                <div className="py-2 text-center text-xs text-muted-foreground">
                  Loading more...
                </div>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );

  return (
    <div className="flex flex-col gap-1 min-w-[8rem]">
      {visible.map((company, i) => {
        const label = chipLabel(company);
        const linked = isPipelineCompany(company);
        const key = chipKey(company, i);
        const isThisBusy =
          pendingAction?.key === key && pendingAction.type === "remove";
        const isLast = i === visible.length - 1;

        return (
          <div key={key} className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    chipBase,
                    linked
                      ? "bg-sky-100 text-sky-900 dark:bg-sky-900/30 dark:text-sky-100"
                      : "bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-100",
                    isThisBusy && "opacity-50",
                  )}
                >
                  {linked ? (
                    <button
                      type="button"
                      onClick={() => onOpenCompany(company.id!)}
                      className="inline-flex items-center gap-1 min-w-0 text-left hover:underline"
                    >
                      <Building className="h-3 w-3 shrink-0" />
                      <span className="truncate">{label}</span>
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1 min-w-0">
                      <Sparkles className="h-3 w-3 shrink-0" />
                      <span className="truncate">{label}</span>
                    </span>
                  )}
                  {!disabled && (
                    <button
                      type="button"
                      aria-label={`Remove ${label}`}
                      disabled={isBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemove(company);
                      }}
                      className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-40 transition-opacity"
                    >
                      {isThisBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                    </button>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                {label}
              </TooltipContent>
            </Tooltip>
            {isLast && !hasOverflow && !disabled && addPopover}
          </div>
        );
      })}

      {hasOverflow && (
        <div className="flex items-center gap-1">
          {onToggleExpand && (
            <button
              type="button"
              className="inline-flex items-center text-[10px] text-primary hover:underline shrink-0"
              onClick={onToggleExpand}
            >
              {expanded ? "Show less" : `+${safeCompanies.length - VISIBLE_LIMIT} more`}
            </button>
          )}
          {!disabled && addPopover}
        </div>
      )}

      {safeCompanies.length === 0 && !disabled && addPopover}

      {safeCompanies.length === 0 && disabled && (
        <span className="text-muted-foreground text-xs">-</span>
      )}
    </div>
  );
}
