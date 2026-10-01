'use client';

import { useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface InsightRowDescriptionProps {
  description: string | null | undefined;
  testId?: string;
}

/**
 * A list row's description line. Every row renders it, with a muted "No
 * description" when there is none, so rows keep one height. Long text is cut
 * to one line with an ellipsis. Hovering a cut-off line shows the whole text
 * in a tooltip below it, clear of the row's document preview, which opens to
 * the right. The full text stays in the DOM, so screen readers get all of it.
 */
export function InsightRowDescription({ description, testId }: InsightRowDescriptionProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const text = description?.trim() ?? '';

  if (!text) {
    return (
      <p className="truncate text-xs italic text-muted-foreground/60" data-testid={testId}>
        No description
      </p>
    );
  }

  return (
    <Tooltip
      open={open}
      // Only a line that is actually cut off opens: measured when the tooltip
      // asks to open, since the row width changes with the window.
      onOpenChange={(next) => {
        const el = ref.current;
        setOpen(next && !!el && el.scrollWidth > el.clientWidth);
      }}
    >
      <TooltipTrigger asChild>
        <p ref={ref} className="truncate text-xs text-muted-foreground" data-testid={testId}>
          {text}
        </p>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-sm whitespace-normal break-words">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
