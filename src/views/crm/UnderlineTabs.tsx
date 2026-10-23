"use client";

import { cn } from "@/lib/utils";

/**
 * A tab strip whose active tab is underlined, with an optional count chip per
 * tab. `className` sets the strip's spacing; each tab's test id is
 * `${testIdPrefix}-${key}`.
 */
export function UnderlineTabs<T extends string>({
  tabs,
  value,
  onChange,
  testIdPrefix,
  className,
}: {
  tabs: Array<{ key: T; label: string; count?: number }>;
  value: T;
  onChange: (key: NoInfer<T>) => void;
  testIdPrefix: string;
  className?: string;
}) {
  return (
    <div className={cn("flex border-b", className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            "-mb-px flex items-center gap-1.5 border-b-2 py-2.5 text-[13px] font-semibold transition-colors",
            value === t.key
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          data-testid={`${testIdPrefix}-${t.key}`}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="rounded-full bg-muted px-1.5 text-xs font-semibold leading-[18px] text-muted-foreground">
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
