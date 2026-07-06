'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  getDashboardInsights,
  getInsightsSettings,
  updateInsightsSettings,
} from '@/lib/api/dashboard';
import type {
  BreakdownRow,
  DashboardInsights,
  FunnelStage,
  InsightsSettings,
  InsightsSettingsMeta,
  InsightsSettingsWithMeta,
} from '@/lib/services/dashboardInsightsService';
import { useChatContext } from '@/components/chat/ChatProvider';
import { AskAIButton } from '@/components/chat/AskAIButton';
import CompanyDetailDialog, {
  type CompanyData,
} from '@/components/pipeline/CompanyDetailDialog';
import { getCompanies } from '@/lib/api/pipeline';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/table';
import {
  useColumnLayout,
  ColumnManagerProvider,
  ManagedTableHeader,
  ManagedRowCells,
  ColumnConfigGear,
  type ColumnDef,
} from '@/components/table';
import { countryToAlpha2 } from 'country-to-iso';
import {
  Loader2,
  TrendingUp,
  Clock,
  Users,
  Sparkles,
  LayoutGrid,
  Globe,
  BarChart3,
  Settings,
  UserCheck,
} from 'lucide-react';

interface InsightsModuleProps {
  from: Date;
  to: Date;
}

function formatRange(from: Date, to: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(from)} – ${fmt(to)}`;
}

/** "Last updated by Jane Doe · Jun 23, 2026", or null when never edited. */
function formatUpdatedBy(meta: InsightsSettingsMeta): string | null {
  if (!meta.updatedBy && !meta.updatedAt) return null;
  const who = meta.updatedBy?.name || meta.updatedBy?.email || 'someone';
  const when = meta.updatedAt
    ? new Date(meta.updatedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  return `Last updated by ${who}${when ? ` · ${when}` : ''}`;
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

/** Conversion-rate color band, mirroring the source design's g/w/r scale. */
function convClass(pct: number, hasBase: boolean): string {
  if (!hasBase) return 'text-muted-foreground font-medium';
  if (pct <= 0) return 'text-red-600 dark:text-red-400 font-semibold';
  if (pct < 10) return 'text-amber-600 dark:text-amber-400 font-semibold';
  return 'text-emerald-600 dark:text-emerald-400 font-semibold';
}

/** Solid fill colors for each funnel bar, L0 (top) → L5 (bottom). */
const FUNNEL_BAR_COLORS: Record<string, string> = {
  L0: 'bg-blue-500/80',
  L1: 'bg-emerald-500/80',
  L2: 'bg-lime-500/80',
  L3: 'bg-amber-400/90',
  L4: 'bg-orange-400/90',
  L5: 'bg-orange-500/90',
};

/** Deterministic avatar tint per banker, keyed off the name's first char. */
const AVATAR_TINTS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
];

function avatarTint(name: string): string {
  const code = name.charCodeAt(0) || 0;
  return AVATAR_TINTS[code % AVATAR_TINTS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Banker / banker_source names hidden from the Banker source quality card.
 * Frontend-only display filter (the backend still counts them). Matched
 * case-insensitively as a substring, so "Sinarmas" also hides "Sinarmas
 * Sekuritas". */
const EXCLUDED_BANKER_SOURCES = ['Starcapital', 'Sinarmas', 'Jien Lit'];

function isExcludedBankerSource(key: string): boolean {
  const k = key.toLowerCase();
  return EXCLUDED_BANKER_SOURCES.some((name) => k.includes(name.toLowerCase()));
}

// `geography` is stored as a free-text country name, so to render a flag we
// resolve the name to its ISO 3166-1 alpha-2 code (via `country-to-iso`, which
// tolerates inconsistent inputs like "South Korea" / "USA") and derive the emoji
// from that code — rather than hardcoding a flag emoji per country.

/** Convert an ISO 3166-1 alpha-2 code (e.g. "JP") into its flag emoji by mapping
 * each letter to its Unicode regional indicator symbol. */
function alpha2ToFlag(code: string): string {
  const cc = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
  const BASE = 0x1f1e6; // regional indicator symbol 'A'
  return String.fromCodePoint(
    BASE + (cc.charCodeAt(0) - 65),
    BASE + (cc.charCodeAt(1) - 65),
  );
}

/** Disambiguation for ambiguous names `country-to-iso` can't resolve on its own
 * (bare "Korea" is KR vs KP). Kept intentionally minimal — extend only for names
 * the library genuinely can't handle. */
const COUNTRY_ALIASES: Record<string, string> = {
  korea: 'South Korea',
};

/** Flag emoji for a geography value: resolves the country name (or raw code) to
 * an ISO 3166-1 alpha-2 code, then derives the emoji. Globe fallback for values
 * with no country (e.g. regions like "Asia Pacific") or unrecognised input. */
function countryFlag(value: string): string {
  const normalised = COUNTRY_ALIASES[value.trim().toLowerCase()] ?? value;
  const code = countryToAlpha2(normalised);
  return code ? alpha2ToFlag(code) : '🌐';
}

// ─── Module ───────────────────────────────────────────────────────────────────

export default function InsightsModule({ from, to }: InsightsModuleProps) {
  const [data, setData] = useState<DashboardInsights | null>(null);
  const [settings, setSettings] = useState<InsightsSettingsWithMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const { analyzeWithAI } = useChatContext();

  // Send a copilot prompt scoped to the active period; AskAIButton then surfaces
  // the copilot pane (or navigates to /chat on mobile).
  const askAI = useCallback(
    (topic: string) => {
      analyzeWithAI(
        `For the Insights dashboard period (${formatRange(from, to)}), ${topic}`,
      );
    },
    [analyzeWithAI, from, to],
  );

  const fetchInsights = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [insights, currentSettings] = await Promise.all([
        getDashboardInsights({ from, to }),
        getInsightsSettings(),
      ]);
      setData(insights);
      setSettings(currentSettings);
    } catch (err) {
      console.error('Error fetching insights:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  // Persist settings, then refresh so the funnel/conversion reflect the new
  // targets immediately (the server bakes them into the insights response).
  const saveSettings = useCallback(
    async (next: InsightsSettings) => {
      const saved = await updateInsightsSettings(next);
      setSettings(saved);
      const insights = await getDashboardInsights({ from, to });
      setData(insights);
    },
    [from, to],
  );

  // Desktop-only, matching the rest of the dashboard sections. Everything lives
  // inside a single wrapping card (like the Overview card); the inner panels are
  // nested cards.
  return (
    <Card className="hidden md:block border bg-gradient-to-br from-muted/40 to-muted/10">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg font-semibold">Insights</CardTitle>
          <span className="text-sm text-muted-foreground">{formatRange(from, to)}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Pipeline health · Origination quality · AI throughput
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error || !data || !settings ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Could not load insights.
          </div>
        ) : (
          <InsightsContent
            data={data}
            settings={settings}
            onAsk={askAI}
            onSaveSettings={saveSettings}
            onRefresh={fetchInsights}
          />
        )}
      </CardContent>
    </Card>
  );
}

function InsightsContent({
  data,
  settings,
  onAsk,
  onSaveSettings,
  onRefresh,
}: {
  data: DashboardInsights;
  settings: InsightsSettingsWithMeta;
  onAsk: (topic: string) => void;
  onSaveSettings: (next: InsightsSettings) => Promise<void>;
  /** Refetch insights after a company edit made from the detail dialog. */
  onRefresh: () => void;
}) {
  const { kpis, funnel, staleDeals, staleThresholdLabel, bankers, segments, countries, aiThroughput } =
    data;

  const [targetModalOpen, setTargetModalOpen] = useState(false);
  const [conversionModalOpen, setConversionModalOpen] = useState(false);
  const [staleModalOpen, setStaleModalOpen] = useState(false);

  // Company detail popup, opened by clicking a deal name (e.g. in the stale
  // list). Mirrors the main Dashboard's handleCompanyClick — the Insights module
  // is desktop-only, so there's no mobile full-screen fallback to handle.
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(null);
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false);

  const openCompany = useCallback(async (id: string) => {
    try {
      const company = await getCompanies({ id });
      if (company) {
        setSelectedCompany(company as CompanyData);
        setCompanyDialogOpen(true);
      }
    } catch (err) {
      console.error('Failed to load company details', err);
    }
  }, []);

  return (
    <div className="space-y-3">
      {/* ── KPI row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <KpiCard
          label="L0 → L1 conversion"
          value={`${kpis.l0l1Conversion}%`}
          sub={kpis.l0l1TargetLabel}
          tone={kpis.l0l1OnTarget ? 'green' : 'amber'}
          onAsk={() => onAsk('analyze the L0 to L1 conversion rate and how to improve it')}
          askLabel="Analyze L0→L1 conversion with AI"
          onConfigure={() => setConversionModalOpen(true)}
          configureLabel="Configure conversion target"
        />
        <KpiCard
          label="Deals stale in stage"
          value={kpis.staleCount}
          sub="need attention"
          tone={kpis.staleCount > 0 ? 'red' : 'muted'}
          onAsk={() => onAsk('analyze the deals that are stale in their stage and what is blocking them')}
          askLabel="Analyze stale deals with AI"
        />
      </div>

      {/* ── Row 1: Funnel + Stale ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="border bg-card">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <TrendingUp className="h-4 w-4 text-muted-foreground" /> Funnel vs. target
              </CardTitle>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setTargetModalOpen(true)}
                  aria-label="Edit stage targets"
                  title="Edit stage targets"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
                <AskAIButton
                  label="Analyze funnel vs. target with AI"
                  onClick={() => onAsk('analyze the pipeline funnel against stage targets')}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {funnel.map((stage) => {
              const target = stage.target;
              // Bar shows progress toward the stage target (capped at 100%).
              // Stages with no target fill fully once they have any deals.
              const targetPct =
                target > 0
                  ? Math.min(100, (stage.count / target) * 100)
                  : stage.count > 0
                    ? 100
                    : 0;
              const barWidth = stage.count > 0 ? Math.max(6, targetPct) : 0;
              return (
                <div key={stage.stage} className="flex items-center gap-3">
                  <span className="w-6 shrink-0 font-mono text-xs font-semibold text-muted-foreground">
                    {stage.stage}
                  </span>
                  <div className="flex-1 h-5 rounded bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded ${FUNNEL_BAR_COLORS[stage.stage] ?? 'bg-primary/70'} transition-[width] duration-500`}
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                  <div className="w-20 shrink-0 text-right">
                    <div
                      className={`font-mono text-sm font-semibold ${
                        stage.count >= target
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : stage.count === 0
                            ? 'text-muted-foreground'
                            : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {stage.count}
                    </div>
                    <div className="text-[10px] text-muted-foreground">target {target}</div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <TargetSettingsModal
          open={targetModalOpen}
          onOpenChange={setTargetModalOpen}
          stages={funnel}
          current={settings.funnelTargets}
          meta={settings.meta}
          onSave={(funnelTargets) =>
            onSaveSettings({ ...settings, funnelTargets })
          }
        />

        <ConversionSettingsModal
          open={conversionModalOpen}
          onOpenChange={setConversionModalOpen}
          current={settings.l0l1Conversion}
          meta={settings.meta}
          onSave={(l0l1Conversion) =>
            onSaveSettings({ ...settings, l0l1Conversion })
          }
        />

        <StaleThresholdsModal
          open={staleModalOpen}
          onOpenChange={setStaleModalOpen}
          current={settings.staleThresholds}
          meta={settings.meta}
          onSave={(staleThresholds) =>
            onSaveSettings({ ...settings, staleThresholds })
          }
        />

        <Card className="border bg-card">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="h-4 w-4 text-muted-foreground" /> Deals stale in stage
              </CardTitle>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setStaleModalOpen(true)}
                  aria-label="Edit stale thresholds"
                  title="Edit stale thresholds"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
                <AskAIButton
                  label="Analyze stale deals with AI"
                  onClick={() => onAsk('analyze the deals stale in their stage and how to unblock them')}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Standard time per stage · {staleThresholdLabel}
            </p>
          </CardHeader>
          <CardContent>
            {staleDeals.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No stale deals — everything is moving.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {staleDeals.map((deal) => (
                  <div key={deal.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openCompany(deal.id)}
                          title={`Open ${deal.name}`}
                          className="min-w-0 truncate text-left text-[13px] font-medium text-foreground transition-colors hover:text-primary hover:underline"
                        >
                          {deal.name}
                        </button>
                        {deal.leadName && (
                          <span
                            title={`${deal.leadLabel}: ${deal.leadName}${deal.leadFromTrack ? ' (from Track)' : ''}`}
                            className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                          >
                            <UserCheck className="h-3 w-3" />
                            <span className="max-w-[10rem] truncate">
                              {deal.leadName}
                              {deal.leadFromTrack && (
                                <span className="text-muted-foreground/70"> (from Track)</span>
                              )}
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{deal.reason}</div>
                    </div>
                    <span className="shrink-0 rounded border bg-muted px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                      {deal.stage}
                    </span>
                    <span
                      className={`shrink-0 font-mono text-[13px] font-semibold ${
                        deal.severity === 'red'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {deal.days} days
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Row 2: Banker quality + AI throughput ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="border bg-card">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4 text-muted-foreground" /> Banker source quality
              </CardTitle>
              <AskAIButton
                label="Analyze banker source quality with AI"
                onClick={() => onAsk('analyze banker source quality and conversion by banker')}
              />
            </div>
          </CardHeader>
          <CardContent>
            <BreakdownTable
              tableId="dashboard-insights-bankers"
              rows={bankers.filter((r) => !isExcludedBankerSource(r.key))}
              firstHeader="Banker"
              leadHeader="Leads"
              leadValue={(r) => r.total}
              convBase={(r) => r.total}
              renderKey={(r) => (
                <div className="flex items-center gap-2.5">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9.5px] font-bold ${avatarTint(r.key)}`}
                  >
                    {initials(r.key)}
                  </span>
                  <span className="truncate text-[13px] font-medium">{r.key}</span>
                </div>
              )}
              emptyLabel="No banker-sourced deals."
            />
          </CardContent>
        </Card>

        <Card className="border bg-card">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-muted-foreground" /> AI screening &amp; deck throughput
              </CardTitle>
              <AskAIButton
                label="Analyze AI throughput with AI"
                onClick={() => onAsk('analyze AI screening and deck-generation throughput')}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <ThroughputHero label="Companies screened (L0)" value={aiThroughput.screenedL0} unit="companies" />
              <ThroughputHero
                label="Company cards generated"
                value={aiThroughput.companyCards.total}
                unit="cards"
              />
              <ThroughputHero label="Company decks generated" value={aiThroughput.decksGenerated} unit="decks" />
            </div>
            <div className="divide-y divide-border">
              <MetaRow
                label="Company cards (completed / failed)"
                value={`${aiThroughput.companyCards.completed} done · ${aiThroughput.companyCards.failed} failed`}
                tone={aiThroughput.companyCards.failed > 0 ? 'amber' : undefined}
              />
              <MetaRow
                label={`AI opinions given (${aiThroughput.aiOpinions.total})`}
                value={`${aiThroughput.aiOpinions.pass} pass · ${aiThroughput.aiOpinions.fail} fail · ${aiThroughput.aiOpinions.tentative} tentative`}
              />
              <MetaRow
                label={`AI screenings done (${aiThroughput.screenings.total})`}
                value={`${aiThroughput.screenings.pass} pass · ${aiThroughput.screenings.fail} fail · ${aiThroughput.screenings.inconclusive} inc · ${aiThroughput.screenings.error} err`}
                tone={aiThroughput.screenings.error > 0 ? 'amber' : undefined}
              />
              <MetaRow
                label="Companies screened by AI"
                value={`${aiThroughput.screenings.companiesScreened} companies`}
              />
              <MetaRow label="AI Workforce runs" value={`${aiThroughput.workforceRuns} runs`} />
              <MetaRow
                label="HITL interventions resolved"
                value={`${aiThroughput.hitlResolved} of ${aiThroughput.hitlResolved + aiThroughput.hitlPending}`}
              />
              <MetaRow
                label="Pending interventions"
                value={`${aiThroughput.hitlPending} waiting`}
                tone={aiThroughput.hitlPending > 0 ? 'amber' : undefined}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Row 4: Segment + Country ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="border bg-card">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <LayoutGrid className="h-4 w-4 text-muted-foreground" /> Deals by industry segment
              </CardTitle>
              <AskAIButton
                label="Analyze deals by segment with AI"
                onClick={() => onAsk('analyze deal distribution and conversion by industry segment')}
              />
            </div>
          </CardHeader>
          <CardContent>
            <BreakdownTable
              tableId="dashboard-insights-segments"
              rows={segments}
              firstHeader="Segment"
              leadHeader="L0"
              leadValue={(r) => r.l0}
              convBase={(r) => r.l0}
              renderKey={(r) => <span className="text-[13px]">{r.key}</span>}
              emptyLabel="No segmented deals."
            />
          </CardContent>
        </Card>

        <Card className="border bg-card">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Globe className="h-4 w-4 text-muted-foreground" /> Deals by country
              </CardTitle>
              <AskAIButton
                label="Analyze deals by country with AI"
                onClick={() => onAsk('analyze deal distribution and conversion by country')}
              />
            </div>
          </CardHeader>
          <CardContent>
            <BreakdownTable
              tableId="dashboard-insights-countries"
              rows={countries}
              firstHeader="Country"
              leadHeader="L0"
              leadValue={(r) => r.l0}
              convBase={(r) => r.l0}
              renderKey={(r) => (
                <span className="flex items-center gap-2 text-[13px]">
                  <span className="text-base leading-none">{countryFlag(r.key)}</span>
                  {r.key}
                </span>
              )}
              emptyLabel="No country data."
            />
          </CardContent>
        </Card>
      </div>

      {selectedCompany && (
        <CompanyDetailDialog
          company={selectedCompany}
          open={companyDialogOpen}
          onOpenChange={setCompanyDialogOpen}
          onUpdate={onRefresh}
        />
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  tone,
  onAsk,
  askLabel,
  onConfigure,
  configureLabel,
}: {
  label: string;
  value: string | number;
  sub: string;
  tone: 'muted' | 'green' | 'amber' | 'red';
  onAsk: () => void;
  askLabel: string;
  /** When provided, renders a grey gear button beside the AI-analysis icon. */
  onConfigure?: () => void;
  configureLabel?: string;
}) {
  const subTone =
    tone === 'green'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'amber'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'red'
          ? 'text-red-600 dark:text-red-400'
          : 'text-muted-foreground';
  return (
    <Card className="border bg-card">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11.5px] text-muted-foreground">{label}</div>
          <div className="flex items-center gap-1">
            {onConfigure && (
              <button
                type="button"
                onClick={onConfigure}
                aria-label={configureLabel ?? 'Configure'}
                title={configureLabel ?? 'Configure'}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            )}
            <AskAIButton label={askLabel} onClick={onAsk} />
          </div>
        </div>
        <div className="mt-1.5 font-mono text-2xl font-semibold tracking-tight">{value}</div>
        <div className={`mt-1 text-[11px] font-medium ${subTone}`}>{sub}</div>
      </CardContent>
    </Card>
  );
}

function ThroughputHero({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1">
        <span className="font-mono text-2xl font-semibold tracking-tight">{value}</span>
        <span className="ml-1 text-[13px] text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

function MetaRow({ label, value, tone }: { label: string; value: string; tone?: 'amber' }) {
  return (
    <div className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`font-mono text-xs font-semibold ${
          tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function BreakdownTable({
  tableId,
  rows,
  firstHeader,
  leadHeader,
  leadValue,
  convBase,
  renderKey,
  emptyLabel,
}: {
  /** Unique, stable key for persisting this table's column layout. */
  tableId: string;
  rows: BreakdownRow[];
  firstHeader: string;
  leadHeader: string;
  leadValue: (r: BreakdownRow) => number;
  convBase: (r: BreakdownRow) => number;
  renderKey: (r: BreakdownRow) => React.ReactNode;
  emptyLabel: string;
}) {
  // Managed (reorderable / hideable / groupable) columns. The identity column
  // (`firstHeader` / `renderKey`) is pinned leading and rendered outside this
  // set; there is no trailing/actions column.
  const columns = useMemo<ColumnDef<BreakdownRow>[]>(
    () => [
      {
        id: 'leads',
        label: leadHeader,
        header: (
          <span className="whitespace-nowrap font-semibold">{leadHeader}</span>
        ),
        headerClassName:
          'h-auto px-0 pb-2 text-right align-bottom text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground',
        cellClassName:
          'p-0 py-2 text-right font-mono text-xs text-muted-foreground',
        cell: (r) => leadValue(r),
      },
      {
        id: 'l1plus',
        label: 'L1+',
        header: <span className="whitespace-nowrap font-semibold">L1+</span>,
        headerClassName:
          'h-auto px-0 pb-2 text-right align-bottom text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground',
        cellClassName:
          'p-0 py-2 text-right font-mono text-xs text-muted-foreground',
        cell: (r) => r.l1plus,
      },
      {
        id: 'conversion',
        label: 'Conv.',
        header: <span className="whitespace-nowrap font-semibold">Conv.</span>,
        headerClassName:
          'h-auto px-0 pb-2 text-right align-bottom text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground',
        cellClassName: (r) => {
          const hasBase = convBase(r) > 0;
          return `p-0 py-2 text-right font-mono text-xs ${convClass(r.conversion, hasBase)}`;
        },
        cell: (r) => {
          const hasBase = convBase(r) > 0;
          return hasBase ? `${r.conversion}%` : '—';
        },
      },
    ],
    [leadHeader, leadValue, convBase],
  );

  const mgr = useColumnLayout<BreakdownRow>(tableId, columns);

  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ColumnManagerProvider value={mgr}>
      <div className="flex items-center justify-end px-2 py-1.5">
        <ColumnConfigGear />
      </div>
      <Table className="border-collapse">
        <ManagedTableHeader
          rowClassName="border-b border-border text-[10.5px] uppercase tracking-wide text-muted-foreground hover:bg-transparent"
          leading={
            <TableHead
              key="identity"
              className="h-auto px-0 pb-2 text-left align-bottom text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {firstHeader}
            </TableHead>
          }
        />
        <TableBody>
          {rows.map((r, index) => (
            <TableRow
              key={r.key}
              className="border-b border-border last:border-0 hover:bg-transparent"
            >
              <TableCell className="p-0 py-2 pr-2">{renderKey(r)}</TableCell>
              <ManagedRowCells row={r} index={index} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ColumnManagerProvider>
  );
}

function TargetSettingsModal({
  open,
  onOpenChange,
  stages,
  current,
  meta,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stages: FunnelStage[];
  current: Record<string, number>;
  meta: InsightsSettingsMeta;
  onSave: (next: Record<string, number>) => Promise<void>;
}) {
  // Draft input values (strings) seeded from the current targets each time the
  // modal opens, so an abandoned edit doesn't persist.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(Object.fromEntries(stages.map((s) => [s.stage, String(current[s.stage] ?? '')])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSave = async () => {
    // Parse each field; fall back to the current value when blank/invalid so a
    // stray field can't zero out a target.
    const next: Record<string, number> = {};
    for (const s of stages) {
      const parsed = Number.parseInt(draft[s.stage] ?? '', 10);
      next[s.stage] = Number.isFinite(parsed) && parsed >= 0 ? parsed : current[s.stage] ?? 0;
    }
    setSaving(true);
    try {
      await onSave(next);
      onOpenChange(false);
    } catch (err) {
      console.error('Failed to save targets:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Set stage targets</DialogTitle>
          <DialogDescription>
            Target number of companies per pipeline stage.
          </DialogDescription>
        </DialogHeader>

        {formatUpdatedBy(meta) && (
          <p className="text-xs text-muted-foreground">{formatUpdatedBy(meta)}</p>
        )}

        <div className="grid grid-cols-2 gap-3 py-1">
          {stages.map((s) => (
            <div key={s.stage} className="space-y-1">
              <Label htmlFor={`target-${s.stage}`} className="text-xs text-muted-foreground">
                {s.stage}
              </Label>
              <Input
                id={`target-${s.stage}`}
                type="number"
                min={0}
                inputMode="numeric"
                value={draft[s.stage] ?? ''}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, [s.stage]: e.target.value }))
                }
              />
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConversionSettingsModal({
  open,
  onOpenChange,
  current,
  meta,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: { min: number; max: number };
  meta: InsightsSettingsMeta;
  onSave: (next: { min: number; max: number }) => Promise<void>;
}) {
  const [minDraft, setMinDraft] = useState('');
  const [maxDraft, setMaxDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMinDraft(String(current.min));
      setMaxDraft(String(current.max));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSave = async () => {
    const parse = (s: string, fallback: number) => {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
    };
    const min = parse(minDraft, current.min);
    const max = parse(maxDraft, current.max);
    setSaving(true);
    try {
      // Server also normalises, but order the band here so the UI never flashes
      // an inverted range.
      await onSave({ min: Math.min(min, max), max: Math.max(min, max) });
      onOpenChange(false);
    } catch (err) {
      console.error('Failed to save conversion target:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>L0 → L1 conversion target</DialogTitle>
          <DialogDescription>
            Healthy conversion band (%). Conversion at or above the minimum counts as on-target.
          </DialogDescription>
        </DialogHeader>

        {formatUpdatedBy(meta) && (
          <p className="text-xs text-muted-foreground">{formatUpdatedBy(meta)}</p>
        )}

        <div className="grid grid-cols-2 gap-3 py-1">
          <div className="space-y-1">
            <Label htmlFor="conv-min" className="text-xs text-muted-foreground">
              Min %
            </Label>
            <Input
              id="conv-min"
              type="number"
              min={0}
              max={100}
              inputMode="numeric"
              value={minDraft}
              onChange={(e) => setMinDraft(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="conv-max" className="text-xs text-muted-foreground">
              Max %
            </Label>
            <Input
              id="conv-max"
              type="number"
              min={0}
              max={100}
              inputMode="numeric"
              value={maxDraft}
              onChange={(e) => setMaxDraft(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** SLA-tracked stages a deal can be flagged stale in, in display order. Kept in
 * sync with `STALE_STAGES` in the service (duplicated to avoid pulling the
 * server module's runtime imports into this client bundle). */
const STALE_THRESHOLD_STAGES = ['L0', 'L1', 'L2', 'L3'] as const;

function StaleThresholdsModal({
  open,
  onOpenChange,
  current,
  meta,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: Record<string, number>;
  meta: InsightsSettingsMeta;
  onSave: (next: Record<string, number>) => Promise<void>;
}) {
  // Draft input values (strings) seeded from the current thresholds each time
  // the modal opens, so an abandoned edit doesn't persist.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(
        Object.fromEntries(
          STALE_THRESHOLD_STAGES.map((s) => [s, String(current[s] ?? '')]),
        ),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSave = async () => {
    // Parse each field; fall back to the current value when blank/invalid so a
    // stray field can't zero out a threshold.
    const next: Record<string, number> = {};
    for (const stage of STALE_THRESHOLD_STAGES) {
      const parsed = Number.parseInt(draft[stage] ?? '', 10);
      next[stage] = Number.isFinite(parsed) && parsed >= 0 ? parsed : current[stage] ?? 0;
    }
    setSaving(true);
    try {
      await onSave(next);
      onOpenChange(false);
    } catch (err) {
      console.error('Failed to save stale thresholds:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Stale-in-stage thresholds</DialogTitle>
          <DialogDescription>
            Days a deal may sit in each stage before it&apos;s flagged stale.
          </DialogDescription>
        </DialogHeader>

        {formatUpdatedBy(meta) && (
          <p className="text-xs text-muted-foreground">{formatUpdatedBy(meta)}</p>
        )}

        <div className="grid grid-cols-2 gap-3 py-1">
          {STALE_THRESHOLD_STAGES.map((stage) => (
            <div key={stage} className="space-y-1">
              <Label htmlFor={`stale-${stage}`} className="text-xs text-muted-foreground">
                {stage} (days)
              </Label>
              <Input
                id={`stale-${stage}`}
                type="number"
                min={0}
                inputMode="numeric"
                value={draft[stage] ?? ''}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, [stage]: e.target.value }))
                }
              />
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
