'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * A plain-English definition for a piece of jargon.
 *
 * `t` = title, `d` = description, `e` = optional footnote naming the industry
 * term, for readers who already know it by another name.
 */
export interface GlossaryEntry {
  t: string;
  d: string;
  e?: string;
}

/**
 * A dotted term that reveals its definition on hover.
 *
 * Takes the entry rather than a key so each page can keep its own vocabulary:
 * "Commitment" means something slightly different on the fund-management page
 * than it does on the ledger, and neither should have to reach into the
 * other's glossary to say so.
 */
export function GlossaryTerm({
  entry,
  children,
  className,
}: {
  /** The definition to show. When absent the children render undecorated. */
  entry: GlossaryEntry | undefined;
  children: ReactNode;
  className?: string;
}) {
  if (!entry) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'cursor-help border-b border-dotted border-muted-foreground/60 hover:border-accent hover:text-accent',
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">
        <div className="text-xs font-semibold text-foreground">{entry.t}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.d}</div>
        {entry.e && (
          <div className="mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground">{entry.e}</div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
