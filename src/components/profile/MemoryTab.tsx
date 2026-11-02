'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Brain, Loader2, MessagesSquare, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  clearProfileMemories,
  deleteProfileMemory,
  getProfileMemories,
  setProfileMemoryEnabled,
  type UserMemoryItem,
} from '@/lib/api/profileMemory';
import MemoryImportDialog from './MemoryImportDialog';

/**
 * Memories per page. Enough that most users never page at all, with "Load more"
 * below for the ones who do — older memories must stay reachable, because this
 * tab is the only place to delete one.
 */
const PAGE_SIZE = 50;

/** "3 days ago", or null when the timestamp is missing or unparseable. */
function relativeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Profile → Memory: everything the CoPilot remembers about the signed-in user,
 * where it came from, and the ways to change it — switch memory off, forget
 * one, forget all, or import a dump from another tool.
 *
 * Memory is scoped to the person, not to a workspace, so this is the same list
 * whichever workspace you are in.
 *
 * Every memory on this page was written by an LLM reading a conversation, so
 * the list is also the correction surface — if something here is wrong, the fix
 * is to delete it.
 */
export default function MemoryTab() {
  const [items, setItems] = useState<UserMemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [available, setAvailable] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [savingPreference, setSavingPreference] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Turning memory OFF and deleting a single memory are both confirmed. Each
  // is derived from the record it concerns, never a standalone boolean.
  const [pendingDelete, setPendingDelete] = useState<UserMemoryItem | null>(null);
  const [confirmOffOpen, setConfirmOffOpen] = useState(false);

  /** Reload from the top. Used on mount, after an import, and after a retry. */
  const fetchMemories = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await getProfileMemories({ limit: PAGE_SIZE });
      setItems(data.items);
      setTotal(data.total);
      setHasMore(data.hasMore);
      setAvailable(data.available);
      setEnabled(data.enabled);
    } catch (err) {
      console.error('Failed to load memories', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Appends the next page. Offset comes from how many rows are already on
  // screen, so a memory deleted in between shifts the window by one rather
  // than skipping a row — acceptable for a newest-first review list, and
  // cheaper than keyset paging over a table this small.
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const data = await getProfileMemories({ limit: PAGE_SIZE, offset: items.length });
      setItems((current) => [...current, ...data.items]);
      setTotal(data.total);
      setHasMore(data.hasMore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load more memories');
    } finally {
      setLoadingMore(false);
    }
  }, [items.length]);

  useEffect(() => {
    void fetchMemories();
  }, [fetchMemories]);

  const handleForget = useCallback(async (id: string) => {
    setPendingDelete(null);
    setDeletingId(id);
    try {
      await deleteProfileMemory(id);
      // Dropped locally rather than refetched: one removal cannot change
      // anything else on the page, and a refetch would flash the whole list.
      setItems((current) => current.filter((item) => item.id !== id));
      setTotal((current) => Math.max(current - 1, 0));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not forget that memory');
    } finally {
      setDeletingId(null);
    }
  }, []);

  // Optimistic: the switch moves immediately and rolls back on failure. The
  // call writes one boolean, so a pending round-trip under the thumb reads as
  // lag rather than as care.
  const applyToggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setSavingPreference(true);
      try {
        const { enabled: stored } = await setProfileMemoryEnabled(next);
        setEnabled(stored);
      } catch (err) {
        setEnabled(previous);
        toast.error(
          err instanceof Error ? err.message : 'Could not change your memory setting',
        );
      } finally {
        setSavingPreference(false);
      }
    },
    [enabled],
  );

  // Turning it ON is harmless and immediate. Turning it OFF stops the CoPilot
  // learning and stops it using what it knows, which is worth a beat.
  const handleToggle = useCallback(
    (next: boolean) => {
      if (next) {
        void applyToggle(true);
        return;
      }
      setConfirmOffOpen(true);
    },
    [applyToggle],
  );

  const handleForgetAll = useCallback(async () => {
    try {
      const { deleted } = await clearProfileMemories();
      setItems([]);
      setTotal(0);
      setHasMore(false);
      toast.success(
        deleted > 0
          ? `Forgot ${deleted} ${deleted === 1 ? 'memory' : 'memories'}.`
          : 'There was nothing to forget.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not clear your memories');
    }
  }, []);

  if (loading) {
    return (
      <div
        className="mx-auto flex w-full max-w-xl flex-col gap-4"
        data-testid="memory-tab-loading"
      >
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-xl rounded-xl border bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">Could not load your memories.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={fetchMemories}>
          Try again
        </Button>
      </div>
    );
  }

  // The deployment switch is off (or there is no model to extract with) —
  // nothing the user can do about it, so no toggle is offered.
  if (!available) {
    return (
      <div
        className="mx-auto w-full max-w-xl rounded-xl border bg-card p-6 text-center"
        data-testid="memory-tab-off"
      >
        <Brain className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">CoPilot memory is turned off</p>
        <p className="mt-1 text-sm text-muted-foreground">
          It has been switched off for this deployment, so nothing is being
          remembered.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4" data-testid="memory-tab">
      <div className="flex items-start justify-between gap-4 rounded-xl border bg-card p-4">
        <div className="flex min-w-0 flex-col gap-1">
          <label
            htmlFor="memory-enabled"
            className="text-sm font-medium leading-none"
          >
            Remember me across conversations
          </label>
          <p className="text-sm text-muted-foreground">
            When off, the CoPilot stops learning from your chats and stops using what
            it already knows. Memories below are kept until you delete them.
          </p>
        </div>
        <Switch
          id="memory-enabled"
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={savingPreference}
          aria-label="Remember me across conversations"
          data-testid="memory-enabled-toggle"
        />
      </div>

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-4">
          <p className="text-sm text-muted-foreground">
            {total === 0
              ? 'The CoPilot has not learned anything about you yet.'
              : `${total} ${total === 1 ? 'memory' : 'memories'}.`}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(true)}
              // An import into a switched-off memory is refused by the server;
              // don't offer the dialog just to fail in it.
              disabled={!enabled}
              title={
                enabled
                  ? undefined
                  : 'Turn memory on to import from another location'
              }
              data-testid="memory-import-open"
            >
              <Upload className="mr-2 h-4 w-4" />
              Import memory from another location
            </Button>
            {total > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" data-testid="memory-forget-all">
                    Forget all
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Forget everything?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The CoPilot will forget all {total} {total === 1 ? 'memory' : 'memories'}{' '}
                      it has about you. Your chats are not affected, and it will start
                      learning again from your next conversation. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleForgetAll}
                      className="bg-red-600 hover:bg-red-700 focus-visible:ring-red-600"
                    >
                      Forget all
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        {items.length === 0 ? (
          <div className="border-t px-4 py-8 text-center" data-testid="memory-empty">
            <Brain className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              {enabled
                ? 'Ask the CoPilot a few questions and it will start remembering what you work on — or import what another tool already knows.'
                : 'Memory is switched off, so nothing new is being learned. Turn it back on above to start again.'}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y border-t" data-testid="memory-list">
            {items.map((item) => (
              <MemoryCard
                key={item.id}
                item={item}
                deleting={deletingId === item.id}
                onForget={() => setPendingDelete(item)}
              />
            ))}
          </ul>
        )}

        {hasMore && (
          <div className="flex flex-col items-center gap-1.5 border-t px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={loadMore}
              disabled={loadingMore}
              data-testid="memory-load-more"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading…
                </>
              ) : (
                'Load more'
              )}
            </Button>
            <p className="text-xs text-muted-foreground">
              Showing the {items.length} most recent of {total}.
            </p>
          </div>
        )}
      </section>

      <MemoryImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchMemories}
      />

      {/* Derived from the memory itself, never a separate boolean — the dialog
          is only mounted while one is selected, and closing clears it. */}
      {pendingDelete && (
        <AlertDialog
          key={pendingDelete.id}
          open={!!pendingDelete}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
        >
          <AlertDialogContent data-testid="memory-delete-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
              <AlertDialogDescription>
                The CoPilot will no longer use this when answering you. This
                can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p className="rounded-lg border bg-muted p-3 text-sm">
              {pendingDelete.memory}
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => handleForget(pendingDelete.id)}
                className="bg-red-600 hover:bg-red-700 focus-visible:ring-red-600"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <AlertDialog open={confirmOffOpen} onOpenChange={setConfirmOffOpen}>
        <AlertDialogContent data-testid="memory-toggle-off-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off memory?</AlertDialogTitle>
            <AlertDialogDescription>
              The CoPilot will stop learning from your chats and stop using what it
              already knows — answers get more generic, and you&apos;ll have to
              re-explain context it already understood. Existing memories are kept
              until you delete them, but nothing new will be remembered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction onClick={() => void applyToggle(false)}>
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MemoryCard({
  item,
  deleting,
  onForget,
}: {
  item: UserMemoryItem;
  deleting: boolean;
  onForget: () => void;
}) {
  const when = relativeTime(item.createdAt);
  const Icon = item.source === 'import' ? Upload : MessagesSquare;

  return (
    <li className="flex items-start gap-3 px-4 py-3.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-sm leading-snug">{item.memory}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">
            {item.source === 'import' ? 'Imported' : 'From a conversation'}
          </Badge>
          {/* An import names what it came from, so a memory can be traced back
              to the file or paste that produced it. */}
          {item.origin && (
            <span
              className="max-w-[18rem] truncate text-[11px] text-muted-foreground"
              title={item.origin}
            >
              {item.origin}
            </span>
          )}
          {when && (
            <>
              <span className="text-[11px] text-muted-foreground">·</span>
              <span className="text-[11px] text-muted-foreground">{when}</span>
            </>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
        aria-label="Forget this memory"
        disabled={deleting}
        onClick={onForget}
        data-testid={`memory-forget-${item.id}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}
