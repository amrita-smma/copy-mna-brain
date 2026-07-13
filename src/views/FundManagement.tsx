'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Building2, Layers, Wallet } from 'lucide-react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import * as fundsApi from '@/lib/api/funds';
import * as holdingEntitiesApi from '@/lib/api/holdingEntities';
import * as fundSourcesApi from '@/lib/api/fundSources';
import * as holdingEntityStakesApi from '@/lib/api/holdingEntityStakes';
import {
  ASSET_CREATE_FIELDS,
  assetRowToHolding,
  buildAssetCreatePayload,
  computeFundHistory,
  fundRowToFund,
  holdingToAssetUpdateInput,
  trailingQuarterEnds,
} from './fundManagement/adapters';
import {
  CurrencyInput,
  normalizeCurrency,
  type Currency,
} from './fundManagement/CurrencyInput';
import { Combobox } from './fundManagement/Combobox';
import { MetricCards } from './fundManagement/MetricCards';
import { MoneyBreakdown } from './fundManagement/MoneyBreakdown';
import { AssetTable } from './fundManagement/AssetTable';
import { FundSummaryTable } from './fundManagement/FundSummaryTable';
import { EntitySummaryTable } from './fundManagement/EntitySummaryTable';
import { SourceSummaryTable } from './fundManagement/SourceSummaryTable';
import { GlossaryTerm } from './fundManagement/parts';
import { FundDataContext } from './fundManagement/context';
import {
  applyHoldingMetrics,
  collectHoldingsByEntity,
  getAssetEntity,
  getAssetFundingSources,
  investorInvestedInFund,
  money,
  recomputeFund,
  sourceAgg,
} from './fundManagement/calc';
import type { Fund, HoldingType, Investor } from './fundManagement/types';

type InvestorRow = Awaited<ReturnType<typeof holdingEntitiesApi.listHoldingEntities>>[number];
type StakeRow = Awaited<ReturnType<typeof holdingEntityStakesApi.listHoldingEntityStakes>>[number];
type FundSourceRow = Awaited<ReturnType<typeof fundSourcesApi.listFundSources>>[number];

interface FundManagementProps {
  showCompanyGraph?: boolean;
  showFundManagement?: boolean;
}

type PortfolioTab = 'asset' | 'fund' | 'investor' | 'source';

const PORTFOLIO_TABS: { k: PortfolioTab; label: string }[] = [
  { k: 'asset', label: 'Asset' },
  { k: 'fund', label: 'Fund' },
  { k: 'investor', label: 'Investor' },
  { k: 'source', label: 'Source of Fund' },
];

// Add-Asset picker options (trimmed from the full HoldingType union: Equity
// and Obligation removed, Shares folded into "Direct Investments").
const HOLDING_TYPES: HoldingType[] = ['Direct Investments', 'Cash', 'Fund of funds'];

const HOLDING_TYPE_INFO: Partial<
  Record<HoldingType, { icon: typeof Building2; description: string }>
> = {
  'Direct Investments': { icon: Building2, description: 'A direct stake in a company' },
  Cash: { icon: Wallet, description: 'Reserve / not yet deployed' },
  'Fund of funds': { icon: Layers, description: 'Investment into another fund' },
};



async function buildFund(fundId: string): Promise<Fund> {
  const { assets, ...fundRow } = await fundsApi.getFund(fundId);
  const perAsset = await Promise.all(
    assets.map(async (asset) => {
      const [txns, valuations] = await Promise.all([
        fundsApi.listTransactions(fundId, asset.id),
        fundsApi.listValuations(fundId, asset.id),
      ]);
      return { asset, txns, valuations };
    }),
  );
  const fund = fundRowToFund(fundRow);
  fund.h = perAsset.map(({ asset, txns, valuations }) => assetRowToHolding(asset, txns, valuations));
  fund.hist = computeFundHistory(perAsset, fundRow.commitment_size_amount, trailingQuarterEnds(4));
  return fund;
}

function AddFundDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (fundId: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [vintageYear, setVintageYear] = useState('');
  const [commitment, setCommitment] = useState<number | null>(null);
  const [currency, setCurrency] = useState<Currency>('USD');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError('Fund name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const fund = await fundsApi.createFund({
        name: name.trim(),
        description: description.trim() || null,
        vintageYear: vintageYear ? Number(vintageYear) : null,
        commitmentSizeAmount: commitment,
        baseCurrency: currency,
      });
      await onCreated(fund.id);
      onOpenChange(false);
      setName('');
      setDescription('');
      setVintageYear('');
      setCommitment(null);
      setCurrency('USD');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create fund');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add fund</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fund-name">Name</Label>
            <Input id="fund-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fund-description">Description</Label>
            <Textarea
              id="fund-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fund-vintage">Vintage year</Label>
              <Input
                id="fund-vintage"
                type="number"
                value={vintageYear}
                onChange={(e) => setVintageYear(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fund-commitment">Commitment size</Label>
              <CurrencyInput
                id="fund-commitment"
                amount={commitment}
                currency={currency}
                onCommit={(amt, cur) => {
                  setCommitment(amt);
                  setCurrency(cur);
                }}
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create fund'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditFundDialog({
  fund,
  open,
  onOpenChange,
  onSaved,
}: {
  fund: Fund | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (fundId: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [vintageYear, setVintageYear] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [commitment, setCommitment] = useState<number | null>(null);
  const [called, setCalled] = useState<number | null>(null);
  const [fmv, setFmv] = useState<number | null>(null);
  const [realized, setRealized] = useState<number | null>(null);
  const [dpi, setDpi] = useState('');
  const [tvpi, setTvpi] = useState('');
  const [irr, setIrr] = useState('');
  const [status, setStatus] = useState<'investing' | 'harvesting'>('investing');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && fund) {
      const M = 1_000_000;
      setName(fund.n);
      setDescription(fund.description ?? '');
      setVintageYear(fund.v ? String(fund.v) : '');
      setCurrency(normalizeCurrency(fund.baseCurrency));
      setCommitment(fund.size ? fund.size * M : null);
      setCalled(fund.called ? fund.called * M : null);
      setFmv(fund.fmv ? fund.fmv * M : null);
      setRealized(fund.real ? fund.real * M : null);
      setDpi(String(fund.dpi ?? 0));
      setTvpi(String(fund.tvpi ?? 0));
      setIrr(String(fund.irr ?? 0));
      setStatus(fund.st === 'Harvesting' ? 'harvesting' : 'investing');
      setError(null);
    }
  }, [open, fund]);

  const submit = async () => {
    if (!fund) return;
    if (!name.trim()) {
      setError('Fund name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
      const irrNum = numOrNull(irr);
      await fundsApi.updateFund(fund.id, {
        name: name.trim(),
        description: description.trim() || null,
        vintageYear: vintageYear ? Number(vintageYear) : null,
        baseCurrency: currency,
        commitmentSizeAmount: commitment,
        status,
        // Derived overrides. UI money is raw here (already ×1e6); DPI/TVPI are
        // ratios; IRR is a percent in the UI but a fraction server-side.
        calledAmount: called,
        fmvAmount: fmv,
        realizedAmount: realized,
        dpi: numOrNull(dpi),
        tvpi: numOrNull(tvpi),
        irr: irrNum == null ? null : irrNum / 100,
      });
      await onSaved(fund.id);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save fund');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit fund{fund ? ` · ${fund.n}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-fund-name">Name</Label>
            <Input id="edit-fund-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-fund-description">Description</Label>
            <Textarea
              id="edit-fund-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-fund-vintage">Vintage year</Label>
              <Input
                id="edit-fund-vintage"
                type="number"
                value={vintageYear}
                onChange={(e) => setVintageYear(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phase</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as 'investing' | 'harvesting')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="investing">Investing</SelectItem>
                  <SelectItem value="harvesting">Harvesting</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-fund-commitment">Commitment size</Label>
            <CurrencyInput
              id="edit-fund-commitment"
              amount={commitment}
              currency={currency}
              onCommit={(amt, cur) => {
                setCommitment(amt);
                setCurrency(cur);
              }}
            />
          </div>

          <div className="border-t pt-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Performance (manual overrides)
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Invested</Label>
                <CurrencyInput
                  amount={called}
                  currency={currency}
                  onCommit={(amt, cur) => {
                    setCalled(amt);
                    setCurrency(cur);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Unrealized Market Value</Label>
                <CurrencyInput
                  amount={fmv}
                  currency={currency}
                  onCommit={(amt, cur) => {
                    setFmv(amt);
                    setCurrency(cur);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Realized Value</Label>
                <CurrencyInput
                  amount={realized}
                  currency={currency}
                  onCommit={(amt, cur) => {
                    setRealized(amt);
                    setCurrency(cur);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-fund-irr">IRR (%)</Label>
                <Input id="edit-fund-irr" type="number" value={irr} onChange={(e) => setIrr(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-fund-dpi">DPI (×)</Label>
                <Input id="edit-fund-dpi" type="number" value={dpi} onChange={(e) => setDpi(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-fund-tvpi">MOIC / TVPI (×)</Label>
                <Input id="edit-fund-tvpi" type="number" value={tvpi} onChange={(e) => setTvpi(e.target.value)} />
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              These are normally derived from each holding's transaction ledger. Values you set
              here are manual overrides — the next metrics recompute (on any asset/transaction
              change) will overwrite them.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAssetDialog({
  funds,
  investorOptions,
  sourceOptions,
  initialFundId,
  open,
  onOpenChange,
  onCreated,
}: {
  funds: Fund[];
  investorOptions: string[];
  sourceOptions: string[];
  initialFundId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (fundId: string) => Promise<void>;
}) {
  // Hardcode a fundId for the API URL paths, as the backend currently requires one
  // in the route structure despite the asset being unbound in the database.
  const fundId = initialFundId ?? funds[0]?.id ?? '';
  const [tp, setTp] = useState<HoldingType>('Direct Investments');
  // Instrument is always Equity for direct investments (picker removed).
  const [values, setValues] = useState<Record<string, string>>({});
  const [assetCurrency, setAssetCurrency] = useState<Currency>('USD');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read via refs (not effect deps) so a background funds reload while the
  // drawer is open — e.g. an unrelated commitHolding PATCH resolving — can't
  // re-trigger this reset and wipe whatever the user has already typed.
  const fundsRef = useRef(funds);
  fundsRef.current = funds;
  const initialFundIdRef = useRef(initialFundId);
  initialFundIdRef.current = initialFundId;

  // Tracks whether the asset create call has already succeeded, so a retry
  // after a partial failure resumes without re-creating the asset.
  const progressRef = useRef<{ assetId: string | null }>({
    assetId: null,
  });

  const effectiveTp: HoldingType = tp;

  useEffect(() => {
    if (open) {
      setTp('Direct Investments');
      setValues({});
      setAssetCurrency('USD');
      setError(null);
      progressRef.current = { assetId: null };
    }
  }, [open]);

  const setField = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!fundId) {
      setError('Choose a fund');
      return;
    }
    const missing = ASSET_CREATE_FIELDS[effectiveTp].find(
      (f) => f.required && !values[f.key]?.trim(),
    );
    if (missing) {
      setError(`${missing.label} is required`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { input } = buildAssetCreatePayload(effectiveTp, values);
      // Persist the currency chosen on the money fields' prefix dropdown.
      input.investmentCurrency = assetCurrency;
      input.reportCurrency = assetCurrency;
      
      let assetId = progressRef.current.assetId;
      if (!assetId) {
        const asset = await fundsApi.addAsset(fundId, input);
        assetId = asset.id;
        progressRef.current.assetId = assetId;
      }

      await onCreated(fundId);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add asset');
    } finally {
      setSaving(false);
    }
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add an asset</DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-1 pb-1">

          <div>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              What kind of asset?
            </div>
            <div className="grid grid-cols-2 gap-2">
              {HOLDING_TYPES.map((t) => {
                const info = HOLDING_TYPE_INFO[t];
                if (!info) return null;
                const { icon: Icon, description } = info;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTp(t)}
                    className={cn(
                      'rounded-md border p-2.5 text-left transition-colors',
                      tp === t ? 'border-accent bg-accent/10' : 'hover:bg-muted/50',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className={cn('h-4 w-4', tp === t ? 'text-accent' : 'text-muted-foreground')} />
                      <span className="text-[13px] font-medium text-foreground">{t}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{description}</div>
                  </button>
                );
              })}
            </div>
          </div>


          <div>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Details
            </div>
            <div className="grid grid-cols-2 gap-3">
              {ASSET_CREATE_FIELDS[effectiveTp].map((f) => (
                <div key={f.key} className={cn('space-y-1.5', f.kind === 'select' && 'col-span-2')}>
                  <Label htmlFor={`asset-${f.key}`}>
                    {f.label}
                    {f.required && <span className="ml-0.5 text-destructive">*</span>}
                  </Label>
                  {f.kind === 'select' ? (
                    <Select value={values[f.key] ?? ''} onValueChange={(v) => setField(f.key, v)}>
                      <SelectTrigger id={`asset-${f.key}`}>
                        <SelectValue placeholder="Select…" />
                      </SelectTrigger>
                      <SelectContent>
                        {f.options?.map((o) => (
                          <SelectItem key={o} value={o}>
                            {o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : f.kind === 'money' ? (
                    <CurrencyInput
                      id={`asset-${f.key}`}
                      amount={values[f.key] ? Number(values[f.key]) : null}
                      currency={assetCurrency}
                      onCommit={(amt, cur) => {
                        setAssetCurrency(cur);
                        setField(f.key, amt == null ? '' : String(amt));
                      }}
                    />
                  ) : (
                    <Input
                      id={`asset-${f.key}`}
                      type={f.kind === 'num' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setField(f.key, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Adding…' : 'Add asset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Fund Management — a modular React implementation (Tailwind + shadcn tokens,
// theme-aware). Funds/holdings/ledger come from the Fund Management API
// (src/lib/api/funds.ts). Investment Entities (investors) and Sources of Fund
// (funding_sources) are persisted through their own APIs; the by-entity /
// by-source tabs group the live funds' holdings by those managed lists.
export default function FundManagement({
  showCompanyGraph = false,
  showFundManagement = false,
}: FundManagementProps) {
  const [funds, setFunds] = useState<Fund[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [investorRows, setInvestorRows] = useState<InvestorRow[]>([]);
  const [stakeRows, setStakeRows] = useState<StakeRow[]>([]);
  const [fundSourceRows, setFundSourceRows] = useState<FundSourceRow[]>([]);
  const [tab, setTab] = useState<PortfolioTab>('asset');
  const [addFundOpen, setAddFundOpen] = useState(false);
  const [addAssetOpen, setAddAssetOpen] = useState(false);
  const [addAssetFundId, setAddAssetFundId] = useState<string | null>(null);
  const [addEntityOpen, setAddEntityOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [editSource, setEditSource] = useState<{ id: string; name: string } | null>(null);
  const [editStakesFor, setEditStakesFor] = useState<string | null>(null);
  const [editFund, setEditFund] = useState<Fund | null>(null);
  // Bump to force a re-render after an in-place optimistic edit to a holding/fund.
  const [, setRev] = useState(0);
  const { toast } = useToast();

  const reloadAll = useCallback(async () => {
    try {
      const rows = await fundsApi.listFunds();
      const built = await Promise.all(rows.map((r) => buildFund(r.id)));
      setFunds(built);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load funds');
    }
  }, []);

  const reloadInvestors = useCallback(async () => {
    try {
      setInvestorRows(await holdingEntitiesApi.listHoldingEntities());
    } catch (err) {
      console.error('Failed to load investment entities', err);
    }
  }, []);

  const reloadStakes = useCallback(async () => {
    try {
      setStakeRows(await holdingEntityStakesApi.listHoldingEntityStakes());
    } catch (err) {
      console.error('Failed to load investor stakes', err);
    }
  }, []);

  const reloadSources = useCallback(async () => {
    try {
      setFundSourceRows(await fundSourcesApi.listFundSources());
    } catch (err) {
      console.error('Failed to load sources of fund', err);
    }
  }, []);

  const deleteInvestor = useCallback(
    async (investorId: string) => {
      try {
        await holdingEntitiesApi.deleteHoldingEntity(investorId);
        // Stakes cascade-delete server-side; refresh both so the local view matches.
        await Promise.all([reloadInvestors(), reloadStakes()]);
      } catch (err) {
        console.error('Failed to delete investment entity', err);
        toast({
          title: 'Failed to delete investment entity',
          description: err instanceof Error ? err.message : 'The entity was not deleted.',
          variant: 'destructive',
        });
        throw err;
      }
    },
    [reloadInvestors, reloadStakes, toast],
  );

  const deleteSource = useCallback(
    async (sourceId: string) => {
      try {
        await fundSourcesApi.deleteFundSource(sourceId);
        await reloadSources();
      } catch (err) {
        console.error('Failed to delete source of fund', err);
        toast({
          title: 'Failed to delete source of fund',
          description: err instanceof Error ? err.message : 'The source was not deleted.',
          variant: 'destructive',
        });
        throw err;
      }
    },
    [reloadSources, toast],
  );

  const editSourceName = useCallback(
    async (sourceId: string, name: string) => {
      try {
        await fundSourcesApi.updateFundSource(sourceId, { name });
        await reloadSources();
      } catch (err) {
        console.error('Failed to rename source of fund', err);
        toast({
          title: 'Failed to rename source of fund',
          description: err instanceof Error ? err.message : 'The source was not renamed.',
          variant: 'destructive',
        });
        throw err;
      }
    },
    [reloadSources, toast],
  );

  useEffect(() => {
    reloadAll();
    reloadInvestors();
    reloadStakes();
    reloadSources();
  }, [reloadAll, reloadInvestors, reloadStakes, reloadSources]);

  const reloadOne = useCallback(
    async (fundId: string) => {
      try {
        const fresh = await buildFund(fundId);
        setFunds((prev) => {
          if (!prev) return prev;
          const exists = prev.some((f) => f.id === fundId);
          return exists ? prev.map((f) => (f.id === fundId ? fresh : f)) : [...prev, fresh];
        });
      } catch (err) {
        console.error('Failed to reload fund', err);
        toast({
          title: 'Failed to refresh fund',
          description: err instanceof Error ? err.message : 'The latest data could not be loaded.',
          variant: 'destructive',
        });
      }
    },
    [toast],
  );


  // Combobox / grouping options merge the managed lists (investors /
  // funding_sources tables) with the values already in use on holdings, so
  // entities and sources already attached to assets are selectable even
  // before anyone adds them to the managed list.
  const entityOptions = useMemo(() => {
    const set = new Set<string>(investorRows.map((r) => r.name));
    (funds ?? []).forEach((f) =>
      f.h.forEach((h) => {
        const e = getAssetEntity(h);
        if (e) set.add(e);
      }),
    );
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [investorRows, funds]);

  const sourceOptions = useMemo(() => {
    const set = new Set<string>(fundSourceRows.map((r) => r.name));
    (funds ?? []).forEach((f) =>
      f.h.forEach((h) =>
        getAssetFundingSources(h).forEach((s) => {
          if (s && s !== 'Unspecified') set.add(s);
        }),
      ),
    );
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [fundSourceRows, funds]);

  // Managed-source name → row id, so the Source tab can offer delete only for
  // sources that actually have a funding_sources row (not free-text/in-use-only).
  const sourceIdsByName = useMemo(
    () => new Map(fundSourceRows.map((r) => [r.name, r.id] as const)),
    [fundSourceRows],
  );

  // Reverse maps (id → name) so edit forms can display a transaction's stored
  // UUID foreign keys as names — the entity/source comboboxes are name-based.
  const entityNameById = useMemo(
    () => new Map(investorRows.map((r) => [r.id, r.name] as const)),
    [investorRows],
  );
  const sourceNameById = useMemo(
    () => new Map(fundSourceRows.map((r) => [r.id, r.name] as const)),
    [fundSourceRows],
  );

  // Names of holdings that have no assigned investing entity (the "Others"
  // group). The Add-asset combobox lists them so they can be picked directly.
  const entitylessHoldingNames = useMemo(() => {
    const set = new Set<string>();
    (funds ?? []).forEach((f) =>
      f.h.forEach((h) => {
        if (!getAssetEntity(h) && h.n) set.add(h.n);
      }),
    );
    return [...set];
  }, [funds]);

  // Investment Entity combobox options: managed/in-use entities + entity-less
  // holding names (so "Others" holdings show by name in the picker).
  const comboboxEntityOptions = useMemo(
    () => [...new Set([...entityOptions, ...entitylessHoldingNames])].sort((a, b) => a.localeCompare(b)),
    [entityOptions, entitylessHoldingNames],
  );

  // Raw stake detail per (investorId, fundId) — feeds the edit-stakes dialog.
  const stakeDetail = useMemo(() => {
    const map: Record<string, Record<string, StakeRow>> = {};
    stakeRows.forEach((s) => {
      (map[s.holding_entity_id!] ||= {})[s.fund_id] = s;
    });
    return map;
  }, [stakeRows]);

  const dataCtx = useMemo(
    () => ({
      commitHolding: (fund: Fund, holding: (typeof fund.h)[number]) => {
        applyHoldingMetrics(holding);
        recomputeFund(fund);
        setRev((r) => r + 1);
        if (!holding.id) return;
        fundsApi
          .updateAsset(fund.id, holding.id, holdingToAssetUpdateInput(holding))
          .then(() => reloadOne(fund.id))
          .catch((err) => {
            console.error('Failed to save asset', err);
            toast({
              title: 'Failed to save',
              description: err instanceof Error ? err.message : 'Your change was not saved.',
              variant: 'destructive',
            });
            reloadOne(fund.id).catch((reloadErr) => console.error('Failed to reload fund', reloadErr));
          });
      },
      refreshHolding: (fund: Fund) => {
        reloadOne(fund.id);
      },
      deleteFund: async (fund: Fund) => {
        try {
          await fundsApi.deleteFund(fund.id);
          setFunds((prev) => (prev ? prev.filter((f) => f.id !== fund.id) : null));
        } catch (err) {
          console.error('Failed to delete fund', err);
          toast({
            title: 'Failed to delete fund',
            description: err instanceof Error ? err.message : `"${fund.n}" was not deleted.`,
            variant: 'destructive',
          });
          throw err;
        }
      },
      deleteAsset: async (fund: Fund, holding: (typeof fund.h)[number]) => {
        if (!holding.id) return;
        try {
          await fundsApi.deleteAsset(fund.id, holding.id);
          reloadOne(fund.id);
        } catch (err) {
          console.error('Failed to delete asset', err);
          toast({
            title: 'Failed to delete holding',
            description: err instanceof Error ? err.message : `"${holding.n}" was not deleted.`,
            variant: 'destructive',
          });
          throw err;
        }
      },
      funds: funds ?? [],
      investorOptions: comboboxEntityOptions,
      sourceOptions,
      entityNameById,
      sourceNameById,
    }),
    [reloadOne, toast, funds, comboboxEntityOptions, sourceOptions, entityNameById, sourceNameById],
  );

  // LP pro-rata model for the By Investment Entity tab: fractional ownership of

  // a fund = the entity's committed capital ÷ the fund's commitment size.
  const tabInvestors = useMemo<Investor[]>(() => {
    const fundSizeById = new Map((funds ?? []).map((f) => [f.id, f.size]));
    return investorRows.map((row) => {
      const stakes: Record<string, number> = {};
      Object.values(stakeDetail[row.id] ?? {}).forEach((s) => {
        const sizeM = fundSizeById.get(s.fund_id) ?? 0; // fund.size is in millions
        const committedM = (s.commitment_amount ?? 0) / 1_000_000;
        if (sizeM > 0 && committedM > 0) stakes[s.fund_id] = committedM / sizeM;
      });
      return { id: row.id, n: row.name, type: row.entity_type ?? '', stakes };
    });
  }, [investorRows, stakeDetail, funds]);

  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph} showFundManagement={showFundManagement}>
      <FundDataContext.Provider value={dataCtx}>
        <TooltipProvider delayDuration={120}>
          <div className="mx-auto max-w-[1180px] px-5 pb-16 pt-6">
            <header className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold text-foreground">Fund Management</h1>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Your funds, what they hold, and how each investor is doing. Hover any{' '}
                  <GlossaryTerm term="dotted">dotted term</GlossaryTerm> for a plain-English
                  explanation.
                </p>
              </div>
            </header>

            {loadError && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {loadError}{' '}
                <button className="underline" onClick={() => reloadAll()}>
                  Retry
                </button>
              </div>
            )}

            {funds == null && !loadError ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading funds…</p>
            ) : (
              <>
                <MetricCards funds={funds ?? []} />
                <MoneyBreakdown funds={funds ?? []} />

                <div className="overflow-hidden rounded-lg border bg-card">
                  <div className="flex flex-wrap items-center gap-2.5 border-b bg-muted/30 px-3 py-2.5">
                    <span className="text-xs font-medium text-foreground">Portfolio</span>
                    <div className="ml-auto flex flex-wrap items-center gap-2.5">
                      {tab === 'fund' && (
                        <Button size="sm" variant="outline" onClick={() => setAddFundOpen(true)}>
                          + Add fund
                        </Button>
                      )}
                      {tab === 'asset' && funds && funds.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setAddAssetFundId(null);
                            setAddAssetOpen(true);
                          }}
                        >
                          + Add asset
                        </Button>
                      )}
                      {tab === 'investor' && (
                        <Button size="sm" variant="outline" onClick={() => setAddEntityOpen(true)}>
                          + Add Investment Entity
                        </Button>
                      )}
                      {tab === 'source' && (
                        <Button size="sm" variant="outline" onClick={() => setAddSourceOpen(true)}>
                          + Add Source of Fund
                        </Button>
                      )}
                      <div className="inline-flex overflow-hidden rounded-full border bg-background">
                        {PORTFOLIO_TABS.map(({ k, label }) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => setTab(k)}
                            className={cn(
                              'px-3.5 py-1 text-xs',
                              tab === k
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="p-3">
                    {tab === 'asset' ? (
                      <AssetTable funds={funds ?? []} />
                    ) : tab === 'fund' ? (
                      <FundSummaryTable funds={funds ?? []} onEditFund={(fund) => setEditFund(fund)} />
                    ) : tab === 'investor' ? (
                      <EntitySummaryTable
                        funds={funds ?? []}
                        investors={tabInvestors}
                        onEditStakes={(id) => setEditStakesFor(id)}
                        onDeleteInvestor={deleteInvestor}
                      />
                    ) : (
                      <SourceSummaryTable
                        funds={funds ?? []}
                        sourceNames={sourceOptions}
                        sourceIdsByName={sourceIdsByName}
                        onDeleteSource={deleteSource}
                        onEditSource={(id, name) => setEditSource({ id, name })}
                      />
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </TooltipProvider>
      </FundDataContext.Provider>

      <AddFundDialog open={addFundOpen} onOpenChange={setAddFundOpen} onCreated={reloadOne} />
      <AddAssetDialog
        funds={funds ?? []}
        investorOptions={comboboxEntityOptions}
        sourceOptions={sourceOptions}
        initialFundId={addAssetFundId}
        open={addAssetOpen}
        onOpenChange={setAddAssetOpen}
        // Reload every fund (not just the target) so the newly added asset —
        // which binds to its fund through its initial transaction — reliably
        // shows up in the list once the drawer closes.
        onCreated={async () => {
          await reloadAll();
        }}
      />
      <EditFundDialog
        fund={editFund}
        open={editFund != null}
        onOpenChange={(o) => !o && setEditFund(null)}
        onSaved={reloadOne}
      />
      <NameDialog
        title="Add Investment Entity"
        label="Investment Entity Name"
        open={addEntityOpen}
        onOpenChange={setAddEntityOpen}
        onSubmit={async (name) => {
          await holdingEntitiesApi.createHoldingEntity({ name });
          await reloadInvestors();
        }}
      />
      <NameDialog
        title="Add Source of Fund"
        label="Source of Fund Name"
        open={addSourceOpen}
        onOpenChange={setAddSourceOpen}
        onSubmit={async (name) => {
          await fundSourcesApi.createFundSource({ name });
          await reloadSources();
        }}
      />
      <NameDialog
        title="Edit Source of Fund"
        label="Source of Fund Name"
        submitLabel="Save changes"
        open={editSource != null}
        onOpenChange={(o) => !o && setEditSource(null)}
        initialValue={editSource?.name ?? ''}
        onSubmit={async (name) => {
          if (!editSource) return;
          await editSourceName(editSource.id, name);
          setEditSource(null);
        }}
      />
      <StakeEditDialog
        open={editStakesFor != null}
        onOpenChange={(o) => !o && setEditStakesFor(null)}
        investorId={editStakesFor}
        investorName={investorRows.find((r) => r.id === editStakesFor)?.name ?? ''}
        funds={funds ?? []}
        detail={editStakesFor ? (stakeDetail[editStakesFor] ?? {}) : {}}
        onSaved={reloadStakes}
      />
    </DashboardLayout>
  );
}

/** Edit an investment entity's committed / invested capital in each fund.
 * Fractional ownership (shown in the tab) is derived as committed ÷ fund size. */
function StakeEditDialog({
  open,
  onOpenChange,
  investorId,
  investorName,
  funds: allFunds,
  detail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  investorId: string | null;
  investorName: string;
  funds: Fund[];
  detail: Record<string, StakeRow>;
  onSaved: () => void | Promise<void>;
}) {
  // Invested is no longer captured here — it's derived from each entity's own
  // transactions (see investorInvestedInFund). Only commitment is editable.
  type Row = {
    commitment: number | null;
    commitmentCcy: Currency;
  };
  // Drop the synthetic "Unassigned Assets" pseudo-fund (injected by GET
  // /api/funds) — it isn't a real fund row, so a stake can't be attached to it
  // and saving one would fail the funds.id lookup on the server.
  const funds = useMemo(() => allFunds.filter((f) => f.id !== 'unassigned'), [allFunds]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const next: Record<string, Row> = {};
      funds.forEach((f) => {
        const s = detail[f.id];
        next[f.id] = {
          commitment: s?.commitment_amount ?? null,
          commitmentCcy: normalizeCurrency(s?.commitment_amount_currency),
        };
      });
      setRows(next);
      setError(null);
    }
  }, [open, funds, detail]);

  const setRow = (fundId: string, patch: Partial<Row>) =>
    setRows((p) => ({ ...p, [fundId]: { ...p[fundId], ...patch } }));

  const submit = async () => {
    if (!investorId) return;
    setSaving(true);
    setError(null);
    try {
      // Upsert funds the entity has (or had) a stake in; skip funds left blank
      // that never had one, so we don't create empty rows.
      await Promise.all(
        funds
          .filter((f) => {
            const r = rows[f.id];
            return r && (r.commitment != null || detail[f.id]);
          })
          .map((f) => {
            const r = rows[f.id];
            // Invested is derived from transactions and no longer persisted here.
            return holdingEntityStakesApi.upsertHoldingEntityStake({
              fundId: f.id,
              holdingEntityId: investorId,
              commitmentAmount: r.commitment,
              commitmentAmountCurrency: r.commitmentCcy,
            });
          }),
      );
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save stakes');
    } finally {
      setSaving(false);
    }
  };

  // Ownership % per fund = committed ÷ fund size, driven live by the Commitment
  // input. This is only a pledge indicator now — the entity's actual
  // performance comes from the assets/transactions attributed to it (below),
  // matching the Investor tab.
  const perFund = funds.map((f) => {
    const r = rows[f.id];
    const committedM = (r?.commitment ?? 0) / 1_000_000;
    const share = f.size > 0 && committedM > 0 ? committedM / f.size : 0;
    // Invested = this entity's own contribution transactions in the fund.
    const invested = investorId ? investorInvestedInFund(investorId, f) : 0;
    const value = f.fmv * share;
    const real = f.real * share;
    return { f, share, invested, value, real, gain: value + real - invested, moic: invested > 0 ? (value + real) / invested : 0 };
  });
  const totalCommit = perFund.reduce(
    (s, p) => s + (rows[p.f.id]?.commitment ?? 0) / 1_000_000,
    0,
  );
  // Invested / Unrealized MV / Net Gain / MOIC roll up from the assets whose
  // investing entity is this one — i.e. straight from their transaction ledger.
  const assetAgg = sourceAgg(
    investorName ? (collectHoldingsByEntity(funds, [investorName]).get(investorName) ?? []) : [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Edit{investorName ? ` · ${investorName}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <p className="text-xs text-muted-foreground">
            Set this entity's committed capital in each fund. Ownership % is committed ÷ the fund's
            commitment size. Invested is computed from this entity's own transactions; Unrealized MV,
            Net Gain and MOIC are computed from that share of each fund's performance.
          </p>
          {funds.length === 0 && (
            <p className="text-sm text-muted-foreground">No funds yet.</p>
          )}
          {perFund.map(({ f, share, invested, value, gain, moic }) => {
            const r = rows[f.id];
            if (!r) return null;
            return (
              <div key={f.id} className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-foreground">{f.n}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {(share * 100).toFixed(0)}% ownership
                  </span>
                </div>
                <div className="space-y-1.5">
                  <Label>Commitment</Label>
                  <CurrencyInput
                    amount={r.commitment}
                    currency={r.commitmentCcy}
                    onCommit={(amt, cur) => setRow(f.id, { commitment: amt, commitmentCcy: cur })}
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-2.5 sm:grid-cols-4">
                  <ReadOut label="Invested" value={money(invested)} />
                  <ReadOut label="Unrealized MV" value={money(value)} />
                  <ReadOut
                    label="Net Gain"
                    value={`${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))}`}
                    tone={gain >= 0 ? 'success' : 'danger'}
                  />
                  <ReadOut label="MOIC" value={`${moic.toFixed(2)}×`} />
                </div>
              </div>
            );
          })}
          {funds.length > 0 && (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Total · {investorName || 'entity'}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
                <ReadOut label="Commitment" value={money(totalCommit)} />
                <ReadOut label="Invested" value={money(assetAgg.cost)} />
                <ReadOut label="Unrealized MV" value={money(assetAgg.fmv)} />
                <ReadOut
                  label="Net Gain"
                  value={`${assetAgg.gain >= 0 ? '+' : '−'}${money(Math.abs(assetAgg.gain))}`}
                  tone={assetAgg.gain >= 0 ? 'success' : 'danger'}
                />
                <ReadOut label="MOIC" value={`${assetAgg.moic.toFixed(2)}×`} />
              </div>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A small labelled read-only figure used in the Edit-entity modal. */
function ReadOut({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          'text-[13px] font-medium',
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

/** Single-text-field dialog used by the "Add Investment Entity" / "Add Source
 * of Fund" header buttons. */
function NameDialog({
  title,
  label,
  open,
  onOpenChange,
  onSubmit,
  initialValue = '',
  submitLabel = 'Save',
}: {
  title: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => Promise<void>;
  /** Pre-fill the field (used when editing an existing name). */
  initialValue?: string;
  submitLabel?: string;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialValue);
      setError(null);
    }
  }, [open, initialValue]);

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="name-dialog-input">{label}</Label>
          <Input
            id="name-dialog-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
