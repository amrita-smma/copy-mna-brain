'use client';

import { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { InvestmentTypeOption } from './context';

/**
 * "Configure groupings": add, rename and delete the workspace's investment
 * types — the groups of the Asset tab's "by Investment Type" view. Each change
 * saves immediately; `onChanged` re-fetches the list.
 */
export function InvestmentTypesDialog({
  open,
  onOpenChange,
  types,
  assetCountByTypeId,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  types: InvestmentTypeOption[];
  /** How many assets each type holds, so a delete can say what it unassigns. */
  assetCountByTypeId: Map<string, number>;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err) {
      toast({
        title: label,
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (t: InvestmentTypeOption) => {
    const draft = drafts[t.id];
    if (draft === undefined) return;
    const clean = draft.trim();
    const clearDraft = () =>
      setDrafts((d) => {
        const next = { ...d };
        delete next[t.id];
        return next;
      });
    if (clean === '' || clean === t.name) {
      clearDraft();
      return;
    }
    if (await run(t.id, 'Failed to rename investment type', () => fundLedgerApi.renameInvestmentType(t.id, clean))) {
      clearDraft();
    }
  };

  const remove = async (t: InvestmentTypeOption) => {
    const count = assetCountByTypeId.get(t.id) ?? 0;
    if (
      count > 0 &&
      !window.confirm(
        `Delete "${t.name}"? Its ${count} asset${count === 1 ? '' : 's'} will become unassigned.`,
      )
    ) {
      return;
    }
    await run(t.id, 'Failed to delete investment type', () => fundLedgerApi.deleteInvestmentType(t.id));
  };

  const add = async () => {
    const clean = newName.trim();
    if (!clean) return;
    if (await run('new', 'Failed to add investment type', () => fundLedgerApi.createInvestmentType(clean))) {
      setNewName('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => busyId === null && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Configure groupings</DialogTitle>
          <DialogDescription>
            Investment types group assets in the &ldquo;by Investment Type&rdquo; view. Assign an
            asset a type from its row menu (⋮ → Investment type).
          </DialogDescription>
        </DialogHeader>

        {/* The padding (offset by the negative margin) leaves room for the inputs'
            focus ring, which overflow-y-auto would otherwise clip. */}
        <div className="-m-1 max-h-[50vh] space-y-1.5 overflow-y-auto p-1">
          {types.length === 0 && (
            <p className="rounded-md bg-muted px-3 py-4 text-center text-sm text-muted-foreground">
              No investment types yet.
            </p>
          )}
          {types.map((t) => {
            const count = assetCountByTypeId.get(t.id) ?? 0;
            return (
              <div key={t.id} className="flex items-center gap-2">
                <Input
                  aria-label={`Rename ${t.name}`}
                  value={drafts[t.id] ?? t.name}
                  disabled={busyId !== null}
                  onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  onBlur={() => void rename(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void rename(t);
                    }
                  }}
                  className="h-8 text-[13px]"
                />
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                  {count} asset{count === 1 ? '' : 's'}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${t.name}`}
                  disabled={busyId !== null}
                  onClick={() => void remove(t)}
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                >
                  {busyId === t.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t pt-3">
          <Input
            aria-label="New investment type"
            placeholder="New investment type…"
            value={newName}
            disabled={busyId !== null}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              }
            }}
            className="h-8 text-[13px]"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busyId !== null || newName.trim() === ''}
            onClick={() => void add()}
            className="shrink-0 gap-1"
          >
            {busyId === 'new' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busyId !== null}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
