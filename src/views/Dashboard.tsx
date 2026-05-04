'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getCompanies } from '@/lib/api/pipeline';
import { getCompanyOverride } from '@/lib/companyOverrides';
import {
  Building2,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  ArrowUpRight,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Database,
  Layers,
  Target,
  Activity,
} from 'lucide-react';
import CompanyDetailDialog from '@/components/pipeline/CompanyDetailDialog';

interface CompanyData {
  id: string;
  target: string | null;
  project_name?: string | null;
  segment: string | null;
  watchlist_status: string | null;
  source: string | null;
  pipeline_stage: string | null;
  revenue_2021_usd_mn: number | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  revenue_2025_usd_mn: number | null;
  ebitda_2021_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  ebitda_2025_usd_mn: number | null;
  ev_2024: number | null;
  l1_screening_result: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
  ownership: string | null;
  geography: string | null;
}

interface StageCounts {
  stage: string;
  label: string;
  count: number;
  inbound?: number;
  outbound?: number;
}

const PIPELINE_STAGES: { stage: string; label: string; color: string }[] = [
  { stage: 'L0', label: 'Sourcing', color: 'bg-blue-500' },
  { stage: 'L1', label: 'Screening', color: 'bg-purple-500' },
  { stage: 'L2', label: 'Initial Review', color: 'bg-amber-500' },
  { stage: 'L3', label: 'Due Diligence', color: 'bg-green-500' },
  { stage: 'L4', label: 'Negotiation', color: 'bg-teal-500' },
  { stage: 'L5', label: 'Closing', color: 'bg-pink-500' },
];

// Softer stage gradients (sqemnabrain style)
const stageGradients: Record<string, string> = {
  L0: 'from-blue-400/80 to-blue-500/80',
  L1: 'from-violet-400/80 to-purple-500/80',
  L2: 'from-amber-400/80 to-orange-500/80',
  L3: 'from-emerald-400/80 to-green-500/80',
  L4: 'from-cyan-400/80 to-teal-500/80',
  L5: 'from-pink-400/80 to-rose-500/80',
};

// Bar colors for inbound (lighter) / outbound (darker) per stage
const stageBarColors: Record<string, { inbound: string; outbound: string }> = {
  L0: { inbound: 'bg-blue-400/70', outbound: 'bg-blue-600/70' },
  L1: { inbound: 'bg-violet-400/70', outbound: 'bg-violet-600/70' },
  L2: { inbound: 'bg-amber-400/70', outbound: 'bg-amber-600/70' },
  L3: { inbound: 'bg-emerald-400/70', outbound: 'bg-emerald-600/70' },
  L4: { inbound: 'bg-cyan-400/70', outbound: 'bg-cyan-600/70' },
  L5: { inbound: 'bg-pink-400/70', outbound: 'bg-pink-600/70' },
};

const statusColors: Record<string, string> = {
  pass: 'bg-green-500',
  fail: 'bg-red-500',
  pending: 'bg-yellow-500',
  default: 'bg-gray-500',
};

const getStatusColor = (status: string | null): string => {
  if (!status) return statusColors.default;
  const lower = status.toLowerCase();
  return statusColors[lower] || statusColors.default;
};

// Values in database are in USD Millions, so format accordingly
const formatCurrency = (value: number | null): string => {
  if (value === null || value === undefined) return '-';
  // Values are stored in millions
  if (Math.abs(value) >= 1000) {
    const billions = value / 1000;
    return `$${billions.toFixed(2)}B`;
  }
  return `$${value.toFixed(2)}M`;
};

const getRevenueChange = (year2023: number | null, year2024: number | null): { direction: 'up' | 'down' | 'flat'; percent: number } => {
  if (!year2023 || !year2024) return { direction: 'flat', percent: 0 };
  const change = ((year2024 - year2023) / year2023) * 100;
  if (change > 1) return { direction: 'up', percent: change };
  if (change < -1) return { direction: 'down', percent: Math.abs(change) };
  return { direction: 'flat', percent: 0 };
};


interface DashboardProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}

