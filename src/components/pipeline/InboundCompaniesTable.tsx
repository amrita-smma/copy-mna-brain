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
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ArrowRight,
  ArrowLeft,
  Pencil,
  Trash2,
  RotateCcw,
  Landmark,
  Inbox,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tables } from "@/lib/repositories";
import type { DealStage } from "@/lib/types";
import { PIPELINE_STAGES } from "@/lib/constants";
import type { PipelineCompany } from "@/views/Pipeline";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { useChatContext } from "@/components/chat/ChatProvider";
import { DuplicatePopup } from "@/components/pipeline/DuplicatePopup";
import { companyDisplayName } from "@/lib/companyDisplay";
import {
  resolveTrackIds,
  trackDisplayName,
  type TrackLike,
} from "@/lib/tracks/matchTracks";

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
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  visibleSelectionState: boolean | "indeterminate";
  onToggleSelectAllVisible: () => void;
  updatingCompanyIds: Set<string>;
  statusOptions: string[];
  sortField: string | null;
  sortDirection: "asc" | "desc";
  onSort: (field: string) => void;
  onOpenDetail: (company: PipelineCompany) => void;
  onStatusChange: (company: PipelineCompany, next: string) => void;
  onTriageAll?: () => void;
  onKeep?: (company: PipelineCompany) => void | Promise<void>;
  onUpdate: (company: PipelineCompany) => void;
  onPromote: (company: PipelineCompany) => void;
  onDemote: (company: PipelineCompany) => void;
  onDrop: (company: PipelineCompany) => void;
  onRestore: (company: PipelineCompany) => void;
}

export default function InboundCompaniesTable({
  companies,
  tracks,
  stage,
  viewMode,
  favoriteIds,
  selectedIds,
  onToggleSelect,
  visibleSelectionState,
  onToggleSelectAllVisible,
  updatingCompanyIds,
  statusOptions,
  sortField,
  sortDirection,
  onSort,
  onOpenDetail,
  onStatusChange,
  onTriageAll,
  onKeep,
  onUpdate,
  onPromote,
  onDemote,
  onDrop,
  onRestore,
}: InboundCompaniesTableProps) {
  const isDropped = viewMode === "dropped";
  const { analyzeWithAI } = useChatContext();
  const stageIndex = PIPELINE_STAGES.indexOf(stage);
  const promoteTarget =
    stageIndex >= 0 && stageIndex < PIPELINE_STAGES.length - 1
      ? PIPELINE_STAGES[stageIndex + 1]
      : null;
  const demoteTarget =
    stageIndex > 0 ? PIPELINE_STAGES[stageIndex - 1] : null;

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field)
      return <ArrowUpDown className="h-3 w-3 ml-1 opacity-50" />;
    return sortDirection === "asc" ? (
      <ArrowUp className="h-3 w-3 ml-1" />
    ) : (
      <ArrowDown className="h-3 w-3 ml-1" />
    );
  };

  const SortHead = ({ field, label }: { field: string; label: string }) => (
    <TableHead>
      <button
        onClick={() => onSort(field)}
        className="flex items-center hover:text-foreground transition-colors"
      >
        {label}
        <SortIcon field={field} />
      </button>
    </TableHead>
  );

  const tableColumnCount = isDropped ? 21 : 20;
  const unreviewedCompanies = isDropped
    ? []
    : companies.filter((company) => company.review_state === "unreviewed");
  const reviewedCompanies = isDropped
    ? []
    : companies.filter((company) => company.review_state !== "unreviewed");
  const showReviewGroups =
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[50px]">
            <Checkbox
              aria-label="Select all visible companies"
              checked={visibleSelectionState}
              onCheckedChange={onToggleSelectAllVisible}
            />
          </TableHead>
          <TableHead className="w-[40px]"></TableHead>
          <SortHead field="name" label="Company" />
          <TableHead>Project</TableHead>
          <TableHead className="min-w-[160px]">Banker / Source</TableHead>
          <SortHead field="sector" label="Sector" />
          <TableHead>Geo</TableHead>
          <TableHead className="min-w-[150px]">Matched Tracks</TableHead>
          <TableHead>Deal Type</TableHead>
          <SortHead field="revenue" label="Revenue" />
          <SortHead field="ebitda" label="EBITDA" />
          <SortHead field="valuation" label="Valuation" />
          <TableHead>% Stake</TableHead>
          <TableHead>PIC</TableHead>
          <TableHead>Originator</TableHead>
          {isDropped ? (
            <>
              <TableHead>Source</TableHead>
              <TableHead>Drop Reason</TableHead>
            </>
          ) : (
            <TableHead className="min-w-[160px]">Status</TableHead>
          )}
          <TableHead className="min-w-[320px] max-w-[400px]">
            Additional Remarks
          </TableHead>
          <TableHead>Created</TableHead>
          <TableHead>{isDropped ? "Dropped On" : "Last Activity"}</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groupedCompanies.map((company, index) => {
          const isFav = favoriteIds.has(company.id);
          const isUpdating = updatingCompanyIds.has(company.id);
          const bankerLabel = company.banker ?? company.banker_source;
          const rev = latestFin(company.financials_raw, "revenue_usd_mn");
          const ebitda = latestFin(company.financials_raw, "ebitda_usd_mn");
          const isUnreviewed = company.review_state === "unreviewed";
          const displayName = companyDisplayName(company, "this company");
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
              previousCompany.review_state !== "unreviewed");
          const startsReviewedSection =
            showReviewGroups &&
            !isUnreviewed &&
            (!previousCompany ||
              previousCompany.review_state === "unreviewed");

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
                  "transition-colors",
                  isUnreviewed && "border-l-2 border-l-amber-400",
                  isFav
                    ? "bg-amber-50/60 dark:bg-amber-900/10 hover:bg-amber-100/60 dark:hover:bg-amber-900/20"
                    : "hover:bg-muted/50",
                  isUpdating && "animate-pulse opacity-60",
                )}
              >
              <TableCell>
                <Checkbox
                  checked={selectedIds.has(company.id)}
                  onCheckedChange={() => onToggleSelect(company.id)}
                />
              </TableCell>
              <TableCell className="pr-0">
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
              <TableCell>
                {company.target ? (
                  <>
                    <button
                      onClick={() => onOpenDetail(company)}
                      className="font-medium text-left hover:text-primary hover:underline transition-colors"
                    >
                      {company.target}
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
                {company.project_name ? (
                  <button
                    onClick={() => onOpenDetail(company)}
                    className="font-medium text-left hover:text-primary hover:underline transition-colors"
                  >
                    {company.project_name}
                  </button>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
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
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-7 gap-1">
                      Actions
                      <ChevronDown className="h-3 w-3" />
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
                        {isUnreviewed && onKeep && (
                          <>
                            <DropdownMenuItem onClick={() => onKeep(company)}>
                              <CheckCircle2 className="mr-2 h-4 w-4 text-green-600" />
                              Keep
                            </DropdownMenuItem>
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
