"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { Calendar, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { LastContactPreset } from "./types";
import { LAST_CONTACT_LABELS } from "./utils";

export function LastContactFilter({
  value,
  customDate,
  onChange,
}: {
  value: LastContactPreset | null;
  customDate: string;
  onChange: (v: LastContactPreset | null, custom?: string) => void;
}) {
  const [draft, setDraft] = useState<LastContactPreset | null>(value);
  const [draftDate, setDraftDate] = useState(customDate);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setDraft(value);
    setDraftDate(customDate);
  }, [value, customDate, open]);

  // Trigger label stays "Last Contact" — the active selection is communicated
  // via the active-filter chip strip below the toolbar.
  const label = "Last Contact";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={value ? "default" : "outline"}
          size="sm"
          className={cn(
            "gap-1",
            value &&
              "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-200",
          )}
        >
          <Calendar className="h-3 w-3" />
          {label}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Show firms contacted…
        </div>
        <RadioGroup
          value={draft ?? ""}
          onValueChange={(v) => setDraft(v as LastContactPreset)}
        >
          {(
            [
              "today",
              "yesterday",
              "week",
              "month",
              "stale_30",
              "custom",
            ] as LastContactPreset[]
          ).map((preset) => (
            <label
              key={preset}
              className="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted"
            >
              <RadioGroupItem value={preset} />
              {LAST_CONTACT_LABELS[preset]}
            </label>
          ))}
        </RadioGroup>
        {draft === "custom" && (
          <Input
            type="date"
            value={draftDate}
            onChange={(e) => setDraftDate(e.target.value)}
            className="mt-2"
          />
        )}
        <div className="mt-3 flex items-center justify-between border-t pt-2">
          <button
            className="text-xs font-semibold text-muted-foreground hover:text-red-600"
            onClick={() => {
              setDraft(null);
              setDraftDate("");
              onChange(null);
              setOpen(false);
            }}
          >
            Clear
          </button>
          <Button
            size="sm"
            onClick={() => {
              onChange(draft, draftDate);
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
