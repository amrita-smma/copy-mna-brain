import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import { Loader2, Zap, Target, Sparkles, Trash2, ArrowUpDown, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, MoreVertical, ArrowRight, Pencil } from 'lucide-react';
import CompanyDetailDialog from './CompanyDetailDialog';
import PromoteDialog from './PromoteDialog';
import { AskAIButton } from '@/components/chat/AskAIButton';
import { useChatContext } from '@/components/chat/ChatProvider';
import { cn } from '@/lib/utils';
import { companyDisplayName } from '@/lib/companyDisplay';
import { DealStage } from '@/lib/types';
import { deleteCompanyById, getCompanies, getFavoriteCompanies } from '@/lib/api/pipeline';
import { useAuth } from '@/hooks/useAuth';
import type { TrackLike } from '@/lib/tracks/matchTracks';

interface MarketScreeningResult {
  id: string;
  target: string | null;
  project_name?: string | null;
  segment: string | null;
  website: string | null;
  pipeline_stage: string;
  created_at: string;
  thesis_content: string | null;
  remarks: string | null;

  // Extended fields
  segment_related_offerings: string | null;
  company_focus: string | null;
  ownership: string | null;
  geography: string | null;

  // Revenue (USD Mn)
  revenue_2021_usd_mn: number | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;

  // EBITDA (USD Mn)
  ebitda_2021_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;

  // Valuation
  ev_2024: number | null;
  ev_ebitda_2024: number | null;

  // Growth metrics
  revenue_cagr_2021_2022: number | null;
  revenue_cagr_2022_2023: number | null;
  revenue_cagr_2023_2024: number | null;

  // Margins
  ebitda_margin_2021: number | null;
  ebitda_margin_2022: number | null;
  ebitda_margin_2023: number | null;
  ebitda_margin_2024: number | null;
  source: string | null;

  // Pipeline edit fields (returned by the company DTO, edited via CompanyDetailDialog)
  deal_type: string | null;
  entered_by: string | null;
  entered_by_name: string | null;
  last_activity_at: string | null;
  banker: string | null;
  doc_type: string | null;
  stake: string | null;
  deal_size: string | null;
  workflow_status: string | null;
  key_rationale: string | null;
  deal_sponsor: string | null;
  deal_captain: string | null;
  matched_track_ids?: string[] | null;

  financials_raw?: import('@/lib/repositories').Tables<'company_financials'>[];
}

