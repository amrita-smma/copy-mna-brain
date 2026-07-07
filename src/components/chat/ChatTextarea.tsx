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

    // Recompute the height on every value change so the box tracks the content,
    // clamped to the CSS max-height (which is responsive via Tailwind classes).
    React.useLayoutEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";
      const maxH = parseFloat(getComputedStyle(el).maxHeight);
      const next = Number.isFinite(maxH)
        ? Math.min(el.scrollHeight, maxH)
        : el.scrollHeight;
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > next ? "auto" : "hidden";
    }, [value]);

    return (
      <textarea
        ref={setRefs}
        rows={1}
        value={value}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            onSubmit?.();
          }
          onKeyDown?.(e);
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
