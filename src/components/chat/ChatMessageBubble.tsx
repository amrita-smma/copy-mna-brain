import { type UIMessage } from "@ai-sdk/react";
import { memo, useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { companyDisplayName } from "@/lib/companyDisplay";
import { User, ChevronDown, ChevronRight, Wrench, Loader2, FileText, X, Sparkles, FileSearch, Brain, AlertTriangle } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import FilePreview from "@/components/Files/FilePreview";
import { toast } from "sonner";
import {
  WorkforceHandoffCard,
  type WorkforceHandoffPayload,
} from "./WorkforceHandoffCard";
import {
  BulkDropCompaniesCard,
  type BulkDropApprovalPayload,
} from "./BulkDropCompaniesCard";
import {
  BulkPromoteCompaniesCard,
  type BulkPromoteApprovalPayload,
} from "./BulkPromoteCompaniesCard";
import { useChatContext } from "./ChatProvider";

const WORKFORCE_HANDOFF_MARKER = "WORKFORCE_HANDOFF_JSON";
const WORKFORCE_HANDOFF_TOOL_NAME = "propose_workforce_handoff";
const BULK_DROP_APPROVAL_MARKER = "BULK_DROP_APPROVAL_JSON";
const BULK_DROP_APPROVAL_TOOL_NAME = "propose_bulk_drop_companies";
const BULK_PROMOTE_APPROVAL_MARKER = "BULK_PROMOTE_APPROVAL_JSON";
const BULK_PROMOTE_APPROVAL_TOOL_NAME = "propose_bulk_promote_companies";

interface ChatMessageBubbleProps {
  message: UIMessage;
  aiEmoji?: string;
  sources?: any[];
  className?: string;
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1 text-muted-foreground py-2">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span className="text-sm">Thinking</span>
      <span className="flex gap-0.5">
        <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
        <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
        <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
      </span>
    </div>
  );
}

export function LoadingBubble() {
  return (
    <div className="flex mb-6">
      {/* Thinking Indicator */}
      <div className="flex-1 min-w-0 flex flex-col items-start px-5">
        <ThinkingIndicator />
      </div>
    </div>
  );
}

