"use client";

import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { isDealLive } from "@/lib/dealStatus";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreVertical,
  ArrowRight,
  ArrowLeft,
  Pencil,
  Trash2,
  RotateCcw,
  Sparkles,
  Loader2,
} from "lucide-react";
import {
  ColumnHeaderContent,
  type FilterOption,
} from "@/components/pipeline/ColumnHeader";
import {
  useColumnLayout,
  ColumnManagerProvider,
  ManagedTableHeader,
  ManagedRowCells,
  ColumnConfigGear,
  type ColumnDef,
  type ColumnSort,
  type ColumnFilter,
} from "@/components/table";
import { cn } from "@/lib/utils";
import { useNearRightEdge } from "@/hooks/useNearRightEdge";
import type { Tables } from "@/lib/repositories";
import type { DealStage } from "@/lib/types";
import { PIPELINE_STAGES } from "@/lib/constants";
import type { PipelineCompany } from "@/views/Pipeline";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { useChatContext } from "@/components/chat/ChatProvider";
import { useLayoutControl } from "@/components/layout/LayoutControlContext";
import { AiOpinionCell } from "@/components/pipeline/AiOpinionCell";
import { companyDisplayName, companyDisplayTitle } from "@/lib/companyDisplay";
import {
  persistedTrackIds,
  trackDisplayName,
  matchedTrackPics,
  dealLeadField,
  dealLeadLabel,
  type TrackLike,
} from "@/lib/tracks/matchTracks";

/**
 * Read-only Deal Sponsor (L0–L2) / Deal Captain (L3+) cell. The stored
 * per-company override wins; when empty, the matched Track's PIC shows as the
 * (muted) default. Editing happens only in the company card, never inline.
 */
function DealLeadCell({
  company,
  tracks,
  stage,
}: {
  company: PipelineCompany;
  tracks: TrackLike[];
  stage: DealStage;
}) {
  const field = dealLeadField(stage);
  // The stored columns are uuid FKs; display uses the resolved user name.
  const stored = company[`${field}_name`];
  const fallbackPics = matchedTrackPics(company, tracks);
  const fallback = fallbackPics.length > 0 ? fallbackPics.join(", ") : null;
  return (
    <span className="text-sm text-muted-foreground">
      {stored || fallback || "—"}
    </span>
  );
}

/**
 * Matched-track pills for a company. Shows ONLY the persisted matches assigned
 * when the company entered L0 (never the live keyword heuristic), so editing &
 * saving Track Settings can't retroactively populate this column.
 */
function MatchedTracksCell({
  company,
  tracks,
}: {
  company: PipelineCompany;
  tracks: TrackLike[];
}) {
  const ids = persistedTrackIds(company, tracks);
  if (ids.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1 max-w-[180px]">
      {ids.map((id) => {
        const track = tracks.find((t) => t.id === id);
        if (!track) return null;
        return (
          <Badge
            key={id}
            variant="secondary"
            className="font-normal text-[10px] px-1.5 py-0 max-w-full truncate"
            title={track.title ?? undefined}
          >
            {trackDisplayName(track)}
          </Badge>
        );
      })}
    </div>
  );
}

