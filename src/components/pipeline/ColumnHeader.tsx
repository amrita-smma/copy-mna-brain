"use client";

import { useState } from "react";
import { TableHead } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FilterOption {
  /** Stored value used for matching. */
  value: string;
  /** Human-friendly label (defaults to value). */
  label?: string;
}

interface ColumnHeaderContentProps {
  label: string;
  /** Sort field key. When set, the label becomes a sort toggle. */
  sortField?: string;
  activeSortField?: string | null;
  sortDirection?: "asc" | "desc";
  onSort?: (field: string) => void;
  /** Filter field key. When set, a multi-select filter control is shown. */
  filterField?: string;
  filterOptions?: FilterOption[];
  selectedValues?: string[];
  onFilterChange?: (field: string, values: string[]) => void;
}

interface ColumnHeaderProps extends ColumnHeaderContentProps {
  className?: string;
}

/**
 * Inner sort/filter controls for a column header, WITHOUT the surrounding
 * `<TableHead>`. Rendered directly by `ColumnHeader` and reused by the managed
 * (drag/hide/group) table header, which supplies its own `<TableHead>` wrapper.
 */
export function ColumnHeaderContent({
  label,
  sortField,
  activeSortField,
  sortDirection = "asc",
  onSort,
  filterField,
  filterOptions = [],
  selectedValues = [],
  onFilterChange,
}: ColumnHeaderContentProps) {
  const [open, setOpen] = useState(false);

  const isSortable = !!sortField && !!onSort;
  const isFilterable = !!filterField && !!onFilterChange;
  const isSorted = isSortable && activeSortField === sortField;
  const activeFilterCount = selectedValues.length;

  const SortIcon = () => {
    if (!isSortable) return null;
    if (!isSorted)
      return <ArrowUpDown className="h-3 w-3 ml-1 opacity-50" />;
    return sortDirection === "asc" ? (
      <ArrowUp className="h-3 w-3 ml-1" />
    ) : (
      <ArrowDown className="h-3 w-3 ml-1" />
    );
  };

  const toggleValue = (value: string) => {
    if (!isFilterable) return;
    const next = selectedValues.includes(value)
      ? selectedValues.filter((v) => v !== value)
      : [...selectedValues, value];
    onFilterChange!(filterField!, next);
  };

  const clearFilter = () => {
    if (!isFilterable) return;
    onFilterChange!(filterField!, []);
  };

  return (
    <div className="flex items-center gap-0.5">
        {isSortable ? (
          <button
            type="button"
            onClick={() => onSort!(sortField!)}
            className="flex items-center hover:text-foreground transition-colors"
          >
            {label}
            <SortIcon />
          </button>
        ) : (
          <span>{label}</span>
        )}

        {isFilterable && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Filter ${label}`}
                className={cn(
                  "h-5 w-5 shrink-0",
                  activeFilterCount > 0
                    ? "text-primary"
                    : "text-muted-foreground opacity-60 hover:opacity-100",
                )}
              >
                <Filter
                  className={cn(
                    "h-3 w-3",
                    activeFilterCount > 0 && "fill-current",
                  )}
                />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-0" align="start">
              <Command>
                <CommandInput placeholder={`Filter ${label}…`} />
                <CommandList>
                  <CommandEmpty>No options.</CommandEmpty>
                  <CommandGroup>
                    {filterOptions.map((opt) => {
                      const checked = selectedValues.includes(opt.value);
                      return (
                        <CommandItem
                          key={opt.value}
                          value={opt.label ?? opt.value}
                          onSelect={() => toggleValue(opt.value)}
                          className="gap-2"
                        >
                          <Checkbox checked={checked} className="pointer-events-none" />
                          <span className="truncate">{opt.label ?? opt.value}</span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
                {activeFilterCount > 0 && (
                  <div className="border-t p-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full justify-center text-xs"
                      onClick={clearFilter}
                    >
                      Clear filter ({activeFilterCount})
                    </Button>
                  </div>
                )}
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>
  );
}

/**
 * Sortable / filterable column header cell (renders its own `<TableHead>`).
 * Thin wrapper around {@link ColumnHeaderContent}.
 */
export function ColumnHeader({ className, ...content }: ColumnHeaderProps) {
  return (
    <TableHead className={className}>
      <ColumnHeaderContent {...content} />
    </TableHead>
  );
}
