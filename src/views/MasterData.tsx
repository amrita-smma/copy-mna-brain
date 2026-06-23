'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import DashboardLayout from '@/components/layout/DashboardLayout';
import CompanyDetailDialog, { type CompanyData } from '@/components/pipeline/CompanyDetailDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { deleteCompanyById, getCompanies, updateCompany } from '@/lib/api/pipeline';
import {
  Database,
  Search,
  Loader2,
  Building2,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Lightbulb,
  ArrowRight,
} from 'lucide-react';
import type { DealStage } from '@/lib/types';
import { SEARCH_SUGGESTION_CHIPS } from '@/lib/constants';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChatContext } from '@/components/chat/ChatProvider';
import { AskAIButton } from '@/components/chat/AskAIButton';
import { companyDisplayName } from '@/lib/companyDisplay';

interface CompanyWithDeal {
  id: string;
  name: string;
  project_name: string | null;
  sector: string;
  geo: string | null;
  source: string;
  revenue_2022: number | null;
  revenue_2023: number | null;
  revenue_2024: number | null;
  revenue_2025: number | null;
  ebitda_2022: number | null;
  ebitda_2023: number | null;
  ebitda_2024: number | null;
  ebitda_2025: number | null;
  valuation: number | null;
  pic: string | null;
  created_at: string;
  current_stage: DealStage | null;
  is_active: boolean;
  status: string | null;
}

const stageLabels: Record<DealStage | 'Acquired', string> = {
  market_screening: 'Market Screening',
  L0: 'Sourcing',
  L1: 'Screening',
  L2: 'Initial Review',
  L3: 'Due Diligence',
  L4: 'Negotiation',
  L5: 'Closing',
  discovered: 'Discovered',
  Acquired: 'Acquired',
};

const stageColors: Record<DealStage | 'Acquired', string> = {
  market_screening: 'bg-purple-500',
  L0: 'bg-stage-l0',
  L1: 'bg-stage-l1',
  L2: 'bg-stage-l2',
  L3: 'bg-stage-l3',
  L4: 'bg-stage-l4',
  L5: 'bg-stage-l5',
  discovered: 'bg-amber-500',
  Acquired: 'bg-green-600',
};

const formatCurrency = (value: number | null): string => {
  if (value === null || value === undefined) return '-';
  // Values are stored in millions
  if (Math.abs(value) >= 1000) {
    const billions = value / 1000;
    return `$${billions.toFixed(2)}B`;
  }
  return `$${value.toFixed(2)}M`;
};

// Normalize a raw company API row into the flat shape this view renders.
// Shared by the main pipeline fetch and the "discovered" section fetch.
const toCompanyWithDeal = (company: any): CompanyWithDeal => ({
  id: company.id,
  name: company.target || '',
  project_name: company.project_name ?? null,
  sector: company.segment || '',
  geo: company.geography || company.geo || null,
  source: company.source ?? '',
  revenue_2022: company.revenue_2022_usd_mn,
  revenue_2023: company.revenue_2023_usd_mn,
  revenue_2024: company.revenue_2024_usd_mn,
  revenue_2025: company.revenue_2025_usd_mn,
  ebitda_2022: company.ebitda_2022_usd_mn,
  ebitda_2023: company.ebitda_2023_usd_mn,
  ebitda_2024: company.ebitda_2024_usd_mn,
  ebitda_2025: company.ebitda_2025_usd_mn,
  valuation: company.ev_2024,
  pic:
    Array.isArray(company.assignees) && company.assignees.length > 0
      ? company.assignees
          .map((a: { name: string | null }) => a.name)
          .filter(Boolean)
          .join(', ')
      : (company.pic ?? null),
  created_at: company.created_at,
  current_stage: company.pipeline_stage as DealStage | null,
  is_active: company.pipeline_stage !== null && company.pipeline_stage !== 'Acquired',
  status: company.status ?? null,
});

