'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { countEntityRows, type LedgerIndex, type SearchEntity } from '@/lib/fundLedger';

const GROUP_ORDER: SearchEntity['group'][] = [
  'Investors',
  'Funds',
  'Assets',
  'Sources of fund',
];

/**
 * Find an investor, fund, asset or capital pool by name; picking one adds it as
 * a filter chip rather than navigating anywhere.
 *
 * The bar on the page is the input you type into — results drop down under it,
 * so there is never a second search box to move focus to. cmdk keeps the list
 * and the keyboard nav (arrows/enter) but does no filtering of its own
 * (`shouldFilter={false}`): matching happens here so a name and its meta line
 * are searched as one string.
 *
 * Each result carries how many rows mention it, so an entity with no ledger
 * history is visibly a dead end before you click it.
 */
export function EntitySearch({
  index,
  onPick,
}: {
  index: LedgerIndex;
  onPick: (entity: SearchEntity) => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // A press anywhere outside the bar and its dropdown dismisses the list. The
  // dropdown lives inside the same root, so selecting a result is not an
  // "outside" press and still reaches the item's onSelect.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Row counts walk every entry per entity, so they are computed once per
  // index rather than on each keystroke.
  const counts = useMemo(() => {
    const byId = new Map<string, number>();
    for (const entity of index.searchEntities) {
      byId.set(entity.id, countEntityRows(entity, index));
    }
    return byId;
  }, [index]);

  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return GROUP_ORDER.map((group) => ({
      group,
      entities: index.searchEntities.filter(
        (entity) =>
          entity.group === group &&
          // The pool type, the investor kind and the English name are matched
          // alongside the name, so "feeder" or "SPV" finds its entities too and
          // an entity recorded in Chinese is reachable by typing its English
          // name — the same string the row displays.
          (needle === '' ||
            `${entity.name} ${entity.englishName ?? ''} ${entity.meta}`
              .toLowerCase()
              .includes(needle)),
      ),
    })).filter((section) => section.entities.length > 0);
  }, [index, search]);

  return (
    <Command
      ref={rootRef}
      shouldFilter={false}
      className="relative w-full max-w-[470px] overflow-visible bg-transparent"
      // Tabbing out of the bar dismisses the list the way the popover used to
      // on focus-outside. A click on a result gives a null relatedTarget
      // (cmdk items aren't focusable), so this can't cancel a selection.
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !rootRef.current?.contains(next)) setOpen(false);
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
          // Down re-opens a list dismissed with Escape, since focus never left
          // the input and onFocus won't fire again.
          if (event.key === 'ArrowDown' && !open) {
            setOpen(true);
            return;
          }
          // cmdk's root moves the list selection on Home/End and preventDefaults
          // them. This is a text field, so those keys belong to the caret.
          if (event.key === 'Home' || event.key === 'End') event.stopPropagation();
        }}
        placeholder="Search an investor, fund, asset or source of fund"
        className="h-9 pl-9 text-[13px]"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-50 w-full min-w-[340px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <CommandList id={listId} className="max-h-[340px]">
            <CommandEmpty>Nothing matches that.</CommandEmpty>
            {grouped.map(({ group, entities }) => (
              <CommandGroup key={group} heading={group}>
                {entities.map((entity) => {
                  const rows = counts.get(entity.id) ?? 0;
                  return (
                    <CommandItem
                      key={`${entity.kind}:${entity.id}`}
                      value={`${entity.kind}:${entity.id}`}
                      onSelect={() => {
                        onPick(entity);
                        setSearch('');
                        setOpen(false);
                      }}
                      className={cn('gap-2 text-[12px]', rows === 0 && 'opacity-50')}
                    >
                      <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-semibold text-muted-foreground">
                        {entity.badge}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="min-w-0 truncate">{entity.name}</span>
                        {entity.englishName && (
                          <span
                            className="min-w-0 truncate text-[10px] leading-tight text-muted-foreground"
                            title={entity.englishName}
                          >
                            {entity.englishName}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {rows ? `${rows} row${rows === 1 ? '' : 's'}` : 'no rows'}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </div>
      )}
    </Command>
  );
}
