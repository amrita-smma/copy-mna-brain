'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DollarSign, TrendingUp, Pencil, Plus, Trash2, Check, X, Loader2 } from 'lucide-react';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine } from 'recharts';
import { toast } from 'sonner';
import type { Tables } from '@/lib/repositories';
import { updateCompanyFinancials, type FinancialEditRow } from '@/lib/api/pipeline';

type FinancialRow = Pick<Tables<'company_financials'>, 'fiscal_year' | 'revenue_usd_mn' | 'ebitda_usd_mn'>;

interface FinancialChartsProps {
  financials: FinancialRow[];
  rawFinancials?: FinancialRow[];
  companyId?: string;
  onUpdate?: () => void;
}

type EditField = 'none' | 'revenue' | 'ebitda';

interface DraftRow {
  fiscal_year: number;
  value: string;
  markedForDelete: boolean;
}

const formatCurrency = (value: number | null) => {
  if (value === null || value === undefined) return '-';
  if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(2)}B`;
  }
  return `$${value.toFixed(2)}M`;
};

const colClass = (n: number) => {
  if (n <= 1) return 'grid-cols-1';
  if (n === 2) return 'grid-cols-2';
  if (n === 3) return 'grid-cols-3';
  return 'grid-cols-4';
};

function buildDraft(rows: FinancialRow[], field: EditField): DraftRow[] {
  const sorted = [...rows].sort((a, b) => a.fiscal_year - b.fiscal_year);
  return sorted.map((r) => ({
    fiscal_year: r.fiscal_year,
    value: field === 'revenue'
      ? (r.revenue_usd_mn != null ? String(r.revenue_usd_mn) : '')
      : (r.ebitda_usd_mn != null ? String(r.ebitda_usd_mn) : ''),
    markedForDelete: false,
  }));
}

function nextDefaultYear(draft: DraftRow[]): number {
  if (draft.length === 0) return new Date().getFullYear() - 1;
  const max = Math.max(...draft.map((d) => d.fiscal_year));
  return Math.min(max + 1, 2100);
}

export function FinancialCharts({
  financials,
  rawFinancials,
  companyId,
  onUpdate,
}: FinancialChartsProps) {
  const [mode, setMode] = useState<EditField>('none');
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newYear, setNewYear] = useState('');
  // Cached fresh data after a successful save — lets the chart auto-update
  // even before the parent's refetch lands a new `financials` prop.
  const [localRaw, setLocalRaw] = useState<FinancialRow[] | null>(null);

  // Drop the local cache only when the dialog is reused for a different company.
  const prevCompanyIdRef = useRef(companyId);
  useEffect(() => {
    if (companyId !== prevCompanyIdRef.current) {
      setLocalRaw(null);
      prevCompanyIdRef.current = companyId;
    }
  }, [companyId]);

  const effectiveDisplay = localRaw ?? financials;
  const effectiveRaw = localRaw ?? rawFinancials ?? financials;

  const sorted = [...effectiveDisplay].sort((a, b) => a.fiscal_year - b.fiscal_year);

  // Unified year axis: both charts always use the same set of years (display
  // years ∪ draft years in edit mode). This prevents a blink when the edit
  // mode's draft year set differs from the display year set — both modes
  // render the same bar count, only the values switch.
  const sortedByYear = new Map(sorted.map((s) => [s.fiscal_year, s]));
  const activeDraft = draft.filter((d) => !d.markedForDelete);
  const draftByYear = new Map(activeDraft.map((d) => [d.fiscal_year, d]));

  // If a year is marked-for-delete on the editing card AND the other metric
  // is also null, the row will be removed entirely on save — predict that
  // and drop the year from the axis now so the post-save state matches what
  // the user already sees.
  const willDeleteYear = (year: number): boolean => {
    if (mode === 'none') return false;
    const d = draft.find((dr) => dr.fiscal_year === year);
    if (!d?.markedForDelete) return false;
    const row = sortedByYear.get(year);
    if (!row) return true;
    const otherCol = mode === 'revenue' ? row.ebitda_usd_mn : row.revenue_usd_mn;
    return otherCol == null;
  };

  const yearAxis = Array.from(
    new Set<number>([
      ...sorted.map((s) => s.fiscal_year),
      ...activeDraft.map((d) => d.fiscal_year),
    ]),
  )
    .filter((y) => !willDeleteYear(y))
    .sort((a, b) => a - b);

  const valueFor = (year: number, metric: 'revenue' | 'ebitda'): number => {
    if (mode === metric) {
      const d = draftByYear.get(year);
      if (!d) return 0;
      if (d.value.trim() === '') return 0;
      const parsed = parseFloat(d.value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const row = sortedByYear.get(year);
    const v = metric === 'revenue' ? row?.revenue_usd_mn : row?.ebitda_usd_mn;
    return v ?? 0;
  };

  const revenueData = yearAxis.map((y) => ({ year: String(y), value: valueFor(y, 'revenue') }));
  const ebitdaData = yearAxis.map((y) => ({ year: String(y), value: valueFor(y, 'ebitda') }));

  const canEdit = Boolean(companyId && onUpdate);

  function enterEdit(field: EditField) {
    const source = effectiveRaw.length > 0 ? effectiveRaw : effectiveDisplay;
    setDraft(buildDraft(source, field));
    setMode(field);
  }

  function cancelEdit() {
    setDraft([]);
    setMode('none');
  }

  function updateDraftValue(idx: number, value: string) {
    setDraft((prev) => prev.map((d, i) => (i === idx ? { ...d, value } : d)));
  }

  function updateDraftYear(idx: number, year: string) {
    const n = parseInt(year, 10);
    setDraft((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, fiscal_year: isNaN(n) ? d.fiscal_year : n } : d)),
    );
  }

  function toggleDelete(idx: number) {
    setDraft((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, markedForDelete: !d.markedForDelete } : d)),
    );
  }

  function openAddYear() {
    setNewYear(String(nextDefaultYear(draft)));
    setAddOpen(true);
  }

  function confirmAddYear() {
    const y = parseInt(newYear, 10);
    if (!Number.isFinite(y) || y < 1990 || y > 2100) {
      toast.error('Enter a year between 1990 and 2100');
      return;
    }
    if (draft.some((d) => d.fiscal_year === y && !d.markedForDelete)) {
      toast.error(`Year ${y} already exists`);
      return;
    }
    setDraft((prev) =>
      [...prev, { fiscal_year: y, value: '', markedForDelete: false }].sort(
        (a, b) => a.fiscal_year - b.fiscal_year,
      ),
    );
    setAddOpen(false);
  }

  function validateDraft(): string | null {
    const active = draft.filter((d) => !d.markedForDelete);
    const years = active.map((d) => d.fiscal_year);
    const uniqueYears = new Set(years);
    if (uniqueYears.size !== years.length) return 'Duplicate years — each year must be unique.';
    for (const d of active) {
      if (d.fiscal_year < 1990 || d.fiscal_year > 2100) {
        return `Year ${d.fiscal_year} is out of range (1990–2100).`;
      }
      if (d.value !== '' && isNaN(parseFloat(d.value))) {
        return `Invalid value for ${d.fiscal_year}.`;
      }
    }
    return null;
  }

  async function save() {
    const err = validateDraft();
    if (err) {
      toast.error(err);
      return;
    }
    if (!companyId || mode === 'none') return;

    const col: 'revenue_usd_mn' | 'ebitda_usd_mn' =
      mode === 'revenue' ? 'revenue_usd_mn' : 'ebitda_usd_mn';
    const otherCol: 'revenue_usd_mn' | 'ebitda_usd_mn' =
      mode === 'revenue' ? 'ebitda_usd_mn' : 'revenue_usd_mn';

    const active = draft.filter((d) => !d.markedForDelete);
    const upsertRows: FinancialEditRow[] = active.map((d) => {
      const parsed = d.value === '' ? null : parseFloat(d.value);
      return { fiscal_year: d.fiscal_year, [col]: parsed } as FinancialEditRow;
    });

    // Smart delete: if the OTHER metric still has data for a removed year,
    // null only this metric. Only delete the row when both would be empty.
    const rawByYear = new Map(effectiveRaw.map((r) => [r.fiscal_year, r]));
    const nullRows: FinancialEditRow[] = [];
    const deletedYears: number[] = [];
    for (const d of draft.filter((d) => d.markedForDelete)) {
      const prev = rawByYear.get(d.fiscal_year);
      const otherHasData = prev?.[otherCol] != null;
      if (otherHasData) {
        nullRows.push({ fiscal_year: d.fiscal_year, [col]: null } as FinancialEditRow);
      } else {
        deletedYears.push(d.fiscal_year);
      }
    }

    setSaving(true);
    try {
      const response = await updateCompanyFinancials(companyId, {
        rows: [...upsertRows, ...nullRows],
        deletedYears,
      });
      // Use the API response (full updated CompanyDTO) so the chart reflects
      // saved values immediately, even before the parent refetch completes.
      if (response?.financials_raw && Array.isArray(response.financials_raw)) {
        setLocalRaw(response.financials_raw as FinancialRow[]);
      }
      toast.success(`${mode === 'revenue' ? 'Revenue' : 'EBITDA'} updated`);
      setMode('none');
      setDraft([]);
      onUpdate?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const renderEditPanel = () => (
    <div className="space-y-2 mt-3 pt-3 border-t">
      {draft.map((d, idx) => (
        <div key={idx} className={`flex items-center gap-2 ${d.markedForDelete ? 'opacity-40' : ''}`}>
          <Input
            type="number"
            min={1990}
            max={2100}
            value={d.fiscal_year}
            onChange={(e) => updateDraftYear(idx, e.target.value)}
            className="w-20 h-8 text-xs"
            disabled={d.markedForDelete || saving}
          />
          <Input
            type="number"
            inputMode="decimal"
            placeholder="value (M)"
            value={d.value}
            onChange={(e) => updateDraftValue(idx, e.target.value)}
            className="flex-1 h-8 text-xs"
            disabled={d.markedForDelete || saving}
          />
          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${d.markedForDelete ? 'text-muted-foreground' : 'text-destructive hover:text-destructive'}`}
            onClick={() => toggleDelete(idx)}
            disabled={saving}
            title={d.markedForDelete ? 'Undo remove' : 'Remove year'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Popover open={addOpen} onOpenChange={setAddOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs"
            onClick={openAddYear}
            disabled={saving}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add year
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-3" align="end">
          <div className="space-y-2">
            <p className="text-xs font-medium">Add year</p>
            <Input
              type="number"
              min={1990}
              max={2100}
              value={newYear}
              onChange={(e) => setNewYear(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmAddYear();
                }
              }}
              className="h-8 text-sm"
              autoFocus
            />
            <Button size="sm" className="w-full" onClick={confirmAddYear}>
              Add
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" className="h-8" onClick={cancelEdit} disabled={saving}>
          <X className="h-4 w-4 mr-1" />
          Cancel
        </Button>
        <Button size="sm" className="h-8" onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Check className="h-4 w-4 mr-1" />
          )}
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );

  const renderChart = (
    data: { year: string; value: number }[],
    color: string,
    label: string,
  ) => (
    <div className="h-[180px]">
      {data.length > 0 ? (
        <ChartContainer
          config={{ value: { label, color } }}
          className="h-full w-full"
        >
          <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
            <XAxis dataKey="year" className="text-xs" />
            <YAxis
              tickFormatter={(v) => formatCurrency(v)}
              className="text-xs"
              width={60}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
            <ChartTooltip
              content={
                <ChartTooltipContent formatter={(v) => formatCurrency(v as number)} />
              }
            />
            <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartContainer>
      ) : (
        <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
          No data yet
        </div>
      )}
    </div>
  );

  const renderBreakdown = (data: { year: string; value: number }[]) =>
    data.length > 0 && (
      <div className={`grid gap-2 mt-3 pt-3 border-t ${colClass(data.length)}`}>
        {data.map((item) => (
          <div key={item.year} className="text-center">
            <p className="text-xs text-muted-foreground">{item.year}</p>
            <p className="font-semibold text-sm">{formatCurrency(item.value)}</p>
          </div>
        ))}
      </div>
    );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Revenue Card */}
      <Card>
        <CardHeader className="flex pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Revenue
          </CardTitle>
          {canEdit && mode === 'none' && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => enterEdit('revenue')}
              aria-label="Edit Revenue"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {renderChart(revenueData, 'hsl(var(--primary))', 'Revenue')}
          {mode === 'revenue' ? renderEditPanel() : renderBreakdown(revenueData)}
        </CardContent>
      </Card>

      {/* EBITDA Card */}
      <Card>
        <CardHeader className="flex pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-success" />
            EBITDA
          </CardTitle>
          {canEdit && mode === 'none' && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => enterEdit('ebitda')}
              aria-label="Edit EBITDA"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {renderChart(ebitdaData, 'hsl(var(--success))', 'EBITDA')}
          {mode === 'ebitda' ? renderEditPanel() : renderBreakdown(ebitdaData)}
        </CardContent>
      </Card>
    </div>
  );
}
