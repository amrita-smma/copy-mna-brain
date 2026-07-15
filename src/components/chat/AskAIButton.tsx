"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { cn } from "@/lib/utils";
import { useLayoutControl } from "@/components/layout/LayoutControlContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";

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
  const isMobile = useIsMobile();
  const router = useRouter();
  const chatHref = useWorkspaceHref("/chat");

  // Every analyze trigger runs the consumer's send handler (the chat lives in a
  // root provider, so the message persists across navigation) and then surfaces
  // the copilot so the response is immediately visible. On mobile there is no
  // side pane — the copilot is its own full-screen route — so navigate there.
  // On desktop, reveal the copilot pane (and collapse the left nav).
  const handleClick = () => {
    onClick();
    if (isMobile) {
      // Mobile has no side pane — analysis opens the full-screen chat route.
      posthog.capture("mobile_ai_analysis_opened", { label });
      router.push(chatHref);
      return;
    }
    focusCopilot();
  };

  if (variant === "button") {
    return (
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md border border-blue-500/30 px-2.5 py-1 text-xs font-medium leading-tight text-blue-600 transition-colors hover:bg-blue-500/10 dark:text-blue-400",
          className,
        )}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0" />
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
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-blue-500 transition-colors hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-blue-400",
        className,
      )}
    >
      <Sparkles className="h-3.5 w-3.5" />
    </button>
  );
}
