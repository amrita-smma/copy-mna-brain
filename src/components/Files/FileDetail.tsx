"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AlertCircle, Bot, FileText, Link2, Loader2, Maximize2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import FilePreview from "@/components/Files/FilePreview";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";

/**
 * The file detail surface — header (name + Copy link / Reprocess) and the
 * two-pane body (preview, AI structured notes). Rendered by both the Smart
 * Files "View details" dialog and the `/files/[id]` deeplink page, so the two
 * stay identical: change it here, not in either shell.
 */

export interface FileRecord {
  id: string;
  file_name: string;
  file_link: string;
  file_type: string | null;
  raw_notes: string | null;
  structured_notes: string | null;
  processing_status: "pending" | "processing" | "awaiting_review" | "completed" | "failed";
  tags: string[];
  matched_companies: any[];
  signed_url?: string | null;
  file_date: string | null;
  created_at: string;
  updated_at: string;
}

interface FileFailureDetails {
  reasons: string[];
  warnings: string[];
  coverage: {
    parsed: number;
    excluded: number;
    ambiguous: number;
    total: number;
    percentage: number;
  } | null;
}

export function getFileFailureDetails(note: FileRecord): FileFailureDetails | null {
  if (note.processing_status !== "failed") return null;

  try {
    const structured = note.structured_notes ? JSON.parse(note.structured_notes) : null;
    const proposal = structured?.fund_update_proposal;
    const validation = proposal?.validation;
    const stats = proposal?.stats;
    const reasons: string[] = Array.isArray(validation?.hardFailures)
      ? Array.from(
          new Set<string>(
            validation.hardFailures.filter(
              (reason: unknown): reason is string => typeof reason === "string",
            ) as string[],
          ),
        )
      : [];
    const warnings = Array.isArray(proposal?.warnings)
      ? proposal.warnings.filter((warning: unknown): warning is string => typeof warning === "string")
      : [];
    const hasCoverage = [
      stats?.parsed_rows_count,
      stats?.excluded_rows_count,
      stats?.ambiguous_rows_count,
      stats?.total_data_rows,
      stats?.coverage_pct,
    ].every((value) => typeof value === "number");

    return {
      reasons: reasons.length > 0 ? reasons : [note.raw_notes || "Extraction failed"],
      warnings,
      coverage: hasCoverage
        ? {
            parsed: stats.parsed_rows_count,
            excluded: stats.excluded_rows_count,
            ambiguous: stats.ambiguous_rows_count,
            total: stats.total_data_rows,
            percentage: stats.coverage_pct,
          }
        : null,
    };
  } catch {
    return {
      reasons: [note.raw_notes || "Extraction failed"],
      warnings: [],
      coverage: null,
    };
  }
}

interface StructuredNotesProps {
  note: FileRecord;
  /** Opens the read-only parsed-workbook browser for a fund-update file. */
  onViewFundUpdateParsed?: (id: string) => void;
}

