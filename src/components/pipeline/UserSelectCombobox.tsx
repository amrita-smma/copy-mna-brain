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
import { Check, ChevronDown } from "lucide-react";

export interface UserOption {
  id: string;
  name: string | null;
  /** Shown beneath the name in the option list, and searchable. */
  email?: string | null;
}

/**
 * Searchable single-user picker backing the "Entered by" / Deal Sponsor /
 * Deal Captain fields (a `users.id` uuid FK). Stores the user's `id` while
 * showing their `name` with their email stacked beneath it, offers a search
 * box over both, and is NOT creatable — the value must be an existing user.
 *
 * (Distinct from `UserCombobox`, which is the multi-select assignee picker.)
 */
interface UserSelectComboboxProps {
  /** Selected user id, or "" / null for none. */
  value: string | null;
  /** Receives the chosen user id, or "" when cleared. */
  onChange: (next: string) => void;
  users: UserOption[];
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Whether to offer a "— None —" entry that clears the value. Default true. */
  allowNone?: boolean;
  className?: string;
}

export default function UserSelectCombobox({
  value,
  onChange,
  users,
  disabled,
  placeholder = "Select a user…",
  searchPlaceholder = "Search a user…",
  emptyText = "No users found.",
  allowNone = true,
  className,
}: UserSelectComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selectedName = useMemo(
    () => users.find((u) => u.id === value)?.name ?? null,
    [users, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        (u.name ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q),
    );
  }, [users, query]);

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
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("h-9 w-full justify-between font-normal text-sm", className)}
        >
          <span className={cn("truncate", !selectedName && "text-muted-foreground")}>
            {selectedName || placeholder}
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
            {filtered.length === 0 && <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {allowNone && (
                <CommandItem value="__none__" onSelect={() => commit("")}>
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      !value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate text-muted-foreground">— None —</span>
                </CommandItem>
              )}
              {filtered.map((u) => (
                <CommandItem
                  key={u.id}
                  value={u.id}
                  onSelect={() => commit(u.id)}
                  className="group"
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      value === u.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{u.name ?? u.id}</span>
                    {/* The highlighted row is filled with `--accent`, so the
                        muted email has to flip to `accent-foreground` or it
                        goes near-invisible on the highlight. */}
                    <span className="block truncate text-xs text-muted-foreground group-data-[selected=true]:text-accent-foreground/75">
                      {u.email ?? "—"}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