const DEAL_TYPE_LABEL: Record<string, string> = {
  majority: "Majority",
  minority: "Minority",
};

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(2)}B`;
  return `$${value.toFixed(2)}M`;
};

/**
 * Current-year value for `key`, falling back to the nearest previous year when
 * the current year is missing. Forward (future) fiscal years are never shown.
 */
const latestFinValue = (
  rows: Tables<"company_financials">[] | undefined,
  key: "revenue_usd_mn" | "ebitda_usd_mn" | "ev_usd_mn",
): number | null => {
  if (!rows?.length) return null;
  const currentYear = new Date().getFullYear();
  let best: { value: number; year: number } | null = null;
  for (const r of rows) {
    const v = r[key] as number | null;
    if (v == null) continue;
    if (r.fiscal_year > currentYear) continue;
    if (!best || r.fiscal_year > best.year) best = { value: v, year: r.fiscal_year };
  }
  return best?.value ?? null;
};

/** Compose the Financial Info roll-up (Rev · EBITDA · EV) from company_financials. */
const composeFinancialInfo = (
  rows: Tables<"company_financials">[] | undefined,
): string => {
  const rev = latestFinValue(rows, "revenue_usd_mn");
  const ebitda = latestFinValue(rows, "ebitda_usd_mn");
  const ev = latestFinValue(rows, "ev_usd_mn");
  const parts: string[] = [];
  if (rev != null) parts.push(`Rev ${formatCurrency(rev)}`);
  if (ebitda != null) parts.push(`EBITDA ${formatCurrency(ebitda)}`);
  if (ev != null) parts.push(`EV ${formatCurrency(ev)}`);
  return parts.join(" · ");
};

const formatDate = (iso: string | null | undefined) => {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

interface OutboundCompaniesTableProps {
  companies: PipelineCompany[];
  tracks: TrackLike[];
  stage: DealStage;
  viewMode: "active" | "dropped";
  updatingCompanyIds: Set<string>;
  statusOptions: string[];
  sortField: string | null;
  sortDirection: "asc" | "desc";
  onSort: (field: string) => void;
  /** Direction-aware sort setter (used by the column right-click menu). */
  onSortColumn: (field: string, direction: "asc" | "desc") => void;
  columnFilters: Record<string, string[]>;
  filterOptions: Record<string, FilterOption[]>;
  onColumnFilterChange: (field: string, values: string[]) => void;
  onOpenDetail: (company: PipelineCompany) => void;
  onStatusChange: (company: PipelineCompany, next: string) => void;
  onUpdate: (company: PipelineCompany) => void;
  onPromote: (company: PipelineCompany) => void;
  onDemote: (company: PipelineCompany) => void;
  onDrop: (company: PipelineCompany) => void;
  onRestore: (company: PipelineCompany) => void;
  onRunScreening?: (company: PipelineCompany) => void;
  runningScreeningCompanyIds?: Set<string>;
  /** Hand a company to the AI Workforce to form a firm AI Opinion verdict. */
  onAnalyzeAiOpinion?: (company: PipelineCompany) => void;
  /** Company ids with an optimistic in-flight AI Opinion request. */
  analyzingAiOpinionIds?: Set<string>;
}

export default function OutboundCompaniesTable({
  companies,
  tracks,
  stage,
  viewMode,
  updatingCompanyIds,
  statusOptions,
  sortField,
  sortDirection,
  onSort,
  onSortColumn,
  columnFilters,
  filterOptions,
  onColumnFilterChange,
  onOpenDetail,
  onStatusChange,
  onUpdate,
  onPromote,
  onDemote,
  onDrop,
  onRestore,
  onRunScreening,
  runningScreeningCompanyIds,
  onAnalyzeAiOpinion,
  analyzingAiOpinionIds,
}: OutboundCompaniesTableProps) {
  const isDropped = viewMode === "dropped";
  const { analyzeWithAI } = useChatContext();
  const { focusCopilot } = useLayoutControl();
  const { nearEdge, edgeHandlers } = useNearRightEdge();

  // "Dive deeper" hands the existing AI Opinion verdict to the copilot and
  // reveals the pane (collapsing the main full-screen view) so the discussion
  // is immediately visible.
  const handleDiveDeeper = (c: PipelineCompany) => {
    const name = companyDisplayName(c, "this company");
    const verdict = c.ai_opinion_verdict ?? "unknown";
    const summary = c.ai_opinion_summary ?? "no summary available";
    analyzeWithAI(
      `Dive deeper into the AI Opinion for ${name}. The current verdict is "${verdict}" with the rationale: "${summary}". Explain the reasoning in more detail, surface the key risks and opportunities, and tell me what additional diligence would strengthen this assessment.`,
    );
    focusCopilot();
  };
  const stageIndex = PIPELINE_STAGES.indexOf(stage);
  const promoteTarget =
    stageIndex >= 0 && stageIndex < PIPELINE_STAGES.length - 1
      ? PIPELINE_STAGES[stageIndex + 1]
      : null;
  const demoteTarget =
    stageIndex > 0 ? PIPELINE_STAGES[stageIndex - 1] : null;
  const picColumnLabel = dealLeadLabel(stage);

  // Sort / filter descriptors for a managed column — surfaced in the column's
  // right-click menu by the managed header (left-click selects for grouping).
  const sortDesc = (field: string): ColumnSort => ({
    active: sortField === field,
    direction: sortDirection,
    onSort: (dir) => onSortColumn(field, dir),
  });
  const filterDesc = (field: string): ColumnFilter => ({
    options: filterOptions[field] ?? [],
    selected: columnFilters[field] ?? [],
    onChange: (values) => onColumnFilterChange(field, values),
  });

  // Managed (reorderable / hideable / groupable) data columns. The sticky
  // Ask-AI, Company, and Actions columns are pinned and rendered outside this
  // set. `viewMode` swaps the Status column for Last Status + Drop Reason.
  const columns = useMemo<ColumnDef<PipelineCompany>[]>(() => {
    const cols: ColumnDef<PipelineCompany>[] = [
      {
        id: "deal_lead",
        label: picColumnLabel,
        sort: sortDesc("deal_lead"), filter: filterDesc("deal_lead"),
        cell: (c) => <DealLeadCell company={c} tracks={tracks} stage={stage} />,
      },
      {
        id: "entered_by",
        label: "Entered by",
        sort: sortDesc("entered_by"), filter: filterDesc("entered_by"),
        cell: (c) => (
          <span className="text-sm text-muted-foreground">
            {c.entered_by_name || "—"}
          </span>
        ),
      },
      {
        id: "sector",
        label: "Segment",
        sort: sortDesc("sector"), filter: filterDesc("sector"),
        cell: (c) => (
          <span className="text-sm text-muted-foreground">{c.segment || "-"}</span>
        ),
      },
      {
        id: "matched_tracks",
        label: "Matched Tracks",
        headerClassName: "min-w-[150px]",
        cell: (c) => <MatchedTracksCell company={c} tracks={tracks} />,
      },
      {
        id: "deal_type",
        label: "Deal Type",
        sort: sortDesc("deal_type"), filter: filterDesc("deal_type"),
        cell: (c) =>
          c.deal_type ? (
            <Badge variant="outline" className="capitalize">
              {DEAL_TYPE_LABEL[c.deal_type] ?? c.deal_type}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "key_rationale",
        label: "Key Rationale",
        headerClassName: "max-w-[260px]",
        cellClassName: "max-w-[260px]",
        cell: (c) =>
          c.key_rationale ? (
            <p
              className="text-xs text-muted-foreground line-clamp-2 leading-snug"
              title={c.key_rationale}
            >
              {c.key_rationale}
            </p>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: "financial_info",
        label: "Financial Info",
        headerClassName: "min-w-[180px]",
        cellClassName: "min-w-[180px]",
        cell: (c) => {
          const finInfo = composeFinancialInfo(c.financials_raw);
          return finInfo ? (
            <span className="text-xs font-mono text-muted-foreground">
              {finInfo}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
    ];

    if (isDropped) {
      cols.push(
        {
          id: "last_status",
          label: "Last Status",
          cell: (c) => (
            <span className="text-sm text-muted-foreground">
              {c.workflow_status || "—"}
            </span>
          ),
        },
        {
          id: "dropped_reason",
          label: "Drop Reason",
          headerClassName: "min-w-[200px] max-w-[280px]",
          cellClassName: "min-w-[200px] max-w-[280px] align-top",
          cell: (c) =>
            c.dropped_reason ? (
              <p
                className="text-xs text-muted-foreground whitespace-normal break-words"
                title={c.dropped_reason}
              >
                {c.dropped_reason}
              </p>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        },
      );
    } else {
      cols.push({
        id: "status",
        label: "Status",
        sort: sortDesc("status"), filter: filterDesc("status"),
        headerClassName: "min-w-[160px]",
        cell: (c) => (
          <StatusCombobox
            variant="cell"
            value={c.workflow_status}
            options={statusOptions}
            placeholder="Set status…"
            onChange={(next) => onStatusChange(c, next)}
          />
        ),
      });
    }

    cols.push(
      {
        id: "remarks",
        label: "Additional Remarks",
        headerClassName: "min-w-[320px] max-w-[400px]",
        cellClassName: "min-w-[320px] max-w-[400px] align-top",
        cell: (c) =>
          c.remarks ? (
            <p
              className="text-xs text-muted-foreground whitespace-normal break-words"
              title={c.remarks}
            >
              {c.remarks}
            </p>
          ) : (
            <span className="text-xs text-muted-foreground">-</span>
          ),
      },
      {
        id: "is_live",
        label: "Live",
        sort: sortDesc("is_live"), filter: filterDesc("is_live"),
        headerClassName: "min-w-[90px]",
        cellClassName: "min-w-[90px]",
        cell: (c) =>
          isDealLive(c) ? (
            <Badge
              variant="outline"
              className="whitespace-nowrap border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              Live
            </Badge>
          ) : (
            <Badge variant="outline" className="whitespace-nowrap text-muted-foreground">
              Not live
            </Badge>
          ),
      },
      {
        id: "nbo_date",
        label: "NBO Date",
        sort: sortDesc("nbo_date"),
        cellClassName: "text-muted-foreground text-sm whitespace-nowrap",
        cell: (c) => formatDate(c.nbo_date ? `${c.nbo_date}T00:00:00` : null),
      },
      {
        id: "created",
        label: "Created",
        sort: sortDesc("created"),
        cellClassName: "text-muted-foreground text-sm whitespace-nowrap",
        cell: (c) => formatDate(c.created_at),
      },
      {
        id: "last_activity",
        label: isDropped ? "Dropped On" : "Last Activity",
        sort: sortDesc(isDropped ? "dropped_on" : "last_activity"),
        cellClassName: "text-muted-foreground text-sm whitespace-nowrap",
        cell: (c) => formatDate(isDropped ? c.dropped_at : c.last_activity_at),
      },
      {
        id: "ai_opinion",
        label: "AI Opinion",
        headerClassName: "min-w-[300px] max-w-[390px]",
        cellClassName: "h-px min-w-[300px] max-w-[390px] align-top",
        cell: (c) =>
          onAnalyzeAiOpinion ? (
            <AiOpinionCell
              company={c}
              analyzing={analyzingAiOpinionIds?.has(c.id) ?? false}
              onAnalyze={onAnalyzeAiOpinion}
              onDiveDeeper={handleDiveDeeper}
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    );
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isDropped,
    picColumnLabel,
    stage,
    tracks,
    statusOptions,
    sortField,
    sortDirection,
    onSortColumn,
    columnFilters,
    filterOptions,
    analyzingAiOpinionIds,
    onAnalyzeAiOpinion,
  ]);

  const mgr = useColumnLayout(`pipeline-outbound:${viewMode}`, columns);

  // colSpan for the empty-state row: 2 pinned leading (Ask-AI + Company) +
  // visible managed columns + 1 pinned trailing (Actions).
  const fullColSpan = 3 + mgr.visibleCount;

  return (
    <ColumnManagerProvider value={mgr}>
      {/* Gear is portaled into the shared filter row (see Pipeline.tsx). */}
      <ColumnConfigGear portalTargetId="pipeline-columns-config" />
      <Table {...edgeHandlers}>
        <ManagedTableHeader
          leading={[
            <TableHead
              key="askai"
              className="w-[40px] sticky left-0 z-20 bg-card"
            />,
            <TableHead
              key="company"
              className="sticky left-[40px] z-20 bg-card border-r"
            >
              <ColumnHeaderContent
                label="Company"
                sortField="name"
                activeSortField={sortField}
                sortDirection={sortDirection}
                onSort={onSort}
              />
            </TableHead>,
          ]}
          trailing={
            <TableHead
              key="actions"
              className="w-[44px] sticky right-0 z-20 bg-transparent"
            />
          }
        />
      <TableBody>
        {companies.length === 0 && (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={fullColSpan}
              className="h-32 text-center text-sm text-muted-foreground"
            >
              No companies match the current filters.
            </TableCell>
          </TableRow>
        )}
        {companies.map((company, index) => {
          const stickyBg = "bg-card group-hover:bg-muted";
          const isUpdating = updatingCompanyIds.has(company.id);
          // AI screening runs only against a company's explicitly matched
          // tracks; with none matched there is nothing to screen, so the action
          // is disabled.
          const hasMatchedTracks =
            persistedTrackIds(company, tracks).length > 0;
          const displayName = companyDisplayName(company, "this company");
          const displayTitle = companyDisplayTitle(company, "");
          return (
            <TableRow
              key={company.id}
              className={cn(
                "group transition-colors hover:bg-muted/50",
                isUpdating && "animate-pulse opacity-60",
              )}
            >
              <TableCell className={cn("pr-0 sticky left-0 z-10", stickyBg)}>
                <AskAIButton
                  variant="icon"
                  label="Analyze using AI"
                  onClick={() =>
                    analyzeWithAI(
                      `Analyze ${displayName} and provide insights about it as a potential deal.`,
                    )
                  }
                />
              </TableCell>
              <TableCell className={cn("sticky left-[40px] z-10 border-r", stickyBg)}>
                {displayTitle ? (
                  <button
                    onClick={() => onOpenDetail(company)}
                    className="font-medium text-left hover:text-primary hover:underline transition-colors"
                  >
                    {displayTitle}
                  </button>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <ManagedRowCells row={company} index={index} />
              <TableCell className="text-right sticky right-0 z-10 bg-transparent">
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
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {isDropped ? (
                      <>
                        <DropdownMenuItem onClick={() => onUpdate(company)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Update
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onRestore(company)}>
                          <RotateCcw className="mr-2 h-4 w-4" />
                          Restore deal
                        </DropdownMenuItem>
                      </>
                    ) : (
                      <>
                        {onRunScreening && (
                          <>
                            {runningScreeningCompanyIds?.has(company.id) ? (
                              <DropdownMenuItem
                                disabled
                                className="text-muted-foreground"
                              >
                                <Loader2 className="mr-2 h-4 w-4 animate-spin text-purple-600" />
                                AI Screening Running
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                disabled={!hasMatchedTracks}
                                onClick={() => onRunScreening(company)}
                                title={
                                  hasMatchedTracks
                                    ? undefined
                                    : "No matched tracks to screen against"
                                }
                              >
                                <Sparkles className="mr-2 h-4 w-4 text-purple-600" />
                                Run AI Screening
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                          </>
                        )}
                        {promoteTarget && (
                          <DropdownMenuItem onClick={() => onPromote(company)}>
                            <ArrowRight className="mr-2 h-4 w-4" />
                            Promote to {promoteTarget}
                          </DropdownMenuItem>
                        )}
                        {demoteTarget && (
                          <DropdownMenuItem onClick={() => onDemote(company)}>
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            Demote to {demoteTarget}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => onUpdate(company)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Update
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => onDrop(company)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                          Drop deal
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      </Table>
    </ColumnManagerProvider>
  );
}
