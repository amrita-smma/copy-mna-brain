import { Skeleton } from '@/components/ui/skeleton';

/**
 * Suspense fallback for everything under `/w/[workspaceSlug]`.
 *
 * Without a boundary here the whole route is withheld until the page segment
 * finishes its own server work (feature-flag resolution, and the admin check on
 * the graph page), so the browser gets no HTML at all. With it, the workspace
 * layout — sidebar, copilot pane, the rest of the shell — streams as soon as it
 * resolves and this stands in for the page body until it arrives. It also gives
 * soft navigations between console tabs an instant response instead of leaving
 * the previous page on screen.
 *
 * Deliberately generic: one shell-shaped placeholder beats per-page skeletons
 * that drift out of sync with the pages they stand in for.
 */
export default function WorkspaceLoading() {
  return (
    <div className="flex h-full w-full flex-col gap-6 p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
