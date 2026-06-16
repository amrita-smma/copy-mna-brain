"use client";

import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutControl } from "@/components/layout/LayoutControlContext";

interface AskAIButtonProps {
  /** Click handler — the consumer wires this to `sendMessage(...)` from `useChatContext`. */
  onClick: () => void;
  /** Accessible label / tooltip text. */
  label: string;
  /**
   * "icon" (default) renders a compact sparkles icon button (used in dense stat
   * cards). "button" renders a labeled pill with the sparkles icon plus text.
   */
  variant?: "icon" | "button";
  className?: string;
}

/**
 * Shared "Analyze using AI" trigger. Presentational only — each consumer owns the
 * message it sends to the AI copilot via `useChatContext().sendMessage`.
 */
export function AskAIButton({
  onClick,
  label,
  variant = "icon",
  className,
}: AskAIButtonProps) {
  const { focusCopilot } = useLayoutControl();

  // Every analyze trigger first focuses the copilot (reveal the pane, collapse
  // the left nav) so the response is immediately visible, then runs the
  // consumer's send handler.
  const handleClick = () => {
    focusCopilot();
    onClick();
  };

  if (variant === "button") {
    return (
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-purple-500/30 px-2.5 text-xs font-medium text-purple-600 transition-colors hover:bg-purple-500/10 dark:text-purple-400",
          className,
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-purple-500 transition-colors hover:bg-purple-500/10 hover:text-purple-600 dark:hover:text-purple-400",
        className,
      )}
    >
      <Sparkles className="h-3.5 w-3.5" />
    </button>
  );
}
