'use client';

import { useEffect, useState } from 'react';
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
import { deleteCompanyById, getCompanies } from '@/lib/api/pipeline';
import { getCompanyOverride } from '@/lib/companyOverrides';
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

interface CompanyWithDeal {
  id: string;
  name: string;
  sector: string;
  geo: string | null;
  source: string;
  revenue_year1: number | null;
  revenue_year2: number | null;
  revenue_year3: number | null;
  ebitda_year1: number | null;
  ebitda_year2: number | null;
  ebitda_year3: number | null;
  valuation: number | null;
  pic: string | null;
  created_at: string;
  current_stage: DealStage | null;
  is_active: boolean;
}

const stageLabels: Record<DealStage | 'Acquired', string> = {
  market_screening: 'Market Screening',
  L0: 'Sourcing',
  L1: 'Screening',
  L2: 'Initial Review',
  L3: 'Due Diligence',
  L4: 'Negotiation',
  L5: 'Closing',
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

const getRevenueChange = (year2: number | null, year3: number | null): { direction: 'up' | 'down' | 'flat'; percent: number } => {
  if (!year2 || !year3) return { direction: 'flat', percent: 0 };
  const change = ((year3 - year2) / year2) * 100;
  if (change > 1) return { direction: 'up', percent: change };
  if (change < -1) return { direction: 'down', percent: Math.abs(change) };
  return { direction: 'flat', percent: 0 };
};

export default function MasterData() {
  const [companies, setCompanies] = useState<CompanyWithDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [sectorFilter, setSectorFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(null);
  const [loadingDialog, setLoadingDialog] = useState(false);
  const { toast } = useToast();
  const itemsPerPage = 10;

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
  }, [searchQuery, stageFilter, sectorFilter, sourceFilter]);

  const fetchCompanies = async (opts: { silent?: boolean } = {}) => {
    try {
      const data = await getCompanies({
        stageIn: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
        orderBy: 'created_at',
        orderDir: 'desc',
      });

      if (data) {
        const formatted = data
          .map((company: any) => {
            const override = getCompanyOverride(company.id);
            return {
              id: company.id,
              name: company.target || 'Unknown',
              sector: company.segment || '',
              geo: company.geography || company.geo || null,
              source: company.watchlist_status === 'Active' ? 'inbound' : 'outbound',
              revenue_year1: company.revenue_2022_usd_mn,
              revenue_year2: override?.revenue_2023_usd_mn ?? company.revenue_2023_usd_mn,
              revenue_year3: override?.revenue_2024_usd_mn ?? company.revenue_2024_usd_mn,
              ebitda_year1: company.ebitda_2022_usd_mn,
              ebitda_year2: override?.ebitda_2023_usd_mn ?? company.ebitda_2023_usd_mn,
              ebitda_year3: override?.ebitda_2024_usd_mn ?? company.ebitda_2024_usd_mn,
              valuation: override?.ev_2024 ?? company.ev_2024,
              pic: override?.pic ?? company.pic ?? null,
              created_at: company.created_at,
              current_stage: company.pipeline_stage as DealStage | null,
              is_active: company.pipeline_stage !== null && company.pipeline_stage !== 'Acquired',
            };
          });
        setCompanies(formatted);
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

  const getDisplayStage = (company: CompanyWithDeal): DealStage | 'Acquired' | null => {
    if (!company.current_stage) return null;
    if (!company.is_active && company.current_stage === 'L5') {
      return 'Acquired';
    }
    return company.current_stage as DealStage;
  };

  const uniqueSectors = [...new Set(companies.map(c => c.sector).filter(Boolean))];

  const filteredCompanies = companies.filter(company => {
    const matchesSearch = company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      company.sector.toLowerCase().includes(searchQuery.toLowerCase());

    const displayStage = getDisplayStage(company);
    const matchesStage = stageFilter === 'all' || displayStage === stageFilter;
    const matchesSector = sectorFilter === 'all' || company.sector === sectorFilter;
    const matchesSource = sourceFilter === 'all' || company.source === sourceFilter;

    return matchesSearch && matchesStage && matchesSector && matchesSource;
  });

  const activeCompanies = companies.filter(c =>
    ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].includes(c.current_stage as string)
  );

  const stats = {
    total: activeCompanies.length + 0,
    active: activeCompanies.length,
    drop: 0,
    byStage: {
      L0: companies.filter(c => c.current_stage === 'L0').length,
      L1: companies.filter(c => c.current_stage === 'L1').length,
      L2: companies.filter(c => c.current_stage === 'L2').length,
      L3: companies.filter(c => c.current_stage === 'L3').length,
      L4: companies.filter(c => c.current_stage === 'L4').length,
      L5: companies.filter(c => c.current_stage === 'L5').length,
    },
  };

  const totalPages = Math.max(1, Math.ceil(filteredCompanies.length / itemsPerPage));
  const paginatedCompanies = filteredCompanies.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Master Data</h1>
            <p className="text-muted-foreground">Complete overview of all companies in the system</p>
          </div>
        </div>

        {/* Stats Cards */}
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
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1.5">
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
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Sector</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Geo</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>PIC</TableHead>
                      <TableHead className="text-right">Rev Y1</TableHead>
                      <TableHead className="text-right">Rev Y2</TableHead>
                      <TableHead className="text-right">Rev Y3</TableHead>
                      <TableHead className="text-center">Trend</TableHead>
                      <TableHead className="text-right">EBITDA Y1</TableHead>
                      <TableHead className="text-right">EBITDA Y2</TableHead>
                      <TableHead className="text-right">EBITDA Y3</TableHead>
                      <TableHead className="text-right">Valuation</TableHead>
                      <TableHead>Added</TableHead>
                      <TableHead className="text-center">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedCompanies.map((company) => {
                      const displayStage = getDisplayStage(company);
                      const revenueChange = getRevenueChange(company.revenue_year2, company.revenue_year3);

                      return (
                        <TableRow key={company.id}>
                          <TableCell className="font-medium">
                            <button
                              type="button"
                              onClick={() => openCompanyDialog(company.id)}
                              disabled={loadingDialog}
                              className="font-medium text-left hover:text-primary transition-colors disabled:opacity-50"
                            >
                              {company.name}
                            </button>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{company.sector || '-'}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="capitalize">
                              {company.source}
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
                            {formatCurrency(company.revenue_year1)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.revenue_year2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.revenue_year3)}
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
                            {formatCurrency(company.ebitda_year1)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.ebitda_year2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(company.ebitda_year3)}
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
                                  <AlertDialogTitle>Delete &ldquo;{company.name}&rdquo;?</AlertDialogTitle>
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
                                    onClick={() => deleteCompany(company.id, company.name)}
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
