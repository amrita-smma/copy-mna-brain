"use client";

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
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  MoreVertical,
  ArrowRight,
  ArrowLeft,
  Pencil,
  Trash2,
  RotateCcw,
  Sparkles,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNearRightEdge } from "@/hooks/useNearRightEdge";
import type { Tables } from "@/lib/repositories";
import type { DealStage } from "@/lib/types";
import { PIPELINE_STAGES } from "@/lib/constants";
import type { PipelineCompany } from "@/views/Pipeline";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { useChatContext } from "@/components/chat/ChatProvider";
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

/** Most recent fiscal year that has a non-null value for `key`. */
const latestFinValue = (
  rows: Tables<"company_financials">[] | undefined,
  key: "revenue_usd_mn" | "ebitda_usd_mn" | "ev_usd_mn",
): number | null => {
  if (!rows?.length) return null;
  let best: { value: number; year: number } | null = null;
  for (const r of rows) {
    const v = r[key] as number | null;
    if (v == null) continue;
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
  favoriteIds: Set<string>;
  togglingFavorite: string | null;
  onToggleFavorite: (id: string) => void;
  updatingCompanyIds: Set<string>;
  statusOptions: string[];
  sortField: string | null;
  sortDirection: "asc" | "desc";
  onSort: (field: string) => void;
  onOpenDetail: (company: PipelineCompany) => void;
  onStatusChange: (company: PipelineCompany, next: string) => void;
  onUpdate: (company: PipelineCompany) => void;
  onPromote: (company: PipelineCompany) => void;
  onDemote: (company: PipelineCompany) => void;
  onDrop: (company: PipelineCompany) => void;
  onRestore: (company: PipelineCompany) => void;
  onRunScreening?: (company: PipelineCompany) => void;
  runningScreeningCompanyIds?: Set<string>;
}

export default function OutboundCompaniesTable({
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
  onOpenDetail,
  onStatusChange,
  onUpdate,
  onPromote,
  onDemote,
  onDrop,
  onRestore,
  onRunScreening,
  runningScreeningCompanyIds,
}: OutboundCompaniesTableProps) {
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

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field)
      return <ArrowUpDown className="h-3 w-3 ml-1 opacity-50" />;
    return sortDirection === "asc" ? (
      <ArrowUp className="h-3 w-3 ml-1" />
    ) : (
      <ArrowDown className="h-3 w-3 ml-1" />
    );
  };

  const SortHead = ({
    field,
    label,
    className,
  }: {
    field: string;
    label: string;
    className?: string;
  }) => (
    <TableHead className={className}>
      <button
        onClick={() => onSort(field)}
        className="flex items-center hover:text-foreground transition-colors"
      >
        {label}
        <SortIcon field={field} />
      </button>
    </TableHead>
  );

  return (
    <Table {...edgeHandlers}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[40px] sticky left-0 z-20 bg-card"></TableHead>
          <SortHead
            field="name"
            label="Company"
            className="sticky left-[40px] z-20 bg-card border-r"
          />
          <TableHead>Project</TableHead>
          <SortHead field="sector" label="Segment" />
          <TableHead className="min-w-[150px]">Matched Tracks</TableHead>
          <TableHead>Deal Type</TableHead>
          <TableHead className="max-w-[260px]">Key Rationale</TableHead>
          <TableHead className="min-w-[180px]">Financial Info</TableHead>
          <TableHead>PIC</TableHead>
          <TableHead>Originator</TableHead>
          {isDropped ? (
            <>
              <TableHead>Last Status</TableHead>
              <TableHead>Drop Reason</TableHead>
            </>
          ) : (
            <TableHead className="min-w-[160px]">Status</TableHead>
          )}
          <TableHead className="min-w-[320px] max-w-[400px]">Additional Remarks</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>{isDropped ? "Dropped On" : "Last Activity"}</TableHead>
          <TableHead className="w-[44px] sticky right-0 z-20 bg-transparent" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {companies.map((company) => {
          const isFav = favoriteIds.has(company.id);
          const stickyBg = isFav
            ? "bg-amber-50 group-hover:bg-amber-100 dark:bg-amber-950 dark:group-hover:bg-amber-900"
            : "bg-card group-hover:bg-muted";
          const isUpdating = updatingCompanyIds.has(company.id);
          const displayName = companyDisplayName(company, "this company");
          return (
            <TableRow
              key={company.id}
              className={cn(
                "group transition-colors",
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
                {company.target ? (
                  <button
                    onClick={() => onOpenDetail(company)}
                    className="font-medium text-left hover:text-primary hover:underline transition-colors"
                  >
                    {company.target}
                  </button>
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
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {company.segment || "-"}
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
              <TableCell className="max-w-[260px]">
                {company.key_rationale ? (
                  <p
                    className="text-xs text-muted-foreground line-clamp-2 leading-snug"
                    title={company.key_rationale}
                  >
                    {company.key_rationale}
                  </p>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="min-w-[180px]">
                {(() => {
                  const finInfo = composeFinancialInfo(company.financials_raw);
                  return finInfo ? (
                    <span className="text-xs font-mono text-muted-foreground">
                      {finInfo}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  );
                })()}
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
                      {company.workflow_status || "—"}
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
                    placeholder="Set status…"
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
                                onClick={() => onRunScreening(company)}
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
  );
}