const getRevenueChange = (year2: number | null, year3: number | null): { direction: 'up' | 'down' | 'flat'; percent: number } => {
  if (!year2 || !year3) return { direction: 'flat', percent: 0 };
  const change = ((year3 - year2) / year2) * 100;
  if (change > 1) return { direction: 'up', percent: change };
  if (change < -1) return { direction: 'down', percent: Math.abs(change) };
  return { direction: 'flat', percent: 0 };
};

interface MasterDataProps {
  showCompanyGraph?: boolean;
}

export default function MasterData({ showCompanyGraph = false }: MasterDataProps) {
  const [companies, setCompanies] = useState<CompanyWithDeal[]>([]);
  // Companies the relationship-graph tooling auto-created (stage "discovered").
  // They sit outside the L0–L5 pipeline, so they get their own section below.
  const [discoveredCompanies, setDiscoveredCompanies] = useState<CompanyWithDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [sectorFilter, setSectorFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [discoveredPage, setDiscoveredPage] = useState(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [addingToL0Id, setAddingToL0Id] = useState<string | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(null);
  const [loadingDialog, setLoadingDialog] = useState(false);
  const { toast } = useToast();
  const { analyzeWithAI } = useChatContext();
  const router = useRouter();
  const isMobile = useIsMobile();

  // On mobile, a company opens its own full-screen profile page (with a back
  // button to the Search list). On desktop it opens the detail dialog.
  const openCompany = (companyId: string) => {
    if (isMobile) {
      router.push(`/pipeline/${companyId}?from=/master-data`);
    } else {
      void openCompanyDialog(companyId);
    }
  };
  // Mobile shows companies as cards, paginated 5 at a time; desktop keeps the
  // dense table at 10 per page.
  const itemsPerPage = isMobile ? 5 : 10;

  const openCompanyDialog = async (companyId: string) => {
    setLoadingDialog(true);
    try {
      const data = await getCompanies({ id: companyId });
      if (!data) {
        toast({ title: 'Error', description: 'Could not load company', variant: 'destructive' });
        return;
      }

      setSelectedCompany({
        id: data.id,
        target: data.target,
        project_name: data.project_name,
        segment: data.segment,
        website: data.website ?? null,
        watchlist_status: data.watchlist_status,
        pipeline_stage: data.pipeline_stage,
        revenue_2021_usd_mn: data.revenue_2021_usd_mn,
        revenue_2022_usd_mn: data.revenue_2022_usd_mn,
        revenue_2023_usd_mn: data.revenue_2023_usd_mn,
        revenue_2024_usd_mn: data.revenue_2024_usd_mn,
        ebitda_2021_usd_mn: data.ebitda_2021_usd_mn,
        ebitda_2022_usd_mn: data.ebitda_2022_usd_mn,
        ebitda_2023_usd_mn: data.ebitda_2023_usd_mn,
        ebitda_2024_usd_mn: data.ebitda_2024_usd_mn,
        ev_2024: data.ev_2024,
        l1_screening_result: data.l1_screening_result,
        remarks: data.remarks,
        created_at: data.created_at,
        updated_at: data.updated_at,
        source: data.source ?? null,
        status: data.status ?? null,
        dropped_reason: data.dropped_reason ?? null,
        dropped_at: data.dropped_at ?? null,
        promoted_reasons: data.promoted_reasons ?? null,
        ownership: data.ownership ?? null,
        geography: data.geography ?? null,
        financials_raw: data.financials_raw,
      });
    } catch {
      toast({ title: 'Error', description: 'Could not load company', variant: 'destructive' });
    } finally {
      setLoadingDialog(false);
    }
  };

  useEffect(() => {
    fetchCompanies();
  }, []);

  useEffect(() => {
    setCurrentPage(1);
    setDiscoveredPage(1);
  }, [searchQuery, stageFilter, sectorFilter, sourceFilter, isMobile]);

  const fetchCompanies = async (opts: { silent?: boolean } = {}) => {
    try {
      const [data, discovered] = await Promise.all([
        getCompanies({
          stageIn: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
          orderBy: 'created_at',
          orderDir: 'desc',
        }),
        getCompanies({
          stageIn: ['discovered'],
          orderBy: 'created_at',
          orderDir: 'desc',
        }),
      ]);

      if (data) {
        setCompanies(data.map(toCompanyWithDeal));
      }
      if (discovered) {
        setDiscoveredCompanies(discovered.map(toCompanyWithDeal));
      }
    } catch (error) {
      console.error('Error fetching companies:', error);
    } finally {
      if (!opts.silent) setLoading(false);
    }
  };

  const deleteCompany = async (companyId: string, companyName: string) => {
    setDeletingId(companyId);
    try {
      await deleteCompanyById(companyId);

      setCompanies((prev) => prev.filter((c) => c.id !== companyId));
      toast({
        title: 'Company deleted',
        description: `"${companyName}" and all related data have been removed.`,
      });
    } catch (error: any) {
      console.error('Error deleting company:', error);
      toast({
        title: 'Delete failed',
        description: error.message || 'Could not delete the company. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setDeletingId(null);
    }
  };

  // Move a relationship-graph "discovered" company into the L0 deal pipeline.
  // Removes it from the discovered list and refetches so it appears in the
  // main pipeline table.
  const addDiscoveredToL0 = async (companyId: string, companyName: string) => {
    setAddingToL0Id(companyId);
    try {
      await updateCompany(companyId, { pipeline_stage: 'L0' });

      setDiscoveredCompanies((prev) => prev.filter((c) => c.id !== companyId));
      toast({
        title: 'Added to L0',
        description: `"${companyName}" is now in the L0 pipeline (Sourcing).`,
      });
      fetchCompanies({ silent: true });
    } catch (error: any) {
      console.error('Error adding discovered company to L0:', error);
      toast({
        title: 'Could not add to L0',
        description: error.message || 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setAddingToL0Id(null);
    }
  };

  const getDisplayStage = (company: CompanyWithDeal): DealStage | 'Acquired' | null => {
    if (!company.current_stage) return null;
    if (!company.is_active && company.current_stage === 'L5') {
      return 'Acquired';
    }
    return company.current_stage as DealStage;
  };

  const uniqueSectors = [...new Set(companies.map(c => c.sector).filter(Boolean))];

  const filteredCompanies = companies.filter(company => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = company.name.toLowerCase().includes(q) ||
      (company.project_name || '').toLowerCase().includes(q) ||
      company.sector.toLowerCase().includes(q);

    const displayStage = getDisplayStage(company);
    const matchesStage = stageFilter === 'all' || displayStage === stageFilter;
    const matchesSector = sectorFilter === 'all' || company.sector === sectorFilter;
    const matchesSource = sourceFilter === 'all' || company.source === sourceFilter;

    return matchesSearch && matchesStage && matchesSector && matchesSource;
  });

  const droppedCompanies = companies.filter(c => c.status === 'dropped');
  const activeCompanies = companies.filter(c =>
    c.status !== 'dropped' &&
    ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].includes(c.current_stage as string)
  );

  const countActiveAtStage = (stage: string) =>
    companies.filter(c => c.status !== 'dropped' && c.current_stage === stage).length;

  const stats = {
    total: activeCompanies.length + droppedCompanies.length,
    active: activeCompanies.length,
    drop: droppedCompanies.length,
    byStage: {
      L0: countActiveAtStage('L0'),
      L1: countActiveAtStage('L1'),
      L2: countActiveAtStage('L2'),
      L3: countActiveAtStage('L3'),
      L4: countActiveAtStage('L4'),
      L5: countActiveAtStage('L5'),
    },
  };

  const totalPages = Math.max(1, Math.ceil(filteredCompanies.length / itemsPerPage));
  const paginatedCompanies = filteredCompanies.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Discovered companies follow the same text search as the main table and are
  // paginated independently (their own page cursor) using the same page size.
  const filteredDiscovered = discoveredCompanies.filter((company) => {
    const q = searchQuery.toLowerCase();
    return (
      company.name.toLowerCase().includes(q) ||
      (company.project_name || '').toLowerCase().includes(q) ||
      company.sector.toLowerCase().includes(q)
    );
  });
  const discoveredTotalPages = Math.max(
    1,
    Math.ceil(filteredDiscovered.length / itemsPerPage),
  );
  const paginatedDiscovered = filteredDiscovered.slice(
    (discoveredPage - 1) * itemsPerPage,
    discoveredPage * itemsPerPage,
  );

  if (loading) {
    return (
      <DashboardLayout showCompanyGraph={showCompanyGraph}>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
      <div className="p-6 space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Master Data</h1>
            <p className="text-muted-foreground">Complete overview of all companies in the system</p>
          </div>
        </div>

        {/* Stats Cards — hidden on mobile to keep the view focused on search */}
        {!isMobile && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Total</span>
                </div>
                <p className="text-2xl font-bold mt-1">{stats.total}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-blue-500" />
                  <span className="text-sm text-muted-foreground">Active</span>
                </div>
                <p className="text-2xl font-bold mt-1">{stats.active}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="text-sm text-muted-foreground">Drop</span>
                </div>
                <p className="text-2xl font-bold mt-1">{stats.drop}</p>
              </CardContent>
            </Card>
            <Card className="col-span-2">
              <CardContent className="pt-4">
                <div className="text-sm text-muted-foreground mb-2">By Stage</div>
                <div className="flex gap-2 flex-wrap">
                  {Object.entries(stats.byStage).map(([stage, count]) => (
                    <Badge key={stage} variant="secondary" className="text-xs">
                      {stage}: {count}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Filters */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-4">
              <div className="flex-1 min-w-[200px]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search companies or sectors..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
              {/* Dropdown filters are hidden on mobile — search only there */}
              {!isMobile && (
                <>
                  <Select value={stageFilter} onValueChange={setStageFilter}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue placeholder="Stage" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Stages</SelectItem>
                      <SelectItem value="L0">L0 - Sourcing</SelectItem>
                      <SelectItem value="L1">L1 - Screening</SelectItem>
                      <SelectItem value="L2">L2 - Initial Review</SelectItem>
                      <SelectItem value="L3">L3 - Due Diligence</SelectItem>
                      <SelectItem value="L4">L4 - Negotiation</SelectItem>
                      <SelectItem value="L5">L5 - Closing</SelectItem>
                      <SelectItem value="Acquired">Acquired</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sectorFilter} onValueChange={setSectorFilter}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue placeholder="Sector" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sectors</SelectItem>
                      {uniqueSectors.map(sector => (
                        <SelectItem key={sector} value={sector}>{sector}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={sourceFilter} onValueChange={setSourceFilter}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue placeholder="Source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sources</SelectItem>
                      <SelectItem value="inbound">Inbound</SelectItem>
                      <SelectItem value="outbound">Outbound</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground mt-1.5">
              <Lightbulb className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <span>Try:</span>
              {SEARCH_SUGGESTION_CHIPS.map((chip, i) => (
                <span key={chip}>
                  <button
                    type="button"
                    onClick={() => setSearchQuery(chip)}
                    className="text-primary hover:underline"
                  >
                    &quot;{chip}&quot;
                  </button>
                  {i < SEARCH_SUGGESTION_CHIPS.length - 1 ? ',' : ''}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Companies Table */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              All Companies ({filteredCompanies.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredCompanies.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Building2 className="mx-auto h-12 w-12 mb-4 opacity-50" />
                <p>No companies found matching your filters.</p>
              </div>
            ) : isMobile ? (
              <div className="space-y-3">
                {paginatedCompanies.map((company) => {
                  const displayStage = getDisplayStage(company);
                  const canOpenCompany = Boolean(company.name || company.project_name);
                  return (
                    <div
                      key={company.id}
                      role="button"
                      tabIndex={canOpenCompany ? 0 : -1}
                      onClick={() => canOpenCompany && openCompany(company.id)}
                      onKeyDown={(e) => {
                        if (canOpenCompany && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          openCompany(company.id);
                        }
                      }}
                      className="rounded-lg border bg-card p-4 transition-colors hover:bg-muted/40 hover:border-primary/40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium">
                          {company.name || '—'}
                        </span>
                        <span
                          className="shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <AskAIButton
                            variant="icon"
                            label="Analyze using AI"
                            onClick={() =>
                              analyzeWithAI(
                                `Analyze ${companyDisplayName(company, 'this company')} and provide insights about it as a potential deal.`,
                              )
                            }
                          />
                        </span>
                      </div>
                      {company.project_name && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{company.project_name}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {displayStage ? (
                          <Badge className={`${stageColors[displayStage as DealStage | 'Acquired']} text-white`}>
                            {displayStage === 'Acquired'
                              ? 'Acquired'
                              : `${displayStage} - ${stageLabels[displayStage as DealStage]}`}
                          </Badge>
                        ) : (
                          <Badge variant="outline">Not in Pipeline</Badge>
                        )}
                        {company.status === 'dropped' && <Badge variant="destructive">Dropped</Badge>}
                        {company.status === 'active' && <Badge variant="default">Active</Badge>}
                        <Badge
                          variant="outline"
                          className="text-sm px-2.5 py-1 whitespace-normal break-words text-left leading-snug"
                        >
                          {company.sector || '-'}
                        </Badge>
                        <Badge variant="secondary" className="capitalize">{company.source || '-'}</Badge>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Rev 2025</span>
                          <span className="font-mono">{formatCurrency(company.revenue_2025)}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">EBITDA 2025</span>
                          <span className="font-mono">{formatCurrency(company.ebitda_2025)}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Valuation</span>
                          <span className="font-mono">{formatCurrency(company.valuation)}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Geo</span>
                          <span>{company.geo || '-'}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">PIC</span>
                          <span>{company.pic || '-'}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Added</span>
                          <span>{new Date(company.created_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Project</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="min-w-[200px]">Sector</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Geo</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>PIC</TableHead>
                      <TableHead className="text-right">Rev 2022</TableHead>
                      <TableHead className="text-right">Rev 2023</TableHead>
                      <TableHead className="text-right">Rev 2024</TableHead>
                      <TableHead className="text-right">Rev 2025</TableHead>
                      <TableHead className="text-center">Trend</TableHead>
                      <TableHead className="text-right">EBITDA 2022</TableHead>
                      <TableHead className="text-right">EBITDA 2023</TableHead>
                      <TableHead className="text-right">EBITDA 2024</TableHead>
                      <TableHead className="text-right">EBITDA 2025</TableHead>
                      <TableHead className="text-right">Valuation</TableHead>
                      <TableHead>Added</TableHead>
                      <TableHead className="text-center">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedCompanies.map((company) => {
                      const displayStage = getDisplayStage(company);
                      const revenueChange = getRevenueChange(company.revenue_2024, company.revenue_2025);

                      return (
                        <TableRow key={company.id}>
                          <TableCell className="font-medium">
                            {company.name ? (
                              <button
                                type="button"
                                onClick={() => openCompanyDialog(company.id)}
                                disabled={loadingDialog}
                                className="font-medium text-left hover:text-primary transition-colors disabled:opacity-50"
                              >
                                {company.name}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="font-medium">
                            {company.project_name ? (
                              <button
                                type="button"
                                onClick={() => openCompanyDialog(company.id)}
                                disabled={loadingDialog}
                                className="font-medium text-left hover:text-primary transition-colors disabled:opacity-50"
                              >
                                {company.project_name}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {company.status === 'dropped' ? (
                              <Badge variant="destructive">Dropped</Badge>
                            ) : company.status === 'active' ? (
                              <Badge variant="default">Active</Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="min-w-[200px]">
                            <Badge
                              variant="outline"
                              className="text-sm px-2.5 py-1 rounded-md whitespace-normal break-words text-left leading-snug"
                            >
                              {company.sector || '-'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="capitalize">
                              {company.source || '-'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">
                              {company.geo || '-'}
                            </span>
                          </TableCell>
                          <TableCell>
                            {displayStage ? (
                              <Badge className={`${stageColors[displayStage as DealStage | 'Acquired']} text-white`}>
                                {displayStage === 'Acquired' ? (
                                  <span className="flex items-center gap-1">
                                    <CheckCircle2 className="h-3 w-3" />
                                    Acquired
                                  </span>
                                ) : (
                                  `${displayStage} - ${stageLabels[displayStage as DealStage]}`
                                )}
                              </Badge>
                            ) : (
                              <Badge variant="outline">Not in Pipeline</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">
                              {company.pic || '-'}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.revenue_2022)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.revenue_2023)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.revenue_2024)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.revenue_2025)}
                          </TableCell>
                          <TableCell className="text-center">
                            {revenueChange.direction === 'up' && (
                              <span className="flex items-center justify-center text-green-600">
                                <TrendingUp className="h-4 w-4 mr-1" />
                                {revenueChange.percent.toFixed(0)}%
                              </span>
                            )}
                            {revenueChange.direction === 'down' && (
                              <span className="flex items-center justify-center text-red-600">
                                <TrendingDown className="h-4 w-4 mr-1" />
                                {revenueChange.percent.toFixed(0)}%
                              </span>
                            )}
                            {revenueChange.direction === 'flat' && (
                              <Minus className="h-4 w-4 mx-auto text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.ebitda_2022)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.ebitda_2023)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.ebitda_2024)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.ebitda_2025)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.valuation)}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {new Date(company.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-center">
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  disabled={deletingId === company.id}
                                >
                                  {deletingId === company.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-4 w-4" />
                                  )}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete &ldquo;{companyDisplayName(company, 'this company')}&rdquo;?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This will permanently delete this company and all related data
                                    including deal history, notes, documents, links, screening results,
                                    and AI analyses. This action cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    onClick={() => deleteCompany(company.id, companyDisplayName(company, 'this company'))}
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {filteredCompanies.length > 0 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                <p className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages} ({filteredCompanies.length} companies)
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Discovered Companies — auto-created via the relationship graph,
            outside the L0–L5 pipeline. Shown as their own section. */}
        {discoveredCompanies.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-amber-500" />
                Discovered Companies ({filteredDiscovered.length})
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Companies surfaced through the relationship graph. Not yet part of the L0–L5 deal pipeline.
              </p>
            </CardHeader>
            <CardContent>
              {filteredDiscovered.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Building2 className="mx-auto h-12 w-12 mb-4 opacity-50" />
                  <p>No discovered companies match your search.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {paginatedDiscovered.map((company) => {
                    const displayName = companyDisplayName(company, '');
                    return (
                      <div
                        key={company.id}
                        className="flex flex-col rounded-lg border bg-card p-4"
                      >
                        <button
                          type="button"
                          onClick={() => displayName && openCompany(company.id)}
                          disabled={!displayName || loadingDialog}
                          className="-m-4 mb-0 rounded-t-lg p-4 pb-0 text-left transition-colors hover:bg-muted/40 disabled:opacity-50"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{displayName || '—'}</span>
                            <Badge className={`${stageColors.discovered} text-white`}>
                              {stageLabels.discovered}
                            </Badge>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                            <Badge variant="outline">{company.sector || '-'}</Badge>
                            <span className="text-muted-foreground">{company.geo || 'Unknown geo'}</span>
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">
                            Added {new Date(company.created_at).toLocaleDateString()}
                          </p>
                        </button>
                        <div className="mt-3 pt-3 border-t">
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={() => displayName && addDiscoveredToL0(company.id, displayName)}
                            disabled={!displayName || addingToL0Id === company.id}
                          >
                            {addingToL0Id === company.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <ArrowRight className="h-4 w-4" />
                            )}
                            Add to L0
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {filteredDiscovered.length > 0 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <p className="text-sm text-muted-foreground">
                    Page {discoveredPage} of {discoveredTotalPages} ({filteredDiscovered.length} companies)
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDiscoveredPage((p) => Math.max(1, p - 1))}
                      disabled={discoveredPage === 1}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDiscoveredPage((p) => Math.min(discoveredTotalPages, p + 1))}
                      disabled={discoveredPage === discoveredTotalPages}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {selectedCompany && (
          <CompanyDetailDialog
            company={selectedCompany}
            open={!!selectedCompany}
            onOpenChange={(open) => !open && setSelectedCompany(null)}
            onUpdate={() => {
              fetchCompanies({ silent: true });
            }}
          />
        )}
      </div>
    </DashboardLayout>
  );
}