interface MarketScreeningResultsProps {
  refreshTrigger: number;
  onAddedToPipeline: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  tracks?: TrackLike[];
}

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '-';
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(2)}B`;
  return `$${value.toFixed(2)}M`;
};

const latestFin = (
  rows: import('@/lib/repositories').Tables<'company_financials'>[] | undefined,
  key: 'revenue_usd_mn' | 'ebitda_usd_mn',
): { value: number | null; year: number | null } => {
  if (!rows?.length) return { value: null, year: null };
  let best: { value: number; year: number } | null = null;
  for (const r of rows) {
    const v = r[key] as number | null;
    if (v == null) continue;
    if (!best || r.fiscal_year > best.year) best = { value: v, year: r.fiscal_year };
  }
  return best ?? { value: null, year: null };
};

const ITEMS_PER_PAGE = 10;

export default function MarketScreeningResults({ refreshTrigger, onAddedToPipeline, collapsed = false, onToggleCollapse }: MarketScreeningResultsProps) {
  const { user } = useAuth();
  const { analyzeWithAI } = useChatContext();
  const [results, setResults] = useState<MarketScreeningResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedResult, setSelectedResult] = useState<MarketScreeningResult | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  // When true, the detail dialog opens straight into inline edit mode (Details tab).
  const [detailInEdit, setDetailInEdit] = useState(false);
  const [companyToPromote, setCompanyToPromote] = useState<MarketScreeningResult | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);

  // Favorites state (used for row highlighting + sort ordering)
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  const fetchResults = async (opts: { silent?: boolean } = {}) => {
    try {
      const data = await getCompanies({
        stage: 'market_screening',
        orderBy: 'created_at',
        orderDir: 'desc',
      });
      setResults((data || []) as MarketScreeningResult[]);
    } catch (error: any) {
      console.error('Error fetching results:', error);
    } finally {
      if (!opts.silent) setLoading(false);
    }
  };

  const fetchFavorites = async () => {
    if (!user?.id) return;
    try {
      const favs = await getFavoriteCompanies(user.id);
      setFavoriteIds(new Set(favs || []));
    } catch (error: any) {
      console.error('Error fetching favorites:', error);
    }
  };

  useEffect(() => {
    fetchResults();
  }, [refreshTrigger]);

  useEffect(() => {
    fetchFavorites();
  }, [user?.id]);

  const dismissResult = async (id: string) => {
    try {
      await deleteCompanyById(id);

      toast.success('Result dismissed');
      fetchResults();
    } catch (error: any) {
      console.error('Error dismissing result:', error);
      toast.error('Failed to dismiss result');
    }
  };

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedResults = useMemo(() => {
    const sorted = [...results].sort((a, b) => {
      // Favorites always come first
      const aFav = favoriteIds.has(a.id) ? 1 : 0;
      const bFav = favoriteIds.has(b.id) ? 1 : 0;
      if (aFav !== bFav) return bFav - aFav;

      if (!sortField) return 0;

      let aVal: any = 0;
      let bVal: any = 0;

        switch (sortField) {
        case 'target':
          aVal = companyDisplayName(a, '').toLowerCase();
          bVal = companyDisplayName(b, '').toLowerCase();
          break;
        case 'segment':
          aVal = (a.segment || '').toLowerCase();
          bVal = (b.segment || '').toLowerCase();
          break;
        case 'revenue':
          aVal = latestFin(a.financials_raw, 'revenue_usd_mn').value ?? 0;
          bVal = latestFin(b.financials_raw, 'revenue_usd_mn').value ?? 0;
          break;
        case 'ebitda':
          aVal = latestFin(a.financials_raw, 'ebitda_usd_mn').value ?? 0;
          bVal = latestFin(b.financials_raw, 'ebitda_usd_mn').value ?? 0;
          break;
        case 'valuation':
          aVal = a.ev_2024 || 0;
          bVal = b.ev_2024 || 0;
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [results, favoriteIds, sortField, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedResults.length / ITEMS_PER_PAGE));
  const paginatedResults = sortedResults.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [sortField, sortDirection]);

  const ModernHeader = ({ showDescription = false }: { showDescription?: boolean }) => (
    <CardHeader className="pb-4 relative">
      <div className="absolute -top-10 -right-10 w-32 h-32 bg-purple-400/20 dark:bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-5 -left-5 w-24 h-24 bg-violet-400/15 dark:bg-violet-500/10 rounded-full blur-2xl pointer-events-none" />

      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <div className={cn(
              "flex h-12 w-12 items-center justify-center rounded-2xl shadow-xl transition-all duration-300 group-hover:scale-105",
              "bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-500"
            )}>
              <Target className="h-6 w-6 text-white" />
            </div>
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-500 animate-ping opacity-20" />
            <div className="absolute inset-0 rounded-2xl bg-purple-500/30 blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <CardTitle className="text-lg font-bold tracking-tight bg-gradient-to-r from-purple-700 via-violet-600 to-fuchsia-600 dark:from-purple-300 dark:via-violet-300 dark:to-fuchsia-300 bg-clip-text text-transparent">
                AI-Discovered Companies
              </CardTitle>
              <Badge variant="outline" className="bg-purple-100/80 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300 text-[10px] px-2 py-0.5 h-5">
                <Zap className="h-2.5 w-2.5 mr-1" />
                AI Powered
              </Badge>
            </div>
            <CardDescription>
              {showDescription ? "Companies matching your investment thesis will appear here" : `${results.length} companies matching your investment thesis`}
            </CardDescription>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Visibility toggle — always rightmost */}
          {onToggleCollapse && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleCollapse}
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
            >
              {collapsed ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {collapsed ? 'Show' : 'Hide'}
              {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      </div>
    </CardHeader>
  );

  if (loading) {
    return (
      <Card className="relative overflow-hidden border-purple-200 dark:border-purple-800/50 bg-gradient-to-br from-purple-50/50 via-violet-50/30 to-fuchsia-50/20 dark:from-purple-950/30 dark:via-violet-950/20 dark:to-fuchsia-950/10 shadow-lg shadow-purple-500/5">
        <ModernHeader />
        {!collapsed && (
          <CardContent>
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
            </div>
          </CardContent>
        )}
      </Card>
    );
  }

  if (results.length === 0) {
    return (
      <Card className="relative overflow-hidden border-purple-200 dark:border-purple-800/50 bg-gradient-to-br from-purple-50/50 via-violet-50/30 to-fuchsia-50/20 dark:from-purple-950/30 dark:via-violet-950/20 dark:to-fuchsia-950/10 shadow-lg shadow-purple-500/5">
        <ModernHeader showDescription />
        {!collapsed && (
          <CardContent>
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <div className="relative mb-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-200 to-violet-200 dark:from-purple-800/50 dark:to-violet-800/50">
                  <Sparkles className="h-8 w-8 text-purple-500 dark:text-purple-400" />
                </div>
              </div>
              <p className="font-medium">No companies discovered yet</p>
              <p className="text-sm">Configure your investment thesis and run a scan</p>
            </div>
          </CardContent>
        )}
      </Card>
    );
  }

  // Helper for sorting buttons
  const SortButton = ({ field, label, align = "left" }: { field: string, label: string, align?: "left" | "right" }) => (
    <button
      onClick={() => toggleSort(field)}
      className={cn(
        "flex items-center hover:text-foreground transition-colors group",
        align === "right" && "justify-end w-full"
      )}
    >
      {label}
      <span className="ml-1 text-muted-foreground/50 group-hover:text-foreground/80">
        <ArrowUpDown className="h-3 w-3" />
      </span>
    </button>
  );

  return (
    <Card className="relative overflow-hidden border-purple-200 dark:border-purple-800/50 bg-gradient-to-br from-purple-50/50 via-violet-50/30 to-fuchsia-50/20 dark:from-purple-950/30 dark:via-violet-950/20 dark:to-fuchsia-950/10 shadow-lg shadow-purple-500/5">
      <ModernHeader />

      <CardContent>
        {!collapsed && (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[40px]"></TableHead>
                    <TableHead><SortButton field="target" label="Company" /></TableHead>
                    <TableHead><SortButton field="segment" label="Sector" /></TableHead>
                    <TableHead className="text-right"><SortButton field="revenue" label="Revenue" align="right" /></TableHead>
                    <TableHead className="text-right"><SortButton field="ebitda" label="EBITDA" align="right" /></TableHead>
                    <TableHead className="text-right"><SortButton field="valuation" label="Valuation" align="right" /></TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedResults.map((result) => {
                    const isFav = favoriteIds.has(result.id);
                    const displayName = companyDisplayName(result, "this company");
                    return (
                      <TableRow
                        key={result.id}
                        className={cn(
                          "transition-colors",
                          isFav
                            ? "bg-amber-50/60 dark:bg-amber-900/10 hover:bg-amber-100/60 dark:hover:bg-amber-900/20"
                            : "hover:bg-purple-50/50 dark:hover:bg-purple-900/10"
                        )}
                      >
                        <TableCell className="pr-0">
                          <AskAIButton
                            variant="icon"
                            label="Analyze using AI"
                            onClick={() =>
                              analyzeWithAI(
                                `Analyze ${displayName} and provide insights about it as a potential deal.`
                              )
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <button
                              onClick={() => {
                                setDetailInEdit(false);
                                setSelectedResult(result);
                                setDetailDialogOpen(true);
                              }}
                              className="font-medium text-left hover:text-purple-600 dark:hover:text-purple-400 transition-colors"
                            >
                              {displayName === "this company" ? "—" : displayName}
                            </button>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-muted-foreground">{result.segment || 'Unknown'}</span>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {(() => {
                            const rev = latestFin(result.financials_raw, 'revenue_usd_mn');
                            return rev.value === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <>
                                <div className="font-medium">{formatCurrency(rev.value)}</div>
                                {rev.year && <div className="text-[10px] text-muted-foreground">{rev.year}</div>}
                              </>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {(() => {
                            const ebitda = latestFin(result.financials_raw, 'ebitda_usd_mn');
                            return ebitda.value === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <>
                                <div className="font-medium">{formatCurrency(ebitda.value)}</div>
                                {ebitda.year && <div className="text-[10px] text-muted-foreground">{ebitda.year}</div>}
                              </>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium text-foreground">
                          {formatCurrency(result.ev_2024)}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setCompanyToPromote(result)}>
                                <ArrowRight className="mr-2 h-4 w-4" />
                                Add to L0
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setDetailInEdit(true);
                                  setSelectedResult(result);
                                  setDetailDialogOpen(true);
                                }}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => dismissResult(result.id)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                <span className="text-sm text-muted-foreground">
                  Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1}-{Math.min(currentPage * ITEMS_PER_PAGE, sortedResults.length)} of {sortedResults.length} companies
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm font-medium px-2">
                    {currentPage} / {totalPages}
                  </span>
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

            {selectedResult && (
              <CompanyDetailDialog
                company={{
                  id: selectedResult.id,
                  target: selectedResult.target,
                  project_name: selectedResult.project_name ?? null,
                  segment: selectedResult.segment,
                  website: selectedResult.website ?? null,
                  watchlist_status: null,
                  pipeline_stage: selectedResult.pipeline_stage as DealStage,
                  revenue_2021_usd_mn: selectedResult.revenue_2021_usd_mn,
                  revenue_2022_usd_mn: selectedResult.revenue_2022_usd_mn,
                  revenue_2023_usd_mn: selectedResult.revenue_2023_usd_mn,
                  revenue_2024_usd_mn: selectedResult.revenue_2024_usd_mn,
                  ebitda_2021_usd_mn: selectedResult.ebitda_2021_usd_mn,
                  ebitda_2022_usd_mn: selectedResult.ebitda_2022_usd_mn,
                  ebitda_2023_usd_mn: selectedResult.ebitda_2023_usd_mn,
                  ebitda_2024_usd_mn: selectedResult.ebitda_2024_usd_mn,
                  ev_2024: selectedResult.ev_2024,
                  l1_screening_result: null,
                  remarks: selectedResult.remarks,
                  created_at: selectedResult.created_at,
                  updated_at: selectedResult.created_at,
                  source: selectedResult.source,
                  status: null,
                  dropped_reason: null,
                  dropped_at: null,
                  promoted_reasons: null,
                  ownership: selectedResult.ownership,
                  geography: selectedResult.geography,
                  // Pipeline edit fields — must be passed through so the inline
                  // editor doesn't blank them on save (it reads from this prop).
                  deal_type: selectedResult.deal_type ?? null,
                  entered_by: selectedResult.entered_by ?? null,
                  entered_by_name: selectedResult.entered_by_name ?? null,
                  last_activity_at: selectedResult.last_activity_at ?? null,
                  banker: selectedResult.banker ?? null,
                  doc_type: selectedResult.doc_type ?? null,
                  stake: selectedResult.stake ?? null,
                  deal_size: selectedResult.deal_size ?? null,
                  workflow_status: selectedResult.workflow_status ?? null,
                  key_rationale: selectedResult.key_rationale ?? null,
                  deal_sponsor: selectedResult.deal_sponsor ?? null,
                  deal_captain: selectedResult.deal_captain ?? null,
                  matched_track_ids: selectedResult.matched_track_ids ?? null,
                  financials_raw: selectedResult.financials_raw,
                }}
                open={detailDialogOpen}
                onOpenChange={(open) => {
                  setDetailDialogOpen(open);
                  if (!open) setDetailInEdit(false);
                }}
                onUpdate={() => fetchResults({ silent: true })}
                initialTab={detailInEdit ? 'details' : 'overview'}
                initialEditing={detailInEdit}
              />
            )}
          </>
        )}
      </CardContent>

      {companyToPromote && (
        <PromoteDialog
          open={!!companyToPromote}
          onOpenChange={(open) => { if (!open) setCompanyToPromote(null); }}
          dealId={companyToPromote.id}
          companyName={companyDisplayName(companyToPromote, 'this company')}
          currentStage={companyToPromote.pipeline_stage as DealStage}
          nextStage="L0"
          onSuccess={() => {
            setCompanyToPromote(null);
            fetchResults({ silent: true });
            onAddedToPipeline();
          }}
        />
      )}

    </Card>
  );
}
