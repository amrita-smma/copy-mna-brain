"use client";

import { Fragment, useMemo } from "react";
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
  Landmark,
  Inbox,
  XCircle,
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
import { DuplicatePopup } from "@/components/pipeline/DuplicatePopup";
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
  const stored = company[field];
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

/**
 * Current-year value for `key`, falling back to the nearest previous year when
 * the current year is missing. Forward (future) fiscal years are never shown.
 */
const latestFin = (
  rows: Tables<"company_financials">[] | undefined,
  key: "revenue_usd_mn" | "ebitda_usd_mn",
): { value: number | null; year: number | null } => {
  if (!rows?.length) return { value: null, year: null };
  const currentYear = new Date().getFullYear();
  let best: { value: number; year: number } | null = null;
  for (const r of rows) {
    const v = r[key] as number | null;
    if (v == null) continue;
    if (r.fiscal_year > currentYear) continue;
    if (!best || r.fiscal_year > best.year)
      best = { value: v, year: r.fiscal_year };
  }
  return best ?? { value: null, year: null };
};

interface InboundCompaniesTableProps {
  companies: PipelineCompany[];
  tracks: TrackLike[];
  stage: DealStage;
  viewMode: "active" | "dropped";
  favoriteIds: Set<string>;
  togglingFavorite: string | null;
  onToggleFavorite: (id: string) => void;
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
  /** Group rows into Unreviewed/Reviewed sections with banner headers. Default true. */
  groupByReviewState?: boolean;
  onTriageAll?: () => void;
  onKeep?: (company: PipelineCompany) => void | Promise<void>;
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

export default function InboundCompaniesTable({
  companies,
  tracks,
  stage,
  viewMode,
  favoriteIds,
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
  groupByReviewState = true,
  onTriageAll,
  onKeep,
  onUpdate,
  onPromote,
  onDemote,
  onDrop,
  onRestore,
  onRunScreening,
  runningScreeningCompanyIds,
  onAnalyzeAiOpinion,
  analyzingAiOpinionIds,
}: InboundCompaniesTableProps) {
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
  // set. `viewMode` swaps the Status column for Source + Drop Reason.
  const columns = useMemo<ColumnDef<PipelineCompany>[]>(() => {
    const numeric = "text-right font-mono";
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
        id: "banker",
        label: "Banker / Source",
        sort: sortDesc("banker"), filter: filterDesc("banker"),
        headerClassName: "min-w-[160px]",
        cellClassName: "max-w-[220px]",
        cell: (c) => {
          const bankerLabel = c.banker ?? c.banker_source;
          return bankerLabel ? (
            <span
              className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              title={bankerLabel}
            >
              <Landmark className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">{bankerLabel}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        id: "advisor",
        label: "Advisor",
        sort: sortDesc("advisor"), filter: filterDesc("advisor"),
        headerClassName: "min-w-[170px]",
        cellClassName: "max-w-[220px]",
        cell: (c) =>
          c.advisor ? (
            <span
              className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              title={c.advisor}
            >
              <Landmark className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">{c.advisor}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
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
        id: "sector",
        label: "Sector",
        sort: sortDesc("sector"), filter: filterDesc("sector"),
        cell: (c) => (
          <span className="text-sm text-muted-foreground">{c.segment || "-"}</span>
        ),
      },
      {
        id: "geo",
        label: "Geo",
        sort: sortDesc("geo"), filter: filterDesc("geo"),
        cell: (c) => (
          <span className="text-sm text-muted-foreground">{c.geo || "-"}</span>
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
        filter: filterDesc("deal_type"),
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
        id: "revenue",
        label: "Revenue",
        sort: sortDesc("revenue"),
        cellClassName: numeric,
        cell: (c) => {
          const rev = latestFin(c.financials_raw, "revenue_usd_mn");
          return rev.value === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <>
              <div className="font-medium">{formatCurrency(rev.value)}</div>
              {rev.year && (
                <div className="text-[10px] text-muted-foreground">{rev.year}</div>
              )}
            </>
          );
        },
      },
      {
        id: "ebitda",
        label: "EBITDA",
        sort: sortDesc("ebitda"),
        cellClassName: numeric,
        cell: (c) => {
          const ebitda = latestFin(c.financials_raw, "ebitda_usd_mn");
          return ebitda.value === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <>
              <div className="font-medium">{formatCurrency(ebitda.value)}</div>
              {ebitda.year && (
                <div className="text-[10px] text-muted-foreground">
                  {ebitda.year}
                </div>
              )}
            </>
          );
        },
      },
      {
        id: "valuation",
        label: "Valuation",
        sort: sortDesc("valuation"),
        cellClassName: numeric,
        cell: (c) => formatCurrency(c.ev_2024),
      },
      {
        id: "stake",
        label: "% Stake",
        sort: sortDesc("stake"), filter: filterDesc("stake"),
        cell: (c) => (
          <span className="text-sm text-muted-foreground">{c.stake || "-"}</span>
        ),
      },
    ];

    if (isDropped) {
      cols.push(
        {
          id: "source",
          label: "Source",
          cell: (c) => (
            <span className="text-sm text-muted-foreground">
              {c.source || "-"}
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
            placeholder="Unreviewed"
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

  const mgr = useColumnLayout(`pipeline-inbound:${viewMode}`, columns);

  // colSpan for the section header / gap / empty rows: 2 pinned leading
  // (Ask-AI + Company) + visible managed columns + 1 pinned trailing (Actions).
  const fullColSpan = 3 + mgr.visibleCount;
  const unreviewedCompanies = isDropped
    ? []
    : companies.filter((company) => company.pipeline_stage === "unreviewed");
  const reviewedCompanies = isDropped
    ? []
    : companies.filter((company) => company.pipeline_stage !== "unreviewed");
  const showReviewGroups =
    groupByReviewState &&
    !isDropped &&
    (unreviewedCompanies.length > 0 || reviewedCompanies.length > 0);
  const groupedCompanies = showReviewGroups
    ? [...unreviewedCompanies, ...reviewedCompanies]
    : companies;

  const sectionHeader = () => {
    const count = unreviewedCompanies.length;

    return (
      <TableRow className="select-none">
        <TableCell
          colSpan={fullColSpan}
          className={cn(
            "border-y px-4 py-2 text-xs font-semibold",
            "border-amber-200 bg-amber-50/90 text-amber-900",
          )}
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-amber-200 bg-amber-100 text-amber-700">
              <Inbox className="h-3.5 w-3.5" />
            </span>
            <div className="flex min-w-fit items-center gap-2">
              <span className="uppercase tracking-wide">Unreviewed</span>
              <span className="rounded-full border border-amber-200 bg-white/70 px-2 py-0.5 text-[11px] leading-none text-amber-800">
                {count} {count === 1 ? "company" : "companies"}
              </span>
              <span className="hidden text-[11px] font-medium normal-case tracking-normal text-amber-700 md:inline">
                from banker emails this week
              </span>
            </div>
            <span className="h-px flex-1 bg-amber-200" />
            {onTriageAll && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] font-semibold uppercase tracking-wide text-amber-700 hover:bg-amber-100 hover:text-amber-900"
                onClick={onTriageAll}
              >
                Triage all &gt;
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
    );
  };

  const sectionGap = () => (
    <TableRow className="select-none hover:bg-transparent">
      <TableCell
        colSpan={fullColSpan}
        className="h-3 border-0 bg-background p-0"
      />
    </TableRow>
  );

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
        {groupedCompanies.length === 0 && (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={fullColSpan}
              className="h-32 text-center text-sm text-muted-foreground"
            >
              No companies match the current filters.
            </TableCell>
          </TableRow>
        )}
        {groupedCompanies.map((company, index) => {
          const isFav = favoriteIds.has(company.id);
          const stickyBg = isFav
            ? "bg-amber-50 group-hover:bg-amber-100 dark:bg-amber-950 dark:group-hover:bg-amber-900"
            : "bg-card group-hover:bg-muted";
          const isUpdating = updatingCompanyIds.has(company.id);
          const rev = latestFin(company.financials_raw, "revenue_usd_mn");
          const ebitda = latestFin(company.financials_raw, "ebitda_usd_mn");
          const isUnreviewed = company.pipeline_stage === "unreviewed";
          // AI screening runs only against a company's explicitly matched
          // tracks; with none matched there is nothing to screen, so the action
          // is disabled.
          const hasMatchedTracks =
            persistedTrackIds(company, tracks).length > 0;
          const displayName = companyDisplayName(company, "this company");
          const displayTitle = companyDisplayTitle(company, "");
          const hasFinancials =
            rev.value != null ||
            ebitda.value != null ||
            company.revenue_2024_usd_mn != null ||
            company.ebitda_2024_usd_mn != null;
          const hasFlags =
            isUnreviewed &&
            (!!company.possible_duplicate_company_id || !hasFinancials);
          const previousCompany = groupedCompanies[index - 1];
          const startsUnreviewedSection =
            showReviewGroups &&
            isUnreviewed &&
            (!previousCompany ||
              previousCompany.pipeline_stage !== "unreviewed");
          const startsReviewedSection =
            showReviewGroups &&
            !isUnreviewed &&
            (!previousCompany ||
              previousCompany.pipeline_stage === "unreviewed");

          return (
            <Fragment key={company.id}>
              {startsUnreviewedSection && sectionHeader()}
              {startsReviewedSection &&
                unreviewedCompanies.length > 0 &&
                sectionGap()}
              <TableRow
                className={cn(
                  "group transition-colors",
                  isFav
                    ? "bg-amber-50/60 dark:bg-amber-900/10 hover:bg-amber-100/60 dark:hover:bg-amber-900/20"
                    : "hover:bg-muted/50",
                  isUpdating && "animate-pulse opacity-60",
                )}
              >
              <TableCell
                className={cn(
                  "pr-0 sticky left-0 z-10",
                  isUnreviewed && "border-l-2 border-l-amber-400",
                  stickyBg,
                )}
              >
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
                  <>
                    <button
                      onClick={() => onOpenDetail(company)}
                      className="font-medium text-left hover:text-primary hover:underline transition-colors"
                    >
                      {displayTitle}
                    </button>
                    {hasFlags && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {company.possible_duplicate_company_id && (
                          <DuplicatePopup
                            possibleDuplicateId={
                              company.possible_duplicate_company_id
                            }
                          />
                        )}
                        {!hasFinancials && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                            <XCircle className="h-3.5 w-3.5" />
                            Financials missing
                          </span>
                        )}
                      </div>
                    )}
                  </>
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
                    ) : isUnreviewed ? (
                      // Unreviewed inbound rows mirror the AI-Discovered menu:
                      // Add to L0 · Edit · Delete (Delete is a soft drop).
                      <>
                        <DropdownMenuItem onClick={() => onPromote(company)}>
                          <ArrowRight className="mr-2 h-4 w-4" />
                          Add to L0
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onUpdate(company)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => onDrop(company)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                          Delete
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
            </Fragment>
          );
        })}
      </TableBody>
      </Table>
    </ColumnManagerProvider>
  );
}
