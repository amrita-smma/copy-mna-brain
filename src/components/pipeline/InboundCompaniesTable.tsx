"use client";

import { Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
  CheckCircle2,
  XCircle,
  Sparkles,
  Loader2,
} from "lucide-react";
import { ColumnHeader, type FilterOption } from "@/components/pipeline/ColumnHeader";
import { cn } from "@/lib/utils";
import { useNearRightEdge } from "@/hooks/useNearRightEdge";
import type { Tables } from "@/lib/repositories";
import type { DealStage } from "@/lib/types";
import { PIPELINE_STAGES } from "@/lib/constants";
import type { PipelineCompany } from "@/views/Pipeline";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { useChatContext } from "@/components/chat/ChatProvider";
import { DuplicatePopup } from "@/components/pipeline/DuplicatePopup";
import { companyDisplayName, companyDisplayTitle } from "@/lib/companyDisplay";
import {
  resolveTrackIds,
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

const DEAL_TYPE_LABEL: Record<string, string> = {
  majority: "Majority",
  minority: "Minority",
};

/** Matched-track pills for a company (manual matches, else auto-suggested). */
function MatchedTracksCell({
  company,
  tracks,
}: {
  company: PipelineCompany;
  tracks: TrackLike[];
}) {
  const ids = resolveTrackIds(company, tracks);
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

/** Most recent fiscal year that has a non-null value for `key`. */
const latestFin = (
  rows: Tables<"company_financials">[] | undefined,
  key: "revenue_usd_mn" | "ebitda_usd_mn",
): { value: number | null; year: number | null } => {
  if (!rows?.length) return { value: null, year: null };
  let best: { value: number; year: number } | null = null;
  for (const r of rows) {
    const v = r[key] as number | null;
    if (v == null) continue;
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
}: InboundCompaniesTableProps) {
  const isDropped = viewMode === "dropped";
  const { analyzeWithAI } = useChatContext();
  const { nearEdge, edgeHandlers } = useNearRightEdge();
  const stageIndex = PIPELINE_STAGES.indexOf(stage);
  const promoteTarget =
    stageIndex >= 0 && stageIndex < PIPELINE_STAGES.length - 1
      ? PIPELINE_STAGES[stageIndex + 1]
      : null;
  const demoteTarget =
    stageIndex > 0 ? PIPELINE_STAGES[stageIndex - 1] : null;

  const Col = ({
    label,
    className,
    sort,
    filter,
  }: {
    label: string;
    className?: string;
    sort?: string;
    filter?: string;
  }) => (
    <ColumnHeader
      label={label}
      className={className}
      sortField={sort}
      activeSortField={sortField}
      sortDirection={sortDirection}
      onSort={sort ? onSort : undefined}
      filterField={filter}
      filterOptions={filter ? filterOptions[filter] ?? [] : undefined}
      selectedValues={filter ? columnFilters[filter] ?? [] : undefined}
      onFilterChange={filter ? onColumnFilterChange : undefined}
    />
  );

  // colSpan for the section header / gap rows. Recount if columns change.
  const tableColumnCount = isDropped ? 19 : 18;
  const picColumnLabel = dealLeadLabel(stage);
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

  const sectionHeader = (kind: "unreviewed" | "reviewed") => {
    const count =
      kind === "unreviewed"
        ? unreviewedCompanies.length
        : reviewedCompanies.length;
    const isUnreviewed = kind === "unreviewed";
    const Icon = isUnreviewed ? Inbox : CheckCircle2;

    return (
      <TableRow className="select-none">
        <TableCell
          colSpan={tableColumnCount}
          className={cn(
            "border-y px-4 py-2 text-xs font-semibold",
            isUnreviewed
              ? "border-amber-200 bg-amber-50/90 text-amber-900"
              : "border-slate-200 bg-slate-50 text-slate-600",
          )}
        >
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                isUnreviewed
                  ? "border-amber-200 bg-amber-100 text-amber-700"
                  : "border-slate-200 bg-white text-slate-500",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="flex min-w-fit items-center gap-2">
              <span className="uppercase tracking-wide">
                {isUnreviewed ? "Unreviewed" : "Reviewed"}
              </span>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] leading-none",
                  isUnreviewed
                    ? "border-amber-200 bg-white/70 text-amber-800"
                    : "border-slate-200 bg-white text-slate-600",
                )}
              >
                {count} {count === 1 ? "company" : "companies"}
              </span>
              <span
                className={cn(
                  "hidden text-[11px] font-medium normal-case tracking-normal md:inline",
                  isUnreviewed ? "text-amber-700" : "text-slate-500",
                )}
              >
                {isUnreviewed
                  ? "from banker emails this week"
                  : "active companies"}
              </span>
            </div>
            <span
              className={cn(
                "h-px flex-1",
                isUnreviewed ? "bg-amber-200" : "bg-slate-200",
              )}
            />
            {isUnreviewed && onTriageAll && (
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
        colSpan={tableColumnCount}
        className="h-3 border-0 bg-background p-0"
      />
    </TableRow>
  );

  return (
    <Table {...edgeHandlers}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[40px] sticky left-0 z-20 bg-card"></TableHead>
          <Col
            label="Company"
            sort="name"
            className="sticky left-[40px] z-20 bg-card border-r"
          />
          <Col label={picColumnLabel} sort="deal_lead" filter="deal_lead" />
          <Col label="Entered by" sort="entered_by" filter="entered_by" />
          <Col
            label="Banker / Source"
            sort="banker"
            filter="banker"
            className="min-w-[160px]"
          />
          <Col label="Sector" sort="sector" filter="sector" />
          <Col label="Geo" sort="geo" filter="geo" />
          <TableHead className="min-w-[150px]">Matched Tracks</TableHead>
          <Col label="Deal Type" filter="deal_type" />
          <Col label="Revenue" sort="revenue" />
          <Col label="EBITDA" sort="ebitda" />
          <Col label="Valuation" sort="valuation" />
          <Col label="% Stake" sort="stake" filter="stake" />
          <TableHead>Entered By</TableHead>
          <TableHead>PIC</TableHead>
          <TableHead>Originator</TableHead>
          {isDropped ? (
            <>
              <TableHead>Source</TableHead>
              <TableHead>Drop Reason</TableHead>
            </>
          ) : (
            <Col
              label="Status"
              sort="status"
              filter="status"
              className="min-w-[160px]"
            />
          )}
          <TableHead className="min-w-[320px] max-w-[400px]">
            Additional Remarks
          </TableHead>
          <Col label="Created" sort="created" />
          <Col
            label={isDropped ? "Dropped On" : "Last Activity"}
            sort={isDropped ? undefined : "last_activity"}
          />
          <TableHead className="w-[44px] sticky right-0 z-20 bg-transparent" />

        </TableRow>
      </TableHeader>
      <TableBody>
        {groupedCompanies.length === 0 && (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={tableColumnCount}
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
          const bankerLabel = company.banker ?? company.banker_source;
          const rev = latestFin(company.financials_raw, "revenue_usd_mn");
          const ebitda = latestFin(company.financials_raw, "ebitda_usd_mn");
          const isUnreviewed = company.pipeline_stage === "unreviewed";
          // AI screening runs against a company's matched tracks; with none
          // matched there is nothing to screen, so the action is disabled.
          const hasMatchedTracks = resolveTrackIds(company, tracks).length > 0;
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
              {startsUnreviewedSection && sectionHeader("unreviewed")}
              {startsReviewedSection && (
                <>
                  {unreviewedCompanies.length > 0 && sectionGap()}
                  {sectionHeader("reviewed")}
                </>
              )}
              <TableRow
                className={cn(
                  "group transition-colors",
                  isUnreviewed && "border-l-2 border-l-amber-400",
                  isFav
                    ? "bg-amber-50/60 dark:bg-amber-900/10 hover:bg-amber-100/60 dark:hover:bg-amber-900/20"
                    : "hover:bg-muted/50",
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
              <TableCell>
                <DealLeadCell
                  company={company}
                  tracks={tracks}
                  stage={stage}
                />
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {company.entered_by || "—"}
                </span>
              </TableCell>
              <TableCell className="max-w-[220px]">
                {bankerLabel ? (
                  <span
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    title={bankerLabel}
                  >
                    <Landmark className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 truncate">{bankerLabel}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {company.segment || "-"}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {company.geo || "-"}
                </span>
              </TableCell>
              <TableCell>
                <MatchedTracksCell company={company} tracks={tracks} />
              </TableCell>
              <TableCell>
                {company.deal_type ? (
                  <Badge variant="outline" className="capitalize">
                    {DEAL_TYPE_LABEL[company.deal_type] ?? company.deal_type}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right font-mono">
                {rev.value === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <>
                    <div className="font-medium">{formatCurrency(rev.value)}</div>
                    {rev.year && (
                      <div className="text-[10px] text-muted-foreground">
                        {rev.year}
                      </div>
                    )}
                  </>
                )}
              </TableCell>
              <TableCell className="text-right font-mono">
                {ebitda.value === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <>
                    <div className="font-medium">
                      {formatCurrency(ebitda.value)}
                    </div>
                    {ebitda.year && (
                      <div className="text-[10px] text-muted-foreground">
                        {ebitda.year}
                      </div>
                    )}
                  </>
                )}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatCurrency(company.ev_2024)}
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {company.stake || "-"}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {company.entered_by_name || "-"}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {company.pic || "-"}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {company.originator || "-"}
                </span>
              </TableCell>
              {isDropped ? (
                <>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {company.source || "-"}
                    </span>
                  </TableCell>
                  <TableCell>
                    {company.dropped_reason ? (
                      <Badge
                        variant="secondary"
                        className="bg-red-100 text-red-700 max-w-[150px] truncate inline-block"
                        title={company.dropped_reason}
                      >
                        {company.dropped_reason}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </>
              ) : (
                <TableCell>
                  <StatusCombobox
                    variant="cell"
                    value={company.workflow_status}
                    options={statusOptions}
                    placeholder="Unreviewed"
                    onChange={(next) => onStatusChange(company, next)}
                  />
                </TableCell>
              )}
              <TableCell className="min-w-[320px] max-w-[400px] align-top">
                {company.remarks ? (
                  <p
                    className="text-xs text-muted-foreground whitespace-normal break-words"
                    title={company.remarks}
                  >
                    {company.remarks}
                  </p>
                ) : (
                  <span className="text-xs text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                {formatDate(company.created_at)}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                {isDropped
                  ? formatDate(company.dropped_at)
                  : formatDate(company.last_activity_at)}
              </TableCell>
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
  );
}
