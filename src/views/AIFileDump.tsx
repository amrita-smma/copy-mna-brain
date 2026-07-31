"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import FilePreview from "@/components/Files/FilePreview";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  useColumnLayout,
  ColumnManagerProvider,
  ManagedTableHeader,
  ManagedRowCells,
  ColumnConfigGear,
  type ColumnDef,
} from "@/components/table";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  AlertCircle,
  Bot,
  CalendarIcon,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Download,
  Eye,
  File,
  FileSpreadsheet,
  FileText,
  FileUp,
  FileStack,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { getCompanies } from "@/lib/api/pipeline";
import { MatchedCompanyCombobox, AUTO as COMBOBOX_AUTO, type CompanyOption as ComboboxOption } from "@/components/Files/MatchedCompanyCombobox";
import { MatchedCompaniesCell } from "@/components/Files/MatchedCompaniesCell";
import { useChatContext } from "@/components/chat/ChatProvider";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { HitlReviewDialog } from "@/components/Files/HitlReviewDialog";
import { FundUpdateReviewDialog } from "@/components/Files/FundUpdateReviewDialog";
import CompanyDetailDialog, {
  type CompanyData,
} from "@/components/pipeline/CompanyDetailDialog";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";
import {
  type AiFileDumpTab,
  isAiFileDumpTab,
} from "@/lib/aiFileDumpTabs";

const AUTO = COMBOBOX_AUTO;

type CompanyOption = ComboboxOption;

/**
 * Lowercase, replace any non-alphanumeric characters with a single space, and
 * collapse runs of whitespace. Used to compare a filename against a company
 * name with separator-insensitive whole-word matching.
 */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Best-effort filename → company matcher. Returns the id of the company whose
 * normalized name appears as a contiguous whole-word run inside the file's
 * stem. Prefers the longest match (so "Acme Capital" beats "Acme") to reduce
 * spurious hits on short generic names. Returns `null` if nothing matches.
 *
 * Pure / client-side — uses only the already-loaded `companyOptions` list,
 * no extra network calls.
 */
export function matchCompanyByFilename(
  fileName: string,
  companies: CompanyOption[],
): string | null {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const normalized = ` ${normalizeForMatch(stem)} `;

  let bestId: string | null = null;
  let bestLength = 0;
  for (const company of companies) {
    const target = normalizeForMatch(company.name);
    // Two-char names (or less) are too noisy to match safely on a filename.
    if (target.length < 3) continue;
    const padded = ` ${target} `;
    if (normalized.includes(padded) && target.length > bestLength) {
      bestId = company.id;
      bestLength = target.length;
    }
  }
  return bestId;
}

interface FileRecord {
  id: string;
  file_name: string;
  file_link: string;
  file_type: string | null;
  raw_notes: string | null;
  structured_notes: string | null;
  processing_status: "pending" | "processing" | "awaiting_review" | "completed" | "failed";
  tags: string[];
  matched_companies: any[];
  signed_url?: string;
  file_date: string | null;
  created_at: string;
  updated_at: string;
}

// Keep these for backward compatibility
type MeetingNote = FileRecord;
type Prospectus = FileRecord;
type OtherFile = FileRecord;

// Reusable FileTable component props
interface FileTableProps {
  title: string;
  icon: React.ReactNode;
  iconColor: string;
  /** The current page of rows already filtered/sorted/paginated server-side. */
  files: FileRecord[];
  /** Total rows matching the current search, across all pages. */
  total: number;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortField: keyof FileRecord;
  sortDirection: "asc" | "desc";
  onSort: (field: keyof FileRecord) => void;
  expandedTags: Record<string, boolean>;
  toggleTags: (id: string) => void;
  expandedCompanies: Record<string, boolean>;
  toggleCompanies: (id: string) => void;
  onOpenCompany: (companyId: string) => void;
  onMatchedCompaniesChanged: () => void;
  onUpdateDate: (id: string, date: Date | undefined) => void;
  onDownload: (id: string, fileName: string) => Promise<void>;
  onDelete: (id: string) => void;
  onReview: (id: string, fileType: string | null) => void;
  onViewFundUpdateParsed?: (id: string) => void;
  onReprocess: (id: string) => void;
  downloadingId: string | null;
  deletingId: string | null;
  reprocessingId: string | null;
  emptyMessage: string;
  emptySubMessage: string;
  currentPage: number;
  onPageChange: (page: number) => void;
  itemsPerPage?: number;
  /** Hide category title/icon — tab bar already identifies the category. */
  hideTitle?: boolean;
}

