'use client';

import { useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
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
 * next merge. Renders nothing before the first generation has run.
 *
 * The trigger is a bare bell icon at both sidebar widths — the footer row it
 * sits in is deliberately just the user's name, this bell, and the overflow
 * menu, so there is no room for a label or an "Updated <date>" line.
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
          title="What’s new"
          className={cn(
            'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors',
            'hover:bg-sidebar-accent hover:text-sidebar-foreground',
          )}
        >
          <Bell className="h-4 w-4" />
          {unseen && (
            <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
          )}
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
