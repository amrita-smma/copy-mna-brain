'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ExternalLink, Info, Languages, Newspaper } from 'lucide-react';
import { languageLabel } from '@/lib/languageNames';
import { CATEGORY_LABELS } from './FilterBar';
import { isSafeHttpUrl } from './newsLinkGuard';
import { displayBody, displaySummary, displayTitle, hasTranslation } from './translation';
import type { NewsItemDetail } from '@/lib/api/dataNavigator';

interface NewsPreviewProps {
  item: NewsItemDetail | null;
  loading: boolean;
}

export function NewsPreview({ item, loading }: NewsPreviewProps) {
  // Non-English items default to the English translation — that is the point
  // of translating them — and the reader can flip back per article.
  const [showOriginal, setShowOriginal] = useState(false);

  // Reset on navigation. The toggle is a per-article reading choice, not a
  // preference: without this, arrowing off a Japanese article left the next
  // one stuck in "original", which for a translated item means a pane the
  // reader can't read and for an English item means a dead toggle state.
  useEffect(() => {
    setShowOriginal(false);
  }, [item?.id]);

  if (loading) {
    return (
      <Card className="border bg-card p-8 text-sm text-muted-foreground">Loading article…</Card>
    );
  }

  if (!item) {
    return (
      <Card className="flex h-full flex-col items-center justify-center gap-2 border bg-card p-8 text-muted-foreground">
        <Newspaper className="h-8 w-8" />
        <p className="text-sm">Select an item to read it here.</p>
      </Card>
    );
  }

  const translated = hasTranslation(item);
  // `showOriginal` can only be true for a translated item — the toggle that
  // sets it is not rendered otherwise — but gate on both so a stale `true`
  // from the render before a navigation can never mis-select the fields.
  const original = translated && showOriginal;
  const sourceLanguage = translated ? languageLabel(item.language) : null;
  const body = displayBody(item, original);
  const summary = displaySummary(item, original);

  return (
    // `bg-card` is opaque on purpose — the shell paints a living background
    // behind the console, and long-form body copy needs a solid surface.
    <Card className="mx-auto max-w-3xl border bg-card">
      <article className="space-y-4 p-6">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge
              variant="secondary"
              className="px-2 py-0 text-[10px] font-medium uppercase tracking-wide"
            >
              {CATEGORY_LABELS[item.category] ?? item.category}
            </Badge>
            <span>{item.source_name}</span>
            {item.region && <span>· {item.region}</span>}
            {item.published_at && (
              <span>· {format(new Date(item.published_at), 'd MMM yyyy, HH:mm')}</span>
            )}
          </div>

          {/* h2, not h1: the page's single h1 is the "Data Navigator" title in
              the view header. Two h1s on one screen is a broken outline for
              anyone navigating by heading. */}
          {/* `lang` follows the text actually rendered, so a screen reader
              switches voice for the original and back for the translation. */}
          <h2
            lang={original ? (item.language ?? undefined) : 'en'}
            className="text-xl font-semibold leading-tight"
          >
            {displayTitle(item, original)}
          </h2>

          {item.authors && <p className="text-sm text-muted-foreground">By {item.authors}</p>}

          <div className="flex flex-wrap items-center gap-2">
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

            {translated && (
              <Button
                data-testid="news-translation-toggle"
                variant="outline"
                size="sm"
                aria-pressed={original}
                onClick={() => setShowOriginal((previous) => !previous)}
              >
                <Languages className="mr-1.5 h-3.5 w-3.5" />
                {original
                  ? 'Show English translation'
                  : sourceLanguage
                    ? `Display in ${sourceLanguage}`
                    : 'Display in original language'}
              </Button>
            )}
          </div>

          {translated && (
            // Stated once, in the header, rather than per field: the reader
            // needs to know a machine produced this copy before trusting a
            // figure in it, but repeating that under every paragraph would
            // crowd out the article.
            <p
              data-testid="news-translation-notice"
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {original
                ? `Original ${sourceLanguage ?? 'text'} as published.`
                : `Machine-translated${sourceLanguage ? ` from ${sourceLanguage}` : ''} — check figures against the original.`}
            </p>
          )}
        </header>

        <div className="border-t pt-4" lang={original ? (item.language ?? undefined) : 'en'}>
          {body ? (
            // Extracted plain text — render paragraphs, never dangerouslySetInnerHTML.
            <div className="space-y-3 text-sm leading-relaxed">
              {body
                .split(/\n{2,}/)
                .filter((p) => p.trim().length > 0)
                .map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
            </div>
          ) : (
            // No stored body — the item was never queued for extraction
            // (`none`), is still queued (`pending`), or exhausted its attempts
            // (`failed`, typically a paywall or consent wall). All three read
            // the same way to a user: this is the summary, the full text is one
            // click away. So show the summary as the body and label it once,
            // quietly — the old copy blamed the publisher in every case and
            // repeated on nearly every article.
            <div className="space-y-3">
              <p className="text-sm leading-relaxed">
                {summary?.trim() || 'No summary was published with this item.'}
              </p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0" />
                Summary only — open the original for the full article.
              </p>
            </div>
          )}
        </div>
      </article>
    </Card>
  );
}
