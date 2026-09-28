"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { TeamMemberSummary } from "./types";

export function TeamFilter({
  users,
  selected,
  onChange,
}: {
  users: TeamMemberSummary[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));

  useEffect(() => {
    if (open) setDraft(new Set(selected));
  }, [open, selected]);

  const q = query.trim().toLowerCase();
  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q),
  );
  const first = users.find((u) => selected.has(u.id));
  const label =
    selected.size === 0 ? "Team member" : (first?.name.split(" ")[0] ?? "Team");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={selected.size ? "default" : "outline"}
          size="sm"
          className={cn(
            "gap-1",
            selected.size &&
              "bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-950 dark:text-blue-200",
          )}
        >
          <Users className="h-3 w-3" />
          {label}
          {selected.size > 1 && (
            <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
              +{selected.size - 1}
            </Badge>
          )}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-3" align="start">
        <Input
          placeholder="Search members…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
        />
        <div className="max-h-52 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No members
            </div>
          ) : (
            filtered.map((u) => {
              const on = draft.has(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md p-1.5 text-left text-sm hover:bg-muted",
                    on && "font-semibold text-blue-700 dark:text-blue-300",
                  )}
                  onClick={() => {
                    const next = new Set(draft);
                    on ? next.delete(u.id) : next.add(u.id);
                    setDraft(next);
                  }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                      on && "bg-primary text-primary-foreground",
                    )}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{u.name}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {u.email ?? "—"}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="mt-3 flex items-center justify-between border-t pt-2">
          <button
            className="text-xs font-semibold text-muted-foreground hover:text-red-600"
            onClick={() => {
              setDraft(new Set());
              onChange(new Set());
              setOpen(false);
            }}
          >
            Clear all
          </button>
          <Button
            size="sm"
            onClick={() => {
              onChange(new Set(draft));
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
