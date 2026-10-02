'use client';

/**
 * Ownership tab on a company holding (MB-567, behind
 * CORPORATE_ACTIONS_ENABLED). A corporate action — a funding round, an
 * opening stake or any other ownership change — is recorded once on the
 * company, and every one of our positions in it (across all our funds) gets its
 * ownership % before and after. It writes neither ledger entries nor
 * valuation marks, so invested, realized and market value never move.
 *
 * Funding-round amounts are entered and shown in millions, like the rest of
 * Fund Management; the API carries raw currency units. The currency is fixed
 * to the workspace currency and shown read-only, not as a picker.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPercentage } from '@/lib/numberFormat';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import type {
  OwnershipContext,
  CorporateActionView,
  CorporateActionWriteInput,
} from '@/lib/api/fundLedger';
import {
  computeFundingRound,
  OWNERSHIP_ACTION_LABELS,
  OWNERSHIP_ACTION_TYPES,
  validateDirectOwnershipChange,
  validateFundingRound,
  type DirectOwnershipInput,
  type FundingRoundParticipantInput,
  type OwnershipActionType,
} from '@/lib/fundLedger/fundingRound';
import { flDiv, flMul } from '@/lib/services/flDecimal';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';
import { useFundData } from './context';
import { GlossaryTerm, Pill } from './parts';
import type { Holding } from './types';

const MILLION = '1000000';
const th = 'px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground border-b';
const DECIMAL_RE = /^\s*\d+(\.\d+)?\s*$/;

/** Raw currency units → millions display, e.g. "1,250M" or "0.5M". */
function mil(raw: string): string {
  const n = Number(flDiv(raw, MILLION, 6));
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
}

/** Millions input → raw currency units; '' stays '' so validation can flag it. */
function millionsToRaw(input: string): string {
  const s = input.trim().replace(/,/g, '');
  return DECIMAL_RE.test(s) ? flMul(s, MILLION) : s;
}

/** Raw currency units → millions input text (6 dp, so 0.5M round-trips). */
function rawToMillionsInput(raw: string): string {
  return flDiv(raw, MILLION, 6).replace(/\.?0+$/, '');
}

/**
 * Adds thousands commas to a typed non-negative decimal, string-wise so no
 * digit is lost to floating point: "1000000.5" → "1,000,000.5". A trailing "."
 * is kept so the user can keep typing decimals.
 */
export function groupDigits(raw: string): string {
  const [int, dec] = raw.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec === undefined ? grouped : `${grouped}.${dec}`;
}

/** Strips commas and anything else that can't be part of a non-negative decimal. */
export function ungroupDigits(typed: string): string {
  const cleaned = typed.replace(/[^\d.]/g, '');
  const dot = cleaned.indexOf('.');
  return dot === -1 ? cleaned : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
}

/**
 * A millions amount field that comma-groups as you type, like the money
 * inputs on the Transactions tab. `value` and `onChange` carry the ungrouped
 * string, so the calculator and validation never see commas. The caret stays
 * after the same digit when a comma is added or removed in front of it.
 */
function GroupedAmountInput({
  value,
  onChange,
  className,
  disabled,
  placeholder,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (raw: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const caretDigits = useRef<number | null>(null);
  const display = groupDigits(value);

  useLayoutEffect(() => {
    const el = ref.current;
    const want = caretDigits.current;
    if (!el || want == null || document.activeElement !== el) return;
    caretDigits.current = null;
    let pos = 0;
    for (let seen = 0; pos < display.length && seen < want; pos++) {
      if (display[pos] !== ',') seen++;
    }
    el.setSelectionRange(pos, pos);
  }, [display]);

  return (
    <input
      ref={ref}
      inputMode="decimal"
      className={className}
      value={display}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        const caret = e.target.selectionStart ?? e.target.value.length;
        caretDigits.current = ungroupDigits(e.target.value.slice(0, caret)).length;
        onChange(ungroupDigits(e.target.value));
      }}
    />
  );
}

function pct(v: string | null | undefined): string {
  return v == null ? '—' : formatPercentage(Number(v));
}

function actionName(r: CorporateActionView): string {
  return r.label?.trim() || OWNERSHIP_ACTION_LABELS[r.action_type];
}

/**
 * How a holding shows the Ownership tab. Fund-of-funds targets and unsaved
 * holdings never get it (`hidden`). Otherwise the tab is always listed, but
 * its body is a `disabled` notice unless the setting is on. Fail-closed:
 * `useFeatureEnabled` treats an unresolved key as on, so this checks for an
 * explicit `true`.
 */
