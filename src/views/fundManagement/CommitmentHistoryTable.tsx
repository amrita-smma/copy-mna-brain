'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Pill } from './parts';
import { useFundMoney } from './useFundMoney';
import { useFundData } from './context';
import * as commitmentEventsApi from '@/lib/api/commitmentEvents';
import type {
  CommitmentEventType,
  CommitmentEventWithBalance,
} from '@/lib/api/commitmentEvents';

export const EVENT_TYPE_LABELS: Record<CommitmentEventType, string> = {
  initial_commitment: 'Initial Commitment',
  additional_commitment: 'Additional Commitment',
  reduction: 'Reduction',
  transfer_in: 'Transfer In',
  transfer_out: 'Transfer Out',
};

export function CommitmentEventTypeBadge({ type }: { type: CommitmentEventType | string }) {
  switch (type) {
    case 'initial_commitment':
      return (
        <Pill className="border-blue-200 bg-blue-500/10 text-blue-700">
          Initial Commitment
        </Pill>
      );
    case 'additional_commitment':
      return (
        <Pill className="border-emerald-200 bg-emerald-500/10 text-emerald-700">
          Addition
        </Pill>
      );
    case 'reduction':
      return (
        <Pill className="border-amber-200 bg-amber-500/10 text-amber-700">
          Reduction
        </Pill>
      );
    case 'transfer_in':
      return (
        <Pill className="border-purple-200 bg-purple-500/10 text-purple-700">
          Transfer In
        </Pill>
      );
    case 'transfer_out':
      return (
        <Pill className="border-indigo-200 bg-indigo-500/10 text-indigo-700">
          Transfer Out
        </Pill>
      );
    default:
      return <Pill>{type}</Pill>;
  }
}

export function formatCommitmentCounterparty(
  eventType: CommitmentEventType | string,
  counterpartyId: string | null | undefined,
  entityNameById?: Map<string, string> | Record<string, string>,
): string {
  if (!counterpartyId) return '—';
  const name =
    entityNameById instanceof Map
      ? entityNameById.get(counterpartyId) || counterpartyId
      : entityNameById?.[counterpartyId] || counterpartyId;

  if (eventType === 'transfer_out') {
    return `To: ${name}`;
  }
  if (eventType === 'transfer_in') {
    return `From: ${name}`;
  }
  return name;
}

export interface InlineCommitmentHistoryProps {
  fundId: string;
  fundName: string;
  holdingEntityId: string;
  investorName?: string;
  refreshKey?: unknown;
  onOpenDialog?: () => void;
}

export function InlineCommitmentHistory({
  fundId,
  fundName,
  holdingEntityId,
  refreshKey,
  onOpenDialog,
}: InlineCommitmentHistoryProps) {
  const { entityNameById } = useFundData();
  const { money } = useFundMoney();
  const [events, setEvents] = useState<CommitmentEventWithBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await commitmentEventsApi.listCommitmentEvents({
        holdingEntityId,
        fundId,
      });
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load commitment history');
    } finally {
      setLoading(false);
    }
  }, [holdingEntityId, fundId]);

  useEffect(() => {
    let isCancelled = false;
    setLoading(true);
    setError(null);

    commitmentEventsApi
      .listCommitmentEvents({ holdingEntityId, fundId })
      .then((data) => {
        if (!isCancelled) {
          setEvents(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!isCancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load commitment history');
          setLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [holdingEntityId, fundId, refreshKey]);

  return (
    <div className="rounded-md border bg-card/60 p-3 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
            Commitment History
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs font-medium text-foreground">{fundName}</span>
          {!loading && !error && events.length > 0 && (
            <Pill className="text-[10px]">
              {events.length} event{events.length === 1 ? '' : 's'}
            </Pill>
          )}
        </div>
        {onOpenDialog && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDialog();
            }}
          >
            ✎ Edit in Dialog
          </Button>
        )}
      </div>

      {error ? (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          <span>Failed to load commitment history: {error}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-destructive hover:bg-destructive/20"
            onClick={(e) => {
              e.stopPropagation();
              load();
            }}
          >
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          Loading commitment history…
        </div>
      ) : events.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          No commitment history recorded yet for this fund.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border bg-background">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-1.5">Date</th>
                <th className="px-3 py-1.5">Type</th>
                <th className="px-3 py-1.5">Counterparty / Detail</th>
                <th className="px-3 py-1.5 text-right">Delta Amount</th>
                <th className="px-3 py-1.5 text-right">Running Balance</th>
                <th className="px-3 py-1.5">Notes</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => {
                const isPositive = ev.delta > 0;
                const counterparty = formatCommitmentCounterparty(
                  ev.event_type,
                  ev.counterparty_holding_entity_id,
                  entityNameById,
                );
                return (
                  <tr key={ev.id} className="border-b hover:bg-muted/30 last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                      {ev.effective_date}
                    </td>
                    <td className="px-3 py-1.5">
                      <CommitmentEventTypeBadge type={ev.event_type} />
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {counterparty}
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap px-3 py-1.5 text-right font-medium',
                        isPositive ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {isPositive ? '+' : '−'}
                      {money(Math.abs(ev.delta) / 1_000_000)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium text-foreground">
                      {money(ev.runningBalance / 1_000_000)}
                    </td>
                    <td
                      className="max-w-[200px] truncate px-3 py-1.5 text-muted-foreground"
                      title={ev.notes || ''}
                    >
                      {ev.notes || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
