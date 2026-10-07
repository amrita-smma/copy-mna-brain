"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { Paperclip, X, LoaderCircle, FileText, AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useChatActions, useChatComposer, type ChatAttachment } from "./ChatProvider";

/**
 * Drag-and-drop wiring for a composer. Spread `dropHandlers` onto the element
 * that should accept file drops; use `isDragging` to render a highlight.
 */
export function useAttachmentDrop() {
  const { addFiles } = useChatActions();
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

/**
 * Clipboard paste wiring for a composer. Bind `onPaste` onto the element (like
 * the form or the textarea) that should accept pasted images/files.
 */
export function useAttachmentPaste() {
  const { addFiles } = useChatActions();

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  return { onPaste };
}

/** Paperclip button that opens a file picker and attaches the chosen files. */
export function AttachButton({
  className,
  disabled,
}: {
  className?: string;
  disabled?: boolean;
}) {
  const { addFiles } = useChatActions();
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

import * as DialogPrimitive from "@radix-ui/react-dialog";

function AttachmentChip({ 
  attachment, 
  isImagesOnly,
  isSingleImage
}: { 
  attachment: ChatAttachment;
  isImagesOnly?: boolean;
  isSingleImage?: boolean;
}) {
  const { removeAttachment } = useChatActions();
  const isImage = attachment.contentType.startsWith("image/") && attachment.previewUrl;

  if (isImage) {
    const sizeClasses = isImagesOnly 
      ? isSingleImage
        ? "h-32 w-32 sm:h-40 sm:w-40 rounded-lg" // Large for single image
        : "h-20 w-20 sm:h-24 sm:w-24 rounded-lg" // Grid size for multiple images
      : "h-16 w-16 rounded-md"; // Compact for mixed files

    return (
      <DialogPrimitive.Root>
        <div className={cn("relative group border shadow-sm overflow-hidden shrink-0 bg-muted", sizeClasses)}>
          <DialogPrimitive.Trigger asChild>
            <button
              type="button"
              className="block h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              // TODO: Implement redownload file to local system when clicked
            >
              <img
                src={attachment.previewUrl}
                alt={attachment.fileName}
                className="h-full w-full object-cover transition-transform hover:scale-110 cursor-pointer"
                title="Click to view full size"
                draggable={false}
              />
            </button>
          </DialogPrimitive.Trigger>
          
          {attachment.status === "uploading" && (
            <div className="absolute inset-0 bg-background/60 flex items-center justify-center pointer-events-none">
              <LoaderCircle className="h-4 w-4 animate-spin text-foreground" aria-hidden />
            </div>
          )}
          
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              removeAttachment(attachment.localId);
            }}
            aria-label={`Remove ${attachment.fileName}`}
            className="absolute top-1 right-1 rounded-full bg-background/80 p-0.5 backdrop-blur-sm opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:bg-background z-10"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          
          <DialogPrimitive.Content 
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none outline-none"
          >
            <DialogPrimitive.Title className="sr-only">{attachment.fileName}</DialogPrimitive.Title>
            
            <img
              src={attachment.previewUrl}
              alt={attachment.fileName}
              className="max-w-full max-h-[90dvh] object-contain pointer-events-auto drop-shadow-2xl"
              draggable={false}
            />

            <DialogPrimitive.Close className="fixed right-4 top-4 md:right-6 md:top-6 z-50 text-white hover:text-white bg-black/50 hover:bg-black/70 rounded-full p-2 backdrop-blur-md transition-all border border-white/10 shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-events-auto">
              <X className="h-6 w-6" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  return (
    <div
      // TODO: Implement redownload file to local system when clicked
      className={cn(
        "flex items-center gap-1.5 rounded-md border bg-muted/60 pl-2 pr-2 py-1 text-xs max-w-[220px]",
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
      <span className="truncate max-w-[120px]" title={attachment.fileName}>
        {attachment.fileName}
      </span>
      <button
        type="button"
        onClick={() => removeAttachment(attachment.localId)}
        aria-label={`Remove ${attachment.fileName}`}
        className="shrink-0 rounded p-0.5 hover:bg-background ml-1"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Row of chips for the currently-attached files. Renders nothing when empty. */
export function AttachmentChips({ className }: { className?: string }) {
  const { attachments } = useChatComposer();
  if (attachments.length === 0) return null;

  // If every attachment is an image, we can show them in a larger layout
  const isImagesOnly = attachments.every((a) => a.contentType.startsWith("image/"));
  const isSingleImage = isImagesOnly && attachments.length === 1;

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {attachments.map((a) => (
        <AttachmentChip key={a.localId} attachment={a} isImagesOnly={isImagesOnly} isSingleImage={isSingleImage} />
      ))}
    </div>
  );
}
