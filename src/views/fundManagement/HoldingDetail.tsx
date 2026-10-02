'use client';

import { useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { formatPercentage } from '@/lib/numberFormat';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { EquityMetrics, Fund, Holding, HoldingFacts, Quarter, SellProceedsDestination, Txn, TxnType } from './types';
import {
  canSubmitTxnDialog,
  computeFoF,
  computeInv,
  formatCompact,
  formatGrouped,
  getAssetInvestType,
  getNextSellProceedsDestination,
  INVEST_TYPES,
  isFoF,
  parseCurrencyInput,
  proceedsTreatmentLabel,
  proceedsTreatmentOptionsFor,
  PROCEEDS_TREATMENT_OPTIONS,
  regroupNumericInput,
  selectEligibleMark,
  setAssetInvestType,
  txnTypeLabel,
  txnValue,
} from './calc';
import { isProceedsTreatmentApplicable } from '@/lib/fundLedger/proceedsTreatment';
import type { CashHolderCandidate } from '@/lib/fundLedger/cashOwnership';
import { useFundMoney } from './useFundMoney';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';
import { useFundData } from './context';
import { Combobox } from './Combobox';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import { isSellProceedsDestination } from '@/lib/sellProceedsDestination';
import { toLocalISODate } from './adapters';
import { FieldKey, GlossaryTerm, InlineEdit, type InlineKind, MiniSpark, Pill } from './parts';
import { CURRENCIES, CurrencyInput, MoneyInlineEdit, normalizeCurrency, type Currency } from './CurrencyInput';
import { OwnershipDisabledNotice, OwnershipSection, ownershipTabState } from './Ownership';
import { useFeatureFlags } from '@/components/layout/FeatureFlagsContext';

// Money domain values are in millions; the currency editors work in raw units.
const M = 1_000_000;
const toRaw = (millions: number | null | undefined): number | null =>
  millions == null ? null : millions * M;
const rawToMillions = (raw: number | null): string => (raw == null ? '' : String(raw / M));

const num = (raw: string): number | null => (raw === '' ? null : parseFloat(raw) || 0);
const txt = (raw: string): string | null => raw || null;

/** Commit handler for the English-name field. It's an asset column that
 * applies to every holding type, so it lives on the holding itself rather than
 * on `inv` / `d` like the other Legal-tab fields. */
const englishNameSetter = (h: Holding, save: () => void) => (raw: string) => {
  h.englishName = txt(raw) ?? undefined;
  save();
};

// ---- display helpers ----
function KV({ label, term, value }: { label: string; term?: string; value?: ReactNode }) {
  const empty = value == null || value === '' || value === '#VALUE!';
  return (
    <div>
      <FieldKey>{term ? <GlossaryTerm term={term}>{label}</GlossaryTerm> : label}</FieldKey>
      <div className="text-[13px] text-foreground">{empty ? '—' : value}</div>
    </div>
  );
}

/** Labelled, click-to-edit field for the identity/business grids. */
function EditKV({
  label,
  term,
  value,
  display,
  kind = 'text',
  options,
  onCommit,
}: {
  label: string;
  term?: string;
  value: string | number | null | undefined;
  display?: ReactNode;
  kind?: InlineKind;
  options?: string[];
  onCommit: (raw: string) => void;
}) {
  return (
    <div>
      <FieldKey>{term ? <GlossaryTerm term={term}>{label}</GlossaryTerm> : label}</FieldKey>
      <div className="text-[13px] text-foreground">
        <InlineEdit value={value} display={display} kind={kind} options={options} onCommit={onCommit} />
      </div>
    </div>
  );
}

/** Labelled searchable dropdown for the identity grids — used for the asset's
 * investing entity / source of fund so the stored value is picked from the
 * managed lists (and therefore lines up with the Investor / Source tabs). A
 * stored value that isn't in `options` (e.g. legacy free text) still shows. */
function SelectKV({
  label,
  term,
  value,
  options,
  placeholder,
  onCommit,
}: {
  label: string;
  term?: string;
  value: string | null | undefined;
  options: string[];
  placeholder?: string;
  onCommit: (raw: string) => void;
}) {
  const current = value ?? '';
  // Surface a stored-but-unmanaged value as a selectable option so it renders
  // in the trigger and can be kept or replaced.
  const opts = current && !options.includes(current) ? [current, ...options] : options;
  return (
    <div>
      <FieldKey>{term ? <GlossaryTerm term={term}>{label}</GlossaryTerm> : label}</FieldKey>
      <div className="mt-1">
        <Combobox
          value={current}
          options={opts}
          onChange={onCommit}
          placeholder={placeholder ?? 'Select…'}
          size="sm"
          className="h-7 text-[13px]"
        />
      </div>
    </div>
  );
}

function Tile({
  label,
  term,
  value,
  tone,
}: {
  label: string;
  term?: string;
  value: ReactNode;
  tone?: 'success' | 'danger';
}) {
  return (
    <div className="rounded-lg border bg-muted px-2.5 py-2">
      <FieldKey>{term ? <GlossaryTerm term={term}>{label}</GlossaryTerm> : label}</FieldKey>
      <div
        className={cn(
          'text-[15px] font-medium',
          tone === 'success' && 'text-success',
          tone === 'danger' && 'text-destructive',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function CalcRow({
  label,
  term,
  value,
  bold,
  indent,
}: {
  label: string;
  term?: string;
  value: ReactNode;
  bold?: boolean;
  indent?: boolean;
}) {
  return (
    <tr>
      <td className={cn('px-2.5 py-1 text-xs text-muted-foreground', indent && 'pl-6', bold && 'font-semibold text-foreground')}>
        {term ? <GlossaryTerm term={term}>{label}</GlossaryTerm> : label}
      </td>
      <td className={cn('px-2.5 py-1 text-right text-xs', bold && 'font-semibold text-foreground')}>{value}</td>
    </tr>
  );
}

function SectionTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full border-collapse">
        <tbody>
          <tr>
            <td colSpan={3} className="border-b border-border px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
              {head}
            </td>
          </tr>
          {children}
        </tbody>
      </table>
    </div>
  );
}

const th = 'px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground border-b';

function safe<T>(v: T | null | undefined, fmt: (v: T) => ReactNode): ReactNode {
  return v != null && (v as unknown) !== '' && String(v) !== '#VALUE!' ? fmt(v) : '—';
}

// ================= Equity =================
function EquityDetail({ fund, holding }: { fund: Fund; holding: Holding }) {
  const { commitHolding, investorOptions, sourceOptions, sourceOfFundsEnabled } = useFundData();
  const ownershipTab = ownershipTabState(useFeatureFlags(), holding);
  const { money, moneyFee } = useFundMoney();
  const save = () => commitHolding(fund, holding);
  const inv = holding.inv!;
  const d = (holding.d = holding.d || {});
  const c = computeInv(holding) as EquityMetrics;

  const setInv = (k: keyof typeof inv, raw: string, numeric = false) => {
    (inv as unknown as Record<string, unknown>)[k as string] = numeric ? num(raw) : txt(raw);
    save();
  };
  const setD = (k: string, raw: string, numeric = false) => {
    (d as Record<string, unknown>)[k] = numeric ? num(raw) : txt(raw);
    save();
  };
  const setEnglishName = englishNameSetter(holding, save);

  const performance = (
    <>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Tile
          label="Gross MOIC"
          term="moicT"
          value={c.grossMOIC != null ? `${c.grossMOIC.toFixed(2)}×` : '—'}
          tone={c.grossMOIC != null ? (c.grossMOIC >= 1 ? 'success' : 'danger') : undefined}
        />
        <Tile
          label="Net MOIC"
          term="moicT"
          value={c.netMOIC != null ? `${c.netMOIC.toFixed(2)}×` : '—'}
          tone={c.netMOIC != null ? (c.netMOIC >= 1 ? 'success' : 'danger') : undefined}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <SectionTable head="Capital & Value">
            <CalcRow
              label="Invested Capital"
              term="costinv"
              value={money(c.investedCapital)}
            />
            <CalcRow
              label="Realized Proceeds"
              term="realproc"
              value={money(c.realizedProceedsGross)}
            />
            <CalcRow label="Shares acquired" term="sharesacquired" value={formatCompact(c.sharesAcquired * M)} indent />
            <CalcRow label="Shares disposed" term="sharesdisposed" value={formatCompact(c.sharesDisposed * M)} indent />
            <CalcRow
              label="Remaining shares held"
              term="sharesheld"
              value={formatCompact(c.sharesHeld * M)}
            />
            <CalcRow label="Blended entry price" term="avgbuy" value={`$${formatCompact(c.blendedEntryPrice)}`} />
            <CalcRow
              label="Current share price"
              term="curprice"
              value={c.curPrice != null ? `$${formatCompact(c.curPrice)}` : '—'}
            />
            <CalcRow
              label="Unrealized value"
              term="marketvalue"
              value={c.unrealizedValue != null ? money(c.unrealizedValue) : '—'}
            />
            <CalcRow label="Total Value (Gross)" term="totalvalgross" value={c.totalValueGross != null ? money(c.totalValueGross) : '—'} bold />
            <CalcRow
              label="Holding period"
              term="holdperiod"
              value={
                <InlineEdit align="right" kind="num" value={c.holdYrs} display={`${c.holdYrs} yrs`} onCommit={(r) => setD('holdYrs', r, true)} />
              }
            />
          </SectionTable>
          <div className="mt-1.5 text-[10px] text-muted-foreground">
            → Driven by transactions + current price per share.
          </div>
        </div>
        <div className="space-y-3">
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full border-collapse">
              <tbody>
                <tr>
                  <td colSpan={3} className="border-b px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                    Fee Structure
                  </td>
                </tr>
                <tr>
                  <th className={cn(th, 'text-left')}>Fee</th>
                  <th className={cn(th, 'text-right')}>Rate (%)</th>
                  <th className={cn(th, 'text-right')}>Value ($)</th>
                </tr>
                <FeeRow label="Management Fee" term="mgmtfee" rate={inv.mgmtFeeRate} value={c.mgmtFeeVal} onCommit={(r) => setInv('mgmtFeeRate', r, true)} />
                <FeeRow label="Preferred Return" term="prefreturn" rate={c.prefReturnRatePct} value={c.prefReturnVal} onCommit={(r) => setInv('prefReturnRate', r, true)} />
                <FeeRow label="Performance Carry" term="carryrate" rate={inv.carryRate} value={c.carryVal} onCommit={(r) => setInv('carryRate', r, true)} />
                <tr>
                  <td className="px-2.5 py-1 text-xs font-semibold text-foreground">Total Fees</td>
                  <td className="px-2.5 py-1 text-right text-xs text-muted-foreground">—</td>
                  <td className="px-2.5 py-1 text-right text-xs font-semibold text-foreground">−{moneyFee(Math.abs(c.totalFeesVal))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <SectionTable head="Return Metrics">
            <CalcRow label="Gross MOIC" term="grossmoic" value={c.grossMOIC != null ? `${c.grossMOIC.toFixed(2)}×` : '—'} />
            <CalcRow label="Net MOIC" term="netmoic" value={c.netMOIC != null ? `${c.netMOIC.toFixed(2)}×` : '—'} bold />
            <CalcRow label="DPI" term="dpiT" value={`${c.dpi.toFixed(2)}×`} />
          </SectionTable>
        </div>
      </div>
    </>
  );

  const legal = (
    <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-4">
      <EditKV label="Company name" term="assetname" value={holding.n} onCommit={(r) => { holding.n = r || holding.n; save(); }} />
      <EditKV label="English name" term="englishname" value={holding.englishName} onCommit={setEnglishName} />
      <EditKV label="Legal name" term="legalname" value={inv.legalName} onCommit={(r) => setInv('legalName', r)} />
      <SelectKV
        label="Investing entity"
        term="investentity"
        value={inv.entity}
        options={investorOptions}
        placeholder="Select entity…"
        onCommit={(r) => setInv('entity', r)}
      />
      <EditKV label="Country" value={d.geo} onCommit={(r) => setD('geo', r)} />
      <EditKV
        label="Investment type"
        value={getAssetInvestType(holding)}
        kind="select"
        options={INVEST_TYPES}
        onCommit={(r) => {
          setAssetInvestType(holding, r);
          save();
        }}
      />
      <KV label="Entry date" value={holding.dt} />
      {sourceOfFundsEnabled && (
        <KV
          label="Source of fund"
          term="fundingsource"
          value={inv.fundingSource}
        />
      )}
      <KV label="Stake" value={inv.stakePct != null ? formatPercentage(inv.stakePct) : undefined} />
      <EditKV label="Hold period" term="holdperiod" value={d.holdYrs} display={d.holdYrs != null ? `${d.holdYrs} yrs` : undefined} kind="num" onCommit={(r) => setD('holdYrs', r, true)} />
      <EditKV label="Reporting date" term="reportdate" kind="date" value={inv.reportDate} onCommit={(r) => setInv('reportDate', r)} />
      <KV label="Investment Currency" term="invccy" value={inv.investCcy} />
      <KV label="Currency" term="reportccy" value={inv.ccy} />
    </div>
  );

  const business = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <FieldKey>Description of business</FieldKey>
        <div className="text-xs leading-relaxed text-muted-foreground">
          <InlineEdit kind="textarea" value={inv.description} onCommit={(r) => setInv('description', r)} placeholder="Add description…" />
        </div>
      </div>
      <div>
        <FieldKey>Business Updates</FieldKey>
        <div className="text-xs leading-relaxed text-muted-foreground">
          <InlineEdit kind="textarea" value={inv.businessUpdates} onCommit={(r) => setInv('businessUpdates', r)} placeholder="Add business updates…" />
        </div>
      </div>
    </div>
  );

  const deal = (
    <>
      <div className="grid grid-cols-2 items-end gap-x-4 gap-y-2.5 sm:grid-cols-4">
        <KV label="Shares held" term="sharesheld" value={formatCompact(c.sharesHeld * M)} />
        <KV label="Avg. buy price" term="avgbuy" value={`$${formatCompact(c.avgBuy)}`} />
        <KV label="Avg. sell price" term="avgsell" value={c.avgSell ? `$${formatCompact(c.avgSell)}` : undefined} />
        <KV label="Add-on expense" term="addon" value={money(c.addOn)} />
        <div>
          <FieldKey>
            <GlossaryTerm term="curprice">Current share price</GlossaryTerm>
          </FieldKey>
          <div className="text-[13px] text-foreground">
            <InlineEdit
              kind="num"
              value={c.curPrice != null ? Number(c.curPrice.toFixed(2)) : null}
              display={c.curPrice != null ? `$${formatCompact(c.curPrice)}` : '—'}
              onCommit={(r) => {
                inv._cur = parseFloat(r) || 0;
                save();
              }}
            />
          </div>
        </div>
        <KV label="Total valuation" term="totalval" value={c.unrealizedValue != null ? money(c.unrealizedValue) : undefined} />
        <KV label="Live MOIC" value={c.grossMOIC != null ? `${c.grossMOIC.toFixed(2)}×` : undefined} />
        <div>
          <FieldKey>
            <GlossaryTerm term="unreal">Unrealised return</GlossaryTerm>
          </FieldKey>
          <div
            className={cn(
              'text-[15px] font-medium',
              c.unreal == null
                ? 'text-foreground'
                : c.unreal >= 0
                  ? 'text-success'
                  : 'text-destructive',
            )}
          >
            {c.unreal != null ? `${c.unreal >= 0 ? '+' : ''}${(c.unreal * 100).toFixed(1)}%` : '—'}
          </div>
        </div>
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground">
        → Editing <b className="font-medium text-muted-foreground">Current Price / Share</b> recomputes Unrealized
        Value → Total Value → MOIC (once share counts are entered on transactions).
      </div>
      <div className="mt-4 border-t pt-4">
        <FieldKey>
          <GlossaryTerm term="keyrights">Key rights</GlossaryTerm>
        </FieldKey>
        <div className="text-xs leading-relaxed text-muted-foreground">
          <InlineEdit kind="textarea" value={inv.keyRights} onCommit={(r) => setInv('keyRights', r)} placeholder="Add key rights…" />
        </div>
      </div>
    </>
  );

  return (
    <TabbedDetail
      tabs={[
        { id: 'perf', label: 'Performance', body: performance },
        { id: 'legal', label: 'Company & legal', body: legal },
        { id: 'biz', label: 'Business', body: business },
        { id: 'txn', label: 'Transactions', body: <TxnTable fund={fund} holding={holding} /> },
        { id: 'deal', label: 'Deal economics', body: deal },
        { id: 'hist', label: 'Historical value', body: <QuarterTable fund={fund} holding={holding} equity /> },
        ...(ownershipTab === 'hidden'
          ? []
          : [
              {
                id: 'own',
                label: 'Ownership',
                body: ownershipTab === 'enabled' ? <OwnershipSection holding={holding} /> : <OwnershipDisabledNotice />,
              },
            ]),
      ]}
    />
  );
}

function FeeRow({
  label,
  term,
  rate,
  value,
  onCommit,
}: {
  label: string;
  term: string;
  rate?: number;
  value: number;
  onCommit: (raw: string) => void;
}) {
  const { moneyFee } = useFundMoney();
  return (
    <tr>
      <td className="px-2.5 py-1 text-xs text-muted-foreground">
        <GlossaryTerm term={term}>{label}</GlossaryTerm>
      </td>
      <td className="px-2.5 py-1 text-right text-xs">
        <InlineEdit align="right" kind="num" value={rate} display={rate != null ? formatPercentage(rate) : undefined} onCommit={onCommit} />
      </td>
      <td className="px-2.5 py-1 text-right text-xs">{moneyFee(value)}</td>
    </tr>
  );
}

// ================= Fund of funds =================
export function FoFDetail({ fund, holding }: { fund: Fund; holding: Holding }) {
  const { commitHolding, refreshHolding, investorOptions, sourceOptions, sourceOfFundsEnabled } =
    useFundData();
  const { moneyK, currency: dispCcy } = useFundMoney();
  const { toast } = useToast();
  const save = () => commitHolding(fund, holding);
  const inv = holding.inv!;
  const d = (holding.d = holding.d || {});
  const c = computeFoF(holding)!;
  const ccy = normalizeCurrency(inv.ccy);

  const setInv = (k: keyof typeof inv, raw: string, numeric = false) => {
    (inv as unknown as Record<string, unknown>)[k as string] = numeric ? num(raw) : txt(raw);
    save();
  };
  const setD = (k: string, raw: string, numeric = false) => {
    (d as Record<string, unknown>)[k] = numeric ? num(raw) : txt(raw);
    save();
  };
  const setEnglishName = englishNameSetter(holding, save);
  // The FoF "unrealized market value" isn't a stored asset column — it's the
  // latest valuation snapshot. Editing it upserts that valuation (same
  // endpoint/units as the Historical value tab: value in millions → raw $),
  // then reloads so server-recomputed rollups land.
  const setMarketValue = (raw: string) => {
    const millions = num(raw);
    if (!holding.id || millions == null) return;
    const latest = selectEligibleMark(inv.quarterly);
    const asOfDate = latest?.asOfDate || toLocalISODate(new Date());
    fundLedgerApi
      .saveHoldingValuation(holding.id, holding.targetKind !== 'asset', {
        ...latest,
        asOfDate,
        mv: millions,
      })
      .then(() => refreshHolding(fund, holding))
      .catch((err) => {
        console.error('Failed to save market value', err);
        toast({
          title: 'Failed to save market value',
          description: err instanceof Error ? err.message : 'Your change was not saved.',
          variant: 'destructive',
        });
        refreshHolding(fund, holding);
      });
  };

  const xirr = c.xirr;
  const moic = c.moic;
  const costInv = c.costInv;
  const netDist = c.netDist;
  const dpiVal = c.dpi;

  const performance = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Tile
        label="XIRR"
        term="xirr"
        value={
          xirr?.status === 'calculated' && xirr.value != null ? (
            `${(xirr.value * 100).toFixed(1)}%`
          ) : xirr?.status === 'unavailable' ? (
            <span
              className="cursor-help text-muted-foreground"
              title={
                xirr.reason === 'insufficient_flows'
                  ? 'IRR unavailable: requires at least two dated cash flows'
                  : xirr.reason === 'no_sign_change'
                    ? 'IRR unavailable: cash flows do not change sign (requires both inflows and outflows)'
                    : xirr.reason === 'did_not_converge'
                      ? 'IRR unavailable: calculation did not converge'
                      : 'IRR unavailable'
              }
            >
              Unavailable
            </span>
          ) : (
            '—'
          )
        }
        tone={
          xirr?.status === 'calculated' && xirr.value != null
            ? xirr.value >= 0
              ? 'success'
              : 'danger'
            : undefined
        }
      />
      <Tile
        label="MOIC"
        term="moicT"
        value={moic != null ? `${moic.toFixed(2)}×` : '—'}
      />
      <Tile
        label="Invested Capital"
        term="costinv"
        value={moneyK(costInv)}
      />
      <Tile
        label="Unrealized Market Value"
        term="marketvalue"
        value={
          <MoneyInlineEdit
            amount={toRaw(c.marketValue)}
            currency={dispCcy}
            onCommit={(amt) => setMarketValue(rawToMillions(amt))}
          />
        }
      />
      <Tile label="Distribution" term="distrib" value={moneyK(c.totalDist)} />
      <Tile label="Divestment" term="divestment" value="—" />
      <Tile label="Others" term="othersT" value={moneyK(c.totalOther)} />
      <Tile
        label="Net distribution"
        term="netdist"
        value={moneyK(netDist)}
      />
      <Tile
        label="DPI"
        term="dpiT"
        value={`${dpiVal.toFixed(2)}×`}
      />
    </div>
  );

  const legal = (
    <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-4">
      <EditKV label="Fund name" term="assetname" value={holding.n} onCommit={(r) => { holding.n = r || holding.n; save(); }} />
      <EditKV label="English name" term="englishname" value={holding.englishName} onCommit={setEnglishName} />
      <EditKV label="Legal name" term="legalname" value={inv.legalName} onCommit={(r) => setInv('legalName', r)} />
      <SelectKV
        label="Investing entity"
        term="investentity"
        value={inv.entity}
        options={investorOptions}
        placeholder="Select entity…"
        onCommit={(r) => setInv('entity', r)}
      />
      <KV label="Country" value={d.geo || inv.country || 'Indonesia'} />
      <KV label="Investment type" value={getAssetInvestType(holding)} />
      {sourceOfFundsEnabled && (
        <KV
          label="Source of fund"
          term="fundingsource"
          value={inv.fundingSource}
        />
      )}
      <KV label="Stake" value={inv.stakePct != null ? formatPercentage(inv.stakePct) : undefined} />
      <KV label="Entry date" value={holding.dt} />
      <EditKV label="Reporting date" term="reportdate" kind="date" value={inv.reportDate} onCommit={(r) => setInv('reportDate', r)} />
      <KV label="Currency" term="reportccy" value={inv.ccy} />
    </div>
  );

  const business = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <FieldKey>Description of business</FieldKey>
        <div className="text-xs leading-relaxed text-muted-foreground">
          <InlineEdit kind="textarea" value={inv.description} onCommit={(r) => setInv('description', r)} placeholder="Add description…" />
        </div>
      </div>
      <div>
        <FieldKey>Business Updates</FieldKey>
        <div className="text-xs leading-relaxed text-muted-foreground">
          <InlineEdit kind="textarea" value={inv.businessUpdates} onCommit={(r) => setInv('businessUpdates', r)} placeholder="Add business updates…" />
        </div>
      </div>
    </div>
  );

  const capital = (
    <>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
        <KV label="Total invested" term="costinv" value={moneyK(c.totalCalled)} />
        <KV label="Capital calls" value={`${c.callsCount} transactions`} />
        <KV label="Total distributed" term="distrib" value={moneyK(c.totalDist + c.totalOther)} />
        <KV label="Distributions" value={`${c.distsCount + c.othersCount} transactions`} />
        <KV label="Shareholding %" term="shpct" value={inv.stakePct != null ? formatPercentage(inv.stakePct) : undefined} />
        <div>
          <FieldKey>
            <GlossaryTerm term="marketvalue">Unrealized market value</GlossaryTerm>
          </FieldKey>
          <div className="text-[13px] text-foreground">
            <MoneyInlineEdit
              amount={toRaw(c.marketValue)}
              currency={dispCcy}
              onCommit={(amt) => setMarketValue(rawToMillions(amt))}
            />
          </div>
        </div>
        <KV label="MOIC" value={c.moic != null ? `${c.moic.toFixed(2)}×` : undefined} />
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Fund-of-funds positions are not share-based at this level. Ownership is expressed through
        shareholding % and total shares outstanding of the underlying fund.
      </div>
      <div className="mt-4 border-t pt-4">
        <FieldKey>
          <GlossaryTerm term="keyrights">Key rights</GlossaryTerm>
        </FieldKey>
        <div className="text-xs leading-relaxed text-muted-foreground">
          <InlineEdit kind="textarea" value={inv.keyRights} onCommit={(r) => setInv('keyRights', r)} placeholder="Add key rights…" />
        </div>
      </div>
    </>
  );

  return (
    <TabbedDetail
      tabs={[
        { id: 'perf', label: 'Performance', body: performance },
        { id: 'legal', label: 'Fund & legal', body: legal },
        { id: 'biz', label: 'Business', body: business },
        { id: 'cap', label: 'Capital account', body: capital },
        { id: 'txn', label: 'Transactions', body: <TxnTable fund={fund} holding={holding} fof /> },
        { id: 'hist', label: 'Historical value', body: <QuarterTable fund={fund} holding={holding} /> },
      ]}
    />
  );
}

// ================= Cash =================
function CashDetail({ fund, holding }: { fund: Fund; holding: Holding }) {
  const { commitHolding, sourceOptions, sourceOfFundsEnabled } = useFundData();
  const { money } = useFundMoney();
  const save = () => commitHolding(fund, holding);
  const inv = holding.inv!;
  const d = (holding.d = holding.d || {});
  // Cash is value-based (no shares/PPS), so it uses the same rollups as a
  // fund-of-funds position.
  const c = computeFoF(holding)!;
  const ccy = normalizeCurrency(inv.ccy);

  const setInv = (k: keyof typeof inv, raw: string, numeric = false) => {
    (inv as unknown as Record<string, unknown>)[k as string] = numeric ? num(raw) : txt(raw);
    save();
  };
  const setD = (k: string, raw: string, numeric = false) => {
    (d as Record<string, unknown>)[k] = numeric ? num(raw) : txt(raw);
    save();
  };

  const balance = c.costInv;
  const currentValue = c.marketValue;
  const netDist = c.netDist;

  const overview = (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile
          label="Amount"
          term="costinv"
          value={money(balance)}
        />
        <Tile
          label="Current value"
          term="marketvalue"
          value={currentValue != null ? money(currentValue) : '—'}
        />
        <Tile
          label="Interest / income"
          term="netdist"
          value={money(netDist)}
        />
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground">
        → Balances roll up from the Transactions ledger and valuation history.
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2.5 border-t pt-4 sm:grid-cols-4">
        <EditKV label="Held at" value={d.institution} onCommit={(r) => setD('institution', r)} />
        <EditKV
          label="Interest earned"
          value={d.yieldPct}
          display={d.yieldPct != null ? formatPercentage(d.yieldPct) : undefined}
          kind="num"
          onCommit={(r) => setD('yieldPct', r, true)}
        />
        <EditKV label="Type" value={d.type} onCommit={(r) => setD('type', r)} />
      {sourceOfFundsEnabled && (
          <KV
            label="Source of fund"
            term="fundingsource"
            value={inv.fundingSource}
          />
        )}
        <KV label="Entry date" value={holding.dt} />
        <KV label="Currency" term="reportccy" value={inv.ccy} />
      </div>
    </>
  );

  return (
    <TabbedDetail
      tabs={[
        { id: 'overview', label: 'Overview', body: overview },
        { id: 'txn', label: 'Transactions', body: <TxnTable fund={fund} holding={holding} fof /> },
      ]}
    />
  );
}

// ================= Transactions (editable) =================
function TxnTable({ fund, holding, fof }: { fund: Fund; holding: Holding; fof?: boolean }) {
  const { refreshHolding, refreshAll, sourceIdsByName } = useFundData();
  const { money } = useFundMoney();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{
    mode: 'add' | 'edit';
    idx: number;
    initialOverride?: Partial<Txn>;
  } | null>(null);
  const txns = holding.inv?.txns || [];
  const ccy = normalizeCurrency(holding.inv?.ccy);
  const dispCcy = useWorkspaceCurrency();
  const typeOptions: TxnType[] = ['Buy', 'Sell', 'Other'];

  const onFailure = (message: string) => (err: unknown) => {
    console.error(message, err);
    toast({
      title: message,
      description: err instanceof Error ? err.message : 'Your change was not saved.',
      variant: 'destructive',
    });
    refreshHolding(fund, holding);
  };

  const persist = (t: Txn, previousTxn?: Txn) => {
    if (!holding.id) return;
    const resolvedSourceId = t.fundingSourceId
      ? (sourceIdsByName?.get(t.fundingSourceId) || t.fundingSourceId)
      : (holding.fundingSourceId ||
         holding.inv?.fundingSourceId ||
         (holding.inv?.fundingSource ? sourceIdsByName?.get(holding.inv.fundingSource) : null) ||
         null);

    const tWithDefaults: Txn = {
      ...t,
      positionId: t.positionId ?? holding.positionId ?? null,
      holdingEntityId: t.holdingEntityId || holding.inv?.entity || null,
      fundingSourceId: resolvedSourceId,
    };
    fundLedgerApi
      .saveHoldingTransaction(fund.id, holding.id, holding.targetKind ? holding.targetKind === 'fund' : fof, { ...tWithDefaults, fundStyle: fof }, t.id)
      .then(() => {
        const isSell = t.type === 'Sell' || previousTxn?.type === 'Sell';
        const txnFundId = t.fundId ?? 'unassigned';
        return isSell || txnFundId !== fund.id ? refreshAll() : refreshHolding(fund, holding);
      })
      .catch(onFailure('Failed to save transaction'));
  };
  const editTxn = (i: number, k: keyof Txn, raw: string, numeric = false) => {
    const prev = txns[i];
    if (prev.isGenerated || prev.sourceDivestmentTxnId) return;
    const next = {
      ...prev,
      [k]: numeric ? num(raw) : txt(raw),
      preserveEconomicFields: k === 'notes' || k === 'date' || k === 'label',
    };
    txns[i] = next;
    persist(next, prev);
  };
  const delTxn = (i: number) => {
    const t = txns[i];
    if (!holding.id || !t.id || t.isGenerated || t.sourceDivestmentTxnId) return;
    const isSell = t.type === 'Sell' || t.sellProceedsDestination != null;
    const resolvedSourceId = t.fundingSourceId
      ? (sourceIdsByName?.get(t.fundingSourceId) || t.fundingSourceId)
      : (holding.fundingSourceId ||
         holding.inv?.fundingSourceId ||
         (holding.inv?.fundingSource ? sourceIdsByName?.get(holding.inv.fundingSource) : null) ||
         null);
    fundLedgerApi
      .deleteHoldingTransaction(fund.id, holding.id, holding.targetKind ? holding.targetKind === 'fund' : fof, t.id, {
        fundingSourceId: resolvedSourceId,
      })
      .then(() => (isSell ? refreshAll() : refreshHolding(fund, holding)))
      .catch(onFailure('Failed to delete transaction'));
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse">
        <thead>
          <tr>
            <th className={cn(th, 'text-left')}><GlossaryTerm term="txndate">Date</GlossaryTerm></th>
            <th className={cn(th, 'text-left')}><GlossaryTerm term="eom">EOM</GlossaryTerm></th>
            <th className={cn(th, 'text-left')}>Type</th>
            {!fof && <th className={cn(th, 'text-right')}><GlossaryTerm term="pps">PPS</GlossaryTerm></th>}
            {!fof && <th className={cn(th, 'text-right')}>Number of Shares</th>}
            <th className={cn(th, 'text-right')}>Value</th>
            {!fof && <th className={cn(th, 'text-left')}>Proceeds treatment</th>}
            <th className={cn(th, 'text-left')}><GlossaryTerm term="fxref">FX</GlossaryTerm></th>
            <th className={cn(th, 'text-left')}><GlossaryTerm term="txnotes">Remarks</GlossaryTerm></th>
            <th className={cn(th, 'w-16 text-right')}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {txns.map((t, i) => {
            const isGen = Boolean(t.isGenerated || t.sourceDivestmentTxnId);
            return (
              <tr key={i} className="group border-b">
                <td className="px-2 py-1 text-xs text-muted-foreground">
                  {isGen ? (
                    t.date || '—'
                  ) : (
                    <InlineEdit value={t.date} kind="date" onCommit={(r) => editTxn(i, 'date', r)} />
                  )}
                </td>
                <td className="px-2 py-1 text-xs text-muted-foreground">
                  {isGen ? (
                    t.eom || '—'
                  ) : (
                    <InlineEdit value={t.eom} onCommit={(r) => editTxn(i, 'eom', r)} />
                  )}
                </td>
                <td className="px-2 py-1">
                  {isGen ? (
                    <Pill>{txnTypeLabel(t, holding)}</Pill>
                  ) : (
                    <InlineEdit
                      value={t.type}
                      display={<Pill>{txnTypeLabel(t, holding)}</Pill>}
                      kind="select"
                      options={typeOptions}
                      onCommit={(r) => {
                        const newType = r as TxnType;
                        if (newType === 'Sell') {
                          setDialog({
                            mode: 'edit',
                            idx: i,
                            initialOverride: { type: 'Sell' },
                          });
                          return;
                        }
                        const prev = txns[i];
                        const next: Txn = {
                          ...prev,
                          type: newType,
                          sellProceedsDestination: null,
                        };
                        txns[i] = next;
                        persist(next, prev);
                      }}
                    />
                  )}
                </td>
                {!fof && (
                  <td className="px-2 py-1 text-right text-xs text-muted-foreground">
                    {isGen ? (
                      '—'
                    ) : (
                      <InlineEdit align="right" kind="num" value={t.pps} display={t.pps ? `$${formatCompact(t.pps)}` : undefined} onCommit={(r) => editTxn(i, 'pps', r, true)} />
                    )}
                  </td>
                )}
                {!fof && (
                  <td className="px-2 py-1 text-right text-xs text-muted-foreground">
                    {isGen ? (
                      '—'
                    ) : (
                      <InlineEdit
                        align="right"
                        kind="num"
                        value={t.shares != null ? t.shares * M : undefined}
                        display={t.shares ? formatGrouped(t.shares * M) : undefined}
                        onCommit={(r) => {
                          const raw = r ? parseFloat(r) : null;
                          const prev = txns[i];
                          const next = { ...prev, shares: raw != null ? raw / M : null };
                          txns[i] = next;
                          persist(next, prev);
                        }}
                      />
                    )}
                  </td>
                )}
                <td className="px-2 py-1 text-right text-xs">
                  {isGen ? (
                    <span className="font-mono text-foreground">{money(txnValue(t) ?? 0)}</span>
                  ) : (
                    <MoneyInlineEdit
                      align="right"
                      amount={toRaw(txnValue(t))}
                      currency={dispCcy}
                      onCommit={(amt) => editTxn(i, 'value', rawToMillions(amt), true)}
                    />
                  )}
                </td>
                {!fof && (
                  <td className="px-2 py-1 text-xs text-muted-foreground">
                    {proceedsTreatmentLabel(t.sellProceedsDestination, t.type)}
                  </td>
                )}
                <td className="px-2 py-1 text-xs text-muted-foreground">
                  {isGen ? (
                    t.fx || '—'
                  ) : (
                    <InlineEdit value={t.fx} onCommit={(r) => editTxn(i, 'fx', r)} />
                  )}
                </td>
                <td className="px-2 py-1 text-xs text-muted-foreground">
                  {isGen ? (
                    t.notes || '—'
                  ) : (
                    <InlineEdit value={t.notes} onCommit={(r) => editTxn(i, 'notes', r)} />
                  )}
                </td>
                <td className="px-1 py-1 text-right">
                  {isGen ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <RowActions
                      onEdit={() => setDialog({ mode: 'edit', idx: i })}
                      onDelete={() => delTxn(i)}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <AddRowButton label="Add transaction" onClick={() => setDialog({ mode: 'add', idx: -1 })} />
      <div className="mt-1.5 flex items-center gap-1.5 border-t bg-muted px-2.5 py-1.5 text-[10px] text-muted-foreground">
        → Adding, editing, or removing transactions recalculates Invested Capital, Realized Proceeds,
        Shares Held and all downstream metrics.
      </div>
      {dialog && (
        <TxnDialog
          fof={fof}
          holdingType={holding.tp}
          currency={ccy}
          typeOptions={typeOptions}
          mode={dialog.mode}
          fundId={fund.id}
          fund={fund}
          holding={holding}
          initial={
            dialog.mode === 'edit'
              ? { ...txns[dialog.idx], ...dialog.initialOverride }
              : undefined
          }
          onClose={() => setDialog(null)}
          onSubmit={(t) => {
            const previousTxn = dialog.mode === 'edit' ? txns[dialog.idx] : undefined;
            if (dialog.mode === 'edit') txns[dialog.idx] = t;
            else (holding.inv!.txns ||= []).push(t);
            persist(t, previousTxn);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function TxnDialog({
  fof,
  holdingType,
  currency,
  typeOptions,
  mode,
  initial,
  fundId,
  fund,
  holding,
  onSubmit,
  onClose,
}: {
  fof?: boolean;
  holdingType?: string;
  currency: Currency;
  typeOptions: TxnType[];
  mode: 'add' | 'edit';
  initial?: Txn;
  fundId?: string;
  fund?: Fund;
  holding?: Holding;
  onSubmit: (t: Txn) => void;
  onClose: () => void;
}) {
  const { funds, investorOptions, sourceOptions, entityNameById, sourceNameById, sourceOfFundsEnabled } =
    useFundData();
  const wsCurrency = useWorkspaceCurrency();
  const isCash = holdingType === 'Cash';

  const getHolderCandidate = (currentFundId: string, currentHoldingEntityId: string): CashHolderCandidate => {
    const resolvedEntity = currentHoldingEntityId || holding?.inv?.entity || null;
    if (resolvedEntity) {
      return {
        holder_investor_id: resolvedEntity,
        holder_fund_id: null,
        holderFundManaged: false,
      };
    }
    const resolvedFundId = currentFundId || fundId || fund?.id || null;
    const targetFund = (funds ?? []).find((fd) => fd.id === resolvedFundId) ?? fund;
    const isManaged =
      typeof (targetFund as any)?.managed === 'boolean'
        ? (targetFund as any).managed === true
        : targetFund?.disclosure === 'external_fund'
          ? false
          : Boolean(targetFund?.id);

    return {
      holder_investor_id: null,
      holder_fund_id: resolvedFundId,
      holderFundManaged: isManaged,
    };
  };

  const isApplicableFor = (type: string, currentFundId: string, currentHoldingEntityId: string): boolean => {
    const candidate = getHolderCandidate(currentFundId, currentHoldingEntityId);
    return isProceedsTreatmentApplicable({
      entryType: type?.toLowerCase(),
      holder: candidate,
    });
  };

  const initialType = initial?.type ?? 'Buy';
  const initialFundId = initial?.fundId ?? fundId ?? '';
  const initialEntityId = initial?.holdingEntityId
    ? (entityNameById.get(initial.holdingEntityId) ?? initial.holdingEntityId)
    : '';

  const initialApplicable = isApplicableFor(initialType, initialFundId, initialEntityId);
  const initialProceeds = initial?.sellProceedsDestination;
  const resolvedInitialProceeds = initialApplicable
    ? (initialProceeds === 'cash_in_fund' || initialProceeds === 'distributed_to_investor'
        ? initialProceeds
        : 'cash_in_fund')
    : '';

  const [f, setF] = useState<{ [k: string]: string }>(() =>
    initial
      ? {
          type: initial.type,
          date: initial.date ?? '',
          eom: initial.eom ?? '',
          pps: initial.pps != null ? formatGrouped(initial.pps) : '',
          ppsCurrency: initial.ppsCurrency ?? '',
          shares: initial.shares != null ? formatGrouped(initial.shares * M) : '',
          value: initial.value != null ? String(initial.value) : '',
          fx: initial.fx ?? '',
          notes: initial.notes ?? '',
          fundId: initialFundId,
          // The ledger stores entity/source as UUID foreign keys, but the
          // comboboxes are name-based (and the save path resolves name → id).
          // Map the stored id to its name so the picker shows the name, not
          // the raw UUID. Fall back to the raw value if it's already a name or
          // has no managed row.
          holdingEntityId: initialEntityId,
          fundingSourceId: initial.fundingSourceId
            ? (sourceNameById.get(initial.fundingSourceId) ?? initial.fundingSourceId)
            : '',
          sellProceedsDestination: resolvedInitialProceeds,
        }
      : {
          type: 'Buy',
          fundId: initialFundId,
          holdingEntityId: initialEntityId,
          sellProceedsDestination: resolvedInitialProceeds,
        },
  );
  const g = (k: string) => f[k] ?? '';
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const destinationApplicable = isApplicableFor(g('type'), g('fundId'), g('holdingEntityId'));
  const isCashInFundSell = destinationApplicable && g('sellProceedsDestination') === 'cash_in_fund';

  const canSubmit = destinationApplicable
    ? canSubmitTxnDialog({
        date: g('date'),
        value: g('value'),
        pps: g('pps'),
        shares: g('shares'),
        type: g('type'),
        sellProceedsDestination: g('sellProceedsDestination'),
        fundId: g('fundId'),
        fof,
        isCash,
      })
    : canSubmitTxnDialog({
        date: g('date'),
        value: g('value'),
        pps: g('pps'),
        shares: g('shares'),
        type: 'Other',
        fof,
        isCash,
      });

  const submit = () => {
    // Fund-style forms hide these inputs, but imported or ledger-posted
    // transactions may already carry units and an explicit price.
    const pps = fof ? initial?.pps ?? null : g('pps') ? (parseCurrencyInput(g('pps')) ?? null) : null;
    const shares = fof ? initial?.shares ?? null : g('shares') ? (parseCurrencyInput(g('shares')) ?? 0) / M : null;
    // Only persist an explicitly typed value (an override). When left blank,
    // value stays null and is derived live as PPS × shares by `txnValue`, so
    // later edits to PPS or shares keep the value in sync automatically.
    const explicitValue = g('value') ? parseFloat(g('value')) : null;
    const value = explicitValue != null ? explicitValue : fof ? 0 : null;
    const dest = g('sellProceedsDestination');
    const sellProceedsDestination: SellProceedsDestination | null =
      destinationApplicable && isSellProceedsDestination(dest) ? dest : null;
    const t: Txn = {
      id: initial?.id,
      date: g('date') || '—',
      eom: g('eom') || null,
      type: (g('type') as TxnType) || 'Buy',
      value,
      pps,
      ppsCurrency: g('ppsCurrency') || null,
      shares,
      ...(fof ? {
        rawPricePerUnit: initial?.rawPricePerUnit,
        rawShares: initial?.rawShares,
      } : {}),
      fx: g('fx') || null,
      notes: g('notes') || null,
      label: initial?.label,
      fundId: g('fundId') || null,
      holdingEntityId: g('holdingEntityId') || null,
      fundingSourceId: g('fundingSourceId') || null,
      sellProceedsDestination,
    };
    onSubmit(t);
  };
  return (
    <FormDialog
      title={mode === 'edit' ? 'Edit transaction' : 'Add transaction'}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={mode === 'edit' ? 'Save changes' : 'Add transaction'}
      submitDisabled={!canSubmit}
    >
      <FormRow>
        <FormField label="Fund" required={isCashInFundSell}>
          <Combobox
            value={g('fundId')}
            options={funds.map((fd) => fd.id)}
            labelFor={(id) => funds.find((fd) => fd.id === id)?.n ?? id}
            onChange={(v) => {
              const nextApplicable = isApplicableFor(g('type'), v, g('holdingEntityId'));
              setF((p) => ({
                ...p,
                fundId: v,
                sellProceedsDestination: nextApplicable
                  ? (p.sellProceedsDestination || 'cash_in_fund')
                  : '',
              }));
            }}
            placeholder="Select fund…"
          />
        </FormField>
        <FormField label="Holding Entity">
          <Combobox
            value={g('holdingEntityId')}
            options={investorOptions}
            onChange={(v) => {
              const nextApplicable = isApplicableFor(g('type'), g('fundId'), v);
              setF((p) => ({
                ...p,
                holdingEntityId: v,
                sellProceedsDestination: nextApplicable
                  ? (p.sellProceedsDestination || 'cash_in_fund')
                  : '',
              }));
            }}
            placeholder="Select entity…"
          />
        </FormField>
        {sourceOfFundsEnabled && (
          <FormField label="Funding Source">
            <Combobox
              value={g('fundingSourceId')}
              options={sourceOptions}
              onChange={(v) => set('fundingSourceId', v)}
              placeholder="Select source…"
            />
          </FormField>
        )}
      </FormRow>
      <FormRow>
        <FormField label="Type" required>
          <FormSelect
            value={g('type')}
            onChange={(v) => {
              const nextApplicable = isApplicableFor(v, g('fundId'), g('holdingEntityId'));
              setF((p) => ({
                ...p,
                type: v,
                sellProceedsDestination: nextApplicable
                  ? (p.sellProceedsDestination || 'cash_in_fund')
                  : '',
              }));
            }}
            options={typeOptions}
          />
        </FormField>
        <FormField label="Date" required>
          <FormInput type="date" value={g('date')} onChange={(v) => set('date', v)} />
        </FormField>
      </FormRow>
      {destinationApplicable && (
        <fieldset className="flex flex-col gap-1.5 border-0 p-0 m-0">
          <legend className="text-[11px] font-medium text-muted-foreground">
            Proceeds treatment<span className="ml-0.5 text-destructive">*</span>
          </legend>
          <RadioGroup
            value={g('sellProceedsDestination')}
            onValueChange={(v) => set('sellProceedsDestination', v)}
            className="flex flex-wrap gap-4 pt-0.5"
          >
            {PROCEEDS_TREATMENT_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground"
              >
                <RadioGroupItem
                  value={opt.value}
                  id={`proceeds-${opt.value.replace(/_/g, '-')}`}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
      )}
      {!fof && (
        <FormRow>
          <FormField label="Price per share">
            <div className="flex gap-1">
              <select
                value={g('ppsCurrency') || wsCurrency}
                onChange={(e) => set('ppsCurrency', e.target.value)}
                className="rounded-md border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-accent"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c} disabled={c !== wsCurrency}>
                    {c === wsCurrency ? c : `${c} (currency not selected in the workspace)`}
                  </option>
                ))}
              </select>
              <FormInput type="number" value={g('pps')} onChange={(v) => set('pps', v)} />
            </div>
          </FormField>
          <FormField label="Number of shares">
            <FormInput type="number" value={g('shares')} onChange={(v) => set('shares', v)} />
          </FormField>
        </FormRow>
      )}
      <FormRow>
        <FormField label={fof ? 'Value' : 'Value (overrides PPS × shares)'}>
          <CurrencyInput
            currency={g('ppsCurrency') ? normalizeCurrency(g('ppsCurrency')) : currency}
            amount={g('value') ? parseFloat(g('value')) * 1_000_000 : null}
            onCommit={(amt, cur) => {
              set('value', amt == null ? '' : String(amt / 1_000_000));
              set('ppsCurrency', cur);
            }}
          />
        </FormField>
        <FormField label="FX rate">
          <FormInput value={g('fx')} onChange={(v) => set('fx', v)} />
        </FormField>
      </FormRow>
      <p className="text-[11px] text-muted-foreground">
        {fof
          ? 'Enter the transaction value.'
          : 'Fill in either a Value, or Price per share + Number of shares.'}
      </p>
      <FormField label="Remarks">
        <FormInput value={g('notes')} onChange={(v) => set('notes', v)} />
      </FormField>
    </FormDialog>
  );
}

// ================= Historical value / quarterly (editable) =================
// Same rationale as TxnTable above: valuations are upserted directly against
// their own endpoint, never through commitHolding.
export function QuarterTable({ fund, holding, equity }: { fund: Fund; holding: Holding; equity?: boolean }) {
  const { refreshHolding } = useFundData();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ mode: 'add' | 'edit'; idx: number } | null>(null);
  const q: Quarter[] = holding.inv?.quarterly || [];
  const ccy = normalizeCurrency(holding.inv?.ccy);
  const dispCcy = useWorkspaceCurrency();

  const onFailure = (message: string) => (err: unknown) => {
    console.error(message, err);
    toast({
      title: message,
      description: err instanceof Error ? err.message : 'Your change was not saved.',
      variant: 'destructive',
    });
    // The optimistic in-place mutation above is now wrong — reconcile with
    // the server's actual state instead of leaving it displayed.
    refreshHolding(fund, holding);
  };

  const persist = (rec: Quarter) => {
    if (!holding.id || !rec.asOfDate) return;
    fundLedgerApi
      .saveHoldingValuation(holding.id, holding.targetKind ? holding.targetKind === 'fund' : !equity, rec)
      .then(() => refreshHolding(fund, holding))
      .catch(onFailure('Failed to save valuation'));
  };
  const editQ = (i: number, k: keyof Quarter, raw: string, numeric = true) => {
    const next = { ...q[i], [k]: numeric ? num(raw) : txt(raw) };
    q[i] = next;
    persist(next);
  };
  const delQ = (i: number) => {
    const rec = q[i];
    if (q.length <= 1 || !holding.id || !rec.id) return;
    fundLedgerApi
      .deleteValuation(rec.id)
      .then(() => refreshHolding(fund, holding))
      .catch(onFailure('Failed to delete valuation'));
  };

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <GlossaryTerm term="mvtracker">Market value tracker</GlossaryTerm> · quarterly
        </span>
        <MiniSpark data={q.map((x) => x.mv || 0)} positive width={Math.max(q.length * 44, 44)} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse">
          <thead>
            <tr>
              <th className={cn(th, 'text-left')}>Quarter</th>
              <th className={cn(th, 'text-right')}><GlossaryTerm term="marketvalue">Market value</GlossaryTerm></th>
              {equity && <th className={cn(th, 'text-right')}><GlossaryTerm term="pps">PPS</GlossaryTerm></th>}
              <th className={cn(th, 'text-right')}><GlossaryTerm term="sharesout">Shares out</GlossaryTerm></th>
              <th className={cn(th, 'text-right')}><GlossaryTerm term="shpct">Stake</GlossaryTerm></th>
              <th className={cn(th, 'text-right')}><GlossaryTerm term="qcost">Invested Capital</GlossaryTerm></th>
              <th className={cn(th, 'text-right')}>MOIC</th>
              <th className={cn(th, 'text-right')}>XIRR</th>
              <th className={cn(th, 'text-left')}>Remarks</th>
              <th className={cn(th, 'w-16 text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.length === 0 ? (
              <tr>
                <td
                  colSpan={equity ? 10 : 9}
                  className="px-2 py-4 text-center text-xs text-muted-foreground"
                >
                  No quarterly valuation history recorded
                </td>
              </tr>
            ) : (
              q.map((x, i) => {
                const last = i === q.length - 1;
              return (
                <tr key={i} className={cn('group border-b', last && 'bg-accent/10')}>
                  <td className={cn('px-2 py-1 text-xs text-foreground', last && 'font-semibold')}>
                    <InlineEdit value={x.q} onCommit={(r) => editQ(i, 'q', r, false)} />
                  </td>
                  <td className="px-2 py-1 text-right text-xs font-medium">
                    <MoneyInlineEdit align="right" amount={toRaw(x.mv)} currency={dispCcy} onCommit={(amt) => editQ(i, 'mv', rawToMillions(amt))} />
                  </td>
                  {equity && (
                    <td className="px-2 py-1 text-right text-xs">
                      <InlineEdit
                        align="right"
                        kind="num"
                        value={x.pps}
                        display={safe(x.pps, (v) => `${x.ppsCurrency || ccy} ${formatCompact(v)}`)}
                        onCommit={(r) => editQ(i, 'pps', r)}
                      />
                    </td>
                  )}
                  <td className="px-2 py-1 text-right text-xs">
                    <InlineEdit
                      align="right"
                      kind="num"
                      value={x.sharesOut != null ? x.sharesOut * M : undefined}
                      display={safe(x.sharesOut, (v) => formatGrouped(v * M))}
                      onCommit={(r) => {
                        const raw = r ? parseFloat(r) : null;
                        const next = { ...q[i], sharesOut: raw != null ? raw / M : null };
                        q[i] = next;
                        persist(next);
                      }}
                    />
                  </td>
                  <td className="px-2 py-1 text-right text-xs">
                    <InlineEdit align="right" kind="num" value={x.shPct} display={safe(x.shPct, formatPercentage)} onCommit={(r) => editQ(i, 'shPct', r)} />
                  </td>
                  <td className="px-2 py-1 text-right text-xs">
                    <MoneyInlineEdit align="right" amount={toRaw(x.cost)} currency={dispCcy} onCommit={(amt) => editQ(i, 'cost', rawToMillions(amt))} />
                  </td>
                  <td className="px-2 py-1 text-right text-xs font-medium">
                    <InlineEdit align="right" kind="num" value={x.moic} display={safe(x.moic, (v) => `${v.toFixed(2)}×`)} onCommit={(r) => editQ(i, 'moic', r)} />
                  </td>
                  <td className="px-2 py-1 text-right text-xs">
                    <InlineEdit align="right" kind="num" value={x.xirr} display={safe(x.xirr, (v) => `${v.toFixed(1)}%`)} onCommit={(r) => editQ(i, 'xirr', r)} />
                  </td>
                  <td className="px-2 py-1 text-xs text-muted-foreground">
                    <InlineEdit value={x.notes} onCommit={(r) => editQ(i, 'notes', r, false)} />
                  </td>
                  <td className="px-1 py-1 text-right">
                    <RowActions
                      deleteDisabled={q.length <= 1}
                      onEdit={() => setDialog({ mode: 'edit', idx: i })}
                      onDelete={() => delQ(i)}
                    />
                  </td>
                </tr>
              );
            })
          )}
          </tbody>
        </table>
      </div>
      <AddRowButton label="Add quarterly record" onClick={() => setDialog({ mode: 'add', idx: -1 })} />
      {dialog && (
        <QuarterDialog
          equity={equity}
          currency={ccy}
          mode={dialog.mode}
          initial={dialog.mode === 'edit' ? q[dialog.idx] : undefined}
          onClose={() => setDialog(null)}
          onSubmit={(rec) => {
            if (dialog.mode === 'edit') {
              const prev = q[dialog.idx];
              q[dialog.idx] = rec;
              // Upsert is keyed on as_of_date — if the date itself changed,
              // upserting the new date alone would leave the old row behind
              // as an orphan, so the old row needs deleting too. Create the
              // new row FIRST and only delete the old one once that
              // succeeds — the other order (delete-then-insert) would
              // permanently lose the valuation if the insert failed after
              // the delete had already gone through.
              if (holding.id && prev.id && prev.asOfDate && rec.asOfDate !== prev.asOfDate) {
                fundLedgerApi
                  .saveHoldingValuation(holding.id, holding.targetKind ? holding.targetKind === 'fund' : !equity, rec)
                  .then(() => fundLedgerApi.deleteValuation(prev.id!))
                  .then(() => refreshHolding(fund, holding))
                  .catch(onFailure('Failed to move valuation to its new date'));
                setDialog(null);
                return;
              }
            } else {
              (holding.inv!.quarterly ||= []).push(rec);
            }
            persist(rec);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function QuarterDialog({
  equity,
  currency,
  mode,
  initial,
  onSubmit,
  onClose,
}: {
  equity?: boolean;
  currency: Currency;
  mode: 'add' | 'edit';
  initial?: Quarter;
  onSubmit: (rec: Quarter) => void;
  onClose: () => void;
}) {
  const s = (v: number | null | undefined) => (v != null ? String(v) : '');
  const [f, setF] = useState<{ [k: string]: string }>(() =>
    initial
      ? {
          asOfDate: initial.asOfDate ?? '',
          q: initial.q ?? '',
          mv: s(initial.mv),
          pps: s(initial.pps),
          ppsCurrency: initial.ppsCurrency ?? '',
          // Shares outstanding is stored in millions; show the real count.
          sharesOut: initial.sharesOut != null ? formatGrouped(initial.sharesOut * M) : '',
          shPct: s(initial.shPct),
          cost: s(initial.cost),
          moic: s(initial.moic),
          xirr: s(initial.xirr),
          notes: initial.notes ?? '',
        }
      : {},
  );
  const [error, setError] = useState<string | null>(null);
  const g = (k: string) => f[k] ?? '';
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const submit = () => {
    if (!g('asOfDate')) {
      setError('As-of date is required');
      return;
    }
    const rec: Quarter = {
      id: initial?.id,
      asOfDate: g('asOfDate'),
      q: g('q') || '—',
      mv: g('mv') ? parseFloat(g('mv')) : null,
      pps: equity && g('pps') ? (parseCurrencyInput(g('pps')) ?? undefined) : undefined,
      ppsCurrency: equity && g('ppsCurrency') ? g('ppsCurrency') : null,
      // Entered as a real share count; the domain stores it in millions.
      sharesOut: g('sharesOut') ? (parseCurrencyInput(g('sharesOut')) ?? 0) / M : null,
      shPct: g('shPct') ? parseFloat(g('shPct')) : null,
      cost: g('cost') ? parseFloat(g('cost')) : null,
      moic: g('moic') ? parseFloat(g('moic')) : null,
      xirr: g('xirr') ? parseFloat(g('xirr')) : null,
      notes: g('notes') || null,
    };
    onSubmit(rec);
  };
  return (
    <FormDialog
      title={mode === 'edit' ? 'Edit quarterly record' : 'Add quarterly record'}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={mode === 'edit' ? 'Save changes' : 'Add record'}
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      <FormRow>
        <FormField label="As-of date">
          <FormInput type="date" value={g('asOfDate')} onChange={(v) => set('asOfDate', v)} />
        </FormField>
        <FormField label="Quarter label (e.g. Q1'26)">
          <FormInput value={g('q')} onChange={(v) => set('q', v)} />
        </FormField>
      </FormRow>
      <FormRow>
        <FormField label="Market Value">
          <CurrencyInput
            currency={g('ppsCurrency') ? normalizeCurrency(g('ppsCurrency')) : currency}
            amount={g('mv') ? parseFloat(g('mv')) * 1_000_000 : null}
            onCommit={(amt, cur) => {
              set('mv', amt == null ? '' : String(amt / 1_000_000));
              set('ppsCurrency', cur);
            }}
          />
        </FormField>
      </FormRow>
      <FormRow>
        {equity && (
          <FormField label="Price per Share">
            <CurrencyInput
              currency={normalizeCurrency(g('ppsCurrency'))}
              amount={g('pps') ? parseFloat(g('pps')) : null}
              onCommit={(amt, cur) => {
                set('pps', amt == null ? '' : String(amt));
                set('ppsCurrency', cur);
              }}
            />
          </FormField>
        )}
        <FormField label="Shares Outstanding">
          <FormInput type="number" value={g('sharesOut')} onChange={(v) => set('sharesOut', v)} />
        </FormField>
        <FormField label="Shareholding %">
          <FormInput type="number" value={g('shPct')} onChange={(v) => set('shPct', v)} />
        </FormField>
      </FormRow>
      <FormRow>
        <FormField label="Invested Capital">
          <CurrencyInput
            currency={g('ppsCurrency') ? normalizeCurrency(g('ppsCurrency')) : currency}
            amount={g('cost') ? parseFloat(g('cost')) * 1_000_000 : null}
            onCommit={(amt, cur) => {
              set('cost', amt == null ? '' : String(amt / 1_000_000));
              set('ppsCurrency', cur);
            }}
          />
        </FormField>
        <FormField label="MOIC">
          <FormInput type="number" value={g('moic')} onChange={(v) => set('moic', v)} />
        </FormField>
        <FormField label="XIRR (%)">
          <FormInput type="number" value={g('xirr')} onChange={(v) => set('xirr', v)} />
        </FormField>
      </FormRow>
      <FormField label="Remarks">
        <FormInput value={g('notes')} onChange={(v) => set('notes', v)} />
      </FormField>
    </FormDialog>
  );
}

// ---- small reusable bits ----
function RowActions({
  onEdit,
  onDelete,
  deleteDisabled,
}: {
  onEdit: () => void;
  onDelete: () => void;
  deleteDisabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label="Row actions"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          ⋮
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[7rem]">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={deleteDisabled}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-destructive focus:text-destructive"
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-accent hover:text-foreground"
    >
      + {label}
    </button>
  );
}

function FormDialog({
  title,
  children,
  onSubmit,
  onClose,
  submitLabel,
  submitDisabled,
}: {
  title: string;
  children: ReactNode;
  onSubmit: () => void;
  onClose: () => void;
  submitLabel: string;
  submitDisabled?: boolean;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 px-1 pb-1">{children}</div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-3">{children}</div>;
}
function FormField({ label, children, required }: { label: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="flex min-w-[120px] flex-1 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}{required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
    </label>
  );
}
function FormInput({
  value,
  onChange,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  const isNum = type === 'number';
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={ref}
      type={isNum ? 'text' : type}
      inputMode={isNum ? 'decimal' : undefined}
      value={value}
      onChange={(e) => {
        if (!isNum) { onChange(e.target.value); return; }
        const el = e.currentTarget;
        const next = regroupNumericInput(el.value, el.selectionStart ?? el.value.length, {
          allowSuffix: true,
        });
        onChange(next.text);
        requestAnimationFrame(() => ref.current?.setSelectionRange(next.caret, next.caret));
      }}
      className="rounded-md border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-accent"
    />
  );
}
function FormSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-accent"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

// ---- generic (obligation / shares / cash) ----
type GenericField = {
  label: string;
  value: string | number | null | undefined;
  display?: ReactNode;
  kind?: InlineKind;
  options?: string[];
  onCommit: (raw: string) => void;
};

/** Editable field descriptors for the non-equity/FoF holding types. `setD`
 * mutates `holding.d` in place and persists via commitHolding — the same
 * pattern the Equity/FoF Legal tabs use. */
function genericFields(
  h: Holding,
  setD: (k: keyof HoldingFacts, raw: string, numeric?: boolean) => void,
  money: (v: number) => string,
): GenericField[] {
  const d = h.d || {};
  if (h.tp === 'Obligation')
    return [
      {
        label: 'Loan type',
        value: d.noteType,
        kind: 'select',
        options: ['Convertible note', 'Bridge loan', 'Senior secured', 'Mezzanine'],
        onCommit: (r) => setD('noteType', r),
      },
      { label: 'Borrower', value: d.issuer, onCommit: (r) => setD('issuer', r) },
      { label: 'Maturity date', value: d.maturity, kind: 'date', onCommit: (r) => setD('maturity', r) },
      {
        label: 'Interest rate',
        value: d.coupon,
        display: d.coupon != null ? formatPercentage(d.coupon) : undefined,
        kind: 'num',
        onCommit: (r) => setD('coupon', r, true),
      },
      {
        label: 'Amount lent',
        value: d.principal,
        display: d.principal != null ? money(d.principal) : undefined,
        kind: 'num',
        onCommit: (r) => setD('principal', r, true),
      },
    ];
  if (h.tp === 'Shares')
    return [
      { label: 'Exchange', value: d.exchange, onCommit: (r) => setD('exchange', r) },
      { label: 'Ticker', value: d.ticker, onCommit: (r) => setD('ticker', r) },
      {
        label: 'Shares held',
        value: d.sharesK,
        display: d.sharesK != null ? `${d.sharesK}K` : undefined,
        kind: 'num',
        onCommit: (r) => setD('sharesK', r, true),
      },
      { label: 'Price per share', value: d.pricePerShare, onCommit: (r) => setD('pricePerShare', r) },
      {
        label: 'Company size',
        value: d.marketCapB,
        display: d.marketCapB != null ? `$${d.marketCapB}B` : undefined,
        kind: 'num',
        onCommit: (r) => setD('marketCapB', r, true),
      },
    ];
  if (h.tp === 'Cash')
    return [
      { label: 'Type', value: d.type, onCommit: (r) => setD('type', r) },
      { label: 'Held at', value: d.institution, onCommit: (r) => setD('institution', r) },
      {
        label: 'Interest earned',
        value: d.yieldPct,
        display: d.yieldPct != null ? formatPercentage(d.yieldPct) : undefined,
        kind: 'num',
        onCommit: (r) => setD('yieldPct', r, true),
      },
    ];
  return [];
}

/** Section: the editable detail grid for non-equity/FoF holdings (cash, loan,
 * public shares). Fields are click-to-edit, mirroring the Equity Legal tab. */
function GenericDetail({ fund, holding, typeName }: { fund: Fund; holding: Holding; typeName: string }) {
  const { commitHolding } = useFundData();
  const { money } = useFundMoney();
  const d = (holding.d = holding.d || {});
  const save = () => commitHolding(fund, holding);
  const setD = (k: keyof HoldingFacts, raw: string, numeric = false) => {
    (d as Record<string, unknown>)[k as string] = numeric ? num(raw) : txt(raw);
    save();
  };
  const fields: GenericField[] = [];
  fields.push(...genericFields(holding, setD, money));

  return (
    <div className="border-l-2 border-accent/40 pl-3.5">
      <div className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-accent">{typeName} details</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
        {fields.map((f) => (
          <EditKV
            key={f.label}
            label={f.label}
            value={f.value}
            display={f.display}
            kind={f.kind}
            options={f.options}
            onCommit={f.onCommit}
          />
        ))}
      </div>
    </div>
  );
}

// ---- shared tab shell ----
function TabbedDetail({ tabs }: { tabs: { id: string; label: string; body: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  return (
    <div className="border-l-2 border-accent/40 pl-4">
      <div className="mb-3.5 flex gap-0 overflow-x-auto border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t.id)}
            className={cn(
              'whitespace-nowrap border-b-2 px-3.5 py-2 text-xs font-medium transition-colors',
              active === t.id
                ? 'border-accent text-accent'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>{tabs.find((t) => t.id === active)?.body}</div>
    </div>
  );
}

/** Section: the expanded detail panel for one holding (equity / FoF / other). */
export function HoldingDetail({
  fund,
  holding,
  footer,
}: {
  fund: Fund;
  holding: Holding;
  /** Rendered below the type-specific detail. */
  footer?: ReactNode;
}) {
  let content: ReactNode;
  if (holding.tp === 'Equity' && holding.inv) {
    content = <EquityDetail fund={fund} holding={holding} />;
  } else if (holding.tp === 'Fund of funds' && holding.inv) {
    content = <FoFDetail fund={fund} holding={holding} />;
  } else if (holding.tp === 'Cash' && holding.inv) {
    content = <CashDetail fund={fund} holding={holding} />;
  } else {
    const typeName =
      ({ Equity: 'Company', Cash: 'Cash', Obligation: 'Loan', Shares: 'Public shares', 'Fund of funds': 'Fund' } as Record<string, string>)[
        holding.tp
      ] || holding.tp;
    content = <GenericDetail fund={fund} holding={holding} typeName={typeName} />;
  }

  return (
    <div className="pl-4 sm:pl-10">
      {content}
      {footer}
    </div>
  );
}