export function ownershipTabState(
  flags: Partial<Record<string, boolean>>,
  holding: Pick<Holding, 'id' | 'targetKind'>,
): 'hidden' | 'disabled' | 'enabled' {
  if (holding.targetKind === 'fund' || !holding.id) return 'hidden';
  return flags.CORPORATE_ACTIONS_ENABLED === true ? 'enabled' : 'disabled';
}

/** The Ownership tab body while the setting is off. Loads nothing. */
export function OwnershipDisabledNotice() {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-md border bg-muted px-6 py-12 text-center"
      data-testid="ownership-disabled"
    >
      <Lock className="h-5 w-5 text-muted-foreground" />
      <div className="text-sm font-medium text-foreground">Ownership &amp; Corporate Actions is turned off</div>
      <p className="max-w-md text-xs text-muted-foreground">
        This workspace doesn&apos;t track ownership % through corporate actions yet. A workspace admin can turn
        on &ldquo;Ownership &amp; Corporate Actions&rdquo; in the admin portal&apos;s Features tab.
      </p>
    </div>
  );
}

/** A holder's name, with its English name after it in muted text when it has one. */
function HolderLabel({ name, englishName }: { name: string | null; englishName: string | null }) {
  return (
    <>
      {name ?? 'Position'}
      {englishName && <span className="text-muted-foreground"> ({englishName})</span>}
    </>
  );
}

/** The Ownership tab body. Render only when {@link ownershipTabState} is `enabled`. */
export function OwnershipSection({ holding }: { holding: Holding }) {
  if (!holding.id) return null;
  return <OwnershipPanel key={holding.id} holding={holding} />;
}

type Editing = { mode: 'add'; key: 'new' } | { mode: 'edit'; key: string; round: CorporateActionView };

