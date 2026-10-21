import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/table';
import { ColumnHeaderContent } from '@/components/pipeline/ColumnHeader';
import {
  useColumnLayout,
  ColumnManagerProvider,
  ManagedTableHeader,
  ManagedRowCells,
  ColumnConfigGear,
  type ColumnDef,
} from '@/components/table';
import { toast } from 'sonner';
import { Loader2, Zap, Target, Sparkles, Trash2, ChevronLeft, ChevronRight, ArrowRight, Inbox, Users } from 'lucide-react';
import CompanyDetailDialog from './CompanyDetailDialog';
import PromoteDialog from './PromoteDialog';
import {
  PipelineRowActions,
  stickyActionsCellClass,
  stickyActionsHeadClass,
  stickyCompanyCellClass,
  stickyCompanyHeadClass,
} from '@/components/pipeline/PipelineRowActions';
import { useChatActions } from '@/components/chat/ChatProvider';
import { cn } from '@/lib/utils';
import { companyDisplayName } from '@/lib/companyDisplay';
import { DealStage } from '@/lib/types';
import { deleteCompanyById, getCompanies, promoteCompany } from '@/lib/api/pipeline';
import { UNREVIEWED_STAGE } from '@/lib/constants';
import {
  findCompaniesContacts,
  findCompanyContacts,
  getCompaniesContacts,
  type CompanyContactsState,
} from '@/lib/api/companyContacts';
import { CompanyContactCell } from './CompanyContactCell';

// Sticky cells follow this table's blue row hover with an opaque tint.
const stickyHoverClass = 'group-hover:bg-blue-50 dark:group-hover:bg-blue-950';

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
  // uuid FKs to users.id; `*_name` carries the resolved display name.
  deal_sponsor: string | null;
  deal_sponsor_name?: string | null;
  deal_captain: string | null;
  deal_captain_name?: string | null;
  matched_track_ids?: string[] | null;
  track_specific_variables?: Record<string, Record<string, string>> | null;
  slide_track_variable_ids?: string[] | null;

  financials_raw?: import('@/lib/repositories').Tables<'company_financials'>[];
}

interface MarketScreeningResultsProps {
  refreshTrigger: number;
  onAddedToPipeline: () => void;
}

/** Re-read the page's contacts this often while any of its searches is running. */
const CONTACTS_POLL_MS = 5_000;
const ITEMS_PER_PAGE = 10;

