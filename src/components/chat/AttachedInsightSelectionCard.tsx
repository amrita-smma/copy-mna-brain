'use client';

import { SquareDashedMousePointer } from 'lucide-react';
import { formatInsightSectionLabel } from '@/lib/chat/pageContext';
import type { InsightSelectionAttachment } from '@/lib/insights/selectionAttachment';

/**
 * The insight elements a sent message was asked about, shown beside the file
 * attachment pills rather than as an address spelled out in the message. The
 * chip names only what was picked; the tooltip adds which insight it is in and,
 * for a multi-element pick, every element.
 */
export function AttachedInsightSelectionCard({
  selection,
}: {
  selection: InsightSelectionAttachment;
}) {
  const { insightName, sections } = selection;
  const labels = sections.map(formatInsightSectionLabel);
  const label = labels.length === 1 ? labels[0] : `${labels.length} elements`;
  const title =
    labels.length === 1
      ? `${label} in ${insightName}`
      : [`${label} in ${insightName}:`, ...labels.map((l) => `• ${l}`)].join('\n');

  return (
    <div
      tabIndex={0}
      aria-label={`Selected: ${title}`}
      title={title}
      className="flex items-center gap-2 px-3 py-2 h-10 rounded-lg border bg-muted text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="attached-insight-selection"
    >
      <SquareDashedMousePointer className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="text-xs text-muted-foreground">Selected</span>
      <span className="truncate max-w-[220px] font-medium">{label}</span>
    </div>
  );
}
