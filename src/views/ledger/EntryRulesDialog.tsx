'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ENTRY_TYPES, ENTRY_TYPE_KEYS, ruleGlyph } from '@/lib/fundLedger';
import { Badge, FieldKey } from './parts';

/**
 * The entry-type matrix, made readable.
 *
 * This is the same table `FlLedgerService.validateEntryDeltas` enforces: a row
 * that breaks it is rejected on the way in, so the posting form greys out the
 * fields a type may never touch rather than letting you fill them and fail.
 */
export function EntryRulesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            What each entry type is allowed to do
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            The database enforces this table. A row that breaks it is rejected on the way in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Allowed deltas
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium">Type</th>
                    <th className="px-2 py-2 text-left font-medium">Sits on</th>
                    <th className="px-2 py-2 text-center font-medium">Commitment Δ</th>
                    <th className="px-2 py-2 text-center font-medium">Quantity Δ</th>
                    <th className="px-2 py-2 text-center font-medium">Cash Δ</th>
                    <th className="px-2 py-2 text-left font-medium">What it means</th>
                  </tr>
                </thead>
                <tbody>
                  {ENTRY_TYPE_KEYS.map((key) => {
                    const spec = ENTRY_TYPES[key];
                    return (
                      <tr key={key} className="border-b last:border-0">
                        <td className="px-2 py-1.5">
                          <Badge direction={spec.direction}>{spec.label}</Badge>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {spec.on === 'any' ? 'either' : spec.on}
                        </td>
                        {([spec.commitment, spec.quantity, spec.cash] as const).map(
                          (rule, ruleIndex) => (
                            <td
                              key={ruleIndex}
                              className={cn(
                                'px-2 py-1.5 text-center font-mono',
                                rule === 'zero' && 'text-muted-foreground/50',
                              )}
                            >
                              {ruleGlyph(rule)}
                            </td>
                          ),
                        )}
                        <td className="px-2 py-1.5 text-muted-foreground">{spec.blurb}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">
              <span className="font-mono">±</span> means the column may be signed either way;{' '}
              <span className="font-mono">0</span> means the type may never touch it.
            </div>
          </div>

          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Reading the signs
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <FieldKey>Perspective</FieldKey>
                <div className="mt-1 text-[12px] leading-relaxed">
                  Always the holder. A capital call is negative cash for the investor; the fund
                  side is the same number, sign flipped.
                </div>
              </div>
              <div className="rounded-md border p-3">
                <FieldKey>Reversals</FieldKey>
                <div className="mt-1 text-[12px] leading-relaxed">
                  A reversal mirrors every sign above. The flag is never accepted as input, so a
                  reversal row cannot be re-posted — which is why editing such an event is
                  blocked.
                </div>
              </div>
              <div className="rounded-md border p-3">
                <FieldKey>Transfers</FieldKey>
                <div className="mt-1 text-[12px] leading-relaxed">
                  Two rows, one event. Commitment and unit deltas must cancel exactly, or neither
                  row posts.
                </div>
              </div>
            </div>
          </div>

          <div className="rounded border border-border bg-muted/50 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
            Distribution, redemption, sell and income all read from the holder, so each puts money{' '}
            <i>into</i> their pocket and carries a positive cash Δ. That is what lets DPI and IRR
            be produced by summing cash Δ.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
