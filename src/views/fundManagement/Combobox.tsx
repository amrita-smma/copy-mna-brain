'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Searchable single-select combobox. Selection is restricted to the provided
 * options (no free-text entry) — built on shadcn Command (cmdk) + Popover.
 *
 * When options contain opaque IDs rather than human-readable names, pass
 * `labelFor` to convert a value to its display label. cmdk will search/filter
 * by label and the trigger button will also show the label instead of the raw
 * value.
 */
export function Combobox({
  id,
  value,
  options,
  onChange,
  placeholder = 'Select…',
  emptyText = 'No match found.',
  labelFor,
  size = 'default',
  className,
  onCreate,
}: {
  id?: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  emptyText?: string;
  /** Optional: convert an option value to its display label (e.g. ID → name). */
  labelFor?: (v: string) => string;
  /** Trigger button size — use `sm` for compact inline grids. */
  size?: 'sm' | 'default';
  className?: string;
  /** Optional callback to create a new option when the typed search query matches no existing option. */
  onCreate?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const label = (v: string) => (labelFor ? labelFor(v) : v);

  const choose = (v: string) => {
    onChange(v);
    setQuery('');
    setOpen(false);
  };

  const trimmedQuery = query.trim();
  const hasExactMatch =
    trimmedQuery !== '' &&
    options.some((o) => label(o).trim().toLowerCase() === trimmedQuery.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          size={size}
          aria-expanded={open}
          className={cn('w-full justify-between font-normal', className)}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value ? label(value) : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>
              {onCreate && trimmedQuery && !hasExactMatch ? (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    onCreate(trimmedQuery);
                    setQuery('');
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onCreate(trimmedQuery);
                      setQuery('');
                      setOpen(false);
                    }
                  }}
                  className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                >
                  Create &ldquo;{trimmedQuery}&rdquo;
                </div>
              ) : (
                emptyText
              )}
            </CommandEmpty>
            {options.map((o) => (
              <CommandItem key={o} value={label(o)} onSelect={() => choose(value === o ? '' : o)}>
                <Check className={cn('mr-2 h-4 w-4', value === o ? 'opacity-100' : 'opacity-0')} />
                {label(o)}
              </CommandItem>
            ))}
            {onCreate && trimmedQuery && !hasExactMatch && (
              <CommandItem
                value={trimmedQuery}
                onSelect={() => {
                  onCreate(trimmedQuery);
                  setQuery('');
                  setOpen(false);
                }}
              >
                Create &ldquo;{trimmedQuery}&rdquo;
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
