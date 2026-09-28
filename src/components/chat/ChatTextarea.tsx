"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export interface ChatTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string;
  /** Called when the user presses Enter (without Shift) to send the message. */
  onSubmit?: () => void;
}

/**
 * A single-line-looking chat input that grows top-down as the user types and
 * wraps long text instead of scrolling sideways. It expands up to 10 rows on
 * desktop (5 rows on mobile), after which it scrolls vertically.
 *
 * Enter submits; Shift+Enter inserts a newline.
 */
const ChatTextarea = React.forwardRef<HTMLTextAreaElement, ChatTextareaProps>(
  ({ className, value, onSubmit, onKeyDown, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    // Recompute the height so the box tracks the content, clamped to the CSS
    // max-height (which is responsive via Tailwind classes).
    const resize = React.useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";
      const maxH = parseFloat(getComputedStyle(el).maxHeight);
      const next = Number.isFinite(maxH)
        ? Math.min(el.scrollHeight, maxH)
        : el.scrollHeight;
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > next ? "auto" : "hidden";
    }, []);

    // Re-run on every value change...
    React.useLayoutEffect(() => {
      resize();
    }, [value, resize]);

    // ...and whenever the textarea's own width changes (e.g. the surrounding
    // pane is resized). Without this, a narrower box would rewrap the text to
    // more lines while the height stayed stale, clipping the last line. Guard
    // on width so our own height writes don't feed back into an infinite loop.
    React.useEffect(() => {
      const el = innerRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      let lastWidth = el.clientWidth;
      const ro = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (Math.abs(width - lastWidth) < 0.5) return;
        lastWidth = width;
        resize();
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [resize]);

    return (
      <textarea
        ref={setRefs}
        rows={1}
        value={value}
        onKeyDown={(e) => {
          // Run the caller's handler first so it can suppress the
          // Enter-to-submit behavior (e.g. a popup hijacking Enter to select
          // a highlighted row) by calling preventDefault().
          onKeyDown?.(e);
          if (
            !e.defaultPrevented &&
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            onSubmit?.();
          }
        }}
        className={cn(
          "flex w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 max-h-[7.25rem] sm:max-h-[13.5rem]",
          className,
        )}
        {...props}
      />
    );
  },
);
ChatTextarea.displayName = "ChatTextarea";

export { ChatTextarea };
