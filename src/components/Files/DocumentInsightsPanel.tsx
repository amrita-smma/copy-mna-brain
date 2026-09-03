"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export type DocumentProcessingStatus = "pending" | "processing" | "completed" | "failed" | string | null;

interface StructuredNotes {
  summary?: string;
  key_points?: string[];
  action_items?: string[];
}

function parseStructuredNotes(structuredNotes: string | null): StructuredNotes | null {
  if (!structuredNotes) return null;
  try {
    return JSON.parse(structuredNotes) as StructuredNotes;
  } catch {
    return null;
  }
}

export function isDealDocumentProcessing(status: DocumentProcessingStatus): boolean {
  return status === "pending" || status === "processing";
}

export function hasDocumentInsights(doc: {
  structured_notes?: string | null;
  processing_status?: DocumentProcessingStatus;
}): boolean {
  return (
    Boolean(doc.structured_notes) ||
    doc.processing_status === "pending" ||
    doc.processing_status === "processing" ||
    doc.processing_status === "failed"
  );
}

/** Silent refetch while any attachment is still in the AI job pipeline. */
export function useDealDocumentProcessingPoll(
  documents: { processing_status?: DocumentProcessingStatus }[],
  refresh: () => void,
) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const hasActive = documents.some((d) => isDealDocumentProcessing(d.processing_status));

  useEffect(() => {
    if (!hasActive) return;
    const startedAt = Date.now();
    const maxMs = 10 * 60 * 1000;
    const id = setInterval(() => {
      if (Date.now() - startedAt >= maxMs) {
        clearInterval(id);
        return;
      }
      refreshRef.current();
    }, 3000);
    return () => clearInterval(id);
  }, [hasActive]);
}

export function DocumentStatusBadge({ status }: { status: DocumentProcessingStatus }) {
  switch (status) {
    case "processing":
      return (
        <Badge variant="outline" className="flex items-center gap-1 text-blue-500 bg-blue-500/5 border-blue-200">
          <Loader2 className="h-3 w-3 animate-spin" />
          Processing
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="outline" className="flex items-center gap-1 text-green-600 bg-green-500/5 border-green-200">
          <CheckCircle2 className="h-3 w-3" />
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="flex items-center gap-1 text-red-600 bg-red-500/5 border-red-200">
          <AlertCircle className="h-3 w-3" />
          Failed
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="flex items-center gap-1 text-gray-500 bg-gray-500/5 border-gray-200">
          Pending
        </Badge>
      );
    default:
      return null;
  }
}

export function DocumentTagsList({
  tags,
  expanded,
  onToggleExpand,
}: {
  tags: string[] | null | undefined;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  if (!tags || tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {(expanded ? tags : tags.slice(0, 3)).map((tag, i) => (
        <Badge key={i} variant="secondary" className="text-[10px] py-0 px-1.5 flex items-center gap-1">
          <Tag className="h-2.5 w-2.5" />
          {tag}
        </Badge>
      ))}
      {tags.length > 3 && (
        <Badge
          variant="outline"
          className="text-[10px] py-0 px-1.5 cursor-pointer hover:bg-muted"
          onClick={onToggleExpand}
        >
          {expanded ? "Show less" : `+${tags.length - 3} more`}
        </Badge>
      )}
    </div>
  );
}

/** Toggle button that expands/collapses the AI notes panel below a document row. */
export function DocumentInsightsToggle({
  hasNotes,
  expanded,
  onToggle,
}: {
  hasNotes: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!hasNotes) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-muted-foreground hover:text-foreground shrink-0"
      title={expanded ? "Hide AI notes" : "Show AI notes"}
    >
      {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
    </button>
  );
}

/** Expandable panel showing the AI-extracted summary / key points / action items for a document. */
export function DocumentInsightsPanel({
  structuredNotes,
  status,
}: {
  structuredNotes: string | null;
  status?: DocumentProcessingStatus;
}) {
  const notes = parseStructuredNotes(structuredNotes);

  if (!structuredNotes) {
    const message =
      status === "failed"
        ? "AI analysis failed for this document."
        : "AI analysis is still processing for this document.";
    return (
      <p className="text-xs text-muted-foreground italic px-3 py-2">
        {message}
      </p>
    );
  }

  if (!notes) {
    return <pre className="text-xs whitespace-pre-wrap px-3 py-2">{structuredNotes}</pre>;
  }

  const hasBody =
    Boolean(notes.summary) ||
    (notes.key_points && notes.key_points.length > 0) ||
    (notes.action_items && notes.action_items.length > 0);

  if (!hasBody) {
    return (
      <p className="text-xs text-muted-foreground italic px-3 py-2">
        No insights were extracted from this document.
      </p>
    );
  }

  return (
    <div className="space-y-2 text-xs px-3 py-2 border-t bg-background/50">
      {notes.summary && (
        <div>
          <h4 className="font-medium text-primary mb-1">Summary</h4>
          <p className="text-muted-foreground">{notes.summary}</p>
        </div>
      )}
      {notes.key_points && notes.key_points.length > 0 && (
        <div>
          <h4 className="font-medium text-primary mb-1">Key Points</h4>
          <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
            {notes.key_points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {notes.action_items && notes.action_items.length > 0 && (
        <div>
          <h4 className="font-medium text-primary mb-1">Action Items</h4>
          <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
            {notes.action_items.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
