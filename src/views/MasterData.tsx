'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';
import { formatMoneyMn } from '@/lib/currency';
import { PageHeader } from '@/components/layout/PageHeader';
import CompanyDetailDialog, { type CompanyData } from '@/components/pipeline/CompanyDetailDialog';
import PromoteDialog from '@/components/pipeline/PromoteDialog';
import DropDealDialog from '@/components/pipeline/DropDealDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { deleteCompanyById, getCompanies } from '@/lib/api/pipeline';
import { useRestoreDeal } from '@/components/pipeline/useRestoreDeal';
import { usePipelineStages } from '@/hooks/usePipelineStages';
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
  MoreVertical,
  Plus,
  XCircle,
  RotateCcw,
} from 'lucide-react';
import type { DealStage } from '@/lib/types';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useNearRightEdge } from '@/hooks/useNearRightEdge';
import {
  useColumnLayout,
  ColumnManagerProvider,
  ManagedTableHeader,
  ManagedRowCells,
  ColumnConfigGear,
  type ColumnDef,
} from '@/components/table';
import { useToast } from '@/hooks/use-toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChatActions } from '@/components/chat/ChatProvider';
import { AskAIButton } from '@/components/chat/AskAIButton';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
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

/** Badge colour by stage; a stage the workspace added uses STAGE_COLOR_FALLBACK. */
const STAGE_COLOR_FALLBACK = 'bg-slate-500';
const stageColors: Record<string, string> = {
  market_screening: 'bg-blue-500',
  unreviewed: 'bg-amber-500',
  L0: 'bg-stage-l0',
  L1: 'bg-stage-l1',
  L2: 'bg-stage-l2',
  L3: 'bg-stage-l3',
  L4: 'bg-stage-l4',
  L5: 'bg-stage-l5',
  discovered: 'bg-amber-500',
  Acquired: 'bg-green-600',
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

export default function MasterData() {
  const [companies, setCompanies] = useState<CompanyWithDeal[]>([]);
  const { restore: restoreWithStagePrompt, restoreStageDialog } = useRestoreDeal();
  const pipelineStages = usePipelineStages();
  /** A stage value as text: a workspace stage by code and name, a bucket by its name. */
  const stageText = pipelineStages.displayLabel;
  // Companies the relationship-graph tooling auto-created (stage "discovered").
  // They sit outside the pipeline stages, so they get their own section below.
  const [discoveredCompanies, setDiscoveredCompanies] = useState<CompanyWithDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [sectorFilter, setSectorFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [discoveredPage, setDiscoveredPage] = useState(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);
  const [companyToPromote, setCompanyToPromote] = useState<CompanyWithDeal | null>(null);
  const [dropDealCompany, setDropDealCompany] = useState<CompanyWithDeal | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(null);
  const [loadingDialog, setLoadingDialog] = useState(false);
  // Tracks which company id the most recent click/close is for, so an
  // out-of-order or late-arriving fetch response (or one still in flight
  // when the dialog is closed) can't clobber the currently selected company.
  const activeCompanyRequestIdRef = useRef<string | null>(null);
  const { toast } = useToast();
  const currency = useWorkspaceCurrency();
  const formatCurrency = (value: number | null): string => formatMoneyMn(value, currency);
  const { analyzeWithAI } = useChatActions();
  const { focusCopilot } = useLayoutControl();
  const router = useRouter();
  const isMobile = useIsMobile();
  const chatHref = useWorkspaceHref('/chat');
  const { nearEdge, edgeHandlers } = useNearRightEdge();
  const pipelineHref = useWorkspaceHref('/pipeline');
  const masterDataHref = useWorkspaceHref('/master-data');

  // On mobile, a company opens its own full-screen profile page (with a back
  // button to the Search list). On desktop it opens the detail dialog.
  const openCompany = (companyId: string) => {
    if (isMobile) {
      router.push(`${pipelineHref}/${companyId}?from=${encodeURIComponent(masterDataHref)}`);
    } else {
      void openCompanyDialog(companyId);
    }
  };
  // Mobile shows companies as cards, paginated 5 at a time; desktop keeps the
  // dense table at 10 per page.
  const itemsPerPage = isMobile ? 5 : 10;
  const discoveredItemsPerPage = isMobile ? 6 : 12;

  const openCompanyDialog = async (companyId: string) => {
    activeCompanyRequestIdRef.current = companyId;
    setLoadingDialog(true);
    try {
      const data = await getCompanies({ id: companyId });
      // A newer click (or a dialog close) superseded this request while it
      // was in flight — discard the stale response instead of overwriting
      // whatever the user has since selected.
      if (activeCompanyRequestIdRef.current !== companyId) {
        return;
      }
      if (!data) {
        toast({ title: 'Error', description: 'Could not load company', variant: 'destructive' });
        return;
      }

      // Forward the full DTO. The detail dialog reads (and, in edit mode,
      // writes back) many more fields than the table needs — deal_sponsor,
      // deal_type, workflow_status, entered_by(_name), key_rationale,
      // matched_track_ids, last_activity_at, etc. Cherry-picking columns here
      // left those blank in the dialog and, worse, let an edit-save clobber the
      // omitted fields to null. getCompanies returns the same DTO shape the
      // Pipeline view passes straight through.
      setSelectedCompany(data as CompanyData);
    } catch {
      if (activeCompanyRequestIdRef.current === companyId) {
        toast({ title: 'Error', description: 'Could not load company', variant: 'destructive' });
      }
    } finally {
      if (activeCompanyRequestIdRef.current === companyId) {
        setLoadingDialog(false);
      }
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
          // Every stage except relationship-graph stubs, which load separately
          // below — so stages the workspace added are included.
          stageNotNull: true,
          excludeStage: 'discovered',
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

  // Reactivating is immediate, no confirmation — matches the pipeline
  // board's restore action.
  const reactivateCompany = async (company: CompanyWithDeal) => {
    setReactivatingId(company.id);
    try {
      const { restored, stage } = await restoreWithStagePrompt({
        id: company.id,
        name: companyDisplayName(company, 'This deal'),
        currentStage: company.current_stage,
      });
      if (!restored) return;
      setCompanies((prev) =>
        prev.map((c) =>
          c.id === company.id ? { ...c, status: 'active', current_stage: stage ?? c.current_stage } : c,
        ),
      );
      toast({
        title: 'Deal reactivated',
        description: `"${companyDisplayName(company, 'this company')}" is active again.`,
      });
    } catch (error: unknown) {
      console.error('Error reactivating company:', error);
      toast({
        title: 'Reactivate failed',
        description:
          error instanceof Error
            ? error.message
            : 'Could not reactivate the deal. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setReactivatingId(null);
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
    c.status !== 'dropped' && !!c.current_stage && c.current_stage !== 'discovered'
  );

  const countActiveAtStage = (stage: string) =>
    companies.filter(c => c.status !== 'dropped' && c.current_stage === stage).length;

  const stats = {
    total: activeCompanies.length + droppedCompanies.length,
    active: activeCompanies.length,
    drop: droppedCompanies.length,
    byStage: Object.fromEntries(
      ['market_screening', 'unreviewed', ...pipelineStages.liveKeys].map((stage) => [
        stage,
        countActiveAtStage(stage),
      ]),
    ) as Record<string, number>,
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
    Math.ceil(filteredDiscovered.length / discoveredItemsPerPage),
  );
  const paginatedDiscovered = filteredDiscovered.slice(
    (discoveredPage - 1) * discoveredItemsPerPage,
    discoveredPage * discoveredItemsPerPage,
  );

  // Managed (reorderable / hideable / groupable) data columns. The identity
  // Company column and the trailing Actions column are pinned and rendered
  // outside this set. Headers are plain labels (no sort), so `label` is enough.
  const columns = useMemo<ColumnDef<CompanyWithDeal>[]>(() => {
    const numeric = 'text-right font-mono';
    return [
      {
        id: 'project',
        label: 'Project',
        cellClassName: 'font-medium',
        cell: (company) =>
          company.project_name ? (
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
          ),
      },
      {
        id: 'status',
        label: 'Status',
        cell: (company) =>
          company.status === 'dropped' ? (
            <Badge variant="destructive">Dropped</Badge>
          ) : company.status === 'active' ? (
            <Badge variant="default">Active</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'sector',
        label: 'Sector',
        headerClassName: 'min-w-[200px]',
        cellClassName: 'min-w-[200px]',
        cell: (company) => (
          <Badge
            variant="outline"
            className="text-sm px-2.5 py-1 rounded-md whitespace-normal break-words text-left leading-snug"
          >
            {company.sector || '-'}
          </Badge>
        ),
      },
      {
        id: 'source',
        label: 'Source',
        cell: (company) => (
          <Badge variant="secondary" className="capitalize">
            {company.source || '-'}
          </Badge>
        ),
      },
      {
        id: 'geo',
        label: 'Geo',
        cell: (company) => (
          <span className="text-sm text-muted-foreground">
            {company.geo || '-'}
          </span>
        ),
      },
      {
        id: 'stage',
        label: 'Stage',
        cell: (company) => {
          const displayStage = getDisplayStage(company);
          return displayStage ? (
            <Badge className={`${stageColors[displayStage] ?? STAGE_COLOR_FALLBACK} text-white`}>
              {displayStage === 'Acquired' ? (
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Acquired
                </span>
              ) : (
                stageText(displayStage)
              )}
            </Badge>
          ) : (
            <Badge variant="outline">Not in Pipeline</Badge>
          );
        },
      },
      {
        id: 'pic',
        label: 'PIC',
        cell: (company) => (
          <span className="text-sm text-muted-foreground">
            {company.pic || '-'}
          </span>
        ),
      },
      {
        id: 'revenue_2022',
        label: 'Rev 2022',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.revenue_2022),
      },
      {
        id: 'revenue_2023',
        label: 'Rev 2023',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.revenue_2023),
      },
      {
        id: 'revenue_2024',
        label: 'Rev 2024',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.revenue_2024),
      },
      {
        id: 'revenue_2025',
        label: 'Rev 2025',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.revenue_2025),
      },
      {
        id: 'trend',
        label: 'Trend',
        headerClassName: 'text-center',
        cellClassName: 'text-center',
        cell: (company) => {
          const revenueChange = getRevenueChange(company.revenue_2024, company.revenue_2025);
          return (
            <>
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
            </>
          );
        },
      },
      {
        id: 'ebitda_2022',
        label: 'EBITDA 2022',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.ebitda_2022),
      },
      {
        id: 'ebitda_2023',
        label: 'EBITDA 2023',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.ebitda_2023),
      },
      {
        id: 'ebitda_2024',
        label: 'EBITDA 2024',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.ebitda_2024),
      },
      {
        id: 'ebitda_2025',
        label: 'EBITDA 2025',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.ebitda_2025),
      },
      {
        id: 'valuation',
        label: 'Valuation',
        headerClassName: 'text-right',
        cellClassName: numeric,
        cell: (company) => formatCurrency(company.valuation),
      },
      {
        id: 'created',
        label: 'Added',
        cellClassName: 'text-muted-foreground text-sm',
        cell: (company) => new Date(company.created_at).toLocaleDateString(),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingDialog]);

  const mgr = useColumnLayout('master-data', columns);

  if (loading) {
    return (
      <>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="min-h-full animate-fade-in">
        <PageHeader
          title="Master Data"
          subtitle="Complete overview of all companies in the system"
          actions={
            <Button
              data-testid="master-data-add-company-button"
              className="gap-2"
              onClick={() => {
                analyzeWithAI('How do I add a new company?');
                if (isMobile) {
                  router.push(chatHref);
                  return;
                }
                focusCopilot();
              }}
            >
              <Plus className="h-4 w-4" />
              Add Company
            </Button>
          }
        />

        <div className="space-y-6 p-6">
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
                      {stageText(stage)}: {count}
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
                      <SelectItem value="market_screening">{stageText('market_screening')}</SelectItem>
                      <SelectItem value="unreviewed">Unreviewed</SelectItem>
                      {pipelineStages.live.map((stage) => (
                        <SelectItem key={stage.key} value={stage.key}>
                          {pipelineStages.label(stage.key)}
                        </SelectItem>
                      ))}
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
                          <Badge className={`${stageColors[displayStage] ?? STAGE_COLOR_FALLBACK} text-white`}>
                            {displayStage === 'Acquired' ? 'Acquired' : stageText(displayStage)}
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
              <ColumnManagerProvider value={mgr}>
              <div className="overflow-x-auto">
                <div className="flex items-center justify-end px-2 py-1.5">
                  <ColumnConfigGear />
                </div>
                <Table {...edgeHandlers}>
                  <ManagedTableHeader
                    leading={<TableHead key="company">Company</TableHead>}
                    trailing={
                      <TableHead
                        key="actions"
                        className="w-[44px] sticky right-0 z-20 bg-transparent"
                      />
                    }
                  />
                  <TableBody>
                    {paginatedCompanies.map((company, index) => {
                      return (
                        <TableRow key={company.id} className="group">
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
                          <ManagedRowCells row={company} index={index} />
                          <TableCell className="text-right sticky right-0 z-10 bg-transparent">
                            <AlertDialog>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Actions"
                                    className={cn(
                                      "h-7 w-7 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100",
                                      nearEdge ? "opacity-100" : "opacity-0",
                                    )}
                                    disabled={deletingId === company.id || reactivatingId === company.id}
                                  >
                                    {deletingId === company.id || reactivatingId === company.id ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <MoreVertical className="h-4 w-4" />
                                    )}
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {company.status === 'dropped' ? (
                                    <DropdownMenuItem
                                      data-testid={`master-data-reactivate-button-${company.id}`}
                                      onSelect={() => reactivateCompany(company)}
                                    >
                                      <RotateCcw className="mr-2 h-4 w-4" />
                                      Reactivate deal
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem
                                      data-testid={`master-data-drop-button-${company.id}`}
                                      onSelect={() => setDropDealCompany(company)}
                                    >
                                      <XCircle className="mr-2 h-4 w-4" />
                                      Drop
                                    </DropdownMenuItem>
                                  )}
                                  <AlertDialogTrigger asChild>
                                    <DropdownMenuItem
                                      onSelect={(e) => e.preventDefault()}
                                      className="text-destructive focus:text-destructive"
                                    >
                                      <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                                      Delete
                                    </DropdownMenuItem>
                                  </AlertDialogTrigger>
                                </DropdownMenuContent>
                              </DropdownMenu>
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
              </ColumnManagerProvider>
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
            outside the pipeline stages. Shown as their own section. */}
        {discoveredCompanies.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-amber-500" />
                Discovered Companies ({filteredDiscovered.length})
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Companies surfaced through the relationship graph. Not yet part of the deal pipeline.
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
                              {stageText('discovered')}
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
                            onClick={() => displayName && setCompanyToPromote(company)}
                            disabled={!displayName}
                          >
                            <ArrowRight className="h-4 w-4" />
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
        </div>

        {selectedCompany && (
          <CompanyDetailDialog
            key={selectedCompany.id}
            company={selectedCompany}
            open={!!selectedCompany}
            onOpenChange={(open) => {
              if (!open) {
                activeCompanyRequestIdRef.current = null;
                setSelectedCompany(null);
                setLoadingDialog(false);
              }
            }}
            onUpdate={() => {
              fetchCompanies({ silent: true });
            }}
          />
        )}

        {companyToPromote && (
          <PromoteDialog
            open={!!companyToPromote}
            onOpenChange={(open) => {
              if (!open) setCompanyToPromote(null);
            }}
            dealId={companyToPromote.id}
            companyName={companyToPromote.name}
            currentStage={(companyToPromote.current_stage || 'discovered') as DealStage}
            nextStage="L0"
            onSuccess={() => {
              setCompanyToPromote(null);
              setDiscoveredCompanies((prev) => prev.filter((c) => c.id !== companyToPromote.id));
              fetchCompanies({ silent: true });
            }}
          />
        )}

        {restoreStageDialog}

        {dropDealCompany && (
          <DropDealDialog
            open={!!dropDealCompany}
            onOpenChange={(open) => {
              if (!open) setDropDealCompany(null);
            }}
            dealId={dropDealCompany.id}
            companyName={companyDisplayName(dropDealCompany, 'this company')}
            currentStage={dropDealCompany.current_stage}
            onSuccess={() => {
              setCompanies((prev) =>
                prev.map((c) =>
                  c.id === dropDealCompany.id ? { ...c, status: 'dropped' } : c,
                ),
              );
              setDropDealCompany(null);
            }}
          />
        )}
      </div>
    </>
  );
}
