"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Check, ChevronDown, X } from "lucide-react";
import { trackDisplayName, type TrackLike } from "@/lib/tracks/matchTracks";

interface TrackMultiSelectProps {
  tracks: TrackLike[];
  /** Currently-selected track ids. */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** "input" = form field with tag chips; "filter" = compact toolbar button. */
  variant?: "input" | "filter";
  className?: string;
}

export default function TrackMultiSelect({
  tracks,
  value,
  onChange,
  disabled,
  placeholder = "Select tracks…",
  variant = "input",
  className,
}: TrackMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = new Set(value);

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  const triggerLabel = () => {
    if (value.length === 0) return placeholder;
    if (variant === "filter") {
      if (value.length === 1) {
        const t = tracks.find((x) => x.id === value[0]);
        return t ? trackDisplayName(t) : "1 track";
      }
      return `${value.length} tracks`;
    }
    return `${value.length} selected`;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "justify-between font-normal",
            value.length > 0 &&
              variant === "filter" &&
              "border-primary text-primary bg-primary/5",
            variant === "input" && "w-full h-auto min-h-9 py-1.5",
            className,
          )}
        >
          {variant === "input" && value.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {value.map((id) => {
                const t = tracks.find((x) => x.id === id);
                if (!t) return null;
                return (
                  <Badge
                    key={id}
                    variant="secondary"
                    className="gap-1 font-normal"
                  >
                    {trackDisplayName(t)}
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(id);
                      }}
                      className="hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </span>
                  </Badge>
                );
              })}
            </span>
          ) : (
            <span className="truncate">{triggerLabel()}</span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tracks…" />
          <CommandList>
            <CommandEmpty>No tracks found.</CommandEmpty>
            <CommandGroup>
              {tracks.map((t) => (
                <CommandItem
                  key={t.id}
                  value={t.title ?? t.id}
                  onSelect={() => toggle(t.id)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selected.has(t.id) ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{trackDisplayName(t)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
