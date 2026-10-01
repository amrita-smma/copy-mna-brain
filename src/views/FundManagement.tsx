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
import type { Tables } from '@/lib/repositories';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import type { AssetKind, FlPortfolioReadModel } from '@/lib/api/fundLedger';
import {
  ASSET_CREATE_FIELDS,
  buildAssetCreatePayload,
  buildEntityFromPortfolio,
  buildFundFromPortfolio,
  buildFundLpHolders,
  buildOrphanAssetFund,
  filterEntityInvestors,
  fromM,
  toLocalISODate,
  txnToLedgerEntryInput,
} from './fundManagement/adapters';
import {
  executeDeleteInvestor,
  executeDeleteFundingSource,
  executeDeleteAsset,
} from './fundManagement/actions';
import {
  CurrencyInput,
  CURRENCIES,
  normalizeCurrency,
  type Currency,
} from './fundManagement/CurrencyInput';
import { MetricCards } from './fundManagement/MetricCards';
import { MoneyBreakdown } from './fundManagement/MoneyBreakdown';
import { AssetTable } from './fundManagement/AssetTable';
import { FundSummaryTable } from './fundManagement/FundSummaryTable';
import { EntitySummaryTable } from './fundManagement/EntitySummaryTable';
import { CommitmentLedgerDialog } from './fundManagement/CommitmentLedgerDialog';
import { Combobox } from './fundManagement/Combobox';
import { SourceSummaryTable } from './fundManagement/SourceSummaryTable';
import { GlossaryTerm } from './fundManagement/parts';
import { FundDataContext } from './fundManagement/context';
import { useFeatureEnabled } from '@/components/layout/FeatureFlagsContext';
import {
  applyHoldingMetrics,
  getAssetEntity,
  getAssetFundingSources,
  getAssetInvestType,
  recomputeFund,
} from './fundManagement/calc';
import type { Fund, Holding, HoldingType, Investor } from './fundManagement/types';

type InvestorRow = Tables<'fl_investors'>;
type FundSourceRow = Tables<'fl_funding_sources'>;
type StakeRow = {
  id: string;
  fund_id: string;
  holding_entity_id: string;
  commitment_amount: number;
  invested_amount: number;
  distributed_amount: number;
  entity_type?: string;
};

type PortfolioTab = 'asset' | 'fund' | 'investor' | 'source';

const PORTFOLIO_TABS: { k: PortfolioTab; label: string }[] = [
  { k: 'asset', label: 'Asset' },
  { k: 'fund', label: 'Fund' },
  { k: 'investor', label: 'Investor' },
  { k: 'source', label: 'Source of Fund' },
];

const HOLDING_TYPES: HoldingType[] = ['Direct Investments', 'Cash', 'Fund of funds'];

const HOLDING_TYPE_INFO: Partial<
  Record<HoldingType, { icon: typeof Building2; description: string }>
