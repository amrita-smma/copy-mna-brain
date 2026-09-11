"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Single-line reason cell for the ledger upload review tables.
 * The text never wraps: it is clamped to the column width with an ellipsis and
 * the full reason is revealed on hover.
 */
export function ReasonCell({ reason }: { reason?: string | null }) {
  const text = reason?.trim();
  if (!text) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block max-w-[220px] cursor-help truncate whitespace-nowrap text-[11px] text-muted-foreground"
          title={text}
        >
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm whitespace-normal text-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
