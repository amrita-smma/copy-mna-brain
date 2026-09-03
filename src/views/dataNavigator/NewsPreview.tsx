'use client';

import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { ExternalLink, Newspaper } from 'lucide-react';
import { CATEGORY_LABELS } from './FilterBar';
import { isSafeHttpUrl } from './newsLinkGuard';
import type { NewsItemDetail } from '@/lib/api/dataNavigator';

interface NewsPreviewProps {
  item: NewsItemDetail | null;
  loading: boolean;
}

export function NewsPreview({ item, loading }: NewsPreviewProps) {
  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading article…</div>;
  }

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Newspaper className="h-8 w-8" />
        <p className="text-sm">Select an item to read it here.</p>
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-3xl space-y-4 p-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 uppercase tracking-wide">
            {CATEGORY_LABELS[item.category] ?? item.category}
          </span>
          <span>{item.source_name}</span>
          {item.region && <span>· {item.region}</span>}
          {item.published_at && (
            <span>· {format(new Date(item.published_at), 'd MMM yyyy, HH:mm')}</span>
          )}
        </div>

        <h1 className="text-xl font-semibold leading-tight">{item.title}</h1>

        {item.authors && <p className="text-sm text-muted-foreground">By {item.authors}</p>}

        {isSafeHttpUrl(item.link) ? (
          <Button asChild variant="outline" size="sm">
            <a href={item.link} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Read original
            </a>
          </Button>
        ) : (
          // Ingest already rejects non-http(s) links for new rows, but an
          // older row could predate that guard — never render a raw
          // javascript:/data: URI as a clickable href.
          <p className="text-xs text-muted-foreground">
            Original link unavailable for this item.
          </p>
        )}
      </header>

      {item.content_text ? (
        // Extracted plain text — render paragraphs, never dangerouslySetInnerHTML.
        <div className="space-y-3 text-sm leading-relaxed">
          {item.content_text
            .split(/\n{2,}/)
            .filter((p) => p.trim().length > 0)
            .map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed">{item.summary ?? 'No preview available.'}</p>
          <p className="text-xs text-muted-foreground">
            {item.content_status === 'failed'
              ? 'The full article could not be retrieved from the publisher — use “Read original” above.'
              : 'The full article has not been fetched for this item.'}
          </p>
        </div>
      )}
    </article>
  );
}
