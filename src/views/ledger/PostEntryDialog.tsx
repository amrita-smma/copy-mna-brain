'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NumericInput } from '@/components/common/NumericInput';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import type { FlPortfolioReadModel } from '@/lib/api/fundLedger';
import {
  DIRECTION_LABELS,
  ENTRY_TYPES,
  ENTRY_TYPE_KEYS,
  allowsPositionKind,
  amountLabelOf,
  buildPostEventInput,
  draftLegs,
  distinctEnglishName,
  draftProblem,
  emptyDraft,
  entityKey,
  entryTypeLabel,
  formatExact,
  formatExactAuto,
  formatQuantityAbs,
  isTwoLegged,
  needsAmount,
  needsUnits,
  offersDecreaseToggle,
  postsAdjustmentDelta,
  adjustmentDirectionOptions,
  adjustmentSubTypesFor,
  resolveAdjustmentSubType,
  ADJUSTMENT_SUB_TYPE_LABELS,
  ADJUSTMENT_EFFECT_LABELS,
  PAID_IN_WRITEOFF_SUBTYPE,
  parseEntityKey,
  positionLabel,
  rollupPosition,
  type EntryDraft,
  type FlEntryType,
  type LedgerIndex,
  type ResolvedPosition,
} from '@/lib/fundLedger';
import { EntityCombobox, type EntityOption } from './EntityCombobox';
import { Badge, FIELD_HINT, FIELD_LABEL, FIELD_TEXT, Term, signClass } from './parts';
import {
  PROCEEDS_DESTINATION_OPTIONS,
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  DEFAULT_PROCEEDS_TREATMENT,
  isProceedsTreatmentApplicable,
  subTypeControlFor,
  resolveNextProceedsDestination,
  type CashHolderCandidate,
} from './postEntryDestination';
import { toDivestmentSubType } from '@/lib/sellProceedsDestination';
import { useLedgerMoney } from './useLedgerMoney';

/** The entity key a position's holder is addressed by. */
export function holderKeyOf(position: ResolvedPosition): string {
  if (!position.resolution.hasHolder || position.holder.kind === 'unknown' || !position.holder.id) {
    return '';
  }
  return entityKey(
    position.holder.kind === 'investor' ? 'investor' : 'fund',
    position.holder.id,
  );
}

/** The entity key a position's instrument is addressed by. */
export function instrumentKeyOf(position: ResolvedPosition): string {
  if (
    !position.resolution.hasInstrument ||
    position.instrumentKind === 'unknown' ||
    !position.instrument.id
  ) {
    return '';
  }
  return entityKey(position.instrumentKind === 'asset' ? 'asset' : 'fund', position.instrument.id);
}

/**
 * Which way the form reads, given the type.
 *
 * A transfer runs between two holders, with the fund picked separately. Anything
 * else runs between the holder and the thing they hold: money leaving the
 * holder reads holder → instrument, and money coming back reads the reverse.
 */
function sidesFor(draft: EntryDraft, holders: EntityOption[], instruments: EntityOption[]) {
  if (isTwoLegged(draft.type)) {
    return {
      transfer: true as const,
      inward: false,
      fromOptions: holders.filter((option) => option.key !== draft.to),
      toOptions: holders.filter((option) => option.key !== draft.from),
      holderKey: draft.from,
      instrumentKey: draft.instrument,
    };
  }
  const inward = ENTRY_TYPES[draft.type].direction === 'in';
  return {
    transfer: false as const,
    inward,
    fromOptions: inward ? instruments : holders,
    toOptions: inward ? holders : instruments,
    holderKey: inward ? draft.to : draft.from,
    instrumentKey: inward ? draft.from : draft.to,
  };
}

/** The positions that pair one holder with one instrument. */
export function positionsFor(
  index: LedgerIndex,
  holderKey: string,
  instrumentKey: string,
): ResolvedPosition[] {
  if (!holderKey || !instrumentKey) return [];
  return [...index.positions.values()].filter(
    (position) =>
      position.resolution.isResolved &&
      holderKeyOf(position) === holderKey &&
      instrumentKeyOf(position) === instrumentKey,
  );
}

