'use client';

import { LayoutTemplate } from 'lucide-react';
import { HtmlHoverPreview } from '@/components/insights/HtmlHoverPreview';
import { getInsightTemplateHtml } from '@/lib/api/insightTemplates';
import { createLruCache } from '@/lib/insights/lruCache';
import type { InsightTemplateAttachment } from '@/lib/insights/templateAttachment';

const attachedTemplatePreviewCache = createLruCache(12);

/**
 * The insight template attached to a sent message, shown beside the file
 * attachment pills rather than as words in the message. Hover previews the
 * template (a deleted template shows the preview's own failure state).
 */
export function AttachedInsightTemplateCard({ template }: { template: InsightTemplateAttachment }) {
  return (
    <HtmlHoverPreview
      id={template.id}
      title={template.name}
      fetchHtml={getInsightTemplateHtml}
      cache={attachedTemplatePreviewCache}
    >
      {/* Focusable, so the hover preview also opens on keyboard focus. */}
      <div
        tabIndex={0}
        aria-label={`Template: ${template.name}`}
        className="flex items-center gap-2 px-3 py-2 h-10 rounded-lg border bg-muted text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="attached-insight-template"
      >
        <LayoutTemplate className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs text-muted-foreground">Template</span>
        <span className="truncate max-w-[180px] font-medium" title={template.name}>
          {template.name}
        </span>
      </div>
    </HtmlHoverPreview>
  );
}
