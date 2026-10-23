"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { EmployerListSort, SortDirection } from "@/lib/crm/employerListSort";
import { cn } from "@/lib/utils";

interface SortHeaderProps {
  column: EmployerListSort;
  sort: EmployerListSort;
  direction: SortDirection;
  onSort: (column: EmployerListSort) => void;
  children: ReactNode;
}

/** A clickable column label in the CRM Firms grid header. */
export function SortHeader({ column, sort, direction, onSort, children }: SortHeaderProps) {
  const active = column === sort;
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      data-testid={`crm-sort-${column}`}
      aria-pressed={active}
      className={cn(
        "group inline-flex items-center gap-1 rounded-sm text-left uppercase tracking-wider hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "text-foreground",
      )}
    >
      {children}
      <Icon
        className={cn("h-3 w-3 shrink-0", active ? "opacity-100" : "opacity-35 group-hover:opacity-70")}
      />
    </button>
  );
}
