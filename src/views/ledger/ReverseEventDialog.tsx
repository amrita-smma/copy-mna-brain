'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import type { FlPortfolioLedgerEntry } from '@/lib/api/fundLedger';
import {
  entryTypeLabel,
  formatDate,
  formatQuantity,
  positionLabel,
  type LedgerIndex,
} from '@/lib/fundLedger';
import { useToast } from '@/hooks/use-toast';
import { FIELD_HINT, FIELD_LABEL, FIELD_TEXT, signClass } from './parts';
import { useLedgerMoney } from './useLedgerMoney';

/**
 * Reversing an event via append-only correction.
 *
 * `FlLedgerService.reverseEvent` creates a new reversal business event linked via
 * `reversal_of_event_id`, writes mirrored entries with negated deltas (`is_reversal = true`),
 * and marks the original event `status = 'reversed'` without deleting any historical facts.
 * Both the original and reversal rows are preserved for auditability and historical reconstruction.
 */
export function ReverseEventDialog({
  entry,
  index,
  onOpenChange,
  onReversed,
}: {
  /** The row whose event is being reversed, or `null` when closed. */
  entry: FlPortfolioLedgerEntry | null;
  index: LedgerIndex;
  onOpenChange: (open: boolean) => void;
  onReversed: () => void;
}) {
  const { toast } = useToast();
  const money = useLedgerMoney();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // A reason belongs to the event being reversed, so reopening the dialog on a
  // different row must not inherit the last one typed.
  useEffect(() => {
    if (entry) setReason('');
  }, [entry]);

  const eventId = entry?.business_event_id ?? null;
  const event = eventId ? index.events.get(eventId) : undefined;
  const rows = eventId ? (index.entriesByEvent.get(eventId) ?? []) : [];
  const alreadyReversed = event?.status === 'reversed';
  const isReversalEvent =
    event?.reversal_of_event_id != null || rows.some((r) => r.is_reversal);

  const submit = async () => {
    if (!eventId) return;
    setSaving(true);
    try {
      await fundLedgerApi.reverseEvent(
        eventId,
        reason.trim() ? { description: reason.trim() } : undefined,
      );
      toast({
        title: 'Event reversed',
        description:
          rows.length === 1
            ? 'A reversal entry was posted and balances were netted.'
            : `Reversal entries were posted for all ${rows.length} rows and balances were netted.`,
      });
      setReason('');
      onOpenChange(false);
      onReversed();
    } catch (error) {
      toast({
        title: 'Could not reverse the event',
        description: error instanceof Error ? error.message : 'Unexpected error',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!entry} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {alreadyReversed ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-[15px]">Already reversed</DialogTitle>
            </DialogHeader>
            <div className="rounded border bg-muted px-2.5 py-2 text-[12px] leading-relaxed text-muted-foreground">
              {event?.description ?? 'This event'} is already marked reversed. Reversals cannot be reversed again.
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : isReversalEvent ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-[15px]">Cannot reverse a reversal</DialogTitle>
            </DialogHeader>
            <div className="rounded border bg-muted px-2.5 py-2 text-[12px] leading-relaxed text-muted-foreground">
              {event?.description ?? 'This event'} is a reversal event. Reversals cannot be reversed. To make a correction, post a new business event.
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-[15px]">Reverse this event</DialogTitle>
              <DialogDescription className="text-[12px]">
                {event?.description ?? '—'}
                {event?.event_date ? ` · ${formatDate(event.event_date)}` : ''}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  What gets reversed
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-2 py-1.5 text-left font-medium">Position</th>
                        <th className="px-2 py-1.5 text-left font-medium">Type</th>
                        <th className="px-2 py-1.5 text-right font-medium">Commitment</th>
                        <th className="px-2 py-1.5 text-right font-medium">Quantity</th>
                        <th className="px-2 py-1.5 text-right font-medium">Cash</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const commitment = row.commitment_delta ?? '0';
                        const quantity = row.quantity_delta ?? '0';
                        const cash = row.cash_delta ?? '0';
                        return (
                          <tr key={row.id} className="border-b last:border-0">
                            <td className="px-2 py-1.5">
                              {positionLabel(row.position_id, index)}
                            </td>
                            <td className="px-2 py-1.5">{entryTypeLabel(row.entry_type)}</td>
                            <td className={cn('px-2 py-1.5 text-right font-mono tabular-nums', signClass(commitment))}>
                              {money.money(commitment)}
                            </td>
                            <td className={cn('px-2 py-1.5 text-right font-mono tabular-nums', signClass(quantity))}>
                              {formatQuantity(quantity)}
                            </td>
                            <td className={cn('px-2 py-1.5 text-right font-mono tabular-nums', signClass(cash))}>
                              {money.money(cash)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  An append-only reversal event will be created with mirrored entries that negate the
                  economic effects of this event. The original event will be marked reversed and
                  preserved for audit history. Historical queries dated before the reversal date will
                  reproduce past balances.
                </div>
              </div>

              <div>
                <Label htmlFor="ledger-reverse-reason" className={FIELD_LABEL}>
                  Why
                </Label>
                <Input
                  id="ledger-reverse-reason"
                  className={cn('mt-1 h-8', FIELD_TEXT)}
                  value={reason}
                  placeholder="e.g. charged to the wrong position"
                  onChange={(changeEvent) => setReason(changeEvent.target.value)}
                />
                <div className={cn('mt-1', FIELD_HINT)}>
                  Recorded with the reversal event. Optional.
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void submit()}
                disabled={saving || rows.length === 0}
              >
                {saving ? 'Reversing…' : 'Reverse event'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
