"use client";

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
import { cn } from "@/lib/utils";
import { getCompaniesLite } from "@/lib/api/pipeline";
import { companyDisplayName } from "@/lib/companyDisplay";
import { Building, Check, ChevronsUpDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export const AUTO = "__auto__";
const PAGE_SIZE = 50;

export interface CompanyOption {
  id: string;
  name: string;
  projectName: string | null;
}

export interface PinnedMatch {
  id: string;
  name: string;
  projectName?: string | null;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  fallbackOptions?: CompanyOption[];
  /** Companies from the file's matched_companies array (non-null id only). Shown at the top. */
  pinnedMatches?: PinnedMatch[];
  disabled?: boolean;
  placeholder?: string;
}

export function MatchedCompanyCombobox({
  value,
  onChange,
  fallbackOptions = [],
  pinnedMatches = [],
  disabled,
  placeholder = "Auto (AI Decides)",
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; target: string | null; project_name: string | null }>>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const rows = await getCompaniesLite({ q: debouncedQuery || undefined, limit: PAGE_SIZE });
        if (cancelled) return;
        setResults(rows);
        setHasMore(rows.length === PAGE_SIZE);
      } catch {
        if (!cancelled) { setResults([]); setHasMore(false); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, debouncedQuery]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const rows = await getCompaniesLite({ q: debouncedQuery || undefined, limit: PAGE_SIZE, offset: results.length });
      setResults((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, hasMore, loading, results.length]);

  const onListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) void loadMore();
  }, [loadMore]);

  const pinnedIds = new Set(pinnedMatches.map((p) => p.id));
  const picked = value === AUTO ? null : results.find((r) => r.id === value);
  const pinnedPicked = value === AUTO ? null : pinnedMatches.find((p) => p.id === value);
  const fallbackPicked = value === AUTO ? null : fallbackOptions.find((c) => c.id === value);
  const label =
    value === AUTO
      ? placeholder
      : (() => {
          const target = picked?.target?.trim() || pinnedPicked?.name?.trim() || fallbackPicked?.name?.trim() || "";
          const project = picked?.project_name?.trim() || pinnedPicked?.projectName?.trim() || fallbackPicked?.projectName?.trim() || "";
          if (target && project) return `${target} (${project})`;
          return target || project || placeholder;
        })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-8 w-full justify-between font-normal text-xs px-2"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="h-3 w-3 opacity-50 shrink-0 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
        // Radix Dialog locks body scroll via react-remove-scroll, which also
        // intercepts wheel events on portal siblings. Stopping propagation
        // here lets the CommandList scroll inside the dialog.
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search company..." value={query} onValueChange={setQuery} />
          <CommandList onScroll={onListScroll}>
            <CommandEmpty>{loading ? "Loading..." : "No companies found."}</CommandEmpty>
            <CommandGroup>
              <CommandItem value={AUTO} onSelect={() => { onChange(AUTO); setOpen(false); }}>
                <Check className={cn("mr-2 h-4 w-4", value === AUTO ? "opacity-100" : "opacity-0")} />
                {placeholder}
              </CommandItem>
            </CommandGroup>
            {pinnedMatches.length > 0 && (
              <CommandGroup heading="Matched from this file">
                {pinnedMatches.map((p) => (
                  <CommandItem key={p.id} value={p.id} onSelect={() => { onChange(p.id); setOpen(false); }}>
                    <Check className={cn("mr-2 h-4 w-4 shrink-0", value === p.id ? "opacity-100" : "opacity-0")} />
                    <Building className="mr-1.5 h-3.5 w-3.5 shrink-0 text-sky-600" />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="truncate font-medium">{p.name || "Unnamed"}</span>
                      {p.projectName && (
                        <span className="truncate text-xs text-muted-foreground">{p.projectName}</span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading={pinnedMatches.length > 0 ? "Select existing company..." : undefined}>
              {results.filter((c) => !pinnedIds.has(c.id)).map((c) => {
                // Pick the primary label: target if it exists, otherwise
                // project_name. The secondary line shows whichever is left
                // (or nothing if only one exists).
                const primary = companyDisplayName(c, "");
                const secondary = c.target?.trim() && c.project_name?.trim() ? c.project_name.trim() : null;
                return (
                  <CommandItem key={c.id} value={c.id} onSelect={() => { onChange(c.id); setOpen(false); }}>
                    <Check className={cn("mr-2 h-4 w-4 shrink-0", value === c.id ? "opacity-100" : "opacity-0")} />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="truncate">
                        {primary ?? <span className="italic text-muted-foreground">Unnamed</span>}
                      </span>
                      {secondary && (
                        <span className="truncate text-xs text-muted-foreground">{secondary}</span>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
              {loading && results.length > 0 && (
                <div className="py-2 text-center text-xs text-muted-foreground">Loading more...</div>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
