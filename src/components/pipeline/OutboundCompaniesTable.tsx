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
  Pencil,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tables } from "@/lib/repositories";
import type { PipelineCompany } from "@/views/Pipeline";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { useChatContext } from "@/components/chat/ChatProvider";

const DEAL_TYPE_LABEL: Record<string, string> = {
  majority: "Majority",
  minority: "Minority",
};

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
  viewMode: "active" | "dropped";
  favoriteIds: Set<string>;
  togglingFavorite: string | null;
  onToggleFavorite: (id: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  updatingCompanyIds: Set<string>;
  statusOptions: string[];
  sortField: string | null;
  sortDirection: "asc" | "desc";
  onSort: (field: string) => void;
  onOpenDetail: (company: PipelineCompany) => void;
  onStatusChange: (company: PipelineCompany, next: string) => void;
  onUpdate: (company: PipelineCompany) => void;
  onPromote: (company: PipelineCompany) => void;
  onDrop: (company: PipelineCompany) => void;
  onRestore: (company: PipelineCompany) => void;
}

export default function OutboundCompaniesTable({
  companies,
  viewMode,
  favoriteIds,
  selectedIds,
  onToggleSelect,
  updatingCompanyIds,
  statusOptions,
  sortField,
  sortDirection,
  onSort,
  onOpenDetail,
  onStatusChange,
  onUpdate,
  onPromote,
  onDrop,
  onRestore,
}: OutboundCompaniesTableProps) {
  const isDropped = viewMode === "dropped";
  const { analyzeWithAI } = useChatContext();

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

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[40px]"></TableHead>
          <TableHead className="w-[50px]">Select</TableHead>
          <SortHead field="name" label="Company" />
          <TableHead>Project</TableHead>
          <SortHead field="sector" label="Segment" />
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
          <TableHead className="max-w-[200px]">Additional Remarks</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>{isDropped ? "Dropped On" : "Last Activity"}</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {companies.map((company) => {
          const isFav = favoriteIds.has(company.id);
          const isUpdating = updatingCompanyIds.has(company.id);
          return (
            <TableRow
              key={company.id}
              className={cn(
                "transition-colors",
                isFav
                  ? "bg-amber-50/60 dark:bg-amber-900/10 hover:bg-amber-100/60 dark:hover:bg-amber-900/20"
                  : "hover:bg-muted/50",
                isUpdating && "animate-pulse opacity-60",
              )}
            >
              <TableCell className="pr-0">
                <AskAIButton
                  variant="icon"
                  label="Analyze using AI"
                  onClick={() =>
                    analyzeWithAI(
                      `Analyze ${company.target || company.project_name || "this company"} and provide insights about it as a potential deal.`,
                    )
                  }
                />
              </TableCell>
              <TableCell>
                <Checkbox
                  checked={selectedIds.has(company.id)}
                  onCheckedChange={() => onToggleSelect(company.id)}
                />
              </TableCell>
              <TableCell>
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
              <TableCell className="max-w-[200px]">
                {company.remarks ? (
                  <p
                    className="text-xs text-muted-foreground truncate"
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
                        <DropdownMenuItem onClick={() => onPromote(company)}>
                          <ArrowRight className="mr-2 h-4 w-4" />
                          Promote to L1
                        </DropdownMenuItem>
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
