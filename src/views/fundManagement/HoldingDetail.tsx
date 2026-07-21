'use client';

import { useRef, useState, type ReactNode } from 'react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { EquityMetrics, Fund, Holding, HoldingFacts, Quarter, Txn, TxnType } from './types';
import {
  applyCommas,
  computeFoF,
  computeInv,
  formatCompact,
  formatGrouped,
  getAssetInvestType,
  INVEST_TYPES,
  isFoF,
  parseCurrencyInput,
  setAssetInvestType,
  txnTypeLabel,
  txnValue,
} from './calc';
import { useFundMoney } from './useFundMoney';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';
import { useFundData } from './context';
import { Combobox } from './Combobox';
import * as fundsApi from '@/lib/api/funds';
import { quarterToPayload, toLocalISODate, txnToPayload } from './adapters';
import { FieldKey, GlossaryTerm, InlineEdit, type InlineKind, MiniSpark, Pill } from './parts';
import { CURRENCIES, CurrencyInput, MoneyInlineEdit, normalizeCurrency, type Currency } from './CurrencyInput';

// Money domain values are in millions; the currency editors work in raw units.
const M = 1_000_000;
const toRaw = (millions: number | null | undefined): number | null =>
  millions == null ? null : millions * M;
const rawToMillions = (raw: number | null): string => (raw == null ? '' : String(raw / M));