> = {
  'Direct Investments': { icon: Building2, description: 'A direct stake in a company' },
  Cash: { icon: Wallet, description: 'Reserve / not yet deployed' },
  'Fund of funds': { icon: Layers, description: 'Investment into another fund' },
};

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
  const [englishName, setEnglishName] = useState('');
  const [description, setDescription] = useState('');
  const [vintageYear, setVintageYear] = useState('');
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
      const fund = await fundLedgerApi.createFund({
        name: name.trim(),
        english_name: englishName.trim() || null,
        description: description.trim() || null,
        vintage_year: vintageYear ? Number(vintageYear) : null,
        base_currency: currency,
        managed: true,
        ownership_basis: 'commitment',
      });
      await onCreated(fund.id);
      onOpenChange(false);
      setName('');
      setEnglishName('');
      setDescription('');
      setVintageYear('');
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
            <Label htmlFor="fund-english-name">English Name (optional)</Label>
            <Input id="fund-english-name" value={englishName} onChange={(e) => setEnglishName(e.target.value)} />
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
              <Label htmlFor="fund-currency">Base currency</Label>
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger id="fund-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
  const [englishName, setEnglishName] = useState('');
  const [description, setDescription] = useState('');
  const [vintageYear, setVintageYear] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [status, setStatus] = useState<'investing' | 'harvesting'>('investing');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && fund) {
      setName(fund.n);
      setEnglishName(fund.englishName ?? '');
      setDescription(fund.description ?? '');
      setVintageYear(fund.v ? String(fund.v) : '');
      setCurrency(normalizeCurrency(fund.baseCurrency));
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
      await fundLedgerApi.updateFund(fund.id, {
        name: name.trim(),
        english_name: englishName.trim() || null,
        description: description.trim() || null,
        vintage_year: vintageYear ? Number(vintageYear) : null,
        base_currency: currency,
        status,
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
            <Label htmlFor="edit-fund-english-name">English Name (optional)</Label>
            <Input id="edit-fund-english-name" value={englishName} onChange={(e) => setEnglishName(e.target.value)} />
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
          <div className="grid grid-cols-3 gap-3">
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
              <Label htmlFor="edit-fund-currency">Base currency</Label>
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger id="edit-fund-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
  sourceIdsByName,
  initialFundId,
  open,
  onOpenChange,
  onCreated,
}: {
  funds: Fund[];
  sourceIdsByName: Map<string, string>;
  initialFundId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (fundId: string) => Promise<void>;
}) {
  const fundVehicleViewEnabled = useFeatureEnabled('FUND_VEHICLE_VIEW_ENABLED');
  const fundId = initialFundId ?? funds[0]?.id ?? '';
  const [tp, setTp] = useState<HoldingType>('Direct Investments');
  const [values, setValues] = useState<Record<string, string>>({});
  const [assetCurrency, setAssetCurrency] = useState<Currency>('USD');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveTp: HoldingType = tp;

  useEffect(() => {
    if (open) {
      setTp('Direct Investments');
      setValues({});
      setAssetCurrency('USD');
      setError(null);
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
      const payload = buildAssetCreatePayload(effectiveTp, values);
      const fundingSourceId = payload.input.fundingSource
        ? sourceIdsByName.get(payload.input.fundingSource as string) || null
        : null;

      if (effectiveTp === 'Fund of funds' && fundVehicleViewEnabled) {
        const newFund = await fundLedgerApi.createFund({
          name: (payload.input.assetName as string) || 'New target fund',
          english_name: (payload.input.englishName as string) || null,
          legal_name: (payload.input.legalName as string) || null,
          managed: false,
          ownership_basis: 'units',
          base_currency: assetCurrency,
        });
        const pos = await fundLedgerApi.openPosition({
          holder_fund_id: fundId,
          fund_id: newFund.id,
          holder_source_of_fund_id: fundingSourceId,
          opened_at: payload.txnDate || toLocalISODate(new Date()),
        });
        if (payload.investedM != null && payload.investedM > 0) {
          const entry = txnToLedgerEntryInput(
            {
              date: payload.txnDate || toLocalISODate(new Date()),
              type: 'Buy',
              value: payload.investedM,
              ppsCurrency: assetCurrency,
              fundingSourceId,
            },
            pos.id,
            { isFoF: true },
          );
          await fundLedgerApi.postEvent({
            event_date: payload.txnDate || toLocalISODate(new Date()),
            description: 'Initial investment',
            entries: [entry],
          });
        }
        if (payload.navM != null) {
          await fundLedgerApi.recordValuation({
            fund_id: newFund.id,
            as_of_date: payload.txnDate || toLocalISODate(new Date()),
            market_value: String(fromM(payload.navM)),
            currency: assetCurrency,
          });
        }
      } else {
        const assetKind: AssetKind =
          effectiveTp === 'Cash'
            ? 'cash'
            : (payload.input.typeDetails as any)?.instrumentType === 'obligation'
              ? 'loan'
              : (payload.input.typeDetails as any)?.instrumentType === 'shares'
                ? 'listed_security'
                : 'equity';

        const newAsset = await fundLedgerApi.createAsset({
          name: (payload.input.assetName as string) || 'New asset',
          english_name: (payload.input.englishName as string) || null,
          asset_kind: assetKind,
          country: (payload.input.country as string) || null,
          sector: (payload.input.sector as string) || null,
          instrument_terms: {
            ...((payload.input.typeDetails as any) || {}),
            ...(effectiveTp === 'Fund of funds' ? { investmentTypeLabel: 'Fund of Funds' } : {}),
          },
          description: (payload.input.investmentDescription as string) || null,
        });
        const pos = await fundLedgerApi.openPosition({
          holder_fund_id: fundId,
          asset_id: newAsset.id,
          holder_source_of_fund_id: fundingSourceId,
          opened_at: payload.txnDate || toLocalISODate(new Date()),
        });
        if (payload.investedM != null && payload.investedM > 0) {
          const entry = txnToLedgerEntryInput(
            {
              date: payload.txnDate || toLocalISODate(new Date()),
              type: 'Buy',
              value: payload.investedM,
              ppsCurrency: assetCurrency,
              fundingSourceId,
            },
            pos.id,
            { isFoF: effectiveTp === 'Fund of funds' },
          );
          await fundLedgerApi.postEvent({
            event_date: payload.txnDate || toLocalISODate(new Date()),
            description: 'Initial investment',
            entries: [entry],
          });
        }
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

export default function FundManagement() {
  const { toast } = useToast();
  const [_funds, setFunds] = useState<Fund[] | null>(null);
  const [_displayFunds, setDisplayFunds] = useState<Fund[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [investorRows, setInvestorRows] = useState<InvestorRow[]>([]);
  const [stakeRows, setStakeRows] = useState<StakeRow[]>([]);
  const [fundSourceRows, setFundSourceRows] = useState<FundSourceRow[]>([]);
  const [portfolioReadModel, setPortfolioReadModel] = useState<FlPortfolioReadModel | null>(null);
  const verificationSummary = useMemo(() => {
    if (!portfolioReadModel) return { entries: 0, valuations: 0 };
    return {
      entries: portfolioReadModel.entries.filter((entry) => entry.data_status === 'needs_verification').length,
      valuations: portfolioReadModel.valuations.filter((valuation) => valuation.data_status === 'needs_verification').length,
    };
  }, [portfolioReadModel]);

  const funds = useMemo(() => {
    if (!_funds) return null;
    return _funds.map((f) => {
      let totalStakesM = 0;
      stakeRows.forEach((s) => {
        if (s.fund_id === f.id && s.commitment_amount) {
          totalStakesM += s.commitment_amount / 1_000_000;
        }
      });
      return { ...f, size: Math.max(f.size, totalStakesM) };
    });
  }, [_funds, stakeRows]);

  const displayFunds = useMemo(() => {
    if (!funds || !_displayFunds) return null;
    const fundMap = new Map(funds.map((f) => [f.id, f]));
    return _displayFunds.map((df) => fundMap.get(df.id) ?? df);
  }, [funds, _displayFunds]);

  const [tab, setTab] = useState<PortfolioTab>('asset');
  // Empty means the live portfolio; a selected date is propagated all the way
  // to the ledger read model so balances and marks are truly as-of.
  const [asOfDate, setAsOfDate] = useState('');
  const fundVehicleViewEnabled = useFeatureEnabled('FUND_VEHICLE_VIEW_ENABLED');
  const sourceOfFundsEnabled = useFeatureEnabled('SOURCE_OF_FUNDS_ENABLED');
  const portfolioTabs = useMemo(
    () =>
      PORTFOLIO_TABS.filter((t) => {
        if (!fundVehicleViewEnabled && t.k === 'fund') return false;
        if (!sourceOfFundsEnabled && t.k === 'source') return false;
        return true;
      }),
    [fundVehicleViewEnabled, sourceOfFundsEnabled],
  );
  const activeTab: PortfolioTab =
    (!fundVehicleViewEnabled && tab === 'fund') || (!sourceOfFundsEnabled && tab === 'source')
      ? 'asset'
      : tab;
  useEffect(() => {
    if (tab !== activeTab) {
      setTab(activeTab);
    }
  }, [tab, activeTab]);
  const [addFundOpen, setAddFundOpen] = useState(false);
  const [addAssetOpen, setAddAssetOpen] = useState(false);
  const [addAssetFundId, setAddAssetFundId] = useState<string | null>(null);
  const [addEntityOpen, setAddEntityOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [editSource, setEditSource] = useState<{ id: string; name: string } | null>(null);
  const [editStakesFor, setEditStakesFor] = useState<{ investorId: string; fundId?: string | null } | null>(null);
  const [commitmentNonce, setCommitmentNonce] = useState(0);
  const [editFund, setEditFund] = useState<Fund | null>(null);
  const [editInvestor, setEditInvestor] = useState<Investor | null>(null);
  const [moveInvestor, setMoveInvestor] = useState<Investor | null>(null);

  const [, setRev] = useState(0);
  const [analyzingAiOpinionIds, setAnalyzingAiOpinionIds] = useState<Set<string>>(new Set());

  const reloadAll = useCallback(async () => {
    try {
      const readModel = await fundLedgerApi.getPortfolio(asOfDate || undefined);
      const builtFunds = readModel.managed_funds
        .filter((f) => f.status !== 'liquidated')
        .map((f) =>
          buildFundFromPortfolio(
            f,
            readModel.positions,
            readModel.entries,
            readModel.valuations,
            asOfDate || undefined,
            readModel.fund_cash_summaries?.[f.id],
          ),
        );
      setFunds(builtFunds);

      // Liquidated funds: fl_funds.status = 'liquidated'
      const liquidatedFundRows = readModel.funds.filter((f) => f.status === 'liquidated');
      const liquidatedFundIds = new Set(liquidatedFundRows.map((f) => f.id));

      // External funds: fl_funds.managed = false (prefer liquidated_fund if also liquidated)
      const externalFunds = readModel.external_funds
        .filter((f) => !liquidatedFundIds.has(f.id))
        .map((f) =>
          buildFundFromPortfolio(
            f,
            readModel.positions,
            readModel.entries,
            readModel.valuations,
            asOfDate || undefined,
            readModel.fund_cash_summaries?.[f.id],
            'external_fund',
          ),
        );

      const liquidatedFunds = liquidatedFundRows.map((f) =>
        buildFundFromPortfolio(
          f,
          readModel.positions,
          readModel.entries,
          readModel.valuations,
          asOfDate || undefined,
          readModel.fund_cash_summaries?.[f.id],
          'liquidated_fund',
        ),
      );

      const orphanFund = buildOrphanAssetFund(readModel.assets, readModel.positions);

      const seenFundIds = new Set<string>();
      const rawDisplayFunds: Fund[] = [];

      for (const f of builtFunds) {
        if (!seenFundIds.has(f.id)) {
          seenFundIds.add(f.id);
          rawDisplayFunds.push(f);
        }
      }
      for (const f of externalFunds) {
        if (!seenFundIds.has(f.id)) {
          seenFundIds.add(f.id);
          rawDisplayFunds.push(f);
        }
      }
      for (const f of liquidatedFunds) {
        if (!seenFundIds.has(f.id)) {
          seenFundIds.add(f.id);
          rawDisplayFunds.push(f);
        }
      }
      if (orphanFund && !seenFundIds.has(orphanFund.id)) {
        seenFundIds.add(orphanFund.id);
        rawDisplayFunds.push(orphanFund);
      }

      setDisplayFunds(rawDisplayFunds);
      setPortfolioReadModel(readModel);
      setInvestorRows(readModel.investors);
      setFundSourceRows(readModel.funding_sources);

      const stakes: StakeRow[] = readModel.positions
        .filter((p) => p.holder_investor_id != null && p.fund_id != null)
        .map((p) => ({
          id: p.id,
          fund_id: p.fund_id!,
          holding_entity_id: p.holder_investor_id!,
          commitment_amount: Number(p.balance?.commitment ?? 0),
          invested_amount: Number(p.balance?.drawn_commitment ?? 0),
          distributed_amount: Number(p.balance?.distributed_capital ?? 0),
          entity_type: p.holder_investor?.investor_type ?? 'individual',
        }));
      setStakeRows(stakes);
      setCommitmentNonce((n) => n + 1);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load funds');
    }
  }, [asOfDate]);

  const handleAnalyzeAiOpinion = useCallback(
    async (holding: Holding) => {
      if (!holding.id || analyzingAiOpinionIds.has(holding.id)) return;
      setAnalyzingAiOpinionIds((prev) => new Set(prev).add(holding.id));
      try {
        await fundLedgerApi.triggerAiOpinion(holding.id);
        toast({
          title: 'AI analysis started',
          description: `Evaluating "${holding.n}".`,
        });
      } catch (err) {
        toast({
          title: 'Analysis failed',
          description: err instanceof Error ? err.message : `Failed to evaluate "${holding.n}".`,
          variant: 'destructive',
        });
      } finally {
        await reloadAll().catch(() => {});
        setAnalyzingAiOpinionIds((prev) => {
          const next = new Set(prev);
          next.delete(holding.id);
          return next;
        });
      }
    },
    [analyzingAiOpinionIds, reloadAll, toast],
  );

  const deleteInvestor = useCallback(
    async (investorId: string) => {
      await executeDeleteInvestor(investorId, { reloadAll, toast });
    },
    [reloadAll, toast],
  );

  const deleteSource = useCallback(
    async (sourceId: string) => {
      await executeDeleteFundingSource(sourceId, { reloadAll, toast });
    },
    [reloadAll, toast],
  );

  const editSourceName = useCallback(
    async (sourceId: string, name: string) => {
      try {
        await fundLedgerApi.updateFundingSource(sourceId, { name });
        await reloadAll();
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
    [reloadAll, toast],
  );

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  const reloadOne = useCallback(async () => {
    await reloadAll();
  }, [reloadAll]);

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

  const sourceIdsByName = useMemo(
    () => new Map(fundSourceRows.map((r) => [r.name, r.id] as const)),
    [fundSourceRows],
  );

  const entityNameById = useMemo(
    () => new Map(investorRows.map((r) => [r.id, r.name] as const)),
    [investorRows],
  );
  const sourceNameById = useMemo(
    () => new Map(fundSourceRows.map((r) => [r.id, r.name] as const)),
    [fundSourceRows],
  );

  const entitylessHoldingNames = useMemo(() => {
    const set = new Set<string>();
    (funds ?? []).forEach((f) =>
      f.h.forEach((h) => {
        if (!getAssetEntity(h) && h.n) set.add(h.n);
      }),
    );
    return [...set];
  }, [funds]);

  const comboboxEntityOptions = useMemo(
    () => [...new Set([...entityOptions, ...entitylessHoldingNames])].sort((a, b) => a.localeCompare(b)),
    [entityOptions, entitylessHoldingNames],
  );

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
        const updatePromise =
          (holding.targetKind === 'fund' || (holding.targetKind == null && holding.tp === 'Fund of funds'))
            ? fundLedgerApi.updateFund(holding.id, {
                name: holding.n,
                english_name: holding.englishName || null,
                legal_name: holding.inv?.legalName || null,
                description: holding.inv?.description || null,
                mgmt_fee_rate: holding.inv?.mgmtFeeRate != null ? String(holding.inv.mgmtFeeRate / 100) : null,
                carry_rate: holding.inv?.carryRate != null ? String(holding.inv.carryRate / 100) : null,
                preferred_return_rate: holding.inv?.prefReturnRate != null ? String(holding.inv.prefReturnRate / 100) : null,
                fund_life_years: holding.d?.fundLifeYears ?? null,
              })
            : fundLedgerApi.updateAsset(holding.id, {
                name: holding.n,
                english_name: holding.englishName || null,
                legal_name: holding.inv?.legalName || null,
                country: holding.d?.geo || null,
                sector: holding.d?.sector || null,
                sub_sector: holding.d?.subSector || null,
                description: holding.inv?.description || null,
                instrument_terms: {
                  ...((holding.d as Record<string, unknown>) ?? {}),
                  dealType: holding.d?.dealType ?? null,
                  investmentTypeLabel: getAssetInvestType(holding),
                  entryEV: holding.d?.entryEV ?? null,
                  holdYrs: holding.d?.holdYrs ?? null,
                  revenue: holding.d?.revenue ?? null,
                  ebitda: holding.d?.ebitda ?? null,
                  noteType: holding.d?.noteType ?? null,
                  issuer: holding.d?.issuer ?? null,
                  coupon: holding.d?.coupon ?? null,
                  principal: holding.d?.principal ?? null,
                  exchange: holding.d?.exchange ?? null,
                  ticker: holding.d?.ticker ?? null,
                  sharesOutstanding: holding.d?.sharesK ?? null,
                  marketCapUsdBn: holding.d?.marketCapB ?? null,
                  pricePerShare: holding.d?.pricePerShare ?? null,
                  shareClass: holding.d?.shareClass ?? null,
                  investingEntity: holding.inv?.entity ?? null,
                  reportDate: holding.inv?.reportDate ?? holding.d?.reportDate ?? null,
                  prefReturnRatePct: holding.inv?.prefReturnRate ?? holding.d?.prefReturnRatePct ?? null,
                  keyRights: holding.inv?.keyRights ?? holding.d?.keyRights ?? null,
                  businessUpdates: holding.inv?.businessUpdates ?? holding.d?.businessUpdates ?? null,
                },
              });

        updatePromise
          .then(() => reloadOne())
          .catch((err) => {
            console.error('Failed to save asset', err);
            toast({
              title: 'Failed to save',
              description: err instanceof Error ? err.message : 'Your change was not saved.',
              variant: 'destructive',
            });
            reloadOne().catch((reloadErr) => console.error('Failed to reload fund', reloadErr));
          });
      },
      refreshHolding: () => {
        reloadOne();
      },
      refreshAll: reloadAll,
      deleteFund: async (fund: Fund) => {
        try {
          await fundLedgerApi.updateFund(fund.id, { status: 'liquidated' });
          await reloadAll();
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
        await executeDeleteAsset(fund, holding, { reloadAll, toast });
      },
      funds: funds ?? [],
      investorOptions: comboboxEntityOptions,
      sourceOptions,
      entityNameById,
      sourceNameById,
      sourceIdsByName,
      sourceOfFundsEnabled,
      analyzeAiOpinion: handleAnalyzeAiOpinion,
      analyzingAiOpinionIds,
    }),
    [
      reloadOne,
      reloadAll,
      toast,
      funds,
      comboboxEntityOptions,
      sourceOptions,
      entityNameById,
      sourceNameById,
      sourceIdsByName,
      sourceOfFundsEnabled,
      handleAnalyzeAiOpinion,
      analyzingAiOpinionIds,
    ],
  );

  const investorById = useMemo(() => {
    const map = new Map<string, Tables<'fl_investors'>>();
    for (const inv of investorRows) {
      map.set(inv.id, inv);
    }
    return map;
  }, [investorRows]);

  const tabInvestors = useMemo<Investor[]>(() => {
    const entityInvestors = filterEntityInvestors(investorRows);
    return entityInvestors.map((row) => {
      const stakes: Record<string, number> = {};
      const invested: Record<string, number> = {};
      const distributed: Record<string, number> = {};
      Object.values(stakeDetail[row.id] ?? {}).forEach((s) => {
        const committedM = (s.commitment_amount ?? 0) / 1_000_000;
        if (committedM > 0) stakes[s.fund_id] = committedM;
        invested[s.fund_id] = (s.invested_amount ?? 0) / 1_000_000;
        distributed[s.fund_id] = (s.distributed_amount ?? 0) / 1_000_000;
      });

      const parent = row.parent_investor_id ? investorById.get(row.parent_investor_id) : null;
      const entity = buildEntityFromPortfolio(
        row,
        portfolioReadModel?.positions ?? [],
        portfolioReadModel?.entries ?? [],
        portfolioReadModel?.valuations ?? [],
        asOfDate,
        parent ? { id: parent.id, name: parent.name } : null,
        portfolioReadModel?.funds,
      );

      return {
        ...entity,
        stakes,
        invested,
        distributed,
      };
    });
  }, [investorRows, stakeDetail, investorById, portfolioReadModel, asOfDate]);

  // A fund's LP list: its investors plus the managed funds that hold it through a
  // fund-held position (e.g. 月升星繁 in 淮安熙和). Fund-tab only — a managed fund is
  // not an entity in the Investor tab.
  const fundTabLps = useMemo<Investor[]>(() => {
    const fundLps = portfolioReadModel
      ? buildFundLpHolders(portfolioReadModel.positions, portfolioReadModel.funds)
      : [];
    return [...tabInvestors, ...fundLps];
  }, [tabInvestors, portfolioReadModel]);

  return (
    <>
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

            {(verificationSummary.entries > 0 || verificationSummary.valuations > 0) && (
              <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                This report includes {verificationSummary.entries} ledger entr{verificationSummary.entries === 1 ? 'y' : 'ies'} and {verificationSummary.valuations} valuation{verificationSummary.valuations === 1 ? '' : 's'} that need verification.
              </div>
            )}

            {(funds == null || displayFunds == null) && !loadError ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading funds…</p>
            ) : (
              <>
                <MetricCards funds={funds ?? []} investors={tabInvestors} />
                <MoneyBreakdown funds={funds ?? []} investors={tabInvestors} />

                <div className="overflow-hidden rounded-lg border bg-card">
                  <div className="flex flex-wrap items-center gap-2.5 border-b bg-muted/30 px-3 py-2.5">
                    <span className="text-xs font-medium text-foreground">Portfolio</span>
                    <div className="ml-auto flex flex-wrap items-center gap-2.5">
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        As of
                        <input
                          type="date"
                          value={asOfDate}
                          onChange={(event) => setAsOfDate(event.target.value)}
                          className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                          aria-label="Portfolio as-of date"
                        />
                      </label>
                      {asOfDate && (
                        <Button size="sm" variant="ghost" onClick={() => setAsOfDate('')}>
                          Current
                        </Button>
                      )}
                      {activeTab === 'fund' && (
                        <Button size="sm" variant="outline" onClick={() => setAddFundOpen(true)}>
                          + Add fund
                        </Button>
                      )}
                      {activeTab === 'asset' && ((displayFunds && displayFunds.length > 0) || tabInvestors.length > 0) && (
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
                      {activeTab === 'investor' && (
                        <Button size="sm" variant="outline" onClick={() => setAddEntityOpen(true)}>
                          + Add Investment Entity
                        </Button>
                      )}
                      {activeTab === 'source' && (
                        <Button size="sm" variant="outline" onClick={() => setAddSourceOpen(true)}>
                          + Add Source of Fund
                        </Button>
                      )}
                      <div className="inline-flex overflow-hidden rounded-full border bg-background">
                        {portfolioTabs.map(({ k, label }) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => setTab(k)}
                            className={cn(
                              'px-3.5 py-1 text-xs',
                              activeTab === k
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
                    {activeTab === 'asset' ? (
                      <AssetTable funds={displayFunds ?? []} investors={tabInvestors} />
                    ) : activeTab === 'fund' ? (
                      <FundSummaryTable
                        funds={(displayFunds ?? []).filter((f) => f.id !== 'unassigned' && f.disclosure !== 'no_holder')}
                        investors={fundTabLps}
                        onEditFund={(fund) => setEditFund(fund)}
                        positions={portfolioReadModel?.positions}
                        entries={portfolioReadModel?.entries}
                        asOfDate={asOfDate}
                      />
                    ) : activeTab === 'investor' ? (
                      <EntitySummaryTable
                        funds={funds ?? []}
                        investors={tabInvestors}
                        onEditStakes={(id, fundId) => setEditStakesFor({ investorId: id, fundId })}
                        onEditInvestor={(inv) => setEditInvestor(inv)}
                        onMoveInvestor={(inv) => setMoveInvestor(inv)}
                        onDeleteInvestor={deleteInvestor}
                        commitmentNonce={commitmentNonce}
                        positions={portfolioReadModel?.positions}
                        entries={portfolioReadModel?.entries}
                        asOfDate={asOfDate}
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
        sourceIdsByName={sourceIdsByName}
        initialFundId={addAssetFundId}
        open={addAssetOpen}
        onOpenChange={setAddAssetOpen}
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
      <AddEntityDialog
        open={addEntityOpen}
        onOpenChange={setAddEntityOpen}
        onCreated={reloadAll}
      />
      <EditInvestorDialog
        investor={editInvestor}
        open={editInvestor != null}
        onOpenChange={(o) => !o && setEditInvestor(null)}
        onSaved={reloadAll}
      />
      <MoveInvestorDialog
        investor={moveInvestor}
        investorRows={investorRows}
        open={moveInvestor != null}
        onOpenChange={(o) => !o && setMoveInvestor(null)}
        onSaved={reloadAll}
      />
      <NameDialog
        title="Add Source of Fund"
        label="Source of Fund Name"
        open={addSourceOpen}
        onOpenChange={setAddSourceOpen}
        onSubmit={async (name) => {
          await fundLedgerApi.createFundingSource({ name });
          await reloadAll();
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
      <CommitmentLedgerDialog
        open={editStakesFor != null}
        onOpenChange={(o) => !o && setEditStakesFor(null)}
        investorId={editStakesFor?.investorId ?? null}
        investorName={investorRows.find((r) => r.id === editStakesFor?.investorId)?.name ?? ''}
        funds={funds ?? []}
        allInvestors={investorRows}
        initialFundId={editStakesFor?.fundId}
        onSaved={reloadAll}
      />
    </>
  );
}

function AddEntityDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [englishName, setEnglishName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError('Entity name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await fundLedgerApi.createInvestor({
        name: name.trim(),
        english_name: englishName.trim() || null,
        investor_type: 'institution',
      });
      await onCreated();
      onOpenChange(false);
      setName('');
      setEnglishName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create entity');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Investment Entity</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="entity-name">Investment Entity Name</Label>
            <Input id="entity-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="entity-english-name">English Name (optional)</Label>
            <Input id="entity-english-name" value={englishName} onChange={(e) => setEnglishName(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create entity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditInvestorDialog({
  investor,
  open,
  onOpenChange,
  onSaved,
}: {
  investor: Investor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [englishName, setEnglishName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && investor) {
      setName(investor.n);
      setEnglishName(investor.englishName ?? '');
      setError(null);
    }
  }, [open, investor]);

  const submit = async () => {
    if (!investor) return;
    if (!name.trim()) {
      setError('Entity name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await fundLedgerApi.updateInvestor(investor.id, {
        name: name.trim(),
        english_name: englishName.trim() || null,
      });
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save entity');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Investment Entity{investor ? ` · ${investor.n}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-entity-name">Investment Entity Name</Label>
            <Input id="edit-entity-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-entity-english-name">English Name (optional)</Label>
            <Input id="edit-entity-english-name" value={englishName} onChange={(e) => setEnglishName(e.target.value)} />
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

function MoveInvestorDialog({
  investor,
  investorRows,
  open,
  onOpenChange,
  onSaved,
}: {
  investor: Investor | null;
  investorRows: Tables<'fl_investors'>[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [newGroupName, setNewGroupName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group investors are investors that are some investor's parent_investor_id
  const groupInvestorIds = useMemo(() => {
    const ids = new Set<string>();
    for (const inv of investorRows) {
      if (inv.parent_investor_id) ids.add(inv.parent_investor_id);
    }
    return ids;
  }, [investorRows]);

  // Exclude the entity itself and all its descendants to prevent cycles
  const descendantIds = useMemo(() => {
    if (!investor) return new Set<string>();
    const desc = new Set<string>([investor.id]);
    let added = true;
    while (added) {
      added = false;
      for (const inv of investorRows) {
        if (inv.parent_investor_id && desc.has(inv.parent_investor_id) && !desc.has(inv.id)) {
          desc.add(inv.id);
          added = true;
        }
      }
    }
    return desc;
  }, [investor, investorRows]);

  const targetGroupInvestors = useMemo(() => {
    return investorRows.filter(
      (inv) => groupInvestorIds.has(inv.id) && !descendantIds.has(inv.id),
    );
  }, [investorRows, groupInvestorIds, descendantIds]);

  const options = useMemo(() => {
    const ids = targetGroupInvestors.map((g) => g.id);
    if (newGroupName && !ids.includes('__new__')) {
      ids.push('__new__');
    }
    return ids;
  }, [targetGroupInvestors, newGroupName]);

  const groupNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const inv of investorRows) {
      map.set(inv.id, inv.name);
    }
    return map;
  }, [investorRows]);

  useEffect(() => {
    if (open && investor) {
      setSelectedGroupId(investor.groupId ?? '');
      setNewGroupName(null);
      setError(null);
    }
  }, [open, investor]);

  const labelFor = (id: string) => {
    if (id === '__new__') return newGroupName ? `${newGroupName} (new group)` : '(new group)';
    return groupNameById.get(id) ?? id;
  };

  const handleCreateGroup = (typedName: string) => {
    setNewGroupName(typedName);
    setSelectedGroupId('__new__');
  };

  const submit = async () => {
    if (!investor) return;
    if (!selectedGroupId) {
      setError('Please select or create a group');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let targetParentId = selectedGroupId;
      if (selectedGroupId === '__new__' && newGroupName) {
        const created = await fundLedgerApi.createInvestor({
          name: newGroupName.trim(),
          investor_type: 'internal_entity',
        });
        targetParentId = created.id;
      }
      await fundLedgerApi.updateInvestor(investor.id, {
        parent_investor_id: targetParentId,
      });
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move entity');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move Investment Entity{investor ? ` · ${investor.n}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="move-group-select">Group</Label>
            <Combobox
              id="move-group-select"
              value={selectedGroupId}
              options={options}
              onChange={(val) => {
                setSelectedGroupId(val);
                if (val !== '__new__') {
                  setNewGroupName(null);
                }
              }}
              labelFor={labelFor}
              placeholder="Select a group…"
              onCreate={handleCreateGroup}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Moving…' : 'Move to group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