export default function MarketScreeningResults({ refreshTrigger, onAddedToPipeline }: MarketScreeningResultsProps) {
  const { analyzeWithAI } = useChatActions();
  const [results, setResults] = useState<MarketScreeningResult[]>([]);
  const [loading, setLoading] = useState(true);
  // Open state is derived from `selectedResult` (not a separate boolean) so the
  // dialog unmounts on close. Keeping it mounted preserves the previous
  // company's fetched analysis/notes/documents, which then flash on the next
  // open before the newly selected company's data arrives.
  const [selectedResult, setSelectedResult] = useState<MarketScreeningResult | null>(null);
  // When true, the detail dialog opens straight into inline edit mode (Details tab).
  const [detailInEdit, setDetailInEdit] = useState(false);
  const [companyToPromote, setCompanyToPromote] = useState<MarketScreeningResult | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);

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

  useEffect(() => {
    fetchResults();
  }, [refreshTrigger]);

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

  // Ids currently being moved to Pending Confirmation, so a double click can't
  // fire the move twice.
  const [movingToPendingIds, setMovingToPendingIds] = useState<Set<string>>(new Set());

  const moveToPendingConfirmation = async (result: MarketScreeningResult) => {
    if (movingToPendingIds.has(result.id)) return;
    setMovingToPendingIds((prev) => new Set(prev).add(result.id));
    try {
      await promoteCompany(result.id, {
        currentStage: result.pipeline_stage,
        nextStage: UNREVIEWED_STAGE,
      });
      toast.success(`${companyDisplayName(result, 'Company')} added to Pending Confirmation`);
      fetchResults({ silent: true });
      onAddedToPipeline();
    } catch (error: any) {
      console.error('Error adding to Pending Confirmation:', error);
      toast.error(`Failed to add to Pending Confirmation: ${error?.message || 'Unknown error'}`);
    } finally {
      setMovingToPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(result.id);
        return next;
      });
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
        default:
          return 0;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [results, sortField, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedResults.length / ITEMS_PER_PAGE));
  const paginatedResults = sortedResults.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [sortField, sortDirection]);

  // Contacts for the visible page, keyed by company id — one batched request
  // per page, never one per row.
  const [contactsById, setContactsById] = useState<Record<string, CompanyContactsState>>({});
  const [startingIds, setStartingIds] = useState<Set<string>>(new Set());
  const [bulkFinding, setBulkFinding] = useState(false);
  const pageIds = useMemo(() => paginatedResults.map((r) => r.id), [paginatedResults]);
  const pageIdsKey = pageIds.join(',');
  const pageIdsRef = useRef(pageIds);
  pageIdsRef.current = pageIds;

  const loadContacts = useCallback(async () => {
    const ids = pageIdsRef.current;
    if (ids.length === 0) return;
    try {
      const states = await getCompaniesContacts(ids);
      setContactsById((prev) => ({ ...prev, ...states }));
    } catch (error) {
      console.error('Error loading contacts:', error);
    }
  }, []);

  useEffect(() => {
    void loadContacts();
  }, [pageIdsKey, refreshTrigger, loadContacts]);

  const anySearching = pageIds.some((id) => contactsById[id]?.run?.active);
  useEffect(() => {
    if (!anySearching) return;
    const timer = setInterval(() => void loadContacts(), CONTACTS_POLL_MS);
    return () => clearInterval(timer);
  }, [anySearching, loadContacts]);

  const findContacts = async (result: MarketScreeningResult) => {
    if (startingIds.has(result.id)) return;
    setStartingIds((prev) => new Set(prev).add(result.id));
    try {
      const { created: _created, ...run } = await findCompanyContacts(result.id);
      setContactsById((prev) => {
        const current = prev[result.id];
        return {
          ...prev,
          [result.id]: {
            employer: current?.employer ?? null,
            contacts: current?.contacts ?? [],
            totalContacts: current?.totalContacts ?? 0,
            run,
          },
        };
      });
    } catch (error) {
      toast.error((error as Error).message || 'Could not start the contact search');
    } finally {
      setStartingIds((prev) => {
        const next = new Set(prev);
        next.delete(result.id);
        return next;
      });
    }
  };

  // Backfill, one page at a time (each search is an agent run; the endpoint
  // takes at most a page — MAX_BULK_CONTACT_DISCOVERY): search the visible
  // companies that have no contacts and were never successfully searched.
  // The server decides which ones that is.
  const findMissingContactsOnPage = async () => {
    setBulkFinding(true);
    try {
      const { queued } = await findCompaniesContacts(pageIds, { onlyMissing: true });
      toast.info(
        queued.length > 0
          ? `Looking for contacts at ${queued.length} compan${queued.length === 1 ? 'y' : 'ies'}…`
          : 'Every company on this page already has contacts or a contact search',
      );
      await loadContacts();
    } catch (error) {
      toast.error((error as Error).message || 'Could not start the contact searches');
    } finally {
      setBulkFinding(false);
    }
  };

  // Header content (sort controls) for a managed column, without the
  // surrounding <TableHead> (the managed header supplies that).
  const colHeader = (
    label: string,
    opts: { sort?: string } = {},
  ) => (
    <ColumnHeaderContent
      label={label}
      sortField={opts.sort}
      activeSortField={sortField}
      sortDirection={sortDirection}
      onSort={opts.sort ? toggleSort : undefined}
    />
  );

  // Managed (reorderable / hideable / groupable) data columns. The Company
  // and Actions columns are pinned and rendered outside this set.
  const columns = useMemo<ColumnDef<MarketScreeningResult>[]>(() => [
    {
      id: 'segment',
      label: 'Sector',
      header: colHeader('Sector', { sort: 'segment' }),
      cell: (result) => (
        <span className="text-muted-foreground">{result.segment || 'Unknown'}</span>
      ),
    },
    {
      id: 'contact',
      label: 'Contact',
      header: colHeader('Contact'),
      cell: (result) => (
        <CompanyContactCell
          state={contactsById[result.id]}
          starting={startingIds.has(result.id)}
          onFind={() => void findContacts(result)}
        />
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [sortField, sortDirection, contactsById, startingIds]);

  const mgr = useColumnLayout('market-screening-results', columns);

  const ModernHeader = ({ showDescription = false }: { showDescription?: boolean }) => (
    <CardHeader className="pb-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <div className={cn(
              "flex h-12 w-12 items-center justify-center rounded-2xl shadow-xl transition-all duration-300 group-hover:scale-105",
              "bg-gradient-to-br from-blue-500 via-blue-500 to-blue-500"
            )}>
              <Target className="h-6 w-6 text-white" />
            </div>
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-blue-500 via-blue-500 to-blue-500 animate-ping opacity-20" />
            <div className="absolute inset-0 rounded-2xl bg-blue-500/30 blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <CardTitle className="text-lg font-bold tracking-tight bg-gradient-to-r from-blue-700 via-blue-600 to-blue-600 dark:from-blue-300 dark:via-blue-300 dark:to-blue-300 bg-clip-text text-transparent">
                AI-Discovered Companies
              </CardTitle>
              <Badge variant="outline" className="bg-blue-100/80 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 text-[10px] px-2 py-0.5 h-5">
                <Zap className="h-2.5 w-2.5 mr-1" />
                AI Powered
              </Badge>
            </div>
            <CardDescription>
              {showDescription ? "Companies matching your investment thesis will appear here" : `${results.length} companies matching your investment thesis`}
            </CardDescription>
          </div>
        </div>
      </div>
    </CardHeader>
  );

  if (loading) {
    return (
      <Card className="relative overflow-hidden shadow-md">
        <ModernHeader />
        <CardContent>
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (results.length === 0) {
    return (
      <Card className="relative overflow-hidden shadow-md">
        <ModernHeader showDescription />
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <div className="relative mb-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-200 to-blue-200 dark:from-blue-800/50 dark:to-blue-800/50">
                <Sparkles className="h-8 w-8 text-blue-500 dark:text-blue-400" />
              </div>
            </div>
            <p className="font-medium">No companies discovered yet</p>
            <p className="text-sm">Configure your investment thesis and run a scan</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="relative overflow-hidden shadow-md">
      <ModernHeader />

      <CardContent>
        <ColumnManagerProvider value={mgr}>
          <div className="flex items-center justify-end gap-2 px-2 py-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => void findMissingContactsOnPage()}
              disabled={bulkFinding}
              data-testid="market-screening-find-all-contacts"
            >
              {bulkFinding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
              Find missing contacts on this page
            </Button>
            <ColumnConfigGear />
          </div>
          <div className="overflow-x-auto">
            <Table>
              <ManagedTableHeader
                rowClassName="hover:bg-transparent"
                leading={[
                  <TableHead key="company" className={stickyCompanyHeadClass}>
                    <ColumnHeaderContent
                      label="Company"
                      sortField="target"
                      activeSortField={sortField}
                      sortDirection={sortDirection}
                      onSort={toggleSort}
                    />
                  </TableHead>,
                ]}
                trailing={
                  <TableHead key="actions" className={stickyActionsHeadClass}>
                    Actions
                  </TableHead>
                }
              />
              <TableBody>
                {paginatedResults.map((result, index) => {
                  const displayName = companyDisplayName(result, "this company");
                  return (
                    <TableRow
                      key={result.id}
                      className={cn(
                        "group transition-colors hover:bg-blue-50/50 dark:hover:bg-blue-900/10"
                      )}
                    >
                      <TableCell className={cn(stickyCompanyCellClass, stickyHoverClass)}>
                        <div className="flex flex-col">
                          <button
                            onClick={() => {
                              setDetailInEdit(false);
                              setSelectedResult(result);
                            }}
                            className="font-medium text-left hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                          >
                            {displayName === "this company" ? "—" : displayName}
                          </button>
                        </div>
                      </TableCell>
                      <ManagedRowCells row={result} index={index} />
                      <TableCell className={cn(stickyActionsCellClass, stickyHoverClass)}>
                        <PipelineRowActions
                          editLabel="Edit"
                          onEdit={() => {
                            setDetailInEdit(true);
                            setSelectedResult(result);
                          }}
                          onView={() => {
                            setDetailInEdit(false);
                            setSelectedResult(result);
                          }}
                          onAsk={() =>
                            analyzeWithAI(
                              `Analyze ${displayName} and provide insights about it as a potential deal.`
                            )
                          }
                          moveItems={[
                            {
                              key: 'add',
                              label: 'Add to L0',
                              icon: ArrowRight,
                              onSelect: () => setCompanyToPromote(result),
                            },
                            {
                              key: 'pending',
                              label: 'Add to Pending Confirmation',
                              icon: movingToPendingIds.has(result.id) ? Loader2 : Inbox,
                              iconClassName: movingToPendingIds.has(result.id) ? 'animate-spin' : undefined,
                              disabled: movingToPendingIds.has(result.id),
                              onSelect: () => moveToPendingConfirmation(result),
                            },
                            {
                              key: 'delete',
                              label: 'Delete',
                              icon: Trash2,
                              onSelect: () => dismissResult(result.id),
                              destructive: true,
                              separatorBefore: true,
                            },
                          ]}
                        />
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
              key={selectedResult.id}
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
                deal_sponsor_name: selectedResult.deal_sponsor_name ?? null,
                deal_captain: selectedResult.deal_captain ?? null,
                deal_captain_name: selectedResult.deal_captain_name ?? null,
                matched_track_ids: selectedResult.matched_track_ids ?? null,
                track_specific_variables: selectedResult.track_specific_variables ?? null,
                slide_track_variable_ids: selectedResult.slide_track_variable_ids ?? null,
                financials_raw: selectedResult.financials_raw,
              }}
              open={!!selectedResult}
              onOpenChange={(open) => {
                if (!open) {
                  setSelectedResult(null);
                  setDetailInEdit(false);
                }
              }}
              onUpdate={() => fetchResults({ silent: true })}
              initialTab={detailInEdit ? 'details' : 'overview'}
              initialEditing={detailInEdit}
            />
          )}
        </ColumnManagerProvider>
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