const num = (raw: string): number | null => (raw === '' ? null : parseFloat(raw) || 0);
const txt = (raw: string): string | null => raw || null;

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
    <div className="rounded-lg border bg-muted/40 px-2.5 py-2">
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
  const { commitHolding, investorOptions, sourceOptions } = useFundData();
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

  // Convert raw-dollar DB overrides to millions for display/value (money()
  // expects millions; these fields load from the DB without toM conversion).
  const investedCapM = inv._investedCapitalAmount != null ? inv._investedCapitalAmount / M : null;
  const realizedProcM = inv._netDistributionAmount != null ? inv._netDistributionAmount / M : null;
  const shareCountM = inv._shareCount != null ? inv._shareCount / M : null;
  const fmvM = inv._fmvAmount != null ? inv._fmvAmount / M : null;

  const performance = (
    <>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Tile
          label="Gross MOIC"
          term="moicT"
          value={
            <InlineEdit
              kind="num"
              value={inv._grossMoic ?? c.grossMOIC}
              display={`${(inv._grossMoic ?? c.grossMOIC).toFixed(2)}×`}
              onCommit={(r) => {
                inv._grossMoic = r ? parseFloat(r) : undefined;
                save();
              }}
            />
          }
          tone={(inv._grossMoic ?? c.grossMOIC) >= 1 ? 'success' : 'danger'}
        />
        <Tile label="Net MOIC" term="moicT" value={`${c.netMOIC.toFixed(2)}×`} tone={c.netMOIC >= 1 ? 'success' : 'danger'} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <SectionTable head="Capital & Value">
            <CalcRow
              label="Invested Capital"
              term="costinv"
              value={
                <InlineEdit
                  align="right"
                  kind="num"
                  value={inv._investedCapitalAmount ?? c.investedCapital * M}
                  display={money(investedCapM ?? c.investedCapital)}
                  onCommit={(r) => {
                    inv._investedCapitalAmount = r ? parseFloat(r) : undefined;
                    save();
                  }}
                />
              }
            />
            <CalcRow
              label="Realized Proceeds"
              term="realproc"
              value={
                <InlineEdit
                  align="right"
                  kind="num"
                  value={inv._netDistributionAmount ?? c.realizedProceedsGross * M}
                  display={money(realizedProcM ?? c.realizedProceedsGross)}
                  onCommit={(r) => {
                    inv._netDistributionAmount = r ? parseFloat(r) : undefined;
                    save();
                  }}
                />
              }
            />
            <CalcRow label="Shares acquired" term="sharesacquired" value={formatCompact(c.sharesAcquired * M)} indent />
            <CalcRow label="Shares disposed" term="sharesdisposed" value={formatCompact(c.sharesDisposed * M)} indent />
            <CalcRow
              label="Remaining shares held"
              term="sharesheld"
              value={
                <InlineEdit
                  align="right"
                  kind="num"
                  value={inv._shareCount ?? c.sharesHeld * M}
                  display={formatCompact((shareCountM ?? c.sharesHeld) * M)}
                  onCommit={(r) => {
                    inv._shareCount = r ? parseFloat(r) : undefined;
                    save();
                  }}
                />
              }
            />
            <CalcRow label="Blended entry price" term="avgbuy" value={`$${formatCompact(c.blendedEntryPrice)}`} />
            <CalcRow
              label="Current share price"
              term="curprice"
              value={
                <InlineEdit
                  align="right"
                  kind="num"
                  value={Number(c.curPrice.toFixed(2))}
                  display={`$${formatCompact(c.curPrice)}`}
                  onCommit={(r) => {
                    inv._cur = parseFloat(r) || 0;
                    save();
                  }}
                />
              }
            />
            <CalcRow
              label="Unrealized value"
              term="marketvalue"
              value={
                <InlineEdit
                  align="right"
                  kind="num"
                  value={inv._fmvAmount ?? c.unrealizedValue * M}
                  display={money(fmvM ?? c.unrealizedValue)}
                  onCommit={(r) => {
                    inv._fmvAmount = r ? parseFloat(r) : undefined;
                    save();
                  }}
                />
              }
            />
            <CalcRow label="Total Value (Gross)" term="totalvalgross" value={money(c.totalValueGross)} bold />
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
            <CalcRow label="Gross MOIC" term="grossmoic" value={`${c.grossMOIC.toFixed(2)}×`} />
            <CalcRow label="Net MOIC" term="netmoic" value={`${c.netMOIC.toFixed(2)}×`} bold />
            <CalcRow label="DPI" term="dpiT" value={`${c.dpi.toFixed(2)}×`} />
          </SectionTable>
        </div>
      </div>
    </>
  );

  const legal = (
    <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-4">
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
      <EditKV label="Entry date" kind="date" value={holding.dt} onCommit={(r) => { holding.dt = r; save(); }} />
      <SelectKV
        label="Source of fund"
        term="fundingsource"
        value={inv.fundingSource}
        options={sourceOptions}
        placeholder="Select source…"
        onCommit={(r) => setInv('fundingSource', r)}
      />
      <EditKV label="Stake" value={inv.stakePct} display={inv.stakePct != null ? `${inv.stakePct}%` : undefined} kind="num" onCommit={(r) => setInv('stakePct', r, true)} />
      <EditKV label="Hold period" term="holdperiod" value={d.holdYrs} display={d.holdYrs != null ? `${d.holdYrs} yrs` : undefined} kind="num" onCommit={(r) => setD('holdYrs', r, true)} />
      <EditKV label="Reporting date" term="reportdate" kind="date" value={inv.reportDate} onCommit={(r) => setInv('reportDate', r)} />
      <EditKV label="Investment Currency" term="invccy" value={inv.investCcy} onCommit={(r) => setInv('investCcy', r)} />
      <EditKV label="Currency" term="reportccy" value={inv.ccy} onCommit={(r) => setInv('ccy', r)} />
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
              value={Number(c.curPrice.toFixed(2))}
              display={`$${formatCompact(c.curPrice)}`}
              onCommit={(r) => {
                inv._cur = parseFloat(r) || 0;
                save();
              }}
            />
          </div>
        </div>
        <KV label="Total valuation" term="totalval" value={money(c.unrealizedValue)} />
        <KV label="Live MOIC" value={`${c.grossMOIC.toFixed(2)}×`} />
        <div>
          <FieldKey>
            <GlossaryTerm term="unreal">Unrealised return</GlossaryTerm>
          </FieldKey>
          <div className={cn('text-[15px] font-medium', c.unreal >= 0 ? 'text-success' : 'text-destructive')}>
            {c.unreal >= 0 ? '+' : ''}
            {(c.unreal * 100).toFixed(1)}%
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
        <InlineEdit align="right" kind="num" value={rate} display={rate != null ? `${rate} %` : undefined} onCommit={onCommit} />
      </td>
      <td className="px-2.5 py-1 text-right text-xs">{moneyFee(value)}</td>
    </tr>
  );
}

