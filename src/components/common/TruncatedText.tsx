'use client';

import { useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface TruncatedTextProps {
  text: string;
  className?: string;
}

/**
 * One line of text cut with an ellipsis. Hovering or focusing a line that is
 * actually cut off shows the whole text in a tooltip; a line that fits shows
 * none. Overflow is measured when the tooltip asks to open, since the cell
 * width changes with the window.
 */
export function TruncatedText({ text, className }: TruncatedTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const el = ref.current;
        setOpen(next && !!el && el.scrollWidth > el.clientWidth);
      }}
    >
      <TooltipTrigger asChild>
        <span ref={ref} className={cn('truncate', className)}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-sm whitespace-normal break-words text-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
