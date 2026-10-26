import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

/** Small "Beta" pill marking a feature that is still in beta. */
export function BetaChip({
  className,
  ...props
}: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-blue-500/30 bg-blue-50 px-1.5 py-px text-[10px] font-semibold uppercase leading-4 tracking-wide text-blue-700 dark:bg-blue-950 dark:text-blue-300",
        className,
      )}
      {...props}
    >
      Beta
    </span>
  );
}
