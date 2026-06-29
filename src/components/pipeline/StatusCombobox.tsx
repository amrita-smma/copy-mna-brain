"use client";

import { useMemo, useState } from "react";
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
import { Check, ChevronDown, Plus } from "lucide-react";

/**
 * Free-text status field with a creatable dropdown. The text input at the top
 * doubles as search AND new-value entry: type anything and pick "Create" to
 * store a custom status. Previously-saved values arrive via `options` and are
 * offered for reuse. Values are stored verbatim — this is intentionally not an
 * enum.
 */
interface StatusComboboxProps {
  value: string | null;
  onChange: (next: string) => void;
  /** Known/suggested values (defaults ∪ distinct saved values). */
  options: string[];
  disabled?: boolean;
  placeholder?: string;
  /** Placeholder for the search/create input inside the dropdown. */
  searchPlaceholder?: string;
  /** Text shown when there are no options and nothing has been typed. */
  emptyText?: string;
  /** "cell" = subtle inline-table look; "input" = form-input look. */
  variant?: "cell" | "input";
  /**
   * Whether the input can create a brand-new value not in `options`. Defaults to
   * `true` (creatable, e.g. statuses/bankers). Set `false` to restrict the field
   * to existing options only — the dropdown then acts as a searchable picker
   * (e.g. Deal Sponsor / Deal Captain, which must be an existing team member).
   */
  allowCreate?: boolean;
  className?: string;
}

export default function StatusCombobox({
  value,
  onChange,
  options,
  disabled,
  placeholder = "Set status…",
  searchPlaceholder = "Search or type a status…",
  emptyText = "No statuses yet.",
  variant = "input",
  allowCreate = true,
  className,
}: StatusComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const uniq = Array.from(new Set(options.filter(Boolean)));
    if (!q) return uniq;
    return uniq.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  const trimmed = query.trim();
  const exactExists = options.some(
    (o) => o.toLowerCase() === trimmed.toLowerCase(),
  );

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={variant === "cell" ? "ghost" : "outline"}
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "justify-between font-normal",
            variant === "cell"
              ? "h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              : "h-9 w-full text-sm",
            className,
          )}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50 shrink-0 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[240px] p-0"
        align="start"
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filtered.length === 0 && (!trimmed || !allowCreate) && (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            {filtered.length > 0 && (
              <CommandGroup>
                {filtered.map((opt) => (
                  <CommandItem
                    key={opt}
                    value={opt}
                    onSelect={() => commit(opt)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 shrink-0",
                        value === opt ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{opt}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {allowCreate && trimmed && !exactExists && (
              <CommandGroup>
                <CommandItem
                  value={`__create__${trimmed}`}
                  onSelect={() => commit(trimmed)}
                >
                  <Plus className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">Create &quot;{trimmed}&quot;</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Default inbound status suggestions, surfaced before any saved values. */
export const DEFAULT_INBOUND_STATUS_OPTIONS = [
  "Unreviewed",
  "Teaser review",
  "NDA pending",
  "NDA executed",
  "IM review",
  "L1 prep",
];

/** Default outbound status suggestions, surfaced before any saved values. */
export const DEFAULT_OUTBOUND_STATUS_OPTIONS = [
  "Target identified",
  "Intermediary approach",
  "Direct outreach",
  "First contact made",
  "Teaser requested",
  "Teaser received",
  "Discussions ongoing",
  "Market intel",
];