function FileTable({
  title,
  icon,
  iconColor,
  files,
  total,
  searchQuery,
  onSearchChange,
  sortField,
  sortDirection,
  onSort,
  expandedTags,
  toggleTags,
  expandedCompanies,
  toggleCompanies,
  onOpenCompany,
  onMatchedCompaniesChanged,
  onUpdateDate,
  onDownload,
  onDelete,
  onReview,
  onViewFundUpdateParsed,
  onReprocess,
  downloadingId,
  deletingId,
  reprocessingId,
  emptyMessage,
  emptySubMessage,
  currentPage,
  onPageChange,
  itemsPerPage = 10,
  hideTitle = false,
}: FileTableProps) {
  const totalPages = Math.max(1, Math.ceil(total / itemsPerPage));
  // `files` is already the server-resolved page; render it as-is.
  const paginatedFiles = files;
  const hasSearch = searchQuery.trim().length > 0;
  const SortIcon = ({ field }: { field: keyof FileRecord }) => {
    if (sortField !== field)
      return <ChevronsUpDown className="h-3 w-3 ml-1 opacity-50" />;
    return sortDirection === "asc" ? (
      <ChevronUp className="h-3 w-3 ml-1 text-primary" />
    ) : (
      <ChevronDown className="h-3 w-3 ml-1 text-primary" />
    );
  };

  const renderStatusBadge = (status: FileRecord["processing_status"]) => {
    switch (status) {
      case "processing":
        return (
          <Badge
            variant="outline"
            className="flex items-center gap-1 text-blue-500 bg-blue-500/5 border-blue-200"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Processing
          </Badge>
        );
      case "awaiting_review":
        return (
          <Badge
            variant="outline"
            className="flex items-center gap-1 text-amber-600 bg-amber-500/5 border-amber-200"
          >
            <Eye className="h-3 w-3" />
            Awaiting Review
          </Badge>
        );
      case "completed":
        return (
          <Badge
            variant="outline"
            className="flex items-center gap-1 text-green-600 bg-green-500/5 border-green-200"
          >
            <CheckCircle2 className="h-3 w-3" />
            Completed
          </Badge>
        );
      case "failed":
        return (
          <Badge
            variant="outline"
            className="flex items-center gap-1 text-red-600 bg-red-500/5 border-red-200"
          >
            <AlertCircle className="h-3 w-3" />
            Failed
          </Badge>
        );
      case "pending":
      default:
        return (
          <Badge
            variant="outline"
            className="flex items-center gap-1 text-gray-500 bg-gray-500/5 border-gray-200"
          >
            Pending
          </Badge>
        );
    }
  };

  const renderTags = (note: FileRecord) => (
    <div className="flex flex-wrap gap-1">
      {note.tags && note.tags.length > 0 ? (
        <>
          {(expandedTags[note.id] ? note.tags : note.tags.slice(0, 3)).map(
            (tag, i) => (
              <Badge
                key={i}
                variant="secondary"
                className="text-[10px] py-0 px-1.5 flex items-center gap-1"
              >
                <Tag className="h-2.5 w-2.5" />
                {tag}
              </Badge>
            ),
          )}
          {note.tags.length > 3 && (
            <Badge
              variant="outline"
              className="text-[10px] py-0 px-1.5 cursor-pointer hover:bg-muted"
              onClick={() => toggleTags(note.id)}
            >
              {expandedTags[note.id]
                ? "Show less"
                : `+${note.tags.length - 3} more`}
            </Badge>
          )}
        </>
      ) : (
        <span className="text-muted-foreground text-xs">-</span>
      )}
    </div>
  );

  const renderCompanies = (note: FileRecord) => {
    const rematchDisabled =
      note.processing_status === "pending" ||
      note.processing_status === "processing";
    return (
      <MatchedCompaniesCell
        fileId={note.id}
        companies={note.matched_companies || []}
        onOpenCompany={onOpenCompany}
        onChanged={onMatchedCompaniesChanged}
        disabled={rematchDisabled}
        expanded={!!expandedCompanies[note.id]}
        onToggleExpand={() => toggleCompanies(note.id)}
      />
    );
  };

  const renderStructuredNotes = (note: FileRecord) => {
    if (!note.structured_notes) {
      return (
        <p className="text-sm text-muted-foreground italic p-4">
          Processing not complete or structure extraction failed.
        </p>
      );
    }

    try {
      const structured = JSON.parse(note.structured_notes);
      const proposal = structured.fund_update_proposal;
      const isFundUpdate =
        structured.file_type === "fund_updates" || note.file_type === "fund_updates";

      return (
        <>
          <div>
            <h4 className="font-medium text-primary mb-1">Summary</h4>
            <p>{structured.summary}</p>
          </div>
          {isFundUpdate && proposal?.stats ? (
            <div className="rounded-md border bg-background p-3 text-xs space-y-2">
              <div className="font-medium text-foreground">Parsed workbook</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                <span>Format</span>
                <span className="text-foreground">{proposal.template_id ?? "—"}</span>
                <span>Assets</span>
                <span className="text-foreground">{proposal.stats.asset_count}</span>
                <span>Transactions</span>
                <span className="text-foreground">{proposal.stats.transaction_count}</span>
                <span>Valuations</span>
                <span className="text-foreground">{proposal.stats.valuation_count}</span>
              </div>
              {onViewFundUpdateParsed ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() => onViewFundUpdateParsed(note.id)}
                >
                  Browse parsed assets
                </Button>
              ) : null}
            </div>
          ) : null}
          <div>
            <h4 className="font-medium text-primary mb-1">Key Points</h4>
            <ul className="list-disc pl-4 space-y-1">
              {structured.key_points?.map((p: string, i: number) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-medium text-primary mb-1">Action Items</h4>
            <ul className="list-disc pl-4 space-y-1">
              {structured.action_items?.map((p: string, i: number) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        </>
      );
    } catch {
      return (
        <pre className="text-xs whitespace-pre-wrap">
          {note.structured_notes}
        </pre>
      );
    }
  };

  // Managed (reorderable / hideable / groupable) data columns. The sortable
  // File Name identity column and the trailing "Meeting Date & Actions" column
  // are pinned and rendered outside this set. Status/Tags/Matched Companies are
  // managed; the cell renderers reuse the existing helpers that close over each
  // row (including the per-row expand/collapse state for tags & companies).
  const columns = useMemo<ColumnDef<FileRecord>[]>(
    () => [
      {
        id: "processing_status",
        label: "Status",
        header: (
          <div
            className="flex items-center cursor-pointer hover:text-primary transition-colors"
            onClick={() => onSort("processing_status")}
          >
            Status
            <SortIcon field="processing_status" />
          </div>
        ),
        cell: (note) => renderStatusBadge(note.processing_status),
      },
      {
        id: "tags",
        label: "Tags",
        header: "Tags",
        cellClassName: "max-w-[200px]",
        cell: (note) => renderTags(note),
      },
      {
        id: "matched_companies",
        label: "Matched Companies",
        header: "Matched Companies",
        cell: (note) => renderCompanies(note),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortField, sortDirection, expandedTags, expandedCompanies],
  );

  const mgr = useColumnLayout("ai-file-dump", columns);

  return (
    <ColumnManagerProvider value={mgr}>
    <Card className={cn(hideTitle && "border-0 shadow-none rounded-none bg-transparent")}>
      <CardHeader className={cn(hideTitle && "hidden")}>
        <div
          className={cn(
            "flex flex-col md:flex-row md:items-center gap-4",
            hideTitle ? "justify-end" : "justify-between",
          )}
        >
          {!hideTitle && (
            <CardTitle className="flex items-center gap-2">
              <span className={iconColor}>{icon}</span>
              {title} ({total})
            </CardTitle>
          )}
          <div className="flex items-center gap-2 w-full md:w-auto">
            <div className="relative w-full md:w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search notes, tags, companies..."
                className="pl-9"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
              />
            </div>
            <ColumnConfigGear portalTargetId={hideTitle ? "ai-file-dump-toolbar" : undefined} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {total === 0 && !hasSearch ? (
          <div className="text-center py-12 text-muted-foreground">
            <div
              className={cn(
                "mx-auto h-12 w-12 mb-4 opacity-50 flex items-center justify-center",
                iconColor,
              )}
            >
              {icon}
            </div>
            <p>{emptyMessage}</p>
            <p className="text-sm">{emptySubMessage}</p>
          </div>
        ) : total === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Search className="mx-auto h-12 w-12 mb-4 opacity-50" />
            <p>No results found for &quot;{searchQuery}&quot;</p>
            <Button variant="link" onClick={() => onSearchChange("")}>
              Clear search
            </Button>
          </div>
        ) : (
          <>

            <div className="max-h-[500px] overflow-auto">
              <Table>
                <ManagedTableHeader
                  leading={
                    <TableHead
                      key="file_name"
                      className="cursor-pointer hover:text-primary transition-colors"
                      onClick={() => onSort("file_name")}
                    >
                      <div className="flex items-center">
                        File Name
                        <SortIcon field="file_name" />
                      </div>
                    </TableHead>
                  }
                  trailing={
                    <TableHead
                      key="date_actions"
                      className="cursor-pointer hover:text-primary transition-colors text-right"
                      onClick={() => onSort("file_date")}
                    >
                      <div className="flex items-center justify-end">
                        Meeting Date & Actions
                        <SortIcon field="file_date" />
                      </div>
                    </TableHead>
                  }
                />
                <TableBody>
                  {paginatedFiles.map((note, index) => (
                    <TableRow key={note.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          {note.file_name}
                        </div>
                      </TableCell>
                      <ManagedRowCells row={note} index={index} />
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end gap-2">
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="ghost"
                                className={cn(
                                  "h-8 w-auto justify-end text-right font-normal px-2",
                                  !note.file_date && "text-muted-foreground",
                                )}
                              >
                                <CalendarIcon className="mr-2 h-3 w-3" />
                                {note.file_date ? (
                                  format(new Date(note.file_date), "PPP")
                                ) : (
                                  <span className="text-xs italic text-muted-foreground">
                                    Set meeting date
                                  </span>
                                )}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="end">
                              <Calendar
                                mode="single"
                                selected={
                                  note.file_date
                                    ? new Date(note.file_date)
                                    : undefined
                                }
                                onSelect={(date) => onUpdateDate(note.id, date)}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>

                          <div className="flex items-center justify-end gap-1">
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="View details"
                                  className="h-8 w-8"
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="flex flex-col w-screen h-screen max-w-none sm:rounded-none border-0">
                                <DialogHeader>
                                  <div className="flex items-center justify-between gap-4 pr-8">
                                    <DialogTitle>
                                      {note.file_name} - Details
                                    </DialogTitle>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => onReprocess(note.id)}
                                      disabled={
                                        reprocessingId === note.id ||
                                        note.processing_status === "processing"
                                      }
                                      title="Re-run AI extraction to refresh notes, tags & matches"
                                    >
                                      {reprocessingId === note.id ? (
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                      ) : (
                                        <RefreshCw className="h-4 w-4 mr-2" />
                                      )}
                                      Reprocess
                                    </Button>
                                  </div>
                                </DialogHeader>
                                <div className="grid md:grid-cols-2 gap-6 mt-4 flex-1 min-h-0 overflow-hidden">
                                  <div className="flex flex-col gap-2 min-h-0">
                                    <h3 className="text-sm font-semibold flex items-center gap-2">
                                      <FileText className="h-4 w-4" />
                                      File Preview
                                    </h3>
                                    {note.signed_url ? (
                                      <div className="flex-1 min-h-0">
                                        <FilePreview
                                          url={note.signed_url}
                                          onDownload={() =>
                                            onDownload(note.id, note.file_name)
                                          }
                                          fileName={note.file_name}
                                          fileKey={note.file_link}
                                        />
                                      </div>
                                    ) : (
                                      <div className="flex flex-1 min-h-0 w-full items-center justify-center bg-muted/30 rounded-md border text-muted-foreground">
                                        Preview not available (Link missing)
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex flex-col gap-2 min-h-0">
                                    <h3 className="text-sm font-semibold flex items-center gap-2">
                                      <Bot className="h-4 w-4" />
                                      AI Structured Notes
                                    </h3>
                                    <ScrollArea className="flex-1 min-h-0 w-full rounded-md border p-4 bg-muted/30">
                                      <div className="space-y-4 text-sm">
                                        {renderStructuredNotes(note)}
                                      </div>
                                    </ScrollArea>
                                  </div>
                                </div>
                              </DialogContent>
                            </Dialog>
                            {note.processing_status === "awaiting_review" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => onReview(note.id, note.file_type)}
                                title="Review & approve"
                                className="h-8 w-8 text-amber-600 hover:text-amber-700"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() =>
                                onDownload(note.id, note.file_name)
                              }
                              disabled={downloadingId === note.id}
                              title="Download file"
                              className="h-8 w-8"
                            >
                              {downloadingId === note.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )}
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-destructive hover:text-destructive h-8 w-8"
                                  disabled={deletingId === note.id}
                                >
                                  {deletingId === note.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-4 w-4" />
                                  )}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    Delete File
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Are you sure you want to delete &quot;
                                    {note.file_name}&quot;? This will remove
                                    both the file from storage and the database
                                    record. This action cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => onDelete(note.id)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                <p className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages} ({total} files)
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onPageChange(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onPageChange(Math.min(totalPages, currentPage + 1))
                    }
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
    </ColumnManagerProvider>
  );
}

/** In-panel spinner for a lazy tab — keeps the page shell mounted across switches. */
function TabBucketPanel({
  loading,
  children,
}: {
  loading: boolean;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return children;
}

const PAGE_SIZE = 10;

interface FileBucket {
  /** Current page of rows for this category. */
  files: FileRecord[];
  /** Total rows matching the current search across all pages. */
  total: number;
  /** True until the first fetch resolves; used to gate the initial page spinner. */
  initialLoading: boolean;
  search: string;
  setSearch: (query: string) => void;
  sortField: keyof FileRecord;
  sortDirection: "asc" | "desc";
  onSort: (field: keyof FileRecord) => void;
  page: number;
  setPage: (page: number) => void;
  refetch: () => void;
}

/**
 * Owns the server-driven search / sort / pagination state for a single AI File
 * Dump category and fetches only the current page from
 * `GET /api/ai-file-dump`. The view used to pull every row per category and
 * filter/sort/paginate in the browser (slow and memory-heavy for large
 * workspaces); this keeps at most PAGE_SIZE rows in memory per category.
 *
 * Search input is debounced (300ms) and any search or sort change returns to
 * page 1. `fileType` is the API bucket key — the MoM bucket maps to the empty
 * `file_type` sentinel the route expects.
 */
function useFileBucket(fileType: string, externalSearch?: string, enabled = true): FileBucket {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [initialLoading, setInitialLoading] = useState(true);
  const [internalSearch, setInternalSearch] = useState("");
  const search = externalSearch !== undefined ? externalSearch : internalSearch;
  const setSearch = externalSearch !== undefined ? () => {} : setInternalSearch;
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortField, setSortField] = useState<keyof FileRecord>("file_date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  // Debounce the search box; committing a new query always returns to page 1.
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  const fetchFiles = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      // The route treats an empty `file_type` as the MoM bucket sentinel.
      params.set("file_type", fileType === "mom" ? "" : fileType);
      const term = debouncedSearch.trim();
      if (term) params.set("search", term);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      params.set("sortField", String(sortField));
      params.set("sortDirection", sortDirection);

      const response = await fetch(`/api/ai-file-dump?${params.toString()}`);
      const result = await response.json();
      if (result.success) {
        setFiles(result.data);
        setTotal(result.total ?? 0);
      } else {
        toast.error("Failed to load files");
      }
    } catch (error) {
      // Aborted requests (Strict Mode remount / superseded fetch) aren't user-facing.
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("Error fetching files:", error);
      toast.error("Failed to load files");
    } finally {
      setInitialLoading(false);
    }
  }, [fileType, debouncedSearch, page, sortField, sortDirection]);

  const hasLoadedRef = useRef(false);
  useEffect(() => {
    if (!enabled && !hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    fetchFiles();
  }, [fetchFiles, enabled]);

  // If a refetch shrank the result set past the current page (e.g. after a
  // delete on the last page), step back so we never sit on an empty page.
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [total, page]);

  const onSort = useCallback(
    (field: keyof FileRecord) => {
      if (field === sortField) {
        setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDirection("asc");
      }
      setPage(1);
    },
    [sortField],
  );

  return {
    files,
    total,
    initialLoading,
    search,
    setSearch,
    sortField,
    sortDirection,
    onSort,
    page,
    setPage,
    refetch: fetchFiles,
  };
}

interface AIFileDumpProps {
  showCompanyGraph?: boolean;
  showFundManagement?: boolean;
  /** Deep-link tab from `/ai-file-dump/<tab>` — defaults to MoM. */
  initialTab?: AiFileDumpTab;
}

export default function AIFileDump({
  showCompanyGraph = false,
  showFundManagement = false,
  initialTab = "mom",
}: AIFileDumpProps) {
  const { analyzeWithAI } = useChatContext();
  const [activeTab, setActiveTab] = useState<AiFileDumpTab>(initialTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(
    () => new Set([initialTab]),
  );
  const [globalSearch, setGlobalSearch] = useState("");
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});

  // Keep the URL in sync with the active tab: `/ai-file-dump/mom`,
  // `/ai-file-dump/prospectus`, etc.
  //
  // IMPORTANT: pass `window.history.state` (not `null`). Next.js patches
  // `history.replaceState` and, when state lacks `__NA`, dispatches
  // ACTION_RESTORE — a soft navigation that remounts this page, aborts
  // in-flight fetches ("Failed to fetch"), and flashes the boot spinner.
  // Reusing the existing Next history entry updates the URL bar only.
  const tabUrlTarget = useWorkspaceHref(`/ai-file-dump/${activeTab}`);
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.location.pathname !== tabUrlTarget
    ) {
      window.history.replaceState(window.history.state, "", tabUrlTarget);
    }
  }, [tabUrlTarget]);

  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/ai-file-dump/counts");
      const json = await res.json();
      if (json.success) setTabCounts(json.counts);
    } catch {
      // counts are non-critical — tabs still work without them
    }
  }, []);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  const handleTabChange = useCallback((tab: string) => {
    if (!isAiFileDumpTab(tab)) return;
    setActiveTab(tab);
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, []);
  // Each category owns its server-driven sort / pagination state but shares
  // the global search term so the search bar persists across tab changes.
  // Tabs are lazy-loaded: data is only fetched once the tab has been visited.
  const mom = useFileBucket("mom", globalSearch, visitedTabs.has("mom"));
  const prospectusBucket = useFileBucket("prospectus", globalSearch, visitedTabs.has("prospectus"));
  const shoppingListBucket = useFileBucket("shopping_list", globalSearch, visitedTabs.has("shopping_list"));
  const bankerCommsBucket = useFileBucket("banker_communications", globalSearch, visitedTabs.has("banker_communications"));
  const fundUpdatesBucket = useFileBucket("fund_updates", globalSearch, visitedTabs.has("fund_updates"));
  const marketStudyBucket = useFileBucket("market_study", globalSearch, visitedTabs.has("market_study"));
  const otherBucket = useFileBucket("other", globalSearch, visitedTabs.has("other"));

  const getActiveBucket = () => {
    switch (activeTab) {
      case "mom": return mom;
      case "prospectus": return prospectusBucket;
      case "shopping_list": return shoppingListBucket;
      case "banker_communications": return bankerCommsBucket;
      case "fund_updates": return fundUpdatesBucket;
      case "market_study": return marketStudyBucket;
      case "other": return otherBucket;
      default: return mom;
    }
  };
  const activeBucket = getActiveBucket();

  const bucketByTab = useMemo<Record<string, FileBucket>>(
    () => ({ mom, prospectus: prospectusBucket, shopping_list: shoppingListBucket, banker_communications: bankerCommsBucket, fund_updates: fundUpdatesBucket, market_study: marketStudyBucket, other: otherBucket }),
    [mom, prospectusBucket, shoppingListBucket, bankerCommsBucket, fundUpdatesBucket, marketStudyBucket, otherBucket],
  );

  /** Refetch only visited (already-loaded) tabs — use after upload, delete, reprocess. */
  const refetchVisited = useCallback(() => {
    for (const tab of visitedTabs) {
      bucketByTab[tab]?.refetch();
    }
    fetchCounts();
  }, [visitedTabs, bucketByTab, fetchCounts]);

  /** Refetch only the active tab — use for same-tab mutations like matched company changes. */
  const refetchAll = useCallback(() => {
    activeBucket.refetch();
  }, [activeBucket]);

  // Full-page spinner only for the very first paint (deep-linked tab). Tab
  // switches use an in-panel spinner so the shell doesn't unmount/blink.
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    if (!activeBucket.initialLoading) setBooting(false);
  }, [activeBucket.initialLoading]);
  const loading = booting;
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // File drop state
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  /** Per-file raw notes: key = `${file.name}-${index}` */
  const [fileRawNotes, setFileRawNotes] = useState<Record<string, string>>({});
  /** Which file note dropdowns are expanded: key = `${file.name}-${index}` */
  const [expandedFileNotes, setExpandedFileNotes] = useState<
    Record<string, boolean>
  >({});
  /**
   * Per-file classification override: key = `${file.name}-${index}`.
   * 'auto' (the default) lets the AI classify; 'mom' / 'prospectus' /
   * 'shopping_list' / 'other' force the file_type and lock the agent's
   * classification.
   */
  const [fileTypeOverrides, setFileTypeOverrides] = useState<
    Record<string, "auto" | "mom" | "prospectus" | "shopping_list" | "fund_updates" | "market_study" | "other">
  >({});
  /**
   * Per-file pre-upload picks for "Matched Company" and "Project Name".
   * Both are UI-only for now — the backend payload is unchanged. When the
   * company/project data model is split (separate effort), the picks will
   * be plumbed through. Value is a company id or `AUTO`.
   */
  const [fileMatchedCompanies, setFileMatchedCompanies] = useState<
    Record<string, string>
  >({});
  const [fileMatchedProjects, setFileMatchedProjects] = useState<
    Record<string, string>
  >({});
  const [companyOptions, setCompanyOptions] = useState<CompanyOption[]>([]);
  // Matched-company popup: clicking a matched company chip opens the full
  // CompanyDetailDialog inline instead of navigating away to /pipeline/[id].
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(
    null,
  );
  const [uploadProgress, setUploadProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const [expandedTags, setExpandedTags] = useState<Record<string, boolean>>({});
  const [expandedCompanies, setExpandedCompanies] = useState<
    Record<string, boolean>
  >({});
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);
  const [reviewFile, setReviewFile] = useState<{
    id: string;
    file_type: string | null;
  } | null>(null);
  const [viewFundUpdateFileId, setViewFundUpdateFileId] = useState<string | null>(null);

  // Load the full company DTO and open the detail dialog. The matched-company
  // chips only carry id + name, but CompanyDetailDialog reads (and can edit)
  // the full record, so fetch it here before opening — same pattern as
  // MasterData / Pipeline.
  const openCompany = useCallback(async (companyId: string) => {
    try {
      const data = (await getCompanies({ id: companyId })) as
        | CompanyData
        | null;
      if (!data) {
        toast.error("Could not load company");
        return;
      }
      setSelectedCompany(data);
    } catch {
      toast.error("Could not load company");
    }
  }, []);

  // Companies for the Matched Company / Project Name dropdowns + the
  // filename auto-matcher. Each row in `companies` carries both `target`
  // (company name) and `project_name` (codename) — the two columns label
  // their dropdowns from those fields respectively, but a single pick
  // resolves to the same company id. `apiRequest` already unwraps the
  // `{ data }` envelope, so `getCompanies` returns the array directly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = (await getCompanies({
          orderBy: "target",
          orderDir: "asc",
        })) as
          | {
              id: string;
              target: string | null;
              project_name: string | null;
            }[]
          | null;
        if (cancelled) return;
        const rows = Array.isArray(result) ? result : [];
        const options = rows
          .filter((r) => r.id && r.target)
          .map((r) => ({
            id: r.id,
            name: r.target as string,
            projectName: r.project_name,
          }));
        setCompanyOptions(options);
      } catch (error) {
        console.error("Error fetching companies for upload picker:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-match newly added files against the company list. Runs whenever a
  // file is added or when the company list arrives (so files dropped before
  // companies finished loading still get matched). User picks survive — once
  // a key has any value (including the AUTO sentinel), this effect
  // leaves it alone. Project Name mirrors Matched Company.
  useEffect(() => {
    if (companyOptions.length === 0 || selectedFiles.length === 0) return;

    const matches: Record<string, string> = {};
    selectedFiles.forEach((file, index) => {
      const key = `${file.name}-${index}`;
      if (fileMatchedCompanies[key] !== undefined) return;
      const matchId = matchCompanyByFilename(file.name, companyOptions);
      if (matchId) matches[key] = matchId;
    });
    if (Object.keys(matches).length === 0) return;

    setFileMatchedCompanies((prev) => ({ ...prev, ...matches }));
    setFileMatchedProjects((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [key, id] of Object.entries(matches)) {
        if (next[key] === undefined) {
          next[key] = id;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedFiles, companyOptions, fileMatchedCompanies, fileMatchedProjects]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setSelectedFiles((prev) => [...prev, ...files]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFiles((prev) => [...prev, ...Array.from(files)]);
    }
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error("Please select at least one file first");
      return;
    }

    // Best-effort duplicate check against the file names currently loaded in
    // each category's page. Since listing is now paginated the browser no
    // longer holds every name, so this only catches duplicates visible on the
    // current pages; the server remains the source of truth.
    const existingFileNames = new Set([
      ...mom.files.map((n) => n.file_name),
      ...prospectusBucket.files.map((n) => n.file_name),
      ...shoppingListBucket.files.map((n) => n.file_name),
      ...bankerCommsBucket.files.map((n) => n.file_name),
      ...fundUpdatesBucket.files.map((n) => n.file_name),
      ...marketStudyBucket.files.map((n) => n.file_name),
      ...otherBucket.files.map((n) => n.file_name),
    ]);
    const duplicates = selectedFiles.filter((file) =>
      existingFileNames.has(file.name),
    );
    const filesToUpload = selectedFiles.filter(
      (file) => !existingFileNames.has(file.name),
    );

    if (filesToUpload.length === 0 && duplicates.length > 0) {
      toast.warning(
        duplicates.length === 1
          ? `File "${duplicates[0].name}" already exists and has been skipped.`
          : `${duplicates.length} files already exist and have been skipped.`,
      );
      setSelectedFiles([]);
      return;
    }

    setUploading(true);
    setUploadProgress({ current: 0, total: filesToUpload.length });

    const results = {
      success: 0,
      failed: 0,
    };

    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i];
      setUploadProgress({ current: i + 1, total: filesToUpload.length });

      try {
        // 1. Get pre-signed URL
        const fileName = file.name;
        const contentType = file.type || "application/octet-stream";

        const urlParams = new URLSearchParams({
          fileName,
          contentType,
        });

        const presignedResponse = await fetch(
          `/api/ai-file-dump/upload-url?${urlParams.toString()}`,
        );
        const presignedResult = await presignedResponse.json();

        if (!presignedResult.success) {
          throw new Error(presignedResult.error || "Failed to get upload URL");
        }

        const { uploadUrl, key } = presignedResult.data;

        // 2. Upload directly to S3
        const s3Response = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: {
            "Content-Type": contentType,
          },
        });

        if (!s3Response.ok) {
          throw new Error("Failed to upload file to S3");
        }

        // 3. Notify server of completion
        const fileKey = `${fileName}-${i}`;
        const rawNotesForFile = fileRawNotes[fileKey]?.trim() || undefined;
        const fileTypeOverride = fileTypeOverrides[fileKey];
        const body: Record<string, unknown> = {
          key,
          fileName,
          contentType,
        };
        if (rawNotesForFile) body.raw_notes = rawNotesForFile;
        if (fileTypeOverride && fileTypeOverride !== "auto") {
          body.file_type_override = fileTypeOverride;
        }

        const notifyResponse = await fetch("/api/ai-file-dump", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const notifyResult = await notifyResponse.json();

        if (notifyResult.success) {
          results.success++;
        } else {
          console.error(
            `Processing failed for ${file.name}:`,
            notifyResult.error,
          );
          results.failed++;
        }
      } catch (error) {
        console.error(`Upload error for ${file.name}:`, error);
        results.failed++;
      }
    }

    if (results.success > 0) {
      // Capture file upload event
      posthog.capture("file_uploaded", {
        file_count: results.success,
        failed_count: results.failed,
        duplicate_count: duplicates.length,
      });

      toast.success(
        filesToUpload.length === 1
          ? "File uploaded successfully"
          : `Successfully uploaded ${results.success} of ${filesToUpload.length} files`,
      );

      if (duplicates.length > 0) {
        toast.warning(
          `${duplicates.length} duplicate ${duplicates.length === 1 ? "file was" : "files were"} skipped.`,
        );
      }

      if (results.failed > 0) {
        toast.error(`Failed to upload ${results.failed} files`);
      }
      setSelectedFiles([]);
      setFileRawNotes({});
      setExpandedFileNotes({});
      setFileTypeOverrides({});
      setFileMatchedCompanies({});
      setFileMatchedProjects({});
      refetchVisited();
    } else {
      if (duplicates.length > 0) {
        toast.warning(
          `${duplicates.length} duplicate ${duplicates.length === 1 ? "file was" : "files were"} skipped.`,
        );
      }
      if (results.failed > 0) {
        toast.error("Failed to upload file");
      }
    }

    setUploading(false);
    setUploadProgress(null);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);

    try {
      const response = await fetch(`/api/ai-file-dump/${id}`, {
        method: "DELETE",
      });

      const result = await response.json();

      if (result.success) {
        // Capture file deleted event
        posthog.capture("file_deleted", {
          file_id: id,
        });

        toast.success("File deleted successfully");
        refetchVisited();
      } else {
        toast.error(result.error || "Failed to delete file");
      }
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("Failed to delete file");
    } finally {
      setDeletingId(null);
    }
  };

  const handleReprocess = async (id: string) => {
    setReprocessingId(id);

    try {
      const response = await fetch(`/api/ai-file-dump/${id}/reprocess`, {
        method: "POST",
      });

      const result = await response.json();

      if (response.ok && result.success) {
        posthog.capture("file_reprocessed", {
          file_id: id,
        });

        toast.success("File reprocessed successfully");
        refetchVisited();
      } else {
        toast.error(result.error || "Failed to reprocess file");
      }
    } catch (error) {
      console.error("Reprocess error:", error);
      toast.error("Failed to reprocess file");
    } finally {
      setReprocessingId(null);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const clearSelectedFiles = () => {
    setSelectedFiles([]);
    setFileRawNotes({});
    setExpandedFileNotes({});
    setFileTypeOverrides({});
    setFileMatchedCompanies({});
    setFileMatchedProjects({});
  };

  const toggleTags = (id: string) => {
    setExpandedTags((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleCompanies = (id: string) => {
    setExpandedCompanies((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleUpdateDate = async (id: string, date: Date | undefined) => {
    if (!date) return;

    try {
      const response = await fetch("/api/ai-file-dump", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id,
          file_date: format(date, "yyyy-MM-dd"),
        }),
      });

      if (!response.ok) throw new Error("Failed to update date");

      // file_date drives the default sort order, so refetch rather than patch
      // in place — the row may move pages.
      refetchAll();

      toast.success("Meeting date updated successfully");
    } catch (error) {
      console.error("Error updating meeting date:", error);
      toast.error("Failed to update meeting date");
    }
  };

  const handleDownload = async (noteId: string, fileName: string) => {
    setDownloadingId(noteId);
    try {
      const response = await fetch(`/api/ai-file-dump/${noteId}/download`);
      if (!response.ok) throw new Error("Failed to generate download URL");

      const { download_url } = await response.json();
      if (!download_url) throw new Error("Download URL not provided");

      // Trigger download
      const link = document.createElement("a");
      link.href = download_url;
      link.setAttribute("download", fileName);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("Download error:", error);
      toast.error("Failed to download file. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <DashboardLayout
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    >
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    >
      <div className="flex flex-col min-h-full p-6 space-y-6 animate-fade-in">
        {/* Header */}
        <div className="relative flex-shrink-0">
          <div className="absolute -inset-2 rounded-2xl opacity-20 blur-xl transition-colors duration-500 bg-gradient-to-r from-blue-500 via-sky-500 to-indigo-500" />
          <div className="relative flex items-center gap-5">
            <div className="relative group">
              <div className="absolute inset-0 rounded-2xl blur-md opacity-60 group-hover:opacity-80 transition-opacity bg-gradient-to-br from-blue-400 to-indigo-600" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl shadow-xl transition-all duration-300 group-hover:scale-105 bg-gradient-to-br from-blue-500 via-sky-500 to-indigo-600">
                <FileStack className="h-7 w-7 text-white drop-shadow-lg" />
                <div
                  className="absolute inset-0 rounded-2xl animate-ping opacity-20 bg-blue-400"
                  style={{ animationDuration: "3s" }}
                />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
                  AI File Dump
                </h1>
                <AskAIButton
                  variant="button"
                  label="Analyze"
                  onClick={() =>
                    analyzeWithAI(
                      "Analyze the files in the AI File Dump and summarize the key takeaways across them.",
                    )
                  }
                />
              </div>
              <p className="text-muted-foreground text-sm">
                Drop your files and let AI automatically organize and categorize
                them
              </p>
            </div>
          </div>
        </div>

        {/* Upload Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Drag and drop files
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Drop Zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`
                border-2 border-dashed rounded-lg p-8 text-center transition-colors
                ${
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-muted-foreground/25 hover:border-primary/50"
                }
                ${selectedFiles.length > 0 ? "bg-muted/50" : ""}
              `}
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-center gap-x-8 gap-y-4">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <FileUp className="h-10 w-10 text-muted-foreground" />
                    <p className="text-muted-foreground text-sm">
                      Drag and drop files here, or{" "}
                      <label className="text-primary cursor-pointer hover:underline">
                        browse
                        <Input
                          type="file"
                          className="hidden"
                          onChange={handleFileSelect}
                          accept=".pdf,.doc,.docx,.txt,.md,.csv,.mbox"
                          multiple
                        />
                      </label>
                    </p>
                    <p className="text-xs text-muted-foreground text-center">
                      Supports PPTX, PDF, DOC, DOCX, TXT, MD, CSV, MBOX
                    </p>
                  </div>
                  {/* <div className="flex flex-col items-center gap-2 text-center">
                    <FileSpreadsheet className="h-10 w-10 text-emerald-600" />
                    <p className="text-muted-foreground text-sm flex flex-col items-center justify-center gap-0.5">
                      <span>Upload bulk companies using</span><span>this template {' '}
                        <a
                          href="/File Upload Template.xlsx"
                          download="File Upload Template.xlsx"
                          className="text-primary font-medium underline underline-offset-2 hover:no-underline cursor-pointer"
                        >
                          here
                        </a>
                      </span>
                    </p>
                  </div> */}
                </div>
              </div>
            </div>

            {/* Selected Files Table — pre-upload classification & metadata */}
            {selectedFiles.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">
                    Selected Files ({selectedFiles.length})
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearSelectedFiles}
                    className="text-xs h-7"
                  >
                    Clear all
                  </Button>
                </div>
                <div className="rounded-md border max-h-[400px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>File name</TableHead>
                        <TableHead className="w-[200px]">
                          Matched Company
                        </TableHead>
                        <TableHead className="w-[200px]">
                          Project Name
                        </TableHead>
                        <TableHead className="w-[160px]">Category</TableHead>
                        <TableHead className="w-[180px] text-right">
                          Actions
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedFiles.map((file, index) => {
                        const fileKey = `${file.name}-${index}`;
                        const existingFileNames = new Set([
                          ...mom.files.map((n) => n.file_name),
                          ...prospectusBucket.files.map((n) => n.file_name),
                          ...bankerCommsBucket.files.map((n) => n.file_name),
                          ...fundUpdatesBucket.files.map((n) => n.file_name),
                          ...otherBucket.files.map((n) => n.file_name),
                        ]);
                        const isDuplicate = existingFileNames.has(file.name);
                        const notesExpanded = expandedFileNotes[fileKey];
                        const hasNotes =
                          (fileRawNotes[fileKey] ?? "").trim() !== "";
                        const matchedCompanyValue =
                          fileMatchedCompanies[fileKey] ?? AUTO;
                        const matchedProjectValue =
                          fileMatchedProjects[fileKey] ?? AUTO;
                        return (
                          <Fragment key={fileKey}>
                            <TableRow
                              className={
                                isDuplicate ? "bg-orange-500/5" : undefined
                              }
                            >
                              <TableCell className="align-top">
                                <div className="flex items-center gap-3 min-w-0">
                                  <FileText
                                    className={cn(
                                      "h-4 w-4 shrink-0",
                                      isDuplicate
                                        ? "text-orange-500"
                                        : "text-primary",
                                    )}
                                  />
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium truncate max-w-[320px]">
                                        {file.name}
                                      </p>
                                      {isDuplicate && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] h-4 py-0 px-1 text-orange-600 bg-orange-500/5 border-orange-200 shrink-0"
                                        >
                                          Duplicate
                                        </Badge>
                                      )}
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">
                                      {(file.size / 1024).toFixed(1)} KB
                                    </p>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="align-top">
                                <MatchedCompanyCombobox
                                  value={matchedCompanyValue}
                                  onChange={(next) => {
                                    // Project Name mirrors Matched Company —
                                    // the user can still override Project
                                    // Name independently afterwards, but the
                                    // next Matched Company change re-syncs.
                                    setFileMatchedCompanies((prev) => ({
                                      ...prev,
                                      [fileKey]: next,
                                    }));
                                    setFileMatchedProjects((prev) => ({
                                      ...prev,
                                      [fileKey]: next,
                                    }));
                                  }}
                                  fallbackOptions={companyOptions}
                                  disabled={uploading}
                                />
                              </TableCell>
                              <TableCell className="align-top">
                                <Select
                                  value={matchedProjectValue}
                                  onValueChange={(value) =>
                                    setFileMatchedProjects((prev) => ({
                                      ...prev,
                                      [fileKey]: value,
                                    }))
                                  }
                                  disabled={uploading}
                                >
                                  <SelectTrigger
                                    className="h-8 text-xs"
                                    aria-label="Project name"
                                  >
                                    <SelectValue placeholder="Auto (AI Decides)" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={AUTO}>
                                      Auto (AI Decides)
                                    </SelectItem>
                                    {companyOptions
                                      .filter((c) => c.projectName)
                                      .map((c) => (
                                        <SelectItem key={c.id} value={c.id}>
                                          {c.projectName}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell className="align-top">
                                <Select
                                  value={fileTypeOverrides[fileKey] ?? "auto"}
                                  onValueChange={(value) =>
                                    setFileTypeOverrides((prev) => ({
                                      ...prev,
                                      [fileKey]: value as
                                        | "auto"
                                        | "mom"
                                        | "prospectus"
                                        | "shopping_list"
                                        | "fund_updates"
                                        | "market_study"
                                        | "other",
                                    }))
                                  }
                                  disabled={uploading}
                                >
                                  <SelectTrigger
                                    className="h-8 text-xs"
                                    aria-label="Category"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="auto">
                                      Auto (AI Decides)
                                    </SelectItem>
                                    <SelectItem value="mom">MoM</SelectItem>
                                    <SelectItem value="prospectus">
                                      Prospectus
                                    </SelectItem>
                                    <SelectItem value="shopping_list">
                                      Shopping List
                                    </SelectItem>
                                    <SelectItem value="fund_updates">
                                      Fund Updates
                                    </SelectItem>
                                    <SelectItem value="market_study">
                                      Market Study
                                    </SelectItem>
                                    <SelectItem value="other">Other</SelectItem>
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell className="align-top text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 text-xs gap-1"
                                    onClick={() =>
                                      setExpandedFileNotes((prev) => ({
                                        ...prev,
                                        [fileKey]: !prev[fileKey],
                                      }))
                                    }
                                  >
                                    {notesExpanded ? (
                                      <ChevronUp className="h-3 w-3" />
                                    ) : (
                                      <ChevronDown className="h-3 w-3" />
                                    )}
                                    Add Notes
                                    {hasNotes && (
                                      <span className="text-primary">•</span>
                                    )}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => removeFile(index)}
                                    className="h-8 w-8"
                                    disabled={uploading}
                                    aria-label="Remove file"
                                  >
                                    <X className="h-3 w-3" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                            {notesExpanded && (
                              <TableRow className="hover:bg-transparent">
                                <TableCell colSpan={5} className="bg-muted/30">
                                  <Textarea
                                    placeholder="Paste raw notes for this file (optional)..."
                                    value={fileRawNotes[fileKey] ?? ""}
                                    onChange={(e) =>
                                      setFileRawNotes((prev) => ({
                                        ...prev,
                                        [fileKey]: e.target.value,
                                      }))
                                    }
                                    rows={3}
                                    className="resize-none text-sm"
                                  />
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {/* Upload Button & Progress */}
            {selectedFiles.length > 0 && (
              <div className="flex flex-col gap-4 pt-2">
                {uploading && uploadProgress && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">
                        Processing {uploadProgress.current} of{" "}
                        {uploadProgress.total}...
                      </span>
                      <span className="font-medium">
                        {Math.round(
                          (uploadProgress.current / uploadProgress.total) * 100,
                        )}
                        %
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{
                          width: `${(uploadProgress.current / uploadProgress.total) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex justify-end">
                  <Button onClick={handleUpload} disabled={uploading}>
                    {uploading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {selectedFiles.length > 1
                          ? `Uploading Queue (${uploadProgress?.current}/${uploadProgress?.total})`
                          : "Uploading..."}
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        {selectedFiles.length > 1
                          ? `Upload ${selectedFiles.length} Files`
                          : "Upload File"}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search across all file types..."
              className="pl-9 h-10 text-sm"
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
            />
          </div>
          <div id="ai-file-dump-toolbar"></div>
        </div>

        <Card className="overflow-hidden">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <div className="border-b px-2 pt-1">
            <TabsList className="h-auto w-full justify-start gap-0 overflow-x-auto rounded-none border-0 bg-transparent px-0 pt-0">
              {(
              [
                { value: "mom", label: "MoM", bucket: mom },
                { value: "prospectus", label: "Prospectus", bucket: prospectusBucket },
                { value: "shopping_list", label: "Shopping Lists", bucket: shoppingListBucket },
                { value: "banker_communications", label: "Banker Communications", bucket: bankerCommsBucket },
                { value: "fund_updates", label: "Fund Updates", bucket: fundUpdatesBucket },
                { value: "market_study", label: "Market Study", bucket: marketStudyBucket },
                { value: "other", label: "Other", bucket: otherBucket },
              ].map((t) => ({
                ...t,
                count: visitedTabs.has(t.value) ? t.bucket.total : (tabCounts[t.value] ?? 0),
              }))
            ).map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="relative -mb-px shrink-0 rounded-none border-b-2 border-transparent bg-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-none transition-colors data-[state=active]:border-blue-500 data-[state=active]:bg-transparent data-[state=active]:text-blue-700 data-[state=active]:shadow-none dark:data-[state=active]:text-blue-300"
              >
                {tab.label}
                <Badge
                  variant="secondary"
                  className="ml-2 h-5 min-w-5 px-1.5 text-xs font-normal"
                >
                  {tab.count}
                </Badge>
              </TabsTrigger>
            ))}
            </TabsList>
          </div>

          <TabsContent value="mom" className="mt-0">
            <TabBucketPanel loading={mom.initialLoading}>
            <FileTable
              title="MoM"
              icon={<FileText className="h-5 w-5" />}
              iconColor="text-blue-500"
              files={mom.files}
              total={mom.total}
              searchQuery={mom.search}
              onSearchChange={mom.setSearch}
              sortField={mom.sortField}
              sortDirection={mom.sortDirection}
              onSort={mom.onSort}
              expandedTags={expandedTags}
              toggleTags={toggleTags}
              expandedCompanies={expandedCompanies}
              toggleCompanies={toggleCompanies}
              onOpenCompany={openCompany}
              onMatchedCompaniesChanged={refetchAll}
              onUpdateDate={handleUpdateDate}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onReview={(id, fileType) => setReviewFile({ id, file_type: fileType })}
              onViewFundUpdateParsed={setViewFundUpdateFileId}
              onReprocess={handleReprocess}
              downloadingId={downloadingId}
              deletingId={deletingId}
              reprocessingId={reprocessingId}
              emptyMessage="No MoM uploaded yet."
              emptySubMessage="Upload your first MoM using the form above."
              currentPage={mom.page}
              onPageChange={mom.setPage}
              hideTitle
            />
            </TabBucketPanel>
          </TabsContent>

          <TabsContent value="prospectus" className="mt-0">
            <TabBucketPanel loading={prospectusBucket.initialLoading}>
            <FileTable
              title="Prospectus"
              icon={<FileSpreadsheet className="h-5 w-5" />}
              iconColor="text-blue-500"
              files={prospectusBucket.files}
              total={prospectusBucket.total}
              searchQuery={prospectusBucket.search}
              onSearchChange={prospectusBucket.setSearch}
              sortField={prospectusBucket.sortField}
              sortDirection={prospectusBucket.sortDirection}
              onSort={prospectusBucket.onSort}
              expandedTags={expandedTags}
              toggleTags={toggleTags}
              expandedCompanies={expandedCompanies}
              toggleCompanies={toggleCompanies}
              onOpenCompany={openCompany}
              onMatchedCompaniesChanged={refetchAll}
              onUpdateDate={handleUpdateDate}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onReview={(id, fileType) => setReviewFile({ id, file_type: fileType })}
              onViewFundUpdateParsed={setViewFundUpdateFileId}
              onReprocess={handleReprocess}
              downloadingId={downloadingId}
              deletingId={deletingId}
              reprocessingId={reprocessingId}
              emptyMessage="No prospectus uploaded yet."
              emptySubMessage="Upload your first prospectus using the form above."
              currentPage={prospectusBucket.page}
              onPageChange={prospectusBucket.setPage}
              hideTitle
            />
            </TabBucketPanel>
          </TabsContent>

          <TabsContent value="shopping_list" className="mt-0">
            <TabBucketPanel loading={shoppingListBucket.initialLoading}>
            <FileTable
              title="Shopping Lists"
              icon={<FileSpreadsheet className="h-5 w-5" />}
              iconColor="text-blue-500"
              files={shoppingListBucket.files}
              total={shoppingListBucket.total}
              searchQuery={shoppingListBucket.search}
              onSearchChange={shoppingListBucket.setSearch}
              sortField={shoppingListBucket.sortField}
              sortDirection={shoppingListBucket.sortDirection}
              onSort={shoppingListBucket.onSort}
              expandedTags={expandedTags}
              toggleTags={toggleTags}
              expandedCompanies={expandedCompanies}
              toggleCompanies={toggleCompanies}
              onOpenCompany={openCompany}
              onMatchedCompaniesChanged={refetchAll}
              onUpdateDate={handleUpdateDate}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onReview={(id, fileType) => setReviewFile({ id, file_type: fileType })}
              onViewFundUpdateParsed={setViewFundUpdateFileId}
              onReprocess={handleReprocess}
              downloadingId={downloadingId}
              deletingId={deletingId}
              reprocessingId={reprocessingId}
              emptyMessage="No shopping lists uploaded yet."
              emptySubMessage="Upload a target list using the form above."
              currentPage={shoppingListBucket.page}
              onPageChange={shoppingListBucket.setPage}
              hideTitle
            />
            </TabBucketPanel>
          </TabsContent>

          <TabsContent value="banker_communications" className="mt-0">
            <TabBucketPanel loading={bankerCommsBucket.initialLoading}>
            <FileTable
              title="Banker Communications"
              icon={<FileSpreadsheet className="h-5 w-5" />}
              iconColor="text-blue-500"
              files={bankerCommsBucket.files}
              total={bankerCommsBucket.total}
              searchQuery={bankerCommsBucket.search}
              onSearchChange={bankerCommsBucket.setSearch}
              sortField={bankerCommsBucket.sortField}
              sortDirection={bankerCommsBucket.sortDirection}
              onSort={bankerCommsBucket.onSort}
              expandedTags={expandedTags}
              toggleTags={toggleTags}
              expandedCompanies={expandedCompanies}
              toggleCompanies={toggleCompanies}
              onOpenCompany={openCompany}
              onMatchedCompaniesChanged={refetchAll}
              onUpdateDate={handleUpdateDate}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onReview={(id, fileType) => setReviewFile({ id, file_type: fileType })}
              onViewFundUpdateParsed={setViewFundUpdateFileId}
              onReprocess={handleReprocess}
              downloadingId={downloadingId}
              deletingId={deletingId}
              reprocessingId={reprocessingId}
              emptyMessage="No banker communications uploaded yet."
              emptySubMessage="Upload CSV or MBOX files from Google Vault exports."
              currentPage={bankerCommsBucket.page}
              onPageChange={bankerCommsBucket.setPage}
              hideTitle
            />
            </TabBucketPanel>
          </TabsContent>

          <TabsContent value="fund_updates" className="mt-0">
            <TabBucketPanel loading={fundUpdatesBucket.initialLoading}>
            <FileTable
              title="Fund Updates"
              icon={<FileText className="h-5 w-5" />}
              iconColor="text-emerald-500"
              files={fundUpdatesBucket.files}
              total={fundUpdatesBucket.total}
              searchQuery={fundUpdatesBucket.search}
              onSearchChange={fundUpdatesBucket.setSearch}
              sortField={fundUpdatesBucket.sortField}
              sortDirection={fundUpdatesBucket.sortDirection}
              onSort={fundUpdatesBucket.onSort}
              expandedTags={expandedTags}
              toggleTags={toggleTags}
              expandedCompanies={expandedCompanies}
              toggleCompanies={toggleCompanies}
              onOpenCompany={openCompany}
              onMatchedCompaniesChanged={refetchAll}
              onUpdateDate={handleUpdateDate}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onReview={(id, fileType) => setReviewFile({ id, file_type: fileType })}
              onViewFundUpdateParsed={setViewFundUpdateFileId}
              onReprocess={handleReprocess}
              downloadingId={downloadingId}
              deletingId={deletingId}
              reprocessingId={reprocessingId}
              emptyMessage="No fund update documents found"
              emptySubMessage="Documents uploaded and classified as 'Fund Updates' will appear here."
              currentPage={fundUpdatesBucket.page}
              onPageChange={fundUpdatesBucket.setPage}
              itemsPerPage={PAGE_SIZE}
              hideTitle
            />
            </TabBucketPanel>
          </TabsContent>

          <TabsContent value="market_study" className="mt-0">
            <TabBucketPanel loading={marketStudyBucket.initialLoading}>
            <FileTable
              title="Market Study"
              icon={<FileSpreadsheet className="h-5 w-5" />}
              iconColor="text-blue-500"
              files={marketStudyBucket.files}
              total={marketStudyBucket.total}
              searchQuery={marketStudyBucket.search}
              onSearchChange={marketStudyBucket.setSearch}
              sortField={marketStudyBucket.sortField}
              sortDirection={marketStudyBucket.sortDirection}
              onSort={marketStudyBucket.onSort}
              expandedTags={expandedTags}
              toggleTags={toggleTags}
              expandedCompanies={expandedCompanies}
              toggleCompanies={toggleCompanies}
              onOpenCompany={openCompany}
              onMatchedCompaniesChanged={refetchAll}
              onUpdateDate={handleUpdateDate}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onReview={(id, fileType) => setReviewFile({ id, file_type: fileType })}
              onViewFundUpdateParsed={setViewFundUpdateFileId}
              onReprocess={handleReprocess}
              downloadingId={downloadingId}
              deletingId={deletingId}
              reprocessingId={reprocessingId}
              emptyMessage="No market studies uploaded yet."
              emptySubMessage="Upload your first market study using the form above."
              currentPage={marketStudyBucket.page}
              onPageChange={marketStudyBucket.setPage}
              hideTitle
            />
            </TabBucketPanel>
          </TabsContent>

          <TabsContent value="other" className="mt-0">
            <TabBucketPanel loading={otherBucket.initialLoading}>
            <FileTable
              title="Other"
              icon={<File className="h-5 w-5" />}
              iconColor="text-blue-500"
              files={otherBucket.files}
              total={otherBucket.total}
              searchQuery={otherBucket.search}
              onSearchChange={otherBucket.setSearch}
              sortField={otherBucket.sortField}
              sortDirection={otherBucket.sortDirection}
              onSort={otherBucket.onSort}
              expandedTags={expandedTags}
              toggleTags={toggleTags}
              expandedCompanies={expandedCompanies}
              toggleCompanies={toggleCompanies}
              onOpenCompany={openCompany}
              onMatchedCompaniesChanged={refetchAll}
              onUpdateDate={handleUpdateDate}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onReview={(id, fileType) => setReviewFile({ id, file_type: fileType })}
              onViewFundUpdateParsed={setViewFundUpdateFileId}
              onReprocess={handleReprocess}
              downloadingId={downloadingId}
              deletingId={deletingId}
              reprocessingId={reprocessingId}
              emptyMessage="No other files uploaded yet."
              emptySubMessage="Upload your files using the form above."
              currentPage={otherBucket.page}
              onPageChange={otherBucket.setPage}
              hideTitle
            />
            </TabBucketPanel>
          </TabsContent>
        </Tabs>
        </Card>
      </div>

      {viewFundUpdateFileId && (
        <FundUpdateReviewDialog
          fileId={viewFundUpdateFileId}
          open={!!viewFundUpdateFileId}
          readOnly
          onClose={() => setViewFundUpdateFileId(null)}
          onApproved={() => setViewFundUpdateFileId(null)}
        />
      )}

      {reviewFile && reviewFile.file_type === "fund_updates" && (
        <FundUpdateReviewDialog
          fileId={reviewFile.id}
          open={!!reviewFile}
          onClose={() => setReviewFile(null)}
          onApproved={() => {
            setReviewFile(null);
            refetchVisited();
          }}
        />
      )}

      {reviewFile && reviewFile.file_type !== "fund_updates" && (
        <HitlReviewDialog
          fileId={reviewFile.id}
          open={!!reviewFile}
          onClose={() => setReviewFile(null)}
          onApproved={() => {
            setReviewFile(null);
            refetchVisited();
          }}
        />
      )}

      {selectedCompany && (
        <CompanyDetailDialog
          company={selectedCompany}
          open={!!selectedCompany}
          onOpenChange={(open) => !open && setSelectedCompany(null)}
          onUpdate={() => {
            refetchVisited();
          }}
        />
      )}
    </DashboardLayout>
  );
}
