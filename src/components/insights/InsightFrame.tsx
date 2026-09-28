'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import type { InsightSectionRef } from '@/lib/chat/pageContext';
import {
  INSIGHT_PRIME_TIMEOUT_MS,
  INSIGHT_SANDBOX,
  INSIGHT_SELECT_MODE_MESSAGE,
  buildInsightPrimerSrcDoc,
  buildInsightSrcDoc,
  isInsightFrameReadyMessage,
  isInsightHeightMessage,
  isInsightPickMessage,
  isInsightSectionsMessage,
  type InsightTheme,
} from '@/lib/insights/srcdoc';

export interface InsightFrameProps {
  /** The document exactly as authored. Never sanitized — see below. */
  html: string;
  /** Accessible name for the frame. */
  title: string;
  /** Height before the document reports its own, and the floor thereafter. */
  minHeight?: number;
  /** Cap past which the frame scrolls internally rather than growing. */
  maxHeight?: number;
  /**
   * Arms click-to-select in the document.
   *
   * The open insight passes whatever the page toolbar's select-mode toggle
   * says; the previews that are NOT the open insight — the approval cards and
   * the version-history dialog — never pass it, so they stay disarmed.
   */
  selectMode?: boolean;
  /** The refs currently selected, mirrored into the document's outlines. */
  selectedSections?: InsightSectionRef[];
  /** Called with the new section ref list, in document order, on every toggle. */
  onSectionsChange?: (sections: InsightSectionRef[]) => void;
  /** Called when the user picks or unpicks an element in the frame. `count` is
   *  the size of the whole selection the pick speaks for, not always 1. */
  onPick?: (
    pick: {
      ref: InsightSectionRef;
      rect: { top: number; left: number; width: number; height: number };
      label: string;
      count: number;
      session: number;
    } | null,
  ) => void;
}

/** A stable empty list, so the "tell the frame" effect doesn't re-fire per render. */
const NO_SECTIONS: InsightSectionRef[] = [];

const DEFAULT_MIN_HEIGHT = 320;
const DEFAULT_MAX_HEIGHT = 20000;

/**
 * Renders an insight document in an isolated frame.
 *
 * This is the ONLY place an insight's HTML may be rendered. It is deliberately
 * unsanitized — an insight is allowed its own CSS, scripts and SVG, which is
 * the whole point of the format — and the isolation is what makes that safe:
 *
 *  - `sandbox` without `allow-same-origin` puts the document in an opaque
 *    origin, so it cannot read our cookies or storage, call our API as the user,
 *    or touch the parent DOM.
 *  - A CSP injected ahead of the author's first byte (see `srcdoc.ts`) stops it
 *    sending anything out.
 *
 * Rendering insight HTML through `dangerouslySetInnerHTML` anywhere would put
 * it back in the app's origin and undo both. Use this component instead —
 * including in previews and approval cards, where the document is least trusted.
 */
export function InsightFrame({
  html,
  title,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
  selectMode = false,
  selectedSections = NO_SECTIONS,
  onSectionsChange,
  onPick,
}: InsightFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const { resolvedTheme } = useTheme();
  const theme: InsightTheme = resolvedTheme === 'dark' ? 'dark' : 'light';
  const srcDoc = useMemo(() => buildInsightSrcDoc(html, { theme }), [html, theme]);
  // The insight loads only after the primer has seen the frame laid out — see
  // buildInsightPrimerSrcDoc. Once primed, html and theme changes load directly:
  // the frame is already sized, so later documents parse at their real width.
  const [primed, setPrimed] = useState(false);

  useEffect(() => {
    if (primed) return;
    function onReady(event: MessageEvent) {
      if (isInsightFrameReadyMessage(event, frameRef.current)) setPrimed(true);
    }
    window.addEventListener('message', onReady);
    const timer = setTimeout(() => setPrimed(true), INSIGHT_PRIME_TIMEOUT_MS);
    return () => {
      window.removeEventListener('message', onReady);
      clearTimeout(timer);
    };
  }, [primed]);

  // Read by the load handler, which has to re-send the current state to a
  // document that has just replaced itself (a theme flip rebuilds the srcdoc).
  const armed = useRef({ selectMode, selectedSections });
  armed.current = { selectMode, selectedSections };

  const postSelectMode = useCallback(() => {
    // '*' is the only usable target: the frame has an opaque origin, and the
    // message carries nothing but display state.
    frameRef.current?.contentWindow?.postMessage(
      {
        type: INSIGHT_SELECT_MODE_MESSAGE,
        active: armed.current.selectMode,
        selected: armed.current.selectedSections,
      },
      '*',
    );
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (isInsightHeightMessage(event, frameRef.current)) {
        setHeight(Math.min(Math.max(event.data.height, minHeight), maxHeight));
        return;
      }
      if (isInsightSectionsMessage(event, frameRef.current)) {
        // A null list is the document announcing itself on load, not a
        // selection — reporting it as one would wipe the selection the host
        // is holding every time the srcdoc is rebuilt.
        if (event.data.sections) onSectionsChange?.(event.data.sections);
        return;
      }
      if (isInsightPickMessage(event, frameRef.current)) {
        if (event.data.ref && event.data.rect) {
          // Clamp label to 80 chars and strip control characters where it enters the host
          const label = event.data.label
            .replace(/[\x00-\x1F\x7F]/g, '')
            .slice(0, 80);
          onPick?.({
            ref: event.data.ref,
            rect: event.data.rect,
            label,
            count: event.data.count ?? 1,
            session: event.data.session ?? 0,
          });
        } else {
          onPick?.(null);
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [minHeight, maxHeight, onSectionsChange, onPick]);

  useEffect(() => {
    postSelectMode();
  }, [postSelectMode, selectMode, selectedSections]);

  // A document that never reports (scripts disabled, parse error) keeps the
  // starting height rather than collapsing to nothing.
  useEffect(() => {
    setHeight(minHeight);
  }, [html, theme, minHeight]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={INSIGHT_SANDBOX}
      srcDoc={primed ? srcDoc : buildInsightPrimerSrcDoc(theme)}
      onLoad={postSelectMode}
      style={{ width: '100%', height, border: 'none', display: 'block' }}
      // Referrer would otherwise leak the workspace URL to the CDN hosts.
      referrerPolicy="no-referrer"
      // Deliberately NOT lazy: an approval card is the only place a change is
      // judged, and a card below the fold in the chat transcript must not show
      // an empty box until it happens to be scrolled into view.
    />
  );
}
