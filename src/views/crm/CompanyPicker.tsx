"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { CompanyPickerValue, EmployerSummary } from "./types";

// Non-portaled popover content. The shadcn PopoverContent renders in a portal
// at <body>, which lands outside Radix Dialog's `react-remove-scroll` boundary
// and breaks wheel scrolling on the inner list when this picker is opened
// from inside AddContactDialog / CurationDialog. Keeping the content in the
// dialog's tree lets react-remove-scroll see the scrollable div and allow it.
const InlinePopoverContent = (
  props: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>,
) => (
  <PopoverPrimitive.Content
    align="start"
    sideOffset={4}
    {...props}
    className={cn(
      "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
      props.className,
    )}
  />
);

export function CompanyPicker({
  value,
  locked,
  placeholder = "Select company",
  onChange,
}: {
  value: CompanyPickerValue | null;
  locked?: boolean;
  placeholder?: string;
  onChange: (next: CompanyPickerValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<EmployerSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ limit: "200" });
    if (debounced) params.set("q", debounced);
    fetch(`/api/crm?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setItems((j.data ?? []) as EmployerSummary[]);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced]);

  const hasExact = debounced
    ? items.some((c) => c.name.toLowerCase() === debounced.toLowerCase())
    : false;

  const label = value?.name || placeholder;

  return (
    <Popover open={open && !locked} onOpenChange={(o) => !locked && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked}
          className={cn(
            "w-full justify-between gap-2 font-medium",
            value?.name &&
              "border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-200",
            locked && "cursor-default opacity-90",
          )}
        >
          <span className="truncate">{label}</span>
          {!locked && <ChevronDown className="h-3 w-3 flex-shrink-0" />}
        </Button>
      </PopoverTrigger>
      <InlinePopoverContent className="w-64 p-3">
        <Input
          placeholder="Search companies…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
          autoFocus
        />
        <div className="max-h-72 overflow-y-auto overscroll-contain">
          {loading ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : items.length === 0 && !debounced ? (
            <div className="py-3 text-center text-xs text-muted-foreground">
              No companies in CRM yet
            </div>
          ) : items.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">
              No matching company
            </div>
          ) : (
            items.map((c) => {
              const isSel = value?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm hover:bg-muted",
                    isSel &&
                      "font-semibold text-indigo-700 dark:text-indigo-300",
                  )}
                  onClick={() => {
                    onChange({ name: c.name, id: c.id });
                    setOpen(false);
                  }}
                >
                  {c.name}
                </button>
              );
            })
          )}
        </div>
        {debounced && !hasExact && (
          <button
            type="button"
            className="mt-2 flex w-full items-center gap-2 border-t pt-2 text-left text-sm font-semibold text-indigo-600 hover:underline"
            onClick={() => {
              onChange({ name: debounced, isNew: true });
              setOpen(false);
            }}
          >
            <Plus className="h-3 w-3" />
            Create “{debounced}”
          </button>
        )}
      </InlinePopoverContent>
    </Popover>
  );
}
