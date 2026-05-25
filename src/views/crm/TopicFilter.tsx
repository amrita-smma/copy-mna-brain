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
import { Check, ChevronDown, Tag } from "lucide-react";
import { useEffect, useState } from "react";
import type { Topic } from "./types";

export function TopicFilter({
  topics,
  selected,
  onChange,
}: {
  topics: Topic[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));

  useEffect(() => {
    if (open) setDraft(new Set(selected));
  }, [open, selected]);

  const filtered = topics.filter((t) =>
    t.name.toLowerCase().includes(query.toLowerCase()),
  );

  const first = topics.find((t) => selected.has(t.id));
  const label = selected.size === 0 ? "Topic" : (first?.name ?? "Topic");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={selected.size ? "default" : "outline"}
          size="sm"
          className={cn(
            "gap-1",
            selected.size &&
              "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-200",
          )}
        >
          <Tag className="h-3 w-3" />
          {label}
          {selected.size > 1 && (
            <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
              +{selected.size - 1}
            </Badge>
          )}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <Input
          placeholder="Search topics…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
        />
        <div className="max-h-52 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No topics
            </div>
          ) : (
            filtered.map((t) => {
              const on = draft.has(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm hover:bg-muted",
                    on && "font-semibold text-indigo-700 dark:text-indigo-300",
                  )}
                  onClick={() => {
                    const next = new Set(draft);
                    on ? next.delete(t.id) : next.add(t.id);
                    setDraft(next);
                  }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                      on && "bg-primary text-primary-foreground",
                    )}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  {t.name}
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
