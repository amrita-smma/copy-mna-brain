import type { PageContext } from './pageContext';

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

/** Replace the context the next chat turn will carry. */
export function setPageContext(context: PageContext | null): void {
  current = context;
}

/** The context to send with this turn, or `null` when nothing is known. */
export function getPageContext(): PageContext | null {
  return current;
}

/** Drop the stored context. Called when the shell unmounts. */
export function clearPageContext(): void {
  current = null;
}
