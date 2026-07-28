'use client';

import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import {
  CHANGELOG,
  groupChangelogByDay,
  latestChangelogDate,
  hasUnseenChanges,
  formatChangelogDate,
  type ChangeCategory,
} from '@/lib/changelog';

const PAGE_SIZE = 7;

const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  feature: 'New',
  improvement: 'Improved',
  fix: 'Fixed',
};

const CATEGORY_CLASS: Record<ChangeCategory, string> = {
  feature: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  improvement: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  fix: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

/**
 * "What's new" affordance in the sidebar footer. Lists changes merged to `main`,
 * grouped by the day they landed, newest first. Content comes from
 * `@/lib/changelog`, regenerated from git history on every push to `main`.
 *
 * A pulsing dot marks changes the viewer hasn't seen; opening the popover
 * records the latest change date in localStorage, clearing the dot until the
 * next merge. Renders nothing before the first generation has run. Collapses to
 * just its icon when the sidebar is in icon mode.
 */
export function ChangelogWidget() {
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useLocalStorage<string>('changelog:last-seen', '');
  const [visibleDays, setVisibleDays] = useState(PAGE_SIZE);

  const days = useMemo(() => groupChangelogByDay(CHANGELOG), []);
  const latest = useMemo(() => latestChangelogDate(CHANGELOG), []);
  const unseen = hasUnseenChanges(lastSeen, CHANGELOG);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && latest) setLastSeen(latest);
    if (!next) setVisibleDays(PAGE_SIZE);
  };

  const visibleDaySlice = days.slice(0, visibleDays);
  const hasMore = visibleDays < days.length;

  if (days.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="What’s new"
          className={cn(
            'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-sidebar-foreground/70 transition-colors',
            'hover:bg-sidebar-accent hover:text-sidebar-foreground',
            'group-data-[state=collapsed]:justify-center group-data-[state=collapsed]:px-0',
          )}
        >
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
            <Sparkles className="h-4 w-4" />
            {unseen && (
              <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col group-data-[state=collapsed]:hidden">
            <span className="font-medium text-sidebar-foreground/90">What’s new</span>
            {latest && (
              <span className="truncate text-[11px] text-sidebar-foreground/50">
                Updated {formatChangelogDate(latest)}
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-semibold">What’s new</p>
          <p className="text-xs text-muted-foreground">Recent changes to the Brain</p>
        </div>
        <div className="max-h-96 overflow-y-auto">
          <ol className="divide-y">
            {visibleDaySlice.map((day) => (
              <li key={day.date} className="px-4 py-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {formatChangelogDate(day.date)}
                </p>
                <ul className="flex flex-col gap-2.5">
                  {day.entries.map((entry) => (
                    <li key={entry.hash} className="flex gap-2">
                      <span
                        className={cn(
                          'shrink-0 self-stretch flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold',
                          CATEGORY_CLASS[entry.category],
                        )}
                      >
                        {CATEGORY_LABEL[entry.category]}
                      </span>
                      <span className="min-w-0 flex-1 text-sm leading-snug">{entry.subject}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {hasMore && (
            <div className="border-t px-4 py-2">
              <button
                type="button"
                onClick={() => setVisibleDays((v) => v + PAGE_SIZE)}
                className="w-full rounded py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
