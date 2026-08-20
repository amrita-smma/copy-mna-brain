'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Fund } from './types';
import { useFundMoney } from './useFundMoney';
import { Combobox } from './Combobox';
import { CurrencyInput, normalizeCurrency, type Currency } from './CurrencyInput';
import { DeleteRowMenu } from './parts';
import {
  CommitmentEventTypeBadge,
  formatCommitmentCounterparty,
} from './CommitmentHistoryTable';
import * as commitmentEventsApi from '@/lib/api/commitmentEvents';
import type {
  CommitmentEventType,
  CommitmentEventWithBalance,
} from '@/lib/api/commitmentEvents';

interface CommitmentLedgerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  investorId: string | null;
  investorName: string;
  funds: Fund[];
  allInvestors: { id: string; name: string }[];
  initialFundId?: string | null;
  onSaved: () => void | Promise<void>;
}

export function CommitmentLedgerDialog({
  open,
  onOpenChange,
  investorId,
  investorName,
  funds: allFunds,
  allInvestors,
  initialFundId,
  onSaved,
}: CommitmentLedgerDialogProps) {
  const { toast } = useToast();
  const { money } = useFundMoney();

  // Filter out the synthetic "unassigned" fund
  const funds = useMemo(() => allFunds.filter((f) => f.id !== 'unassigned'), [allFunds]);

  const [selectedFundId, setSelectedFundId] = useState<string>('');
  const [events, setEvents] = useState<CommitmentEventWithBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add / Edit form state
  const [formOpen, setFormOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CommitmentEventWithBalance | null>(null);
  const [formFundId, setFormFundId] = useState<string>('');
  const [formEventType, setFormEventType] = useState<CommitmentEventType>('additional_commitment');
  const [formEffectiveDate, setFormEffectiveDate] = useState<string>('');
  const [formAmount, setFormAmount] = useState<number | null>(null);
  const [formCurrency, setFormCurrency] = useState<Currency>('USD');
  const [formCounterpartyId, setFormCounterpartyId] = useState<string>('');
  const [formNotes, setFormNotes] = useState<string>('');
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Map of holding entity ID to entity name
  const investorNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const inv of allInvestors) {
      map[inv.id] = inv.name;
    }
    return map;
  }, [allInvestors]);

  // Available counterparties (excluding current investor)
  const counterpartyOptions = useMemo(() => {
    return allInvestors.filter((inv) => inv.id !== investorId).map((inv) => inv.id);
  }, [allInvestors, investorId]);

  // Load events for the selected investor and fund
  const loadEvents = useCallback(async () => {
    if (!investorId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await commitmentEventsApi.listCommitmentEvents({
        holdingEntityId: investorId,
        fundId: selectedFundId || undefined,
      });
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load commitment events');
    } finally {
      setLoading(false);
    }
  }, [investorId, selectedFundId]);

  useEffect(() => {
    if (open) {
      const fundToSelect = initialFundId || funds[0]?.id || '';
      setSelectedFundId(fundToSelect);
      setError(null);
    }
  }, [open, initialFundId, funds]);

  useEffect(() => {
    if (open && investorId) {
      loadEvents();
    }
  }, [open, investorId, selectedFundId, loadEvents]);

  const currentFund = funds.find((f) => f.id === selectedFundId);

  // Calculate current total commitment for the selected fund from events
  const selectedFundBalance = useMemo(() => {
    if (!selectedFundId) return 0;
    const fundEvents = events.filter((e) => e.fund_id === selectedFundId);
    if (fundEvents.length === 0) return 0;
    return fundEvents[fundEvents.length - 1]?.runningBalance ?? 0;
  }, [events, selectedFundId]);

  const selectedFundEvents = useMemo(() => {
    return events.filter((e) => !selectedFundId || e.fund_id === selectedFundId);
  }, [events, selectedFundId]);

  const existingLedgerCurrency = useMemo(() => {
    if (selectedFundEvents.length > 0) {
      return normalizeCurrency(selectedFundEvents[0].currency);
    }
    return normalizeCurrency(currentFund?.baseCurrency);
  }, [selectedFundEvents, currentFund]);

  // Open add form
  const openAddForm = (initialType: CommitmentEventType = 'additional_commitment') => {
    setEditingEvent(null);
    setFormFundId(selectedFundId || funds[0]?.id || '');
    setFormEventType(selectedFundEvents.length === 0 ? 'initial_commitment' : initialType);
    setFormEffectiveDate(new Date().toISOString().slice(0, 10));
    setFormAmount(null);
    setFormCurrency(existingLedgerCurrency);
    setFormCounterpartyId('');
    setFormNotes('');
    setFormError(null);
    setFormOpen(true);
  };

  // Open edit form
  const openEditForm = (ev: CommitmentEventWithBalance) => {
    setEditingEvent(ev);
    setFormFundId(ev.fund_id);
    setFormEventType(ev.event_type);
    setFormEffectiveDate(ev.effective_date);
    setFormAmount(ev.amount);
    setFormCurrency(normalizeCurrency(ev.currency));
    setFormCounterpartyId(ev.counterparty_holding_entity_id || '');
    setFormNotes(ev.notes || '');
    setFormError(null);
    setFormOpen(true);
  };

  // Submit add / edit form
  const submitForm = async () => {
    if (!investorId) return;
    if (!formFundId) {
      setFormError('Please select a fund');
      return;
    }
    if (!formAmount || formAmount <= 0) {
      setFormError('Amount must be greater than 0');
      return;
    }
    if (!formEffectiveDate) {
      setFormError('Effective date is required');
      return;
    }
    if (
      !editingEvent &&
      (formEventType === 'transfer_in' || formEventType === 'transfer_out') &&
      !formCounterpartyId
    ) {
      setFormError('Please select a counterparty for the transfer');
      return;
    }

    setFormSaving(true);
    setFormError(null);

    try {
      if (editingEvent) {
        await commitmentEventsApi.updateCommitmentEvent(editingEvent.id, {
          effectiveDate: formEffectiveDate,
          eventType: formEventType,
          amount: formAmount,
          currency: formCurrency,
          notes: formNotes.trim() || null,
        });
        toast({ title: 'Commitment event updated' });
      } else if (formEventType === 'transfer_out') {
        await commitmentEventsApi.createCommitmentTransfer({
          fundId: formFundId,
          fromHoldingEntityId: investorId,
          toHoldingEntityId: formCounterpartyId,
          effectiveDate: formEffectiveDate,
          amount: formAmount,
          currency: formCurrency,
          notes: formNotes.trim() || null,
        });
        toast({ title: 'Transfer recorded successfully' });
      } else if (formEventType === 'transfer_in') {
        await commitmentEventsApi.createCommitmentTransfer({
          fundId: formFundId,
          fromHoldingEntityId: formCounterpartyId,
          toHoldingEntityId: investorId,
          effectiveDate: formEffectiveDate,
          amount: formAmount,
          currency: formCurrency,
          notes: formNotes.trim() || null,
        });
        toast({ title: 'Transfer recorded successfully' });
      } else {
        await commitmentEventsApi.createCommitmentEvent({
          fundId: formFundId,
          holdingEntityId: investorId,
          effectiveDate: formEffectiveDate,
          eventType: formEventType,
          amount: formAmount,
          currency: formCurrency,
          counterpartyHoldingEntityId: formCounterpartyId || null,
          notes: formNotes.trim() || null,
        });
        toast({ title: 'Commitment event recorded' });
      }

      setFormOpen(false);
      await loadEvents();
      await onSaved();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save commitment event');
    } finally {
      setFormSaving(false);
    }
  };

  // Delete event
  const handleDeleteEvent = async (ev: CommitmentEventWithBalance) => {
    try {
      await commitmentEventsApi.deleteCommitmentEvent(ev.id);
      toast({ title: 'Commitment event deleted' });
      await loadEvents();
      await onSaved();
    } catch (err) {
      toast({
        title: 'Failed to delete event',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'destructive',
      });
    }
  };

  const isEditingTransfer = editingEvent?.transfer_group_id != null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[760px]">
          <DialogHeader>
            <DialogTitle>
              Commitments · {investorName || 'Investment Entity'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Fund Selector Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="fund-select" className="text-xs font-medium text-muted-foreground">
                  Fund:
                </Label>
                <Select value={selectedFundId} onValueChange={setSelectedFundId}>
                  <SelectTrigger id="fund-select" className="h-8 w-[220px] text-xs">
                    <SelectValue placeholder="Select fund" />
                  </SelectTrigger>
                  <SelectContent>
                    {funds.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedFundId && (
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Current Commitment:{' '}
                    </span>
                    <span className="text-[13px] font-semibold text-foreground">
                      {money(selectedFundBalance / 1_000_000)}
                    </span>
                  </div>
                  <Button size="sm" onClick={() => openAddForm('additional_commitment')}>
                    + Add commitment change
                  </Button>
                </div>
              )}
            </div>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {error}
              </div>
            )}

            {/* Event Ledger Table */}
            <div className="max-h-[50vh] overflow-y-auto rounded-md border">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Counterparty / Detail</th>
                    <th className="px-3 py-2 text-right">Delta Amount</th>
                    <th className="px-3 py-2 text-right">Running Balance</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && events.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                        Loading commitment history…
                      </td>
                    </tr>
                  ) : events.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                        No commitment history recorded yet for this fund.
                      </td>
                    </tr>
                  ) : (
                    events.map((ev) => {
                      const isPositive = ev.delta > 0;
                      const counterparty = formatCommitmentCounterparty(
                        ev.event_type,
                        ev.counterparty_holding_entity_id,
                        investorNameById,
                      );

                      return (
                        <tr key={ev.id} className="border-b hover:bg-muted/30">
                          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                            {ev.effective_date}
                          </td>
                          <td className="px-3 py-2">
                            <CommitmentEventTypeBadge type={ev.event_type} />
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {counterparty}
                          </td>
                          <td
                            className={cn(
                              'whitespace-nowrap px-3 py-2 text-right font-medium',
                              isPositive ? 'text-success' : 'text-destructive',
                            )}
                          >
                            {isPositive ? '+' : '−'}
                            {money(Math.abs(ev.delta) / 1_000_000)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-foreground">
                            {money(ev.runningBalance / 1_000_000)}
                          </td>
                          <td className="max-w-[180px] truncate px-3 py-2 text-muted-foreground" title={ev.notes || ''}>
                            {ev.notes || '—'}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <DeleteRowMenu
                              label={ev.transfer_group_id ? 'Delete transfer pair' : 'Delete event'}
                              title="Delete commitment event?"
                              description={
                                ev.transfer_group_id
                                  ? 'This is a linked transfer. Deleting it will atomically remove both the transfer-out and transfer-in records and recalculate running balances for both entities.'
                                  : 'This will remove this commitment record and recalculate all chronological running balances.'
                              }
                              onEdit={() => openEditForm(ev)}
                              onConfirm={() => handleDeleteEvent(ev)}
                            />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Commitment changes are recorded as chronological deltas. Running balance and current
              fund ownership percentage are automatically recomputed from this ledger.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add / Edit Commitment Change Sub-Dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {editingEvent ? 'Edit Commitment Event' : 'Add Commitment Change'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {!editingEvent && (
              <div className="space-y-1.5">
                <Label htmlFor="change-fund">Fund</Label>
                <Select value={formFundId} onValueChange={setFormFundId} disabled={!!selectedFundId}>
                  <SelectTrigger id="change-fund">
                    <SelectValue placeholder="Select fund" />
                  </SelectTrigger>
                  <SelectContent>
                    {funds.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="change-type">Event Type</Label>
              <Select
                value={formEventType}
                onValueChange={(v) => setFormEventType(v as CommitmentEventType)}
                disabled={isEditingTransfer}
              >
                <SelectTrigger id="change-type" disabled={isEditingTransfer}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="initial_commitment">Initial Commitment</SelectItem>
                  <SelectItem value="additional_commitment">Additional Commitment</SelectItem>
                  <SelectItem value="reduction">Commitment Reduction</SelectItem>
                  <SelectItem value="transfer_in">Transfer In</SelectItem>
                  <SelectItem value="transfer_out">Transfer Out</SelectItem>
                </SelectContent>
              </Select>
              {isEditingTransfer && (
                <p className="text-[11px] text-muted-foreground">
                  Transfer event type cannot be changed. Delete the transfer to modify participants.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="change-date">Effective Date</Label>
              <Input
                id="change-date"
                type="date"
                value={formEffectiveDate}
                onChange={(e) => setFormEffectiveDate(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="change-amount">
                Amount ({formEventType === 'reduction' || formEventType === 'transfer_out' ? 'Reduction' : 'Addition'})
              </Label>
              <CurrencyInput
                id="change-amount"
                amount={formAmount}
                currency={formCurrency}
                currencyEditable={selectedFundEvents.length === 0 && !editingEvent}
                onCommit={(amt, cur) => {
                  setFormAmount(amt);
                  setFormCurrency(cur);
                }}
              />
            </div>

            {(formEventType === 'transfer_in' || formEventType === 'transfer_out') && (
              <div className="space-y-1.5">
                <Label>
                  {formEventType === 'transfer_out' ? 'Transfer To (Buyer)' : 'Transfer From (Seller)'}
                </Label>
                {isEditingTransfer ? (
                  <Input
                    disabled
                    value={investorNameById[formCounterpartyId] || formCounterpartyId || '—'}
                  />
                ) : (
                  <Combobox
                    value={formCounterpartyId}
                    options={counterpartyOptions}
                    labelFor={(id) => investorNameById[id] || id}
                    onChange={setFormCounterpartyId}
                    placeholder="Select counterparty entity…"
                  />
                )}
                {isEditingTransfer && (
                  <p className="text-[11px] text-muted-foreground">
                    Transfer counterparty cannot be changed. Delete and re-create to change counterparty.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="change-notes">Notes / Remarks</Label>
              <Textarea
                id="change-notes"
                rows={2}
                placeholder="Optional notes or context…"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>

            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={formSaving}>
              Cancel
            </Button>
            <Button onClick={submitForm} disabled={formSaving}>
              {formSaving ? 'Saving…' : editingEvent ? 'Update Event' : 'Record Change'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