// ================= Fund of funds =================
function FoFDetail({ fund, holding }: { fund: Fund; holding: Holding }) {
  const { commitHolding, refreshHolding, investorOptions, sourceOptions } = useFundData();
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
  // The FoF "unrealized market value" isn't a stored asset column — it's the
  // latest valuation snapshot. Editing it upserts that valuation (same
  // endpoint/units as the Historical value tab: value in millions → raw $),
  // then reloads so server-recomputed rollups land.
  const setMarketValue = (raw: string) => {
    const millions = num(raw);
    if (!holding.id || millions == null) return;
    const latest = inv.quarterly && inv.quarterly.length ? inv.quarterly[inv.quarterly.length - 1] : null;
    const asOfDate = latest?.asOfDate || toLocalISODate(new Date());
    fundsApi
      .upsertValuation(fund.id, holding.id, {
        asOfDate,
        periodLabel: latest?.q,
        marketValueAmount: millions * 1_000_000,
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

  // Live values fold in any manual override (inv._*) over the ledger-derived
  // metric, exactly like the Equity Performance tab.
  const xirr = inv._grossIrr ?? c.xirr;
  const moic = inv._grossMoic ?? c.moic;
  const costInv = inv._investedCapitalAmount != null ? inv._investedCapitalAmount / M : c.costInv;
  const netDist = inv._netDistributionAmount != null ? inv._netDistributionAmount / M : c.netDist;
  const dpiVal = inv._dpi ?? c.dpi;

  const performance = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Tile
        label="XIRR"
        term="xirr"
        value={
          <InlineEdit
            kind="num"
            value={Number((xirr * 100).toFixed(1))}
            display={`${(xirr * 100).toFixed(1)}%`}
            onCommit={(r) => {
              inv._grossIrr = r ? parseFloat(r) / 100 : undefined;
              save();
            }}
          />
        }
        tone={xirr >= 0 ? 'success' : 'danger'}
      />
      <Tile
        label="MOIC"
        term="moicT"
        value={
          <InlineEdit
            kind="num"
            value={Number(moic.toFixed(2))}
            display={`${moic.toFixed(2)}×`}
            onCommit={(r) => {
              inv._grossMoic = r ? parseFloat(r) : undefined;
              save();
            }}
          />
        }
      />
      <Tile
        label="Invested Capital"
        term="costinv"
        value={
          <InlineEdit
            kind="num"
            value={costInv}
            display={moneyK(costInv)}
            onCommit={(r) => {
              inv._investedCapitalAmount = r ? parseFloat(r) * M : undefined;
              save();
            }}
          />
        }
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
        value={
          <InlineEdit
            kind="num"
            value={netDist}
            display={moneyK(netDist)}
            onCommit={(r) => {
              inv._netDistributionAmount = r ? parseFloat(r) * M : undefined;
              save();
            }}
          />
        }
      />
      <Tile
        label="DPI"
        term="dpiT"
        value={
          <InlineEdit
            kind="num"
            value={Number(dpiVal.toFixed(2))}
            display={`${dpiVal.toFixed(2)}×`}
            onCommit={(r) => {
              inv._dpi = r ? parseFloat(r) : undefined;
              save();
            }}
          />
        }
      />
    </div>
  );

  const legal = (
    <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-4">
      <EditKV label="Fund name" value={holding.n} onCommit={(r) => { holding.n = r || holding.n; save(); }} />
      <EditKV label="Legal name" term="legalname" value={inv.legalName} onCommit={(r) => setInv('legalName', r)} />
      <SelectKV
        label="Investing entity"
        term="investentity"
        value={inv.entity}
        options={investorOptions}
        placeholder="Select entity…"
        onCommit={(r) => setInv('entity', r)}
      />
      <EditKV label="Country" value={d.geo} display={d.geo || inv.country || 'Indonesia'} onCommit={(r) => setD('geo', r)} />
      <EditKV label="Investment type" value={getAssetInvestType(holding)} kind="select" options={INVEST_TYPES} onCommit={(r) => { setAssetInvestType(holding, r); save(); }} />
      <SelectKV
        label="Source of fund"
        term="fundingsource"
        value={inv.fundingSource}
        options={sourceOptions}
        placeholder="Select source…"
        onCommit={(r) => setInv('fundingSource', r)}
      />
      <EditKV label="Stake" value={inv.stakePct} display={inv.stakePct != null ? `${inv.stakePct}%` : undefined} kind="num" onCommit={(r) => setInv('stakePct', r, true)} />
      <EditKV label="Entry date" kind="date" value={holding.dt} onCommit={(r) => { holding.dt = r; save(); }} />
      <EditKV label="Reporting date" term="reportdate" kind="date" value={inv.reportDate} onCommit={(r) => setInv('reportDate', r)} />
      <EditKV label="Currency" term="reportccy" value={inv.ccy} onCommit={(r) => setInv('ccy', r)} />
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
        <EditKV label="Shareholding %" term="shpct" value={inv.stakePct} display={inv.stakePct != null ? `${inv.stakePct}%` : undefined} kind="num" onCommit={(r) => setInv('stakePct', r, true)} />
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
        <KV label="MOIC" value={`${c.moic.toFixed(2)}×`} />
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
  const { commitHolding, sourceOptions } = useFundData();
  const save = () => commitHolding(fund, holding);
  const inv = holding.inv!;
  const d = (holding.d = holding.d || {});
  // Cash is value-based (no shares/PPS), so it uses the same rollups as a
  // fund-of-funds position.
  const c = computeFoF(holding)!;
  const ccy = normalizeCurrency(inv.ccy);
  const dispCcy = useWorkspaceCurrency();

  const setInv = (k: keyof typeof inv, raw: string, numeric = false) => {
    (inv as unknown as Record<string, unknown>)[k as string] = numeric ? num(raw) : txt(raw);
    save();
  };
  const setD = (k: string, raw: string, numeric = false) => {
    (d as Record<string, unknown>)[k] = numeric ? num(raw) : txt(raw);
    save();
  };

  // Live figures fold any manual override (inv._*) over the ledger-derived
  // amount, exactly like the Equity/FoF Performance tabs. Editing a value here
  // writes the override straight to the asset's invested_capital_amount /
  // fmv_amount columns (flags is_manually_overridden) — adding or editing a
  // transaction afterwards clears the override and re-derives from the ledger.
  const balance = inv._investedCapitalAmount != null ? inv._investedCapitalAmount / M : c.costInv;
  const currentValue = inv._fmvAmount != null ? inv._fmvAmount / M : c.marketValue;
  const netDist = inv._netDistributionAmount != null ? inv._netDistributionAmount / M : c.netDist;

  const overview = (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile
          label="Amount"
          term="costinv"
          value={
            <MoneyInlineEdit
              amount={toRaw(balance)}
              currency={dispCcy}
              onCommit={(amt) => {
                inv._investedCapitalAmount = amt ?? undefined;
                save();
              }}
            />
          }
        />
        <Tile
          label="Current value"
          term="marketvalue"
          value={
            <MoneyInlineEdit
              amount={toRaw(currentValue)}
              currency={dispCcy}
              onCommit={(amt) => {
                inv._fmvAmount = amt ?? undefined;
                save();
              }}
            />
          }
        />
        <Tile
          label="Interest / income"
          term="netdist"
          value={
            <MoneyInlineEdit
              amount={toRaw(netDist)}
              currency={dispCcy}
              onCommit={(amt) => {
                inv._netDistributionAmount = amt ?? undefined;
                save();
              }}
            />
          }
        />
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground">
        → Balances roll up from the Transactions ledger. Typing a value here overrides that
        roll-up until you next add or edit a transaction, which recomputes from the ledger.
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2.5 border-t pt-4 sm:grid-cols-4">
        <EditKV label="Held at" value={d.institution} onCommit={(r) => setD('institution', r)} />
        <EditKV
          label="Interest earned"
          value={d.yieldPct}
          display={d.yieldPct != null ? `${d.yieldPct}%` : undefined}
          kind="num"
          onCommit={(r) => setD('yieldPct', r, true)}
        />
        <EditKV label="Type" value={d.type} onCommit={(r) => setD('type', r)} />
        <SelectKV
          label="Source of fund"
          term="fundingsource"
          value={inv.fundingSource}
          options={sourceOptions}
          placeholder="Select source…"
          onCommit={(r) => setInv('fundingSource', r)}
        />
        <EditKV label="Entry date" kind="date" value={holding.dt} onCommit={(r) => { holding.dt = r; save(); }} />
        <EditKV label="Currency" term="reportccy" value={inv.ccy} onCommit={(r) => setInv('ccy', r)} />
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
  const { refreshHolding } = useFundData();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ mode: 'add' | 'edit'; idx: number } | null>(null);
  const txns = holding.inv?.txns || [];
  const ccy = normalizeCurrency(holding.inv?.ccy);
  const dispCcy = useWorkspaceCurrency();
  const typeOptions: TxnType[] = fof ? ['Buy', 'Distribution', 'Other'] : ['Buy', 'Sell', 'Distribution', 'Other'];

  const onFailure = (message: string) => (err: unknown) => {
    console.error(message, err);
    toast({
      title: message,
      description: err instanceof Error ? err.message : 'Your change was not saved.',
      variant: 'destructive',
    });
    refreshHolding(fund, holding);
  };

  const persist = (t: Txn) => {
    if (!holding.id) return;
    const payload = txnToPayload(t);
    // Default to the holding's assigned entity/source if the transaction didn't explicitly override it.
    if (!payload.holdingEntityId) payload.holdingEntityId = holding.inv?.entity || null;
    if (!payload.fundingSourceId) payload.fundingSourceId = holding.inv?.fundingSource || null;
    const request = t.id
      ? fundsApi.updateTransaction(fund.id, holding.id, t.id, payload)
      : fundsApi.addTransaction(fund.id, holding.id, payload);
    request.then(() => refreshHolding(fund, holding)).catch(onFailure('Failed to save transaction'));
  };
  const editTxn = (i: number, k: keyof Txn, raw: string, numeric = false) => {
    const next = { ...txns[i], [k]: numeric ? num(raw) : txt(raw) };
    txns[i] = next;
    persist(next);
  };
  const delTxn = (i: number) => {
    const t = txns[i];
    if (txns.length <= 1 || !holding.id || !t.id) return;
    fundsApi
      .deleteTransaction(fund.id, holding.id, t.id)
      .then(() => refreshHolding(fund, holding))
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
            <th className={cn(th, 'text-left')}><GlossaryTerm term="fxref">FX</GlossaryTerm></th>
            <th className={cn(th, 'text-left')}><GlossaryTerm term="txnotes">Remarks</GlossaryTerm></th>
            <th className={cn(th, 'w-16 text-right')}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {txns.map((t, i) => (
            <tr key={i} className="group border-b">
              <td className="px-2 py-1 text-xs text-muted-foreground">
                <InlineEdit value={t.date} kind="date" onCommit={(r) => editTxn(i, 'date', r)} />
              </td>
              <td className="px-2 py-1 text-xs text-muted-foreground">
                <InlineEdit value={t.eom} onCommit={(r) => editTxn(i, 'eom', r)} />
              </td>
              <td className="px-2 py-1">
                <InlineEdit value={t.type} display={<Pill>{txnTypeLabel(t, holding)}</Pill>} kind="select" options={typeOptions} onCommit={(r) => editTxn(i, 'type', r)} />
              </td>
              {!fof && (
                <td className="px-2 py-1 text-right text-xs">
                  <InlineEdit align="right" kind="num" value={t.pps} display={t.pps ? `$${formatCompact(t.pps)}` : undefined} onCommit={(r) => editTxn(i, 'pps', r, true)} />
                </td>
              )}
              {!fof && (
                <td className="px-2 py-1 text-right text-xs">
                  <InlineEdit
                    align="right"
                    kind="num"
                    value={t.shares != null ? t.shares * M : undefined}
                    display={t.shares ? formatGrouped(t.shares * M) : undefined}
                    onCommit={(r) => {
                      const raw = r ? parseFloat(r) : null;
                      const next = { ...txns[i], shares: raw != null ? raw / M : null };
                      txns[i] = next;
                      persist(next);
                    }}
                  />
                </td>
              )}
              <td className="px-2 py-1 text-right text-xs">
                <MoneyInlineEdit
                  align="right"
                  amount={toRaw(txnValue(t))}
                  currency={dispCcy}
                  onCommit={(amt) => editTxn(i, 'value', rawToMillions(amt), true)}
                />
              </td>
              <td className="px-2 py-1 text-xs text-muted-foreground">
                <InlineEdit value={t.fx} onCommit={(r) => editTxn(i, 'fx', r)} />
              </td>
              <td className="px-2 py-1 text-xs text-muted-foreground">
                <InlineEdit value={t.notes} onCommit={(r) => editTxn(i, 'notes', r)} />
              </td>
              <td className="px-1 py-1 text-right">
                <RowActions
                  deleteDisabled={txns.length <= 1}
                  onEdit={() => setDialog({ mode: 'edit', idx: i })}
                  onDelete={() => delTxn(i)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddRowButton label="Add transaction" onClick={() => setDialog({ mode: 'add', idx: -1 })} />
      <div className="mt-1.5 flex items-center gap-1.5 border-t bg-muted/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">
        → Adding, editing, or removing transactions recalculates Invested Capital, Realized Proceeds,
        Shares Held and all downstream metrics.
      </div>
      {dialog && (
        <TxnDialog
          fof={fof}
          currency={ccy}
          typeOptions={typeOptions}
          mode={dialog.mode}
          fundId={fund.id}
          initial={dialog.mode === 'edit' ? txns[dialog.idx] : undefined}
          onClose={() => setDialog(null)}
          onSubmit={(t) => {
            if (dialog.mode === 'edit') txns[dialog.idx] = t;
            else (holding.inv!.txns ||= []).push(t);
            persist(t);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function TxnDialog({
  fof,
  currency,
  typeOptions,
  mode,
  initial,
  fundId,
  onSubmit,
  onClose,
}: {
  fof?: boolean;
  currency: Currency;
  typeOptions: TxnType[];
  mode: 'add' | 'edit';
  initial?: Txn;
  fundId?: string;
  onSubmit: (t: Txn) => void;
  onClose: () => void;
}) {
  const { funds, investorOptions, sourceOptions, entityNameById, sourceNameById } = useFundData();
  const wsCurrency = useWorkspaceCurrency();
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
          fundId: initial.fundId ?? fundId ?? '',
          // The ledger stores entity/source as UUID foreign keys, but the
          // comboboxes are name-based (and the save path resolves name → id).
          // Map the stored id to its name so the picker shows the name, not
          // the raw UUID. Fall back to the raw value if it's already a name or
          // has no managed row.
          holdingEntityId: initial.holdingEntityId
            ? (entityNameById.get(initial.holdingEntityId) ?? initial.holdingEntityId)
            : '',
          fundingSourceId: initial.fundingSourceId
            ? (sourceNameById.get(initial.fundingSourceId) ?? initial.fundingSourceId)
            : '',
        }
      : { type: 'Buy', fundId: fundId ?? '' },
  );
  const g = (k: string) => f[k] ?? '';
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  // One of "Value" or "Price per share + Number of shares" must be filled.
  const hasValue = !!g('value');
  const hasPpsShares = !fof && !!g('pps') && !!g('shares');
  const canSubmit = !!g('date') && (hasValue || hasPpsShares);
  const submit = () => {
    const pps = !fof && g('pps') ? (parseCurrencyInput(g('pps')) ?? null) : null;
    const shares = !fof && g('shares') ? (parseCurrencyInput(g('shares')) ?? 0) / M : null;
    // Only persist an explicitly typed value (an override). When left blank,
    // value stays null and is derived live as PPS × shares by `txnValue`, so
    // later edits to PPS or shares keep the value in sync automatically.
    const explicitValue = g('value') ? parseFloat(g('value')) : null;
    const value = explicitValue != null ? explicitValue : fof ? 0 : null;
    const t: Txn = {
      id: initial?.id,
      date: g('date') || '—',
      eom: g('eom') || null,
      type: (g('type') as TxnType) || 'Buy',
      value,
      pps,
      ppsCurrency: !fof && g('ppsCurrency') ? g('ppsCurrency') : null,
      shares,
      fx: g('fx') || null,
      notes: g('notes') || null,
      label: initial?.label,
      fundId: g('fundId') || null,
      holdingEntityId: g('holdingEntityId') || null,
      fundingSourceId: g('fundingSourceId') || null,
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
        <FormField label="Fund">
          <Combobox
            value={g('fundId')}
            options={funds.map((fd) => fd.id)}
            labelFor={(id) => funds.find((fd) => fd.id === id)?.n ?? id}
            onChange={(v) => set('fundId', v)}
            placeholder="Select fund…"
          />
        </FormField>
        <FormField label="Holding Entity">
          <Combobox
            value={g('holdingEntityId')}
            options={investorOptions}
            onChange={(v) => set('holdingEntityId', v)}
            placeholder="Select entity…"
          />
        </FormField>
        <FormField label="Funding Source">
          <Combobox
            value={g('fundingSourceId')}
            options={sourceOptions}
            onChange={(v) => set('fundingSourceId', v)}
            placeholder="Select source…"
          />
        </FormField>
      </FormRow>
      <FormRow>
        <FormField label="Type" required>
          <FormSelect value={g('type')} onChange={(v) => set('type', v)} options={typeOptions} />
        </FormField>
        <FormField label="Date" required>
          <FormInput type="date" value={g('date')} onChange={(v) => set('date', v)} />
        </FormField>
      </FormRow>
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
function QuarterTable({ fund, holding, equity }: { fund: Fund; holding: Holding; equity?: boolean }) {
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
    fundsApi
      .upsertValuation(fund.id, holding.id, quarterToPayload(rec, rec.asOfDate))
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
    fundsApi
      .deleteValuation(fund.id, holding.id, rec.id)
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
            {q.map((x, i) => {
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
                    <InlineEdit align="right" kind="num" value={x.shPct} display={safe(x.shPct, (v) => `${v}%`)} onCommit={(r) => editQ(i, 'shPct', r)} />
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
            })}
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
                fundsApi
                  .upsertValuation(fund.id, holding.id, quarterToPayload(rec, rec.asOfDate!))
                  .then(() => fundsApi.deleteValuation(fund.id, holding.id!, prev.id!))
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
        const cursorInV = el.selectionStart ?? el.value.length;
        const before = el.value.slice(0, cursorInV).replace(/,/g, '').length;
        const stripped = el.value.replace(/,/g, '');
        const formatted = applyCommas(stripped);
        onChange(formatted);
        requestAnimationFrame(() => {
          const inp = ref.current;
          if (!inp) return;
          let rem = before;
          let cur = formatted.length;
          if (rem === 0) {
            cur = 0;
          } else {
            for (let i = 0; i < formatted.length; i++) {
              if (formatted[i] !== ',') rem--;
              if (rem === 0) { cur = i + 1; break; }
            }
          }
          inp.setSelectionRange(cur, cur);
        });
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
        display: d.coupon != null ? `${d.coupon}%` : undefined,
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
        display: d.yieldPct != null ? `${d.yieldPct}%` : undefined,
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
  // Cash (and other non-equity types) have no `inv` ledger, so the amount is
  // written straight to the asset's invested/value columns as a manual
  // override — the raw-dollar buffer lives on `d` (see holdingToAssetUpdateInput).
  const setAmount = (field: '_investedAmount' | '_fmvAmount', target: 'cost' | 'fmv', raw: string) => {
    const millions = num(raw);
    holding[target] = millions ?? 0;
    d[field] = millions == null ? null : millions * M;
    save();
  };

  const fields: GenericField[] = [];
  if (holding.tp === 'Cash') {
    fields.push(
      {
        label: 'Amount',
        value: holding.cost,
        display: money(holding.cost),
        kind: 'num',
        onCommit: (r) => setAmount('_investedAmount', 'cost', r),
      },
      {
        label: 'Current value',
        value: holding.fmv,
        display: money(holding.fmv),
        kind: 'num',
        onCommit: (r) => setAmount('_fmvAmount', 'fmv', r),
      },
    );
  }
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
export function HoldingDetail({ fund, holding }: { fund: Fund; holding: Holding }) {
  if (holding.tp === 'Equity' && holding.inv) {
    return (
      <div className="pl-4 sm:pl-10">
        <EquityDetail fund={fund} holding={holding} />
      </div>
    );
  }
  if (holding.tp === 'Fund of funds' && holding.inv) {
    return (
      <div className="pl-4 sm:pl-10">
        <FoFDetail fund={fund} holding={holding} />
      </div>
    );
  }
  if (holding.tp === 'Cash' && holding.inv) {
    return (
      <div className="pl-4 sm:pl-10">
        <CashDetail fund={fund} holding={holding} />
      </div>
    );
  }
  const typeName =
    ({ Equity: 'Company', Cash: 'Cash', Obligation: 'Loan', Shares: 'Public shares', 'Fund of funds': 'Fund' } as Record<string, string>)[
      holding.tp
    ] || holding.tp;
  return (
    <div className="pl-4 sm:pl-10">
      <GenericDetail fund={fund} holding={holding} typeName={typeName} />
    </div>
  );
}