function OwnershipPanel({ holding }: { holding: Holding }) {
  const assetId = holding.id!;
  const { refreshAll } = useFundData();
  const { toast } = useToast();
  const workspaceCurrency = useWorkspaceCurrency();
  const [ctx, setCtx] = useState<OwnershipContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<CorporateActionView | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  // Drops a slow earlier load that lands after a newer one (e.g. after a save).
  const activeLoadRef = useRef(0);

  const load = async () => {
    const reqId = ++activeLoadRef.current;
    try {
      const data = await fundLedgerApi.getOwnershipContext(assetId);
      if (activeLoadRef.current !== reqId) return;
      setCtx(data);
      setLoadError(null);
    } catch (err) {
      if (activeLoadRef.current !== reqId) return;
      setLoadError(err instanceof Error ? err.message : 'Could not load ownership');
    }
  };

  useEffect(() => {
    void load();
    // `load` only closes over assetId, which keys this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const afterWrite = async (warnings: string[]) => {
    await Promise.all([load(), refreshAll()]);
    for (const w of warnings) {
      toast({ title: 'Check the follow-on investment', description: w });
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyDelete(true);
    try {
      await fundLedgerApi.deleteCorporateAction(deleting.id);
      setDeleting(null);
      await afterWrite([]);
    } catch (err) {
      toast({
        title: 'Failed to delete corporate action',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setBusyDelete(false);
    }
  };

  return (
    <div data-testid="ownership">
      <p className="mb-3 text-xs text-muted-foreground">
        Our ownership % in this company, across every fund that holds it. Corporate actions change ownership only —
        they never post cash or change invested, realized or market value.
      </p>

      {loadError && <p className="text-xs text-destructive">{loadError}</p>}
      {!ctx && !loadError && (
        <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading ownership…
        </div>
      )}

      {ctx && (
        <OwnershipTables
          ctx={ctx}
          onRecord={() => setEditing({ mode: 'add', key: 'new' })}
          onEdit={(r) => setEditing({ mode: 'edit', key: r.id, round: r })}
          onDelete={setDeleting}
        />
      )}

      {ctx && editing && (
        <CorporateActionDialog
          key={editing.key}
          assetId={assetId}
          defaultCurrency={workspaceCurrency}
          ctx={ctx}
          round={editing.mode === 'edit' ? editing.round : null}
          onClose={() => setEditing(null)}
          onSaved={async (warnings) => {
            setEditing(null);
            await afterWrite(warnings);
          }}
        />
      )}

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busyDelete) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this corporate action?</AlertDialogTitle>
            <AlertDialogDescription>
              Its before/after stakes are removed. Invested, realized and market value are not affected. Later actions
              are not recomputed and will show as stale.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyDelete}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyDelete}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {busyDelete ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Current ownership per fund and the ownership history, newest first. */
export function OwnershipTables({
  ctx,
  onRecord,
  onEdit,
  onDelete,
}: {
  ctx: OwnershipContext;
  onRecord: () => void;
  onEdit: (round: CorporateActionView) => void;
  onDelete: (round: CorporateActionView) => void;
}) {
  const rounds = ctx.actions;
  const eventById = new Map(rounds.map((r) => [r.id, r]));
  return (
    <>
      <div className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <GlossaryTerm term="ownership">Current ownership</GlossaryTerm>
      </div>
      <div className="overflow-x-auto rounded-md border bg-card" data-testid="ownership-current">
        <table className="w-full min-w-[520px] border-collapse">
          <thead>
            <tr>
              <th className={cn(th, 'text-left')}>Holder</th>
              <th className={cn(th, 'text-right')}>Stake</th>
              <th className={cn(th, 'text-left')}>As of</th>
              <th className={cn(th, 'text-left')}>From</th>
            </tr>
          </thead>
          <tbody>
            {ctx.positions.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No open holdings in this company
                </td>
              </tr>
            ) : (
              ctx.positions.map((p) => {
                const event = p.current_pct_event_id ? eventById.get(p.current_pct_event_id) : undefined;
                return (
                  <tr key={p.position_id} className="border-b last:border-b-0">
                    <td className="px-2 py-1.5 text-xs">
                      <HolderLabel name={p.holder_name} englishName={p.holder_english_name} />
                    </td>
                    <td className="px-2 py-1.5 text-right text-xs font-medium">{pct(p.current_pct)}</td>
                    <td className="px-2 py-1.5 text-xs">{p.current_pct_as_of ?? '—'}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">
                      {p.current_pct_source === 'ownership' && event
                        ? actionName(event)
                        : p.current_pct_source === 'valuation'
                          ? 'Quarterly mark'
                          : 'Not recorded — add an opening stake'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mb-2.5 mt-6 flex items-center justify-between gap-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <GlossaryTerm term="corporateaction">Ownership history</GlossaryTerm>
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={ctx.positions.length === 0}
          onClick={onRecord}
          data-testid="record-corporate-action"
        >
          Record corporate action
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse">
          <thead>
            <tr>
              <th className={cn(th, 'w-24 text-left')}>Date</th>
              <th className={cn(th, 'min-w-[180px] text-left')}>Action</th>
              <th className={cn(th, 'text-left')}>Round terms</th>
              <th className={cn(th, 'text-left')}>Our stakes (before → after)</th>
              <th className={cn(th, 'w-28 text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rounds.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No corporate actions recorded
                </td>
              </tr>
            ) : (
              [...rounds].reverse().map((r) => (
                <tr key={r.id} className="border-b align-top" data-testid={`ownership-event-${r.id}`}>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums">{r.action_date}</td>
                  <td className="px-2 py-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill className="whitespace-nowrap">{OWNERSHIP_ACTION_LABELS[r.action_type]}</Pill>
                      {r.stale && (
                        <Pill className="whitespace-nowrap border-warning/40 text-warning">
                          <span title="An earlier action changed after this one was entered. Its starting stakes are out of date; edit it to recompute.">
                            Stale
                          </span>
                        </Pill>
                      )}
                    </div>
                    {r.label && <div className="mt-1">{r.label}</div>}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    {r.action_type === 'funding_round' && r.pre_money != null && r.round_size != null ? (
                      <span className="whitespace-nowrap">
                        {r.currency} pre {mil(r.pre_money)} + raised {mil(r.round_size)} = post{' '}
                        <b className="font-medium">{r.post_money != null ? mil(r.post_money) : '—'}</b>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    {r.changes.map((p) => (
                      // Long holder names (with their English names) wrap; the figures after them never split.
                      <div key={p.id} className="py-0.5">
                        <span className="text-muted-foreground">
                          {p.holder_name ?? 'Position'}
                          {p.holder_english_name && ` (${p.holder_english_name})`}:
                        </span>{' '}
                        <span className="whitespace-nowrap">
                          {r.action_type === 'opening_stake' ? '' : `${pct(p.pct_before)} → `}
                          <b className="font-medium">{pct(p.effective_pct)}</b>
                          {Number(p.follow_on_amount) > 0 && (
                            <span className="text-muted-foreground">
                              {' '}
                              · follow-on {r.currency ? `${r.currency} ` : ''}
                              {mil(p.follow_on_amount)}
                            </span>
                          )}
                          {p.pct_override != null && <span className="text-muted-foreground"> (override)</span>}
                        </span>
                      </div>
                    ))}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => onEdit(r)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                      onClick={() => onDelete(r)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface Row {
  positionId: string;
  holderName: string;
  holderEnglishName: string | null;
  include: boolean;
  /** Whether the position already has ownership history (drives the opening-stake default). */
  hasHistory: boolean;
  preRoundPct: string;
  followOnM: string;
  overridePct: string;
  overrideRemark: string;
  pctAfter: string;
}

function numText(v: string | null | undefined): string {
  return v == null ? '' : String(Number(v));
}

function initialRows(ctx: OwnershipContext, round: CorporateActionView | null): Row[] {
  if (round) {
    return round.changes.map((p) => ({
      positionId: p.position_id,
      holderName: p.holder_name ?? 'Position',
      holderEnglishName: p.holder_english_name,
      include: true,
      hasHistory: true,
      preRoundPct: numText(p.pct_before),
      followOnM: Number(p.follow_on_amount) === 0 ? '' : rawToMillionsInput(p.follow_on_amount),
      overridePct: numText(p.pct_override),
      overrideRemark: p.override_remark ?? '',
      pctAfter: numText(p.effective_pct),
    }));
  }
  return ctx.positions.map((p) => ({
    positionId: p.position_id,
    holderName: p.holder_name ?? 'Position',
    holderEnglishName: p.holder_english_name,
    include: true,
    hasHistory: p.current_pct_source === 'ownership',
    preRoundPct: numText(p.current_pct),
    followOnM: '',
    overridePct: '',
    overrideRemark: '',
    pctAfter: '',
  }));
}

function CorporateActionDialog({
  assetId,
  defaultCurrency,
  ctx,
  round,
  onClose,
  onSaved,
}: {
  assetId: string;
  defaultCurrency: string;
  ctx: OwnershipContext;
  round: CorporateActionView | null;
  onClose: () => void;
  onSaved: (warnings: string[]) => Promise<void>;
}) {
  const { toast } = useToast();
  // With no ownership history anywhere yet, the first thing to record is an opening stake.
  const [actionType, setActionType] = useState<OwnershipActionType>(
    round?.action_type ?? (ctx.actions.length === 0 ? 'opening_stake' : 'funding_round'),
  );
  const [roundDate, setRoundDate] = useState(round?.action_date ?? '');
  const [label, setLabel] = useState(round?.label ?? '');
  // Not editable: a new action takes the workspace currency; an edit keeps the one it was saved in.
  const currency = round?.currency ?? defaultCurrency;
  const [preMoneyM, setPreMoneyM] = useState(round?.pre_money ? rawToMillionsInput(round.pre_money) : '');
  const [roundSizeM, setRoundSizeM] = useState(round?.round_size ? rawToMillionsInput(round.round_size) : '');
  const [rows, setRows] = useState<Row[]>(() => initialRows(ctx, round));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const isRound = actionType === 'funding_round';
  const isOpening = actionType === 'opening_stake';

  const changeType = (next: OwnershipActionType) => {
    setActionType(next);
    // An opening stake is for positions with no history yet; other actions default to everyone.
    setRows((prev) => prev.map((r) => ({ ...r, include: next === 'opening_stake' ? !r.hasHistory : true })));
  };

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const included = rows.filter((r) => r.include);

  // Funding round: computed from the terms.
  const terms = { preMoney: millionsToRaw(preMoneyM), roundSize: millionsToRaw(roundSizeM) };
  const roundParticipants: FundingRoundParticipantInput[] = included.map((r) => ({
    positionId: r.positionId,
    preRoundPct: r.preRoundPct.trim(),
    participationAmount: r.followOnM.trim() ? millionsToRaw(r.followOnM) : '0',
    overridePct: r.overridePct.trim() || null,
    overrideRemark: r.overrideRemark.trim() || null,
  }));
  // Opening stake / other: stake after as entered.
  const directParticipants: DirectOwnershipInput[] = included.map((r) => ({
    positionId: r.positionId,
    preRoundPct: isOpening ? '0' : r.preRoundPct.trim(),
    pctAfter: r.pctAfter.trim(),
  }));

  const errors = isRound
    ? validateFundingRound(terms, roundParticipants)
    : validateDirectOwnershipChange(actionType, directParticipants);
  if (!roundDate) errors.unshift('Date is required.');
  // Hold the error list back until the form has something in it, so an empty
  // form doesn't open on a wall of red.
  const showErrors = isRound
    ? !!roundDate && !!preMoneyM.trim() && !!roundSizeM.trim()
    : !!roundDate && included.some((r) => r.pctAfter.trim() !== '');
  const preview = isRound && errors.length === 0 ? computeFundingRound(terms, roundParticipants) : null;
  const byPosition = new Map(preview?.participants.map((p) => [p.positionId, p]) ?? []);

  const submit = async () => {
    if (errors.length > 0 || saving) return;
    setSaving(true);
    setServerError(null);
    const input: CorporateActionWriteInput & { action_type?: OwnershipActionType } = isRound
      ? {
          action_date: roundDate,
          label: label.trim() || null,
          currency,
          pre_money: terms.preMoney,
          round_size: terms.roundSize,
          participants: roundParticipants.map((p) => ({
            position_id: p.positionId,
            pct_before: p.preRoundPct,
            follow_on_amount: p.participationAmount,
            pct_override: p.overridePct ?? null,
            override_remark: p.overrideRemark ?? null,
          })),
        }
      : {
          action_date: roundDate,
          label: label.trim() || null,
          participants: directParticipants.map((p) => ({
            position_id: p.positionId,
            pct_before: p.preRoundPct,
            pct_after: p.pctAfter,
          })),
        };
    try {
      const result = round
        ? await fundLedgerApi.updateCorporateAction(round.id, input)
        : await fundLedgerApi.recordCorporateAction(assetId, { ...input, action_type: actionType });
      await onSaved(result.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The action was not saved.';
      setServerError(message);
      toast({ title: 'Failed to save corporate action', description: message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const input = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm';

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-w-[880px]">
        <DialogHeader>
          <DialogTitle>{round ? 'Edit corporate action' : 'Record corporate action'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 px-1 pb-1">
          <p className="text-xs text-muted-foreground">
            {isRound
              ? "The company raised new money. Works out each fund's ownership % after the round from pre-money, round size and any follow-on. Record the follow-on cash itself under Transactions."
              : isOpening
                ? 'The ownership % a fund started with in this company. The ledger records cash, never ownership, so enter it once per fund.'
                : "Any other change to our ownership % (share transfer, buyback, ESOP top-up…). Enter each fund's stake before and after."}{' '}
            Only ownership changes — no cash is posted and no valuation is written.
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
            <label className="col-span-2 text-xs">
              <span className="mb-1 block text-muted-foreground">Type</span>
              <select
                className={input}
                value={actionType}
                disabled={!!round}
                onChange={(e) => changeType(e.target.value as OwnershipActionType)}
                data-testid="corporate-action-type"
              >
                {OWNERSHIP_ACTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {OWNERSHIP_ACTION_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 text-xs">
              <span className="mb-1 block text-muted-foreground">Date</span>
              <input type="date" className={input} value={roundDate} onChange={(e) => setRoundDate(e.target.value)} />
            </label>
            <label className="col-span-2 text-xs">
              <span className="mb-1 block text-muted-foreground">Label (optional)</span>
              <input
                className={input}
                value={label}
                placeholder={isRound ? 'e.g. Series B' : isOpening ? 'e.g. Initial investment' : 'e.g. Share transfer'}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            {isRound && (
              <>
                {/* Fixed, not a picker: the workspace currency (or the one an older action was saved in). */}
                <div className="col-span-2 text-xs">
                  <span className="mb-1 block text-muted-foreground">Currency</span>
                  <div
                    className="flex h-8 items-center rounded-md border bg-muted px-2 text-sm text-muted-foreground"
                    title="Corporate actions use the workspace currency"
                    data-testid="corporate-action-currency"
                  >
                    {currency}
                  </div>
                </div>
                <label className="col-span-2 text-xs">
                  <span className="mb-1 block text-muted-foreground">Pre-money (M)</span>
                  <GroupedAmountInput
                    className={cn(input, 'text-right')}
                    value={preMoneyM}
                    onChange={setPreMoneyM}
                  />
                </label>
                <label className="col-span-2 text-xs">
                  <span className="mb-1 block text-muted-foreground">Round size (M)</span>
                  <GroupedAmountInput
                    className={cn(input, 'text-right')}
                    value={roundSizeM}
                    onChange={setRoundSizeM}
                  />
                </label>
              </>
            )}
          </div>

          <div className="overflow-x-auto rounded-md border bg-card">
            <table className={cn('w-full border-collapse', isRound ? 'min-w-[760px]' : 'min-w-[420px]')}>
              <thead>
                <tr>
                  <th className={cn(th, 'w-8 text-left')} />
                  <th className={cn(th, 'text-left')}>Holder</th>
                  {!isOpening && <th className={cn(th, 'text-right')}>Stake before %</th>}
                  {isRound ? (
                    <>
                      <th className={cn(th, 'text-right')}>Follow-on (M)</th>
                      <th className={cn(th, 'text-right')}>Override %</th>
                      <th className={cn(th, 'text-left')}>Override remark</th>
                      <th className={cn(th, 'text-right')}>No follow-on</th>
                      <th className={cn(th, 'text-right')}>Stake after</th>
                      <th className={cn(th, 'text-right')} title="Stake after × post-money. For reference; not saved.">
                        Implied value (M)
                      </th>
                    </>
                  ) : (
                    <th className={cn(th, 'text-right')}>{isOpening ? 'Opening stake %' : 'Stake after %'}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const res = r.include ? byPosition.get(r.positionId) : undefined;
                  return (
                    <tr key={r.positionId} className={cn('border-b', !r.include && 'text-muted-foreground')}>
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          aria-label={`Include ${r.holderName}`}
                          checked={r.include}
                          disabled={!!round}
                          onChange={(e) => setRow(i, { include: e.target.checked })}
                        />
                      </td>
                      <td className="px-2 py-1 text-xs">
                        <HolderLabel name={r.holderName} englishName={r.holderEnglishName} />
                      </td>
                      {!isOpening && (
                        <td className="px-2 py-1">
                          <input
                            inputMode="decimal"
                            className={cn(input, 'ml-auto h-7 w-20 text-right')}
                            value={r.preRoundPct}
                            disabled={!r.include}
                            onChange={(e) => setRow(i, { preRoundPct: e.target.value })}
                          />
                        </td>
                      )}
                      {isRound ? (
                        <>
                          <td className="px-2 py-1">
                            <GroupedAmountInput
                              className={cn(input, 'h-7 w-28 text-right')}
                              value={r.followOnM}
                              placeholder="0"
                              disabled={!r.include}
                              aria-label={`Follow-on for ${r.holderName}`}
                              onChange={(v) => setRow(i, { followOnM: v })}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              inputMode="decimal"
                              className={cn(input, 'h-7 w-20 text-right')}
                              value={r.overridePct}
                              disabled={!r.include}
                              onChange={(e) => setRow(i, { overridePct: e.target.value })}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              className={cn(input, 'h-7')}
                              value={r.overrideRemark}
                              placeholder={r.overridePct.trim() ? 'Required with an override' : ''}
                              disabled={!r.include}
                              onChange={(e) => setRow(i, { overrideRemark: e.target.value })}
                            />
                          </td>
                          <td className="px-2 py-1 text-right text-xs">
                            {res ? pct(res.pctWithoutParticipation) : '—'}
                          </td>
                          <td className="px-2 py-1 text-right text-xs font-medium">
                            {res ? pct(res.effectivePct) : '—'}
                          </td>
                          <td className="px-2 py-1 text-right text-xs text-muted-foreground">
                            {res ? mil(res.value) : '—'}
                          </td>
                        </>
                      ) : (
                        <td className="px-2 py-1">
                          <input
                            inputMode="decimal"
                            className={cn(input, 'ml-auto h-7 w-20 text-right')}
                            value={r.pctAfter}
                            disabled={!r.include}
                            onChange={(e) => setRow(i, { pctAfter: e.target.value })}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {preview && (
            <p className="text-xs text-muted-foreground">
              Post-money {currency} {mil(preview.postMoney)} · dilution ×{Number(preview.dilutionFactor).toFixed(4)}
            </p>
          )}

          {((showErrors && errors.length > 0) || serverError) && (
            <div className="rounded-md border border-destructive/40 bg-card px-3 py-2 text-xs text-destructive">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" /> Fix before saving
              </div>
              <ul className="list-disc pl-5">
                {serverError && <li>{serverError}</li>}
                {showErrors &&
                  errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={errors.length > 0 || saving}>
            {saving ? 'Saving…' : round ? 'Save changes' : 'Record'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
