import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { UserSummary } from "@/lib/api/pipeline";

interface UserComboboxProps {
  users: UserSummary[];
  selectedUserIds: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

export default function UserCombobox({
  users,
  selectedUserIds,
  onChange,
  loading,
  placeholder = "Select team members...",
  disabled,
}: UserComboboxProps) {
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () =>
      selectedUserIds
        .map((id) => users.find((u) => u.id === id))
        .filter((u): u is UserSummary => Boolean(u)),
    [selectedUserIds, users],
  );

  const toggle = (id: string) => {
    if (selectedUserIds.includes(id)) {
      onChange(selectedUserIds.filter((x) => x !== id));
    } else {
      onChange([...selectedUserIds, id]);
    }
  };

  const remove = (id: string) =>
    onChange(selectedUserIds.filter((x) => x !== id));

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((user) => (
            <span
              key={user.id}
              className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-sm"
            >
              {user.name}
              <button
                type="button"
                onClick={() => remove(user.id)}
                disabled={disabled}
                className="rounded-sm text-muted-foreground hover:text-destructive disabled:opacity-50"
                aria-label={`Remove ${user.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || loading}
            className="group w-full justify-between font-normal"
          >
            <span className="flex items-center gap-1.5 text-muted-foreground group-hover:text-white">
              <Plus className="h-3.5 w-3.5" />
              {loading ? "Loading users..." : placeholder}
            </span>
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] p-0"
          align="start"
        >
          <Command>
            <CommandInput placeholder="Search users..." />
            <CommandList>
              <CommandEmpty>No users found.</CommandEmpty>
              <CommandGroup>
                {users.map((user) => {
                  const isSelected = selectedUserIds.includes(user.id);
                  // `group` so the name/email spans can follow the item's own
                  // highlight state — see their group-data rules below.
                  return (
                    <CommandItem
                      key={user.id}
                      value={`${user.name} ${user.email ?? ""} ${user.role ?? ""}`}
                      onSelect={() => toggle(user.id)}
                      className="group flex items-start gap-2"
                    >
                      <Check
                        className={cn(
                          "mt-0.5 h-4 w-4 shrink-0",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="flex min-w-0 flex-col">
                        {/* Name over email — the same two-line shape every
                            user picker uses. The highlighted row is filled
                            with `--accent` (a deep blue), so the name must
                            flip to `accent-foreground` (white). Hardcoding
                            `text-foreground` here would override CommandItem's
                            own highlight colour and leave black-on-blue. */}
                        <span className="truncate group-data-[selected=true]:text-accent-foreground">
                          {user.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground group-data-[selected=true]:text-accent-foreground/75">
                          {user.email ?? "—"}
                        </span>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
