'use client';

import { useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { CHAT_LINK_CLICKED, chatLinkProperties, type ChatSurface } from '@/lib/posthog-chat';
import { STALE_SOURCE_MONTHS, isStaleSource, type CitationSource } from '@/lib/chat/citations';

/** Long enough to cross the gap from the chip to the card without it closing. */
const CLOSE_DELAY_MS = 150;

const initialOf = (source: string) => (source.trim().charAt(0) || '?').toUpperCase();

const staleOf = (c: CitationSource) => (c.date ? isStaleSource(new Date(c.date)) : false);

/**
 * The sources behind one statement, drawn beside it as a single chip — the
 * first source's initial and name, "+N" for the rest — with a card listing
 * every source's publisher, headline and date. The card opens on hover with a
 * mouse, and on tap or Enter everywhere else, since touch has no hover. Amber
 * when any source is older than `STALE_SOURCE_MONTHS`.
 */
export function CitationGroup({
  citations,
  linkSurface,
}: {
  citations: CitationSource[];
  linkSurface?: ChatSurface;
}) {
  const [open, setOpen] = useState(false);
  // A hover-opened card closes when the pointer leaves; a click pins it.
  const openedByHover = useRef(false);
  // Opened from the keyboard: focus moves into the card so its links are
  // reachable. A pointer leaves focus where it is.
  const openedByKeyboard = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (openedByHover.current) setOpen(false);
    }, CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);

  if (citations.length === 0) return null;
  const [first] = citations;
  const more = citations.length - 1;
  const stale = citations.some(staleOf);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) openedByHover.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-citation-group"
          data-citation={stale ? 'stale' : first.date ? 'dated' : 'undated'}
          aria-label={`Sources: ${citations.map((c) => c.source).join(', ')}`}
          onPointerEnter={(e) => {
            if (e.pointerType !== 'mouse') return;
            cancelClose();
            if (!open) {
              openedByHover.current = true;
              setOpen(true);
            }
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') scheduleClose();
          }}
          onClick={(e) => {
            const wasHover = open && openedByHover.current;
            openedByHover.current = false;
            openedByKeyboard.current = e.detail === 0;
            // Pin a hover-opened card instead of letting Radix toggle it shut.
            if (wasHover) e.preventDefault();
          }}
          className={cn(
            'ml-1.5 inline-flex h-[22px] max-w-[14rem] items-center gap-1.5 rounded-full border border-transparent bg-muted py-0 pl-[3px] pr-2 align-middle',
            'text-[11px] font-semibold leading-none text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            stale &&
              'border-amber-500 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900 dark:hover:text-amber-50',
          )}
        >
          <span
            aria-hidden
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-card text-[8px] font-bold text-primary"
          >
            {initialOf(first.source)}
          </span>
          <span className="truncate">{first.source}</span>
          {more > 0 && <span className="shrink-0 font-normal opacity-80">+{more}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        collisionPadding={16}
        onOpenAutoFocus={(e) => {
          if (!openedByKeyboard.current) e.preventDefault();
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') cancelClose();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') scheduleClose();
        }}
        className="max-h-[min(360px,calc(100vh-48px))] w-[360px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-2xl p-1.5 shadow-lg"
        data-testid="chat-citation-card"
      >
        {citations.map((c, i) => {
          const rowStale = staleOf(c);
          return (
            <a
              key={c.url}
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                if (!linkSurface) return;
                posthog.capture(
                  CHAT_LINK_CLICKED,
                  chatLinkProperties({ href: c.url, surface: linkSurface, linkText: `${c.source}, ${c.dateText}` }),
                );
              }}
              className={cn(
                'flex flex-col gap-1.5 rounded-lg px-3 py-3 text-inherit no-underline hover:bg-muted',
                i > 0 && 'border-t border-border',
              )}
            >
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-muted text-[8px] font-bold text-primary"
                >
                  {initialOf(c.source)}
                </span>
                <span className="truncate">{c.source}</span>
              </span>
              <span className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{c.title}</span>
              <span
                className={cn('text-xs tabular-nums', rowStale ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}
                title={rowStale ? `Dated source: published over ${STALE_SOURCE_MONTHS} months ago` : undefined}
              >
                {c.date ? c.dateText : 'Undated'}
                {rowStale ? ' · dated' : ''}
              </span>
            </a>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
