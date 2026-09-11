'use client';

import { useState } from 'react';
import { MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * The per-row `⋮` menu.
 *
 * "Reverse this event" posts an append-only reversal event that negates the
 * original economic deltas while keeping full audit history.
 */
export function RowMenu({
  entryId,
  isReversal = false,
  onOpenPosition,
  onReverse,
}: {
  entryId: string;
  isReversal?: boolean;
  onOpenPosition: () => void;
  onReverse: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(entryId);
      setCopied(true);
      setTimeout(() => setCopied(false), 900);
    } catch {
      // A clipboard the browser won't hand over isn't worth an error toast —
      // the id is visible in the Ref column either way.
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Row actions"
        className="rounded p-0.5 text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-muted focus:opacity-100 group-hover/sheet-row:opacity-100 data-[state=open]:opacity-100"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => void copyId()}>
          {copied ? 'Copied' : 'Copy entry ID'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenPosition}>Open the position</DropdownMenuItem>
        <DropdownMenuItem
          disabled={isReversal}
          onSelect={isReversal ? undefined : onReverse}
          className={
            isReversal
              ? 'opacity-50 cursor-not-allowed'
              : 'text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400'
          }
        >
          Reverse this event
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
