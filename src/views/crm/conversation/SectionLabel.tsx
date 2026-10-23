"use client";

import { cn } from "@/lib/utils";
import { Sparkles } from "lucide-react";

/**
 * The Conversation modal's section eyebrow. `ai` adds the sparkle, which marks
 * content a model produced; plain arithmetic and controls go without it.
 */
export function SectionLabel({
  children,
  ai = true,
  className,
}: {
  children: React.ReactNode;
  ai?: boolean;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-primary",
        className,
      )}
    >
      {ai && <Sparkles className="h-3 w-3" aria-hidden />}
      {children}
    </h3>
  );
}

/** "— <reason>" for a section with nothing to show. */
export function NoData({ text }: { text: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      — <span className="text-xs">{text}</span>
    </p>
  );
}