function StructuredNotes({ note, onViewFundUpdateParsed }: StructuredNotesProps) {
  if (!note.structured_notes) {
    const failure = getFileFailureDetails(note);
    if (failure) {
      return (
        <div className="rounded-md border border-red-200 bg-red-500/5 p-3 text-sm text-red-700">
          <div className="flex items-center gap-2 font-medium">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Why this failed
          </div>
          <p className="mt-2">{failure.reasons[0]}</p>
        </div>
      );
    }
    return (
      <p className="text-sm text-muted-foreground italic p-4">
        Processing not complete or structure extraction failed.
      </p>
    );
  }

  let structured: Record<string, any> | null = null;
  try {
    const parsed: unknown = JSON.parse(note.structured_notes);
    if (parsed && typeof parsed === "object") structured = parsed as Record<string, unknown>;
  } catch {
    // Not JSON — shown raw below.
  }
  if (!structured) {
    return (
      <pre className="text-xs whitespace-pre-wrap">
        {note.structured_notes}
      </pre>
    );
  }
  const proposal = structured.fund_update_proposal;
  const isFundUpdate =
    structured.file_type === "fund_updates" || note.file_type === "fund_updates";
  const failure = getFileFailureDetails(note);

  return (
    <>
      {failure ? (
        <div className="rounded-md border border-red-200 bg-red-500/5 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Why this failed
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-red-700">
            {failure.reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
          {failure.coverage ? (
            <div className="mt-3 rounded border border-red-200/80 bg-background/70 p-2 text-xs text-foreground">
              <span className="font-medium">Coverage: {failure.coverage.percentage}%</span>
              <span className="text-muted-foreground">
                {` · ${failure.coverage.parsed} parsed · ${failure.coverage.excluded} excluded · ${failure.coverage.ambiguous} ambiguous · ${failure.coverage.total} planned`}
              </span>
            </div>
          ) : null}
          {failure.warnings.length > 0 ? (
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium">
                Show {failure.warnings.length} extraction warning
                {failure.warnings.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {failure.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
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
            {proposal.fund_catalog?.length ? (
              <>
                <span>Funds</span>
                <span className="text-foreground">{proposal.fund_catalog.length}</span>
              </>
            ) : null}
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
          {(Array.isArray(structured.key_points) ? structured.key_points : []).map((p: string, i: number) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="font-medium text-primary mb-1">Action Items</h4>
        <ul className="list-disc pl-4 space-y-1">
          {(Array.isArray(structured.action_items) ? structured.action_items : []).map((p: string, i: number) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** Path of a file's deeplink page, relative to the workspace. */
export function fileDetailPath(fileId: string): string {
  return `/files/${encodeURIComponent(fileId)}`;
}

interface FileDetailActionsProps {
  file: FileRecord;
  reprocessing: boolean;
  onReprocess: (id: string) => void;
  /** Show an "Open page" link to the file's deeplink (the dialog does; the page itself doesn't). */
  showOpenPage?: boolean;
}

/** Header actions for a file: Open page (dialog only), Copy link, Reprocess. */
export function FileDetailActions({
  file,
  reprocessing,
  onReprocess,
  showOpenPage = false,
}: FileDetailActionsProps) {
  const pageHref = useWorkspaceHref(fileDetailPath(file.id));

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(new URL(pageHref, window.location.origin).toString());
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy link");
    }
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      {showOpenPage ? (
        <Button variant="outline" size="sm" asChild title="Open this file on its own page">
          <Link href={pageHref} data-testid="file-detail-open-page">
            <Maximize2 className="h-4 w-4 mr-2" />
            Open page
          </Link>
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() => void copyLink()}
        title="Copy a link to this file"
        data-testid="file-detail-copy-link"
      >
        <Link2 className="h-4 w-4 mr-2" />
        Copy link
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onReprocess(file.id)}
        disabled={reprocessing || file.processing_status === "processing"}
        title="Re-run AI extraction to refresh notes, tags & matches"
      >
        {reprocessing ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4 mr-2" />
        )}
        Reprocess
      </Button>
    </div>
  );
}

interface FileDetailBodyProps {
  file: FileRecord;
  onDownload: () => Promise<void> | void;
  onViewFundUpdateParsed?: (id: string) => void;
}

/** The two-pane body: file preview on the left, AI structured notes on the right. */
export function FileDetailBody({ file, onDownload, onViewFundUpdateParsed }: FileDetailBodyProps) {
  const previewTitle: ReactNode = (
    <>
      <FileText className="h-4 w-4" />
      File Preview
    </>
  );

  return (
    <div className="grid md:grid-cols-2 gap-6 mt-4 flex-1 min-h-0 overflow-hidden">
      <div className="flex flex-col gap-2 min-h-0">
        {file.signed_url ? (
          <div className="flex-1 min-h-0">
            <FilePreview
              title={previewTitle}
              url={file.signed_url}
              onDownload={onDownload}
              fileName={file.file_name}
              fileKey={file.file_link}
            />
          </div>
        ) : (
          <>
            <h3 className="text-sm font-semibold flex items-center gap-2">{previewTitle}</h3>
            <div className="flex flex-1 min-h-0 w-full items-center justify-center bg-muted rounded-md border text-muted-foreground">
              Preview not available (Link missing)
            </div>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2 min-h-0">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Bot className="h-4 w-4" />
          AI Structured Notes
        </h3>
        <ScrollArea className="flex-1 min-h-0 w-full rounded-md border p-4 bg-muted">
          <div className="space-y-4 text-sm">
            <StructuredNotes note={file} onViewFundUpdateParsed={onViewFundUpdateParsed} />
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
