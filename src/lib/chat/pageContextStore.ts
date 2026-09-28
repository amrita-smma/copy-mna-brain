import { useSyncExternalStore } from 'react';
import {
  type InsightSectionRef,
  type PageContext,
  insightSectionRefId,
} from './pageContext';

/**
 * Module-level holder for the current page context.
 *
 * A plain singleton rather than React context because the two ends live on
 * opposite sides of the provider tree: `PageContextProvider` sits inside the
 * workspace layout (it needs the route), while `ChatProvider` — whose transport
 * body has to read this on every send — is mounted all the way up at the app
 * root. One shell renders per browser tab, so a single slot is exactly right.
 */
let current: PageContext | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribePageContext(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

/** Replace the context the next chat turn will carry. */
export function setPageContext(context: PageContext | null): void {
  current = context;
  notify();
}

/** The context to send with this turn, or `null` when nothing is known. */
export function getPageContext(): PageContext | null {
  return current;
}

/** Drop the stored context. Called when the shell unmounts. */
export function clearPageContext(): void {
  current = null;
  notify();
}

/**
 * Replace the insight section selection, leaving the rest of the context alone.
 *
 * The store — not the view — is the single source of truth for the selection,
 * because both ends can change it: the user clicks a block inside the insight
 * frame, or removes a chip in the chat composer.
 */
export function setInsightSections(refs: InsightSectionRef[]): void {
  if (!current) {
    if (refs.length === 0) return;
    current = {
      tabSlug: 'insight',
      path: typeof window !== 'undefined' ? window.location.pathname : '',
      insightSections: refs,
    };
    notify();
    return;
  }
  const existing = current.insightSections ?? [];
  if (
    existing.length === refs.length &&
    existing.every((r, i) => insightSectionRefId(r) === insightSectionRefId(refs[i]))
  ) {
    return;
  }
  const { insightSections: _dropped, ...rest } = current;
  current = refs.length > 0 ? { ...rest, insightSections: refs } : rest;
  notify();
}

/** Drop one section from the selection. */
export function clearInsightSection(id: string): void {
  const existing = current?.insightSections ?? [];
  setInsightSections(existing.filter((r) => insightSectionRefId(r) !== id));
}

/** Drop the whole selection. */
export function clearAllInsightSections(): void {
  setInsightSections([]);
}

const getServerSnapshot = (): PageContext | null => null;

/** Hook subscribing to page context changes via useSyncExternalStore. */
export function usePageContext(): PageContext | null {
  return useSyncExternalStore(subscribePageContext, getPageContext, getServerSnapshot);
}

/**
 * The insight open in the center console and the sector agent it is bound to
 * (MB-549), for the CoPilot header's "what would this chat run on" preview and
 * for switching threads when the open insight's agent differs from the current
 * thread's. Display-only: it never travels to the server — the chat route
 * resolves the agent from `page_context.insightId` itself.
 */
export interface OpenInsightAgent {
  insightId: string;
  /** The raw bound key, null when the insight has no sector agent. */
  agentKey: string | null;
}

let openInsightAgent: OpenInsightAgent | null = null;
const openInsightListeners = new Set<Listener>();

function subscribeOpenInsightAgent(l: Listener): () => void {
  openInsightListeners.add(l);
  return () => {
    openInsightListeners.delete(l);
  };
}

export function getOpenInsightAgent(): OpenInsightAgent | null {
  return openInsightAgent;
}

/** Publish (or clear, with `null`) the open insight's binding. */
export function setOpenInsightAgent(next: OpenInsightAgent | null): void {
  if (
    openInsightAgent?.insightId === next?.insightId &&
    openInsightAgent?.agentKey === next?.agentKey
  ) {
    return;
  }
  openInsightAgent = next;
  for (const listener of Array.from(openInsightListeners)) {
    listener();
  }
}

/**
 * Clear the slot only if it still describes `insightId`, so an unmounting view
 * never wipes the binding the next insight's view just published.
 */
export function clearOpenInsightAgent(insightId: string): void {
  if (openInsightAgent?.insightId === insightId) setOpenInsightAgent(null);
}

const getOpenInsightServerSnapshot = (): OpenInsightAgent | null => null;

export function useOpenInsightAgent(): OpenInsightAgent | null {
  return useSyncExternalStore(
    subscribeOpenInsightAgent,
    getOpenInsightAgent,
    getOpenInsightServerSnapshot,
  );
}
