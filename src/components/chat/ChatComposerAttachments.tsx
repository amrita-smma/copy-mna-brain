"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { Paperclip, X, LoaderCircle, FileText, AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChatContext, type ChatAttachment } from "./ChatProvider";

/**
 * Drag-and-drop wiring for a composer. Spread `dropHandlers` onto the element
 * that should accept file drops; use `isDragging` to render a highlight.
 */
export function useAttachmentDrop() {
  const { addFiles } = useChatContext();
  const [isDragging, setIsDragging] = useState(false);
  // Depth counter so nested children don't flicker the highlight on every
  // dragenter/dragleave bubbling through them.
  const depth = useRef(0);

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setIsDragging(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      depth.current = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  return { isDragging, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

/** Paperclip button that opens a file picker and attaches the chosen files. */
export function AttachButton({
  className,
  disabled,
}: {
  className?: string;
  disabled?: boolean;
}) {
  const { addFiles } = useChatContext();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) addFiles(files);
          // Reset so re-selecting the same file fires onChange again.
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        aria-label="Attach file"
        title="Attach file"
        className={cn("shrink-0 px-2 text-muted-foreground", className)}
      >
        <Paperclip className="h-4 w-4" />
      </Button>
    </>
  );
}

function AttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  const { removeAttachment } = useChatContext();
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border bg-muted/60 px-2 py-1 text-xs max-w-[220px]",
        attachment.status === "error" && "border-destructive/50 text-destructive",
      )}
    >
      {attachment.status === "uploading" ? (
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      ) : attachment.status === "error" ? (
        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="truncate" title={attachment.fileName}>
        {attachment.fileName}
      </span>
      <button
        type="button"
        onClick={() => removeAttachment(attachment.localId)}
        aria-label={`Remove ${attachment.fileName}`}
        className="shrink-0 rounded p-0.5 hover:bg-background"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Row of chips for the currently-attached files. Renders nothing when empty. */
export function AttachmentChips({ className }: { className?: string }) {
  const { attachments } = useChatContext();
  if (attachments.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {attachments.map((a) => (
        <AttachmentChip key={a.localId} attachment={a} />
      ))}
    </div>
  );
}
