'use client';

import { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { FIELD_HINT, FIELD_LABEL, FIELD_TEXT } from './parts';

/** One selectable entity, filed under a group heading. */
export interface EntityOption {
  /** The `<kind>:<id>` key this option sets. */
  key: string;
  name: string;
  /** English rendering of `name`, when one is recorded and differs from it.
   *  Shown under the name and matched on alongside it. */
  englishName?: string;
  group: string;
}

/**
 * A grouped, searchable single-select over investors, funds and assets.
 *
 * Distinct from the fund-management `Combobox`, which selects plain strings —
 * here the options carry a group heading, because "Startech Growth Fund VCC"
 * means something different depending on whether it is being picked as a holder
 * or as the thing being held.
 */
export function EntityCombobox({
  id,
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  options: EntityOption[];
  onChange: (key: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.key === value);

  const groups = Array.from(new Set(options.map((option) => option.group)));

  return (
    <div className="min-w-0">
      <Label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn('mt-1 h-8 w-full justify-between font-normal', FIELD_TEXT)}
          >
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {selected?.name ?? 'Search…'}
            </span>
            <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-[240px] p-0"
          /*
           * This combobox always renders inside a dialog, and the popover content
           * is portalled outside it — so the dialog's scroll lock, which listens
           * on the document, would otherwise swallow every wheel/touch event over
           * the option list and make a long list of investors or assets
           * unscrollable. Stopping propagation at the content keeps those events
           * from ever reaching the lock. (Radix's `modal` popover would also fix
           * the scroll, but a modal popover nested in a modal dialog leaves
           * `pointer-events: none` stuck on the body and kills the whole dialog.)
           */
          onWheel={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
        >
          <Command>
            <CommandInput placeholder="Search…" className={FIELD_TEXT} />
            <CommandList className="max-h-[260px]">
              <CommandEmpty>Nothing matches that.</CommandEmpty>
              {groups.map((group) => (
                <CommandGroup key={group} heading={group}>
                  {options
                    .filter((option) => option.group === group)
                    .map((option) => (
                      <CommandItem
                        key={option.key}
                        // cmdk matches on this string alone, so the English
                        // name has to be in it or a name typed in English
                        // finds nothing even though the row shows it.
                        value={`${option.name} ${option.englishName ?? ''} ${option.group}`}
                        onSelect={() => {
                          onChange(option.key);
                          setOpen(false);
                        }}
                        className={FIELD_TEXT}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="min-w-0 truncate">{option.name}</span>
                          {option.englishName && (
                            <span
                              className="min-w-0 truncate text-[10px] leading-tight text-muted-foreground"
                              title={option.englishName}
                            >
                              {option.englishName}
                            </span>
                          )}
                        </span>
                        {option.key === value && <span className="ml-2 text-primary">✓</span>}
                      </CommandItem>
                    ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {hint && <div className={cn('mt-1', FIELD_HINT)}>{hint}</div>}
    </div>
  );
}