function ChatMessageBubbleImpl(props: ChatMessageBubbleProps) {
  const isUser = props.message.role === "user";
  const parts = props.message?.parts || [];

  // Check if there's any text content being streamed (has text parts with content)
  const hasTextContent = parts.some(
    (part) => part.type === "text" && (part as any).text?.trim()
  );

  // Check if streaming is complete (all text parts have state === 'done')
  const isStreamingComplete = parts.length > 0 &&
    parts.filter((part) => part.type === "text").every((part) => (part as any).state === "done");

  // Check if tools are still running
  const hasRunningTools = parts.some(
    (part) => (part.type === "dynamic-tool" || part.type === "tool-invocation") &&
      (part as any).state !== "output-available"
  );

  // Show thinking indicator when: no text content yet OR tools are running (but not if thinking text is streaming)
  const showThinking = !isUser && (!hasTextContent || hasRunningTools) && !isStreamingComplete;

  // Auto-collapse tool results when response text starts streaming
  const [toolsCollapsed, setToolsCollapsed] = useState(false);

  useEffect(() => {
    // Collapse tools when we have text content
    if (hasTextContent && !toolsCollapsed) {
      setToolsCollapsed(true);
    }
  }, [hasTextContent]);

  // For user messages, just show text content
  if (isUser) {
    const textContent = parts
      .filter((part) => part.type === "text")
      .map((part) => (part as any).text)
      .join("");

    return (
      <div className="flex gap-4 mb-6 flex-row-reverse min-w-0">
        <div className="flex-shrink-0 h-10 w-10 rounded-xl flex items-center justify-center bg-primary">
          <User className="h-5 w-5 text-primary-foreground" />
        </div>
        <div className="flex-1 min-w-0 max-w-full md:max-w-[80%] flex flex-col items-end">
          <div className="rounded-2xl px-5 py-4 w-full min-w-0 overflow-auto break-words bg-primary text-primary-foreground">
            <MarkdownRenderer
              content={textContent}
              className="prose-invert [&_*]:text-primary-foreground"
            />
          </div>
        </div>
      </div>
    );
  }

  // Separate tool parts from text parts
  const toolParts = parts.filter(
    (part) => part.type === "dynamic-tool" || part.type === "tool-invocation"
  );
  const textParts = parts.filter((part) => part.type === "text");

  // Delimiters: thinking is between THINKING_START and THINKING_END; response is after THINKING_END.
  const THINKING_START_DELIMITER = "<!-- THINKING_START -->";
  const THINKING_END_DELIMITER = "<!-- THINKING_END -->";

  const fullText = textParts.map((part) => (part as any).text || "").join("");

  let thinkingText = "";
  let responseText = "";

  const hasEitherDelimiter = fullText.includes(THINKING_START_DELIMITER) || fullText.includes(THINKING_END_DELIMITER);

  if (!hasEitherDelimiter) {
    responseText = fullText;
  } else {
    // Collect all thinking blocks (text between each THINKING_START and THINKING_END pair)
    const thinkingParts: string[] = [];
    let remaining = fullText;

    while (remaining.length > 0) {
      const startIdx = remaining.indexOf(THINKING_START_DELIMITER);
      const endIdx = remaining.indexOf(THINKING_END_DELIMITER);

      if (startIdx === -1 && endIdx === -1) {
        // No more delimiters — rest is response text
        responseText += remaining;
        break;
      }

      if (startIdx !== -1 && (endIdx === -1 || startIdx < endIdx)) {
        // Found a THINKING_START — text before it is response
        responseText += remaining.substring(0, startIdx);
        remaining = remaining.substring(startIdx + THINKING_START_DELIMITER.length);

        // Look for matching THINKING_END
        const matchingEnd = remaining.indexOf(THINKING_END_DELIMITER);
        if (matchingEnd !== -1) {
          thinkingParts.push(remaining.substring(0, matchingEnd).trim());
          remaining = remaining.substring(matchingEnd + THINKING_END_DELIMITER.length);
        } else {
          // No closing delimiter yet (still streaming) — rest is thinking
          thinkingParts.push(remaining.trim());
          remaining = "";
        }
      } else {
        // THINKING_END without a preceding START — skip past it
        responseText += remaining.substring(0, endIdx);
        remaining = remaining.substring(endIdx + THINKING_END_DELIMITER.length);
      }
    }

    thinkingText = thinkingParts.filter(Boolean).join("\n\n---\n\n");
  }

  // Second pass: pull warning blocks out of responseText. The agent wraps an
  // EBITDA concern (or any other risk surfaced from a tool preview) between
  // <!-- WARNING_START --> and <!-- WARNING_END -->; we render those as a
  // yellow banner above the chat bubble and strip them from the prose.
  const WARNING_START_DELIMITER = "<!-- WARNING_START -->";
  const WARNING_END_DELIMITER = "<!-- WARNING_END -->";

  const warnings: string[] = [];
  if (
    responseText.includes(WARNING_START_DELIMITER) ||
    responseText.includes(WARNING_END_DELIMITER)
  ) {
    let cleaned = "";
    let remaining = responseText;
    while (remaining.length > 0) {
      const startIdx = remaining.indexOf(WARNING_START_DELIMITER);
      if (startIdx === -1) {
        // Drop any orphan END token but keep surrounding text.
        cleaned += remaining.split(WARNING_END_DELIMITER).join("");
        break;
      }
      cleaned += remaining.substring(0, startIdx);
      remaining = remaining.substring(startIdx + WARNING_START_DELIMITER.length);
      const endIdx = remaining.indexOf(WARNING_END_DELIMITER);
      if (endIdx === -1) {
        // Mid-stream: closing delimiter hasn't arrived. Treat the remainder
        // as an in-progress warning so it shows immediately as a banner.
        const partial = remaining.trim();
        if (partial) warnings.push(partial);
        remaining = "";
      } else {
        const body = remaining.substring(0, endIdx).trim();
        if (body) warnings.push(body);
        remaining = remaining.substring(endIdx + WARNING_END_DELIMITER.length);
      }
    }
    responseText = cleaned;
  }

  const hasThinkingContent = thinkingText.trim().length > 0;
  const hasResponseContent = responseText.trim().length > 0;

  // Auto-collapse thinking when response text starts streaming
  const [thinkingCollapsed, setThinkingCollapsed] = useState(false);

  useEffect(() => {
    if (hasResponseContent && !thinkingCollapsed) {
      setThinkingCollapsed(true);
    }
  }, [hasResponseContent]);

  // Extract citations from all web_search tool results
  const allCitations: { title: string; url: string }[] = [];
  // Extract files from query_files tool results - matches MeetingNote type
  interface MeetingNoteRef {
    id: string;
    file_name: string;
    file_link: string;
    file_date: string | null;
    tags: string[];
    structured_notes: string | null;
    matched_companies: any[];
  }
  const allMeetingNotes: MeetingNoteRef[] = [];
  let workforceHandoff: WorkforceHandoffPayload | null = null;
  let bulkDropApproval: BulkDropApprovalPayload | null = null;
  let bulkPromoteApproval: BulkPromoteApprovalPayload | null = null;

  for (const part of toolParts) {
    const toolName = (part as any).toolName || "";
    const output = (part as any).output;
    let content = "";
    if (output?.kwargs?.content) {
      content = output.kwargs.content;
    } else if (typeof output === "string") {
      content = output;
    }

    if (toolName === "web_search") {
      const citationMatch = content.match(/<!-- CITATIONS_JSON:(.*?) -->/);
      if (citationMatch) {
        try {
          const citations = JSON.parse(citationMatch[1]);
          for (const cite of citations) {
            if (!allCitations.some(c => c.url === cite.url)) {
              allCitations.push(cite);
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }

    if (toolName === WORKFORCE_HANDOFF_TOOL_NAME && !workforceHandoff) {
      const handoffMatch = content.match(
        new RegExp(`<!--\\s*${WORKFORCE_HANDOFF_MARKER}:(.*?)-->`, "s"),
      );
      if (handoffMatch) {
        try {
          const parsed = JSON.parse(handoffMatch[1].trim()) as WorkforceHandoffPayload;
          if (parsed && parsed.title && parsed.instruction) {
            workforceHandoff = parsed;
          }
        } catch {
          // Ignore parse errors — fall through to plain text rendering.
        }
      }
    }

    if (toolName === BULK_DROP_APPROVAL_TOOL_NAME && !bulkDropApproval) {
      const bulkDropMatch = content.match(
        new RegExp(`<!--\\s*${BULK_DROP_APPROVAL_MARKER}:(.*?)-->`, "s"),
      );
      if (bulkDropMatch) {
        try {
          const parsed = JSON.parse(bulkDropMatch[1].trim()) as BulkDropApprovalPayload;
          if (parsed && parsed.title && Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
            bulkDropApproval = parsed;
          }
        } catch {
          // Ignore parse errors — fall through to plain text rendering.
        }
      }
    }

    if (toolName === BULK_PROMOTE_APPROVAL_TOOL_NAME && !bulkPromoteApproval) {
      const bulkPromoteMatch = content.match(
        new RegExp(`<!--\\s*${BULK_PROMOTE_APPROVAL_MARKER}:(.*?)-->`, "s"),
      );
      if (bulkPromoteMatch) {
        try {
          const parsed = JSON.parse(bulkPromoteMatch[1].trim()) as BulkPromoteApprovalPayload;
          if (
            parsed &&
            parsed.title &&
            parsed.target_stage &&
            Array.isArray(parsed.candidates) &&
            parsed.candidates.length > 0
          ) {
            bulkPromoteApproval = parsed;
          }
        } catch {
          // Ignore parse errors — fall through to plain text rendering.
        }
      }
    }

    if (toolName === "query_files") {
      const notesMatch = content.match(/<!-- FILES_JSON:(.*?) -->/);
      if (notesMatch) {
        try {
          const notes = JSON.parse(notesMatch[1]);
          for (const note of notes) {
            if (!allMeetingNotes.some(n => n.id === note.id)) {
              allMeetingNotes.push(note);
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  }

  // Chat context for sending follow-up messages (e.g. "Just answer here")
  const { sendMessage } = useChatContext();
  const handleJustAnswerHere = () => {
    sendMessage({
      text: "Just answer here — please proceed inline without sending this to the Workforce.",
    });
  };

  // State for files preview modal
  const [previewNote, setPreviewNote] = useState<MeetingNoteRef | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Fetch signed URL when opening preview
  const handleOpenPreview = async (note: typeof previewNote) => {
    if (!note) return;
    setPreviewNote(note);
    setLoadingPreview(true);
    try {
      // Use the meeting-notes API to get a signed URL
      const res = await fetch(`/api/ai-file-dump/${note.id}/download-url`);
      if (res.ok) {
        const data = await res.json();
        setPreviewUrl(data.url);
      } else {
        // Fallback: try to use file_link directly if it's a full URL
        if (note.file_link.startsWith('http')) {
          setPreviewUrl(note.file_link);
        } else {
          toast.error("Failed to load file preview");
        }
      }
    } catch (e) {
      console.error("Failed to fetch preview URL:", e);
      toast.error("Failed to load file preview");
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleClosePreview = () => {
    setPreviewNote(null);
    setPreviewUrl(null);
  };

  // For assistant messages, render parts with switch statement
  return (
    <div className="flex mb-6 min-w-0">
      {/* Message Content — flat, full-width with symmetric horizontal padding */}
      <div className="flex-1 min-w-0 flex flex-col items-start gap-2 px-0 md:px-2">
        {/* Tool Results - All tools behind a single collapsible */}
        {toolParts.length > 0 && (
          <Collapsible
            open={!toolsCollapsed}
            onOpenChange={(open) => setToolsCollapsed(!open)}
            className="w-full"
          >
            <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-2 px-3 w-full bg-muted/40 rounded-lg border hover:bg-muted/60">
              <Wrench className="h-4 w-4" />
              <span className="font-medium">
                {toolParts.length} tool{toolParts.length > 1 ? "s" : ""} used
              </span>
              {toolsCollapsed ? (
                <ChevronRight className="h-4 w-4 ml-auto" />
              ) : (
                <ChevronDown className="h-4 w-4 ml-auto" />
              )}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 space-y-2 max-h-64 overflow-y-auto rounded-lg bg-muted/20 border p-3">
                {toolParts.map((part, index) => {
                  const toolName = (part as any).toolName || "Tool";
                  const output = (part as any).output;

                  // Extract content from the ToolMessage structure if present
                  let displayContent = "";
                  if (output?.kwargs?.content) {
                    displayContent = output.kwargs.content;
                  } else if (typeof output === "string") {
                    displayContent = output;
                  } else if (output) {
                    displayContent = JSON.stringify(output, null, 2);
                  }

                  // Remove hidden metadata from display content
                  displayContent = displayContent.replace(/\n*<!-- CITATIONS_JSON:.*? -->/g, "");
                  displayContent = displayContent.replace(/\n*<!-- FILES_JSON:.*? -->/g, "");
                  displayContent = displayContent.replace(
                    new RegExp(`\\n*<!--\\s*${WORKFORCE_HANDOFF_MARKER}:.*?-->`, "gs"),
                    "",
                  );

                  return (
                    <div key={`tool-${index}`} className="border-b border-border/50 pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-foreground">{toolName}</span>
                        {(part as any).state && (
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded",
                            (part as any).state === "output-available" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
                              (part as any).state === "running" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" :
                                "bg-muted text-muted-foreground"
                          )}>
                            {(part as any).state === "output-available" ? "completed" : (part as any).state}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <MarkdownRenderer
                          content={displayContent}
                          className="prose-xs [&_*]:text-xs"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Thinking Text - Agent reasoning about tools (collapsible, muted style) */}
        {hasThinkingContent && (() => {
          const tailLength = 120;
          const plainTail = thinkingText.replace(/\s+/g, " ").trim();
          const tailPreview =
            plainTail.length > tailLength
              ? "…" + plainTail.slice(-tailLength)
              : plainTail;
          return (
          <Collapsible
            open={!thinkingCollapsed}
            onOpenChange={(open) => setThinkingCollapsed(!open)}
            className="w-full"
          >
            <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-2 px-3 w-full bg-muted/30 rounded-lg border border-dashed hover:bg-muted/50 text-left">
              <Brain className="h-4 w-4 flex-shrink-0" />
              <span className="font-medium flex-shrink-0">Thinking</span>
              {thinkingCollapsed && tailPreview ? (
                <span className="min-w-0 flex-1 truncate text-xs ml-1" title={tailPreview}>
                  {tailPreview}
                </span>
              ) : null}
              {thinkingCollapsed ? (
                <ChevronRight className="h-4 w-4 flex-shrink-0 ml-auto" />
              ) : (
                <ChevronDown className="h-4 w-4 flex-shrink-0 ml-auto" />
              )}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-lg bg-muted/20 border border-dashed p-4 text-muted-foreground">
                <div className="text-sm">
                  <MarkdownRenderer
                    content={thinkingText}
                    className="prose-sm [&_*]:text-muted-foreground"
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
          );
        })()}

        {/* Thinking Indicator - Shows when agent is still processing */}
        {showThinking && <ThinkingIndicator />}

        {/* Warning banner(s) — agent surfaces concerns (e.g. weak EBITDA on an
            L0→L1 promotion preview) between WARNING_START/WARNING_END. */}
        {warnings.length > 0 && (
          <div className="w-full flex flex-col gap-2">
            {warnings.map((w, i) => (
              <div
                key={`warning-${i}`}
                role="alert"
                className="flex items-start gap-3 w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
              >
                <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 text-sm leading-relaxed">
                  <span className="font-semibold">Warning! </span>
                  <MarkdownRenderer
                    content={w}
                    className="inline prose-sm [&_p]:inline [&_p]:m-0 [&_*]:text-amber-900 dark:[&_*]:text-amber-200"
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Response Text - Final answer. Rendered as plain full-width text
            with no card/bubble, flat against the background. */}
        {hasResponseContent && (
          <div className="w-full min-w-0 overflow-auto break-words">
            <MarkdownRenderer content={responseText} />
          </div>
        )}

        {/* Workforce handoff card */}
        {workforceHandoff && (
          <WorkforceHandoffCard
            payload={workforceHandoff}
            onJustAnswerHere={handleJustAnswerHere}
          />
        )}

        {/* Bulk drop approval card */}
        {bulkDropApproval && (
          <BulkDropCompaniesCard payload={bulkDropApproval} />
        )}

        {/* Bulk promote approval card */}
        {bulkPromoteApproval && (
          <BulkPromoteCompaniesCard payload={bulkPromoteApproval} />
        )}

        {/* Sources */}
        {props.sources && props.sources.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            <p className="font-semibold mb-1">Sources:</p>
            <div className="flex flex-wrap gap-2">
              {props.sources.map((source, i) => (
                <div key={i} className="bg-muted px-2 py-1 rounded border">
                  {source.title || source.name || "Source"}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Web Search Citations - Below chat bubble */}
        {allCitations.length > 0 && (
          <div className="mt-2">
            <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">📚 Sources</p>
            <div className="flex flex-wrap gap-1.5">
              {allCitations.slice(0, 6).map((cite, i) => (
                <a
                  key={i}
                  href={cite.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50 transition-colors border border-blue-100 dark:border-blue-800"
                >
                  {cite.title.length > 35 ? cite.title.substring(0, 35) + "..." : cite.title}
                  <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Files - Below chat bubble */}
        {allMeetingNotes.length > 0 && (
          <div className="mt-2">
            <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">📄 Files</p>
            <div className="flex flex-wrap gap-1.5">
              {allMeetingNotes.slice(0, 6).map((note, i) => (
                <button
                  key={i}
                  onClick={() => handleOpenPreview(note)}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/50 transition-colors border border-amber-100 dark:border-amber-800 cursor-pointer"
                >
                  <FileText className="h-3 w-3 flex-shrink-0" />
                  {note.file_name?.length > 30 ? note.file_name.substring(0, 30) + "..." : note.file_name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Files Preview Dialog */}
      <Dialog open={!!previewNote} onOpenChange={(open) => !open && handleClosePreview()}>
        <DialogContent className="flex flex-col w-screen h-screen max-w-none sm:rounded-none border-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              <span className="truncate">{previewNote?.file_name}</span>
              {previewNote?.file_date && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  {previewNote.file_date}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          {/* Side-by-side layout */}
          <div className="grid md:grid-cols-2 gap-6 mt-4 flex-1 min-h-0 overflow-hidden">
            {/* Left: File Preview */}
            <div className="flex flex-col gap-2 min-h-0">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <FileSearch className="h-4 w-4" />
                File Preview
              </h3>
              {loadingPreview ? (
                <div className="flex flex-1 min-h-0 w-full items-center justify-center bg-muted/30 rounded-md border">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
              ) : previewUrl ? (
                <div className="flex-1 min-h-0">
                  <FilePreview
                    url={previewUrl}
                    fileName={previewNote?.file_name || ""}
                    fileKey={
                      previewNote?.file_link && !previewNote.file_link.startsWith("http")
                        ? previewNote.file_link
                        : undefined
                    }
                  />
                </div>
              ) : (
                <div className="flex flex-1 min-h-0 w-full items-center justify-center bg-muted/30 rounded-md border text-muted-foreground">
                  Preview not available
                </div>
              )}
            </div>

            {/* Right: AI Structured Notes */}
            <div className="flex flex-col gap-2 min-h-0">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                AI Structured Notes
              </h3>
              <ScrollArea className="flex-1 min-h-0 w-full rounded-md border p-4 bg-muted/30">
                {previewNote?.structured_notes ? (
                  <div className="space-y-4 text-sm">
                    {(() => {
                      try {
                        const structured = JSON.parse(previewNote.structured_notes);
                        return (
                          <>
                            {/* Tags */}
                            {previewNote?.tags && previewNote.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pb-2">
                                {previewNote.tags.map((tag, i) => (
                                  <Badge key={i} variant="secondary" className="text-xs">
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            )}

                            {/* Summary */}
                            {structured.summary && (
                              <div>
                                <h4 className="font-medium text-primary mb-1">Summary</h4>
                                <p>{structured.summary}</p>
                              </div>
                            )}

                            {/* Key Points */}
                            {structured.key_points && structured.key_points.length > 0 && (
                              <div>
                                <h4 className="font-medium text-primary mb-1">Key Points</h4>
                                <ul className="list-disc pl-4 space-y-1">
                                  {structured.key_points.map((point: string, i: number) => (
                                    <li key={i}>{point}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Action Items */}
                            {structured.action_items && structured.action_items.length > 0 && (
                              <div>
                                <h4 className="font-medium text-primary mb-1">Action Items</h4>
                                <ul className="list-disc pl-4 space-y-1">
                                  {structured.action_items.map((item: string, i: number) => (
                                    <li key={i}>{item}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Matched Companies */}
                            {previewNote?.matched_companies && previewNote.matched_companies.length > 0 && (
                              <div>
                                <h4 className="font-medium text-primary mb-1">Companies Mentioned</h4>
                                <div className="flex flex-wrap gap-1.5">
                                  {previewNote.matched_companies.map((company, i) => (
                                    <Badge key={i} variant="outline" className="text-xs">
                                      {typeof company === 'string' ? company : companyDisplayName(company)}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        );
                      } catch (e) {
                        return <pre className="text-xs whitespace-pre-wrap">{previewNote.structured_notes}</pre>;
                      }
                    })()}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic p-4">
                    Processing not complete or structure extraction failed.
                  </p>
                )}
              </ScrollArea>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Memoize so typing in the input doesn't re-render every bubble in the
// history. Streaming messages still re-render because the AI SDK produces a
// new message object on each chunk (changes the prop reference).
export const ChatMessageBubble = memo(ChatMessageBubbleImpl);