export default function Dashboard({ showCrm = false, showAiWorkforce = false }: DashboardProps) {
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState<CompanyData[]>([]);
  const [totalCompanies, setTotalCompanies] = useState(0);
  const [stageCounts, setStageCounts] = useState<StageCounts[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const itemsPerPage = 10;

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async (opts: { silent?: boolean } = {}) => {
    try {
      // Fetch all companies
      const companiesData = await getCompanies({
        orderBy: 'updated_at',
        orderDir: 'desc',
      });

      if (companiesData) {
        setCompanies(companiesData.map((company: any) => {
          const override = getCompanyOverride(company.id);
          return {
            ...company,
            revenue_2025_usd_mn: override?.revenue_2025_usd_mn ?? company.revenue_2025_usd_mn,
            ebitda_2025_usd_mn: override?.ebitda_2025_usd_mn ?? company.ebitda_2025_usd_mn,
          };
        }));
        setTotalCompanies(companiesData.length);

        // Calculate pipeline stage counts
        const stageMap = new Map<string, { count: number; inbound: number; outbound: number }>();
        
        // Initialize all stages
        PIPELINE_STAGES.forEach(({ stage }) => {
          stageMap.set(stage, { count: 0, inbound: 0, outbound: 0 });
        });
        
        companiesData.forEach((company) => {
          const stage = company.pipeline_stage || 'L0';
          const current = stageMap.get(stage) || { count: 0, inbound: 0, outbound: 0 };
          current.count += 1;

          // Track inbound vs outbound for every stage (source column; fallback to watchlist_status)
          const src = company.source?.toLowerCase();
          const fromSource = src === 'inbound' || src === 'outbound';
          if (fromSource) {
            if (src === 'inbound') current.inbound += 1;
            else current.outbound += 1;
          } else {
            const status = company.watchlist_status?.toLowerCase() || '';
            if (status.includes('inbound') || status === 'active') {
              current.inbound += 1;
            } else {
              current.outbound += 1;
            }
          }

          stageMap.set(stage, current);
        });
        
        const counts: StageCounts[] = PIPELINE_STAGES.map(({ stage, label }) => {
          const data = stageMap.get(stage) || { count: 0, inbound: 0, outbound: 0 };
          return {
            stage,
            label,
            count: data.count,
            inbound: data.inbound,
            outbound: data.outbound,
          };
        });
        
        setStageCounts(counts);
      }
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      if (!opts.silent) setLoading(false);
    }
  };

  // Pagination logic
  const totalPages = Math.ceil(companies.length / itemsPerPage);
  const paginatedCompanies = companies.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Get recent companies (last 5 updated)
  const recentCompanies = companies.slice(0, 5);

  const totalInbound = stageCounts.reduce((s, x) => s + (x.inbound || 0), 0);
  const totalOutbound = stageCounts.reduce((s, x) => s + (x.outbound || 0), 0);
  const l0Count = stageCounts[0]?.count || 1;
  const l5Count = stageCounts[5]?.count ?? stageCounts.find(s => s.stage === 'L5')?.count ?? 0;
  const conversionPercent = l0Count > 0 ? Math.round((l5Count / l0Count) * 100) : 0;

  if (loading) {
    return (
      <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground text-sm">Loading dashboard...</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <div className="p-6 lg:p-8 space-y-8 animate-fade-in">
          {/* Header - clean professional style */}
          <div className="relative">
            <div className="flex items-center gap-3 mb-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/10">
                <Layers className="h-5 w-5 text-foreground" />
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Dashboard
              </h1>
            </div>
            <p className="text-muted-foreground ml-[52px]">
              Real-time overview of your M&A deal pipeline
            </p>
          </div>

          {/* Stat cards - soft colored accents */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="border bg-card">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
                    <Target className="h-4 w-4 text-blue-500" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">Total Deals</p>
                </div>
                <p className="text-3xl font-semibold">{totalCompanies}</p>
                <p className="text-xs text-muted-foreground mt-1">Active in pipeline</p>
              </CardContent>
            </Card>
            <Card className="border bg-card">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10">
                    <ArrowUpRight className="h-4 w-4 text-emerald-500" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">Inbound</p>
                </div>
                <p className="text-3xl font-semibold">{totalInbound}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {totalCompanies > 0 ? Math.round((totalInbound / totalCompanies) * 100) : 0}% of total
                </p>
              </CardContent>
            </Card>
            <Card className="border bg-card">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10">
                    <Activity className="h-4 w-4 text-violet-500" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">Outbound</p>
                </div>
                <p className="text-3xl font-semibold">{totalOutbound}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {totalCompanies > 0 ? Math.round((totalOutbound / totalCompanies) * 100) : 0}% of total
                </p>
              </CardContent>
            </Card>
            <Card className="border bg-card">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10">
                    <TrendingUp className="h-4 w-4 text-amber-500" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">Conversion</p>
                </div>
                <p className="text-3xl font-semibold">{conversionPercent}%</p>
                <p className="text-xs text-muted-foreground mt-1">L0 → L5</p>
              </CardContent>
            </Card>
          </div>

          {/* Pipeline Stages */}
          <Card className="border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-3 text-lg font-semibold">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                  <TrendingUp className="h-4 w-4 text-primary" />
                </div>
                Pipeline Stages
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {totalCompanies === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Building2 className="mx-auto h-12 w-12 mb-4 opacity-40" />
                  <p className="text-base font-medium">No companies in database yet.</p>
                  <p className="text-sm">Import or add companies to see pipeline stages</p>
                </div>
              ) : (
                <div className="flex items-end gap-4 justify-between" style={{ height: '300px' }}>
                  {stageCounts.map((item, index) => {
                    const maxCount = Math.max(...stageCounts.map(s => s.count), 1);
                    const l0 = stageCounts[0]?.count || 1;
                    const conversionPercentStage = l0 > 0 ? Math.round((item.count / l0) * 100) : 0;
                    const barMaxHeight = 200;
                    const minBarHeight = 80; // fits two segments with label + number (min 40px each)
                    const barHeight = Math.max((item.count / maxCount) * barMaxHeight, minBarHeight);
                    const colors = stageBarColors[item.stage] || { inbound: 'bg-gray-400/70', outbound: 'bg-gray-600/70' };
                    const inboundRatio = item.count > 0 ? (item.inbound || 0) / item.count : 0.5;
                    const outboundRatio = item.count > 0 ? (item.outbound || 0) / item.count : 0.5;
                    const segmentMinPx = 40;
                    const remainingHeight = Math.max(0, barHeight - 2 * segmentMinPx);
                    const inboundHeightPx = segmentMinPx + inboundRatio * remainingHeight;
                    const outboundHeightPx = segmentMinPx + outboundRatio * remainingHeight;
                    return (
                      <Link
                        key={item.stage}
                        href={`/pipeline?stage=${item.stage}`}
                        className="flex-1 flex flex-col items-center cursor-pointer group no-underline text-inherit"
                      >
                        <span className="text-xl font-semibold mb-2 transition-transform group-hover:scale-110">{item.count}</span>
                        <Badge variant="secondary" className="mb-4 text-xs bg-muted/80 backdrop-blur-sm">
                          {conversionPercentStage}%
                        </Badge>
                        <div
                          className="w-full rounded-xl overflow-hidden flex flex-col transition-all duration-200 group-hover:scale-[1.02]"
                          style={{ height: `${barHeight}px` }}
                        >
                          <div
                            className={`w-full ${colors.inbound} flex items-center justify-center shrink-0`}
                            style={{ height: `${inboundHeightPx}px`, minHeight: segmentMinPx }}
                          >
                            <div className="text-white text-xs font-medium text-center px-1">
                              <div className="opacity-80 text-[10px] uppercase tracking-wide">Inbound</div>
                              <div className="font-semibold text-sm">{item.inbound || 0}</div>
                            </div>
                          </div>
                          <div
                            className={`w-full ${colors.outbound} flex items-center justify-center shrink-0`}
                            style={{ height: `${outboundHeightPx}px`, minHeight: segmentMinPx }}
                          >
                            <div className="text-white text-xs font-medium text-center px-1">
                              <div className="opacity-80 text-[10px] uppercase tracking-wide">Outbound</div>
                              <div className="font-semibold text-sm">{item.outbound || 0}</div>
                            </div>
                          </div>
                        </div>
                        <div className="text-center mt-4">
                          <div className="text-base font-bold">{item.stage}</div>
                          <div className="text-xs text-muted-foreground">{item.label}</div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Two Column Layout: Company Overview + Recent Activity */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Company Overview Table */}
            <Card className="lg:col-span-2 border bg-card">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-3 text-lg font-semibold">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
                    <Database className="h-4 w-4 text-emerald-500" />
                  </div>
                  Company Overview
                </CardTitle>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/master-data" className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    View All <ArrowUpRight className="h-4 w-4" />
                  </Link>
                </Button>
              </CardHeader>
              <CardContent>
                {companies.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Building2 className="mx-auto h-12 w-12 mb-4 opacity-40" />
                    <p className="text-base font-medium">No companies yet</p>
                    <p className="text-sm">Import data to get started</p>
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto rounded-xl border border-border/50">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableHead className="font-semibold">Company</TableHead>
                            <TableHead className="font-semibold">Project</TableHead>
                            <TableHead className="font-semibold">Status</TableHead>
                            <TableHead className="font-semibold">Source</TableHead>
                            <TableHead className="text-right font-semibold">Rev 2022</TableHead>
                            <TableHead className="text-right font-semibold">Rev 2023</TableHead>
                            <TableHead className="text-right font-semibold">Rev 2024</TableHead>
                            <TableHead className="text-right font-semibold">Rev 2025</TableHead>
                            <TableHead className="text-center font-semibold">Trend</TableHead>
                            <TableHead className="text-right font-semibold">EBITDA 2024</TableHead>
                            <TableHead className="text-right font-semibold">EBITDA 2025</TableHead>
                            <TableHead className="text-right font-semibold">EV 2024</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {paginatedCompanies.map((company) => {
                            const revenueChange = getRevenueChange(company.revenue_2024_usd_mn, company.revenue_2025_usd_mn);
                            return (
                              <TableRow key={company.id} className="hover:bg-muted/50 transition-colors">
                                <TableCell>
                                  <div>
                                    <button
                                      onClick={() => {
                                        setSelectedCompany(company);
                                        setDetailDialogOpen(true);
                                      }}
                                      className="font-semibold text-left hover:text-primary transition-colors"
                                    >
                                      {company.target || '—'}
                                    </button>
                                    <p className="text-xs text-muted-foreground">{company.segment || '-'}</p>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  {company.project_name ? (
                                    <button
                                      onClick={() => {
                                        setSelectedCompany(company);
                                        setDetailDialogOpen(true);
                                      }}
                                      className="text-sm font-semibold text-left hover:text-primary transition-colors"
                                    >
                                      {company.project_name}
                                    </button>
                                  ) : (
                                    <span className="text-sm text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {company.l1_screening_result ? (
                                    <Badge className={`${getStatusColor(company.l1_screening_result)} text-white text-xs border-0`}>
                                      {company.l1_screening_result}
                                    </Badge>
                                  ) : (
                                    <Badge variant="secondary" className="text-xs">
                                      Pending
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {company.source ? (
                                    <Badge
                                      variant="secondary"
                                      className={`text-xs border-0 ${
                                        company.source.toLowerCase() === 'inbound'
                                          ? 'bg-emerald-500/15 text-emerald-600'
                                          : 'bg-violet-500/15 text-violet-600'
                                      }`}
                                    >
                                      {company.source}
                                    </Badge>
                                  ) : (
                                    <span className="text-muted-foreground text-sm">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-semibold">
                                  {formatCurrency(company.revenue_2022_usd_mn)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-semibold">
                                  {formatCurrency(company.revenue_2023_usd_mn)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-semibold">
                                  {formatCurrency(company.revenue_2024_usd_mn)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-semibold">
                                  {formatCurrency(company.revenue_2025_usd_mn)}
                                </TableCell>
                                <TableCell className="text-center">
                                  {revenueChange.direction === 'up' && (
                                    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-emerald-500/10">
                                      <TrendingUp className="h-4 w-4 text-emerald-500" />
                                    </span>
                                  )}
                                  {revenueChange.direction === 'down' && (
                                    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-red-500/10">
                                      <TrendingDown className="h-4 w-4 text-red-500" />
                                    </span>
                                  )}
                                  {revenueChange.direction === 'flat' && (
                                    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-muted">
                                      <Minus className="h-4 w-4 text-muted-foreground" />
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-medium">
                                  {formatCurrency(company.ebitda_2024_usd_mn)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-medium">
                                  {formatCurrency(company.ebitda_2025_usd_mn)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-medium">
                                  {formatCurrency(company.ev_2024)}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                    {totalPages > 1 && (
                      <div className="flex items-center justify-between mt-4 pt-4 border-t border-border/50">
                        <p className="text-sm text-muted-foreground">
                          Page <span className="font-semibold">{currentPage}</span> of <span className="font-semibold">{totalPages}</span>
                          <span className="ml-2 text-muted-foreground/60">({companies.length} companies)</span>
                        </p>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={currentPage === 1}
                            className="h-9 w-9 p-0"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={currentPage === totalPages}
                            className="h-9 w-9 p-0"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {selectedCompany && (
                  <CompanyDetailDialog
                    company={selectedCompany}
                    open={detailDialogOpen}
                    onOpenChange={setDetailDialogOpen}
                    onUpdate={() => fetchDashboardData({ silent: true })}
                  />
                )}
              </CardContent>
            </Card>

            {/* Recent Activity */}
            <Card className="border bg-card">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-3 text-lg font-semibold">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10">
                    <Clock className="h-4 w-4 text-cyan-500" />
                  </div>
                  Recent Updates
                </CardTitle>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/master-data" className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    View All <ArrowUpRight className="h-4 w-4" />
                  </Link>
                </Button>
              </CardHeader>
              <CardContent>
                {recentCompanies.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Building2 className="mx-auto h-12 w-12 mb-4 opacity-40" />
                    <p className="text-base font-medium">No companies yet</p>
                    <p className="text-sm">Import data to get started</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {recentCompanies.map((company) => (
                      <div
                        key={company.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${getStatusColor(company.l1_screening_result)}`} />
                          <div>
                            <p className="font-medium text-sm">{[company.target, company.project_name].filter(Boolean).join(' — ') || 'Unknown'}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(company.updated_at).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        {company.l1_screening_result ? (
                          <Badge className={`${getStatusColor(company.l1_screening_result)} text-white text-xs border-0`}>
                            {company.l1_screening_result}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            Pending
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
      </div>
    </DashboardLayout>
  );
}