/** One position, summarised so the choice between two of them is informed. */
function PositionOption({
  position,
  index,
  selected,
  onSelect,
}: {
  position: ResolvedPosition;
  index: LedgerIndex;
  selected: boolean;
  onSelect: () => void;
}) {
  const money = useLedgerMoney();
  const rollup = rollupPosition(position.id, index.entries);
  const bits: string[] = [];
  if (Number(rollup.commitment)) bits.push(`${money.moneyAbs(rollup.commitment)} pledged`);
  if (Number(rollup.invested)) bits.push(`${money.moneyAbs(rollup.invested)} in`);
  if (Number(rollup.units)) bits.push(`${formatQuantityAbs(rollup.units)} units`);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors',
        selected ? 'border-primary bg-primary/5' : 'hover:bg-muted',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium">
          {position.fundingSource?.name ?? 'No declared source'}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {bits.length ? bits.join(' · ') : 'no movements yet'}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <Badge direction={position.status === 'open' ? 'in' : 'flat'}>{position.status}</Badge>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          {rollup.rowCount} row{rollup.rowCount === 1 ? '' : 's'}
          {rollup.needsChecking ? ` · ${rollup.needsChecking} to check` : ''}
        </span>
      </span>
    </button>
  );
}

/** Pick — or open — the position a leg lands on. */
function PositionPicker({
  index,
  portfolio,
  holderKey,
  instrumentKey,
  selectedId,
  onSelect,
  onCreated,
  date,
}: {
  index: LedgerIndex;
  portfolio: FlPortfolioReadModel;
  holderKey: string;
  instrumentKey: string;
  selectedId: string;
  onSelect: (positionId: string) => void;
  onCreated: (positionId: string) => Promise<void> | void;
  date: string;
}) {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [sourceId, setSourceId] = useState<string>('none');
  const [saving, setSaving] = useState(false);

  const matches = useMemo(
    () => positionsFor(index, holderKey, instrumentKey),
    [index, holderKey, instrumentKey],
  );

  if (!holderKey || !instrumentKey) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-[11px] text-muted-foreground">
        Choose both sides above and the matching positions will appear here.
      </div>
    );
  }

  const create = async () => {
    const holder = holderKey.split(':');
    const instrument = instrumentKey.split(':');
    setSaving(true);
    try {
      const created = await fundLedgerApi.openPosition({
        holder_investor_id: holder[0] === 'investor' ? holder[1] : null,
        holder_fund_id: holder[0] === 'fund' ? holder[1] : null,
        fund_id: instrument[0] === 'fund' ? instrument[1] : null,
        asset_id: instrument[0] === 'asset' ? instrument[1] : null,
        holder_source_of_fund_id: sourceId === 'none' ? null : sourceId,
        opened_at: date,
      });
      // Await the reload before closing the inline form: the picker reads from
      // `index`, so selecting a position that isn't in it yet would leave the
      // list looking empty right after creating one.
      await onCreated(created.id);
      setCreating(false);
      setSourceId('none');
    } catch (error) {
      toast({
        title: 'Could not open the position',
        description: error instanceof Error ? error.message : 'Unexpected error',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {matches.length === 0 && !creating && (
        <div className="rounded-md border border-dashed p-3 text-center">
          <div className="text-[12px]">No position yet for this pair</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Opening one starts its history.
          </div>
          <Button
            size="sm"
            className="mt-2 h-7 text-xs"
            onClick={() => setCreating(true)}
            type="button"
          >
            Create a new position
          </Button>
        </div>
      )}

      {matches.map((position) => (
        <PositionOption
          key={position.id}
          position={position}
          index={index}
          selected={position.id === selectedId}
          onSelect={() => onSelect(position.id)}
        />
      ))}

      {matches.length > 0 && !creating && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-3 w-3" />
          Another position, different source
        </Button>
      )}

      {creating && (
        <div className="rounded-md border p-3">
          <Label className={FIELD_LABEL}>
            <Term k="sourceoffund">Source of fund</Term> for the new position
          </Label>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger className={cn('mt-1 h-8', FIELD_TEXT)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none" className={FIELD_TEXT}>
                No declared source — attribute per movement
              </SelectItem>
              {(portfolio.funding_sources ?? []).map((source) => (
                <SelectItem key={source.id} value={source.id} className={FIELD_TEXT}>
                  {source.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className={cn('mt-1', FIELD_HINT)}>
            A position funded from one pool can only ever be attributed to that pool.
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={saving}
              onClick={() => void create()}
            >
              {saving ? 'Opening…' : 'Open position'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Posting an entry.
 *
 * The form offers only the fields the chosen type is allowed to touch, and
 * never asks for a sign — the type decides, and the preview at the bottom shows
 * exactly the row (or the two cancelling rows) that will be written.
 */
export function PostEntryDialog({
  open,
  onOpenChange,
  index,
  portfolio,
  today,
  onPosted,
  onReloadPortfolio,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  index: LedgerIndex;
  portfolio: FlPortfolioReadModel;
  today: string;
  onPosted: () => void;
  /** Re-fetch the read model — used after a position is opened mid-dialog. */
  onReloadPortfolio: () => Promise<void>;
}) {
  const { toast } = useToast();
  // A posting is denominated in the workspace display currency — there is no
  // per-entry currency picker, so the draft carries it from here.
  const money = useLedgerMoney();
  const [draft, setDraft] = useState<EntryDraft>(() => emptyDraft(today, money.currency));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft(emptyDraft(today, money.currency));
  }, [open, today, money.currency]);

  const holderOptions = useMemo<EntityOption[]>(
    () => [
      ...(portfolio.investors ?? []).map((investor) => ({
        key: entityKey('investor', investor.id),
        name: investor.name,
        englishName: distinctEnglishName(investor.name, investor.english_name),
        group: 'Investors',
      })),
      ...(portfolio.funds ?? []).map((fund) => ({
        key: entityKey('fund', fund.id),
        name: fund.name,
        englishName: distinctEnglishName(fund.name, fund.english_name),
        group: 'Funds',
      })),
    ],
    [portfolio],
  );

  const instrumentOptions = useMemo<EntityOption[]>(() => {
    const options: EntityOption[] = [];
    if (allowsPositionKind(draft.type, 'fund')) {
      options.push(
        ...(portfolio.funds ?? []).map((fund) => ({
          key: entityKey('fund', fund.id),
          name: fund.name,
          englishName: distinctEnglishName(fund.name, fund.english_name),
          group: fund.managed ? 'Our funds' : 'External funds',
        })),
      );
    }
    if (allowsPositionKind(draft.type, 'asset')) {
      options.push(
        ...(portfolio.assets ?? []).map((asset) => ({
          key: entityKey('asset', asset.id),
          name: asset.name,
          englishName: distinctEnglishName(asset.name, asset.english_name),
          group: 'Assets',
        })),
      );
    }
    return options;
  }, [draft.type, portfolio]);

  const sides = sidesFor(draft, holderOptions, instrumentOptions);
  const spec = ENTRY_TYPES[draft.type];
  const transfer = sides.transfer;
  const legs = draftLegs(draft);
  const parsedHolder = parseEntityKey(sides.holderKey);
  const holderFund =
    parsedHolder?.kind === 'fund'
      ? portfolio.funds?.find((fund) => fund.id === parsedHolder.id)
      : undefined;
  const holderCandidate: CashHolderCandidate = useMemo(
    () => ({
      holder_investor_id: parsedHolder?.kind === 'investor' ? parsedHolder.id : null,
      holder_fund_id: parsedHolder?.kind === 'fund' ? parsedHolder.id : null,
      holderFundManaged: holderFund?.managed === true,
    }),
    [parsedHolder?.id, parsedHolder?.kind, holderFund?.managed],
  );
  const subTypeControl = subTypeControlFor({
    entryType: draft.type,
    holder: holderCandidate,
  });
  const problem = draftProblem(draft);

  const update = (patch: Partial<EntryDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      const nextSides = sidesFor(next, holderOptions, instrumentOptions);
      const nextParsed = parseEntityKey(nextSides.holderKey);
      const nextFund =
        nextParsed?.kind === 'fund'
          ? portfolio.funds?.find((fund) => fund.id === nextParsed.id)
          : undefined;
      const nextCandidate: CashHolderCandidate = {
        holder_investor_id: nextParsed?.kind === 'investor' ? nextParsed.id : null,
        holder_fund_id: nextParsed?.kind === 'fund' ? nextParsed.id : null,
        holderFundManaged: nextFund?.managed === true,
      };
      next.holderFundManaged = nextCandidate.holderFundManaged;
      // `null` means no position yet; a position the index cannot resolve —
      // including one created a moment ago, before the portfolio reload lands —
      // is 'unknown', which is treated as conservatively as an asset.
      next.instrumentKind = next.positionId
        ? index.positions.get(next.positionId)?.instrumentKind ?? 'unknown'
        : null;

      const nextApplicable = isProceedsTreatmentApplicable({
        entryType: next.type,
        holder: nextCandidate,
      });

      const nextControl = subTypeControlFor({
        entryType: next.type,
        holder: nextCandidate,
      });

      if (patch.subType !== undefined) {
        if (
          !nextApplicable &&
          (nextControl === 'none' || toDivestmentSubType(patch.subType) !== null)
        ) {
          next.subType = '';
        }
      } else {
        next.subType = resolveNextProceedsDestination(
          nextApplicable,
          next.subType,
          DEFAULT_PROCEEDS_TREATMENT,
        );
      }

      return next;
    });
  };

  const chooseType = (type: FlEntryType) => {
    // The sides are typed against the previous entry type's options — a buy's
    // asset is not a valid instrument for a capital call — so clear anything
    // the new type can't hold rather than posting against a stale pairing.
    update({
      type,
      from: '',
      to: '',
      instrument: '',
      positionId: '',
      fromPositionId: '',
      toPositionId: '',
      // An adjustment is a reduction far more often than an addition, so it
      // opens on the direction the reviewer almost always wants.
      decrease: postsAdjustmentDelta(type),
      subType: '',
    });
  };

  // A pairing with exactly one position needs no choosing.
  const singleMatch = (holderKey: string, instrumentKey: string): string => {
    const matches = positionsFor(index, holderKey, instrumentKey);
    return matches.length === 1 ? matches[0].id : '';
  };

  useEffect(() => {
    if (transfer) {
      const fromAuto = singleMatch(draft.from, draft.instrument);
      const toAuto = singleMatch(draft.to, draft.instrument);
      if (fromAuto && !draft.fromPositionId) update({ fromPositionId: fromAuto });
      if (toAuto && !draft.toPositionId) update({ toPositionId: toAuto });
      return;
    }
    const auto = singleMatch(sides.holderKey, sides.instrumentKey);
    if (auto && !draft.positionId) update({ positionId: auto });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.from, draft.to, draft.instrument, transfer, index]);

  const submit = async () => {
    const holderName =
      holderOptions.find((option) => option.key === sides.holderKey)?.name ?? '';
    const description = transfer
      ? `${entryTypeLabel(draft.type)} — ${holderOptions.find((option) => option.key === draft.from)?.name ?? ''} to ${holderOptions.find((option) => option.key === draft.to)?.name ?? ''}`
      : `${entryTypeLabel(draft.type)} — ${draft.positionId ? positionLabel(draft.positionId, index) : holderName}`;

    setSaving(true);
    try {
      await fundLedgerApi.postEvent(buildPostEventInput(draft, description));
      toast({ title: 'Entry posted' });
      onOpenChange(false);
      onPosted();
    } catch (error) {
      toast({
        title: 'Could not post the entry',
        description: error instanceof Error ? error.message : 'Unexpected error',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const amountEnabled = transfer || needsAmount(draft.type);
  const unitsEnabled = transfer ? draft.type === 'unit_transfer' : needsUnits(draft.type);
  const isAdjustment = !transfer && postsAdjustmentDelta(draft.type);
  const selectedPosition = draft.positionId ? index.positions.get(draft.positionId) : undefined;
  const instrumentKind = selectedPosition?.instrumentKind ?? null;
  // What this position may be adjusted for, and the choice that will actually
  // post — resolved, so a stale sub-type shows as the one it coerces to rather
  // than posting a meaning the reviewer cannot see.
  const adjustmentOptions = adjustmentSubTypesFor(instrumentKind);
  const adjustmentSubType = resolveAdjustmentSubType(draft.subType, instrumentKind);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-[15px]">Post an entry</DialogTitle>
          <DialogDescription className="text-[12px]">
            One real-world action. The form only offers the fields this type is allowed to touch.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <section>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              What happened
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {ENTRY_TYPE_KEYS.filter((key) => key !== 'cash_movement').map((key) => {
                const candidate = ENTRY_TYPES[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => chooseType(key)}
                    className={cn(
                      'rounded-md border p-2 text-left transition-colors',
                      draft.type === key ? 'border-primary bg-primary/5' : 'hover:bg-muted',
                    )}
                  >
                    <div className="text-[12px] font-medium">{candidate.label}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {candidate.twoLegged ? 'Two rows' : DIRECTION_LABELS[candidate.direction]}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 rounded border bg-muted px-2.5 py-2 text-[11px] text-muted-foreground">
              {spec.blurb}
            </div>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Which way it moves
            </div>
            <div className="flex items-end gap-2">
              <EntityCombobox
                id="ledger-post-from"
                label={
                  transfer
                    ? 'From — gives up'
                    : `From — ${sides.inward ? 'what is held' : 'the holder'}`
                }
                value={draft.from}
                options={sides.fromOptions}
                onChange={(key) =>
                  update({ from: key, positionId: '', fromPositionId: '' })
                }
              />
              <div className="pb-2 text-muted-foreground">→</div>
              <EntityCombobox
                id="ledger-post-to"
                label={
                  transfer ? 'To — receives' : `To — ${sides.inward ? 'the holder' : 'what is held'}`
                }
                value={draft.to}
                options={sides.toOptions}
                onChange={(key) => update({ to: key, positionId: '', toPositionId: '' })}
              />
            </div>
            {transfer && (
              <div className="mt-2.5">
                <EntityCombobox
                  id="ledger-post-instrument"
                  label={`In — the fund the ${draft.type === 'commitment_transfer' ? 'pledge sits in' : 'units sit in'}`}
                  value={draft.instrument}
                  options={instrumentOptions}
                  onChange={(key) =>
                    update({ instrument: key, fromPositionId: '', toPositionId: '' })
                  }
                />
              </div>
            )}
            <div className="mt-2 text-[10px] text-muted-foreground">
              {transfer
                ? "Two rows, one event. The fund's own totals do not change — only who owes what."
                : spec.cash === 'zero'
                  ? 'No cash moves on this type — the arrow shows which way the pledge or the units go.'
                  : sides.inward
                    ? 'Money comes back to the holder, so the holding is on the left.'
                    : 'Money leaves the holder, so the holder is on the left.'}
            </div>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {transfer ? (
                <>
                  The two <Term k="position">positions</Term> it lands on
                </>
              ) : (
                <>
                  <Term k="position">Position</Term> it lands on
                </>
              )}
            </div>
            {transfer ? (
              <div className="space-y-3">
                <div>
                  <div className="mb-1.5 text-[10px] text-muted-foreground">
                    {holderOptions.find((option) => option.key === draft.from)?.name ??
                      'The giver'}{' '}
                    — gives up
                  </div>
                  <PositionPicker
                    index={index}
                    portfolio={portfolio}
                    holderKey={draft.from}
                    instrumentKey={draft.instrument}
                    selectedId={draft.fromPositionId}
                    onSelect={(positionId) => update({ fromPositionId: positionId })}
                    onCreated={async (positionId) => {
                      await onReloadPortfolio();
                      update({ fromPositionId: positionId });
                    }}
                    date={draft.date}
                  />
                </div>
                <div>
                  <div className="mb-1.5 text-[10px] text-muted-foreground">
                    {holderOptions.find((option) => option.key === draft.to)?.name ??
                      'The receiver'}{' '}
                    — receives
                  </div>
                  <PositionPicker
                    index={index}
                    portfolio={portfolio}
                    holderKey={draft.to}
                    instrumentKey={draft.instrument}
                    selectedId={draft.toPositionId}
                    onSelect={(positionId) => update({ toPositionId: positionId })}
                    onCreated={async (positionId) => {
                      await onReloadPortfolio();
                      update({ toPositionId: positionId });
                    }}
                    date={draft.date}
                  />
                </div>
              </div>
            ) : (
              <PositionPicker
                index={index}
                portfolio={portfolio}
                holderKey={sides.holderKey}
                instrumentKey={sides.instrumentKey}
                selectedId={draft.positionId}
                onSelect={(positionId) => update({ positionId })}
                onCreated={async (positionId) => {
                  await onReloadPortfolio();
                  update({ positionId });
                }}
                date={draft.date}
              />
            )}
          </section>

          <section>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              The movement
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ledger-post-date" className={FIELD_LABEL}>
                  Date
                </Label>
                <Input
                  id="ledger-post-date"
                  type="date"
                  className={cn('mt-1 h-8', FIELD_TEXT)}
                  value={draft.date}
                  max={today}
                  onChange={(event) => update({ date: event.target.value })}
                />
              </div>
              {isAdjustment ? (
                <div>
                  <Label htmlFor="ledger-post-adjustment-kind" className={FIELD_LABEL}>
                    Adjusts
                  </Label>
                  <Select
                    value={adjustmentSubType}
                    onValueChange={(value) => update({ subType: value })}
                    disabled={adjustmentOptions.length === 1}
                  >
                    <SelectTrigger
                      id="ledger-post-adjustment-kind"
                      className={cn('mt-1 h-8', FIELD_TEXT)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {adjustmentOptions.map((option) => (
                        <SelectItem key={option} value={option} className={FIELD_TEXT}>
                          {ADJUSTMENT_SUB_TYPE_LABELS[option]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className={cn('mt-1', FIELD_HINT)}>
                    {adjustmentOptions.length === 1
                      ? 'Only a stake in a fund has paid-in capital to write off.'
                      : 'What this adjustment restates.'}
                  </div>
                </div>
              ) : subTypeControl === 'destination' ? (
                <div>
                  <Label htmlFor="ledger-post-subtype" className={FIELD_LABEL}>
                    Proceeds destination
                  </Label>
                  <Select
                    value={draft.subType || DEFAULT_PROCEEDS_TREATMENT}
                    onValueChange={(value) => update({ subType: value })}
                  >
                    <SelectTrigger id="ledger-post-subtype" className={cn('mt-1 h-8', FIELD_TEXT)}>
                      <SelectValue placeholder="Select destination…" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROCEEDS_DESTINATION_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className={FIELD_TEXT}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : subTypeControl === 'none' ? null : (
                <div>
                  <Label htmlFor="ledger-post-subtype" className={FIELD_LABEL}>
                    Sub-type
                  </Label>
                  <Input
                    id="ledger-post-subtype"
                    className={cn('mt-1 h-8', FIELD_TEXT)}
                    value={draft.subType}
                    placeholder={transfer ? 'secondary' : 'follow_on, mgmt_fee…'}
                    onChange={(event) => update({ subType: event.target.value })}
                  />
                </div>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ledger-post-amount" className={FIELD_LABEL}>
                  {transfer
                    ? draft.type === 'commitment_transfer'
                      ? 'Commitment transferred'
                      : 'Units transferred'
                    : amountLabelOf(draft.type, draft.subType, instrumentKind)}
                </Label>
                <NumericInput
                  id="ledger-post-amount"
                  className={cn('mt-1 h-8 font-mono tabular-nums', FIELD_TEXT)}
                  placeholder="0.00"
                  disabled={!amountEnabled && !unitsEnabled}
                  value={
                    transfer && draft.type === 'unit_transfer' ? draft.units : draft.amount
                  }
                  onChange={(value) =>
                    transfer && draft.type === 'unit_transfer'
                      ? update({ units: value })
                      : update({ amount: value })
                  }
                />
                <div className={cn('mt-1', FIELD_HINT)}>
                  {transfer
                    ? 'Leaves one holder and arrives at the other, unchanged.'
                    : isAdjustment
                      ? `Full amount in ${draft.currency}, unsigned — the direction beside it sets the sign.`
                      : amountEnabled
                        ? `Full amount in ${draft.currency} — type 1500000, not 1.5M.`
                        : 'This type never moves cash.'}
                </div>
              </div>
              {isAdjustment ? (
                <div>
                  <Label htmlFor="ledger-post-adjustment-direction" className={FIELD_LABEL}>
                    Direction
                  </Label>
                  <Select
                    value={draft.decrease ? 'decrease' : 'increase'}
                    onValueChange={(value) => update({ decrease: value === 'decrease' })}
                  >
                    <SelectTrigger
                      id="ledger-post-adjustment-direction"
                      className={cn('mt-1 h-8', FIELD_TEXT)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {adjustmentDirectionOptions(adjustmentSubType).map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className={FIELD_TEXT}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className={cn('mt-1', FIELD_HINT)}>Sets the sign of the amount.</div>
                </div>
              ) : (
                <div>
                  <Label htmlFor="ledger-post-units" className={FIELD_LABEL}>
                    {transfer ? 'Consideration paid' : 'Units'}
                  </Label>
                  <NumericInput
                    id="ledger-post-units"
                    className={cn('mt-1 h-8 font-mono tabular-nums', FIELD_TEXT)}
                    placeholder="0"
                    disabled={!transfer && !unitsEnabled}
                    value={transfer ? draft.consideration : draft.units}
                    onChange={(value) =>
                      transfer ? update({ consideration: value }) : update({ units: value })
                    }
                  />
                  <div className={cn('mt-1', FIELD_HINT)}>
                    {transfer
                      ? 'What the receiver paid the giver. Leave blank if untracked.'
                      : unitsEnabled
                        ? 'Units or shares this movement covers.'
                        : 'This type never changes units.'}
                  </div>
                </div>
              )}
            </div>

            {offersDecreaseToggle(draft.type) && (
              <Label className="mt-3 flex w-fit cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] font-normal">
                <Checkbox
                  checked={draft.decrease}
                  onCheckedChange={(checked) => update({ decrease: checked === true })}
                  className="h-3.5 w-3.5"
                />
                Reduce instead of increase
              </Label>
            )}

            {selectedPosition?.fundingSource && amountEnabled && (
              <div className="mt-3 rounded border bg-muted px-2.5 py-2 text-[11px] text-muted-foreground">
                This position is funded from{' '}
                <b className="font-semibold text-foreground">
                  {selectedPosition.fundingSource.name}
                </b>
                , so the whole amount is attributed there automatically. Money from a different
                pool belongs on a different position.
              </div>
            )}

            <div className="mt-3">
              <Label htmlFor="ledger-post-notes" className={FIELD_LABEL}>
                Remarks
              </Label>
              <Textarea
                id="ledger-post-notes"
                rows={2}
                className={cn('mt-1', FIELD_TEXT)}
                placeholder="Context the next person will need"
                value={draft.notes}
                onChange={(event) => update({ notes: event.target.value })}
              />
            </div>
          </section>
        </div>

        <DialogFooter className="flex-col items-stretch gap-3 border-t px-5 py-4 sm:flex-col sm:items-stretch">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              The {legs.length > 1 ? 'rows' : 'row'} this will write
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                    {transfer && <th className="px-2 py-1.5 text-left font-medium">Leg</th>}
                    <th className="px-2 py-1.5 text-right font-medium">Commitment Δ</th>
                    <th className="px-2 py-1.5 text-right font-medium">Quantity Δ</th>
                    <th className="px-2 py-1.5 text-right font-medium">Cash Δ</th>
                    {isAdjustment && (
                      <th className="px-2 py-1.5 text-right font-medium">
                        {adjustmentSubType === PAID_IN_WRITEOFF_SUBTYPE ? 'Paid-in Δ' : 'Value Δ'}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {legs.map((leg, legIndex) => (
                    <tr key={legIndex} className="border-b last:border-0">
                      {transfer && (
                        <td className="px-2 py-1.5 text-muted-foreground">{leg.role}</td>
                      )}
                      {(isAdjustment
                        ? ([
                            leg.commitmentDelta,
                            leg.quantityDelta,
                            leg.cashDelta,
                            leg.valuationDelta,
                          ] as const)
                        : ([leg.commitmentDelta, leg.quantityDelta, leg.cashDelta] as const)
                      ).map((value, valueIndex) => (
                        <td
                          key={valueIndex}
                          className={cn(
                            'px-2 py-1.5 text-right font-mono tabular-nums',
                            (isAdjustment ? valueIndex === 3 : valueIndex === 2) &&
                              'font-medium',
                            signClass(value),
                          )}
                        >
                          {/* Units keep their stored precision; money is always 2dp. */}
                          {valueIndex === 1 ? formatExactAuto(value) : formatExact(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-auto max-w-[300px] text-[11px] leading-snug text-muted-foreground">
              {problem ??
                (transfer
                  ? "Both legs cancel, so the fund's totals are untouched."
                  : isAdjustment
                    ? ADJUSTMENT_EFFECT_LABELS[adjustmentSubType]
                    : 'Signs are set by the type, not typed by hand.')}
            </span>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!!problem || saving} onClick={() => void submit()}>
              {saving ? 'Posting…' : `Post ${transfer ? 'both rows' : 'entry'}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
