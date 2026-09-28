'use client';

import { cn } from '@/lib/utils';

export type EffortOption = 'auto' | 'low' | 'medium' | 'high';

export const OPTIONS: { value: EffortOption; label: string; title: string }[] = [
  {
    value: 'auto',
    label: 'Auto',
    title: 'Pick the effort level to match the question (recommended)',
  },
  { value: 'low', label: 'Low', title: 'Low effort — quickest, for lookups and follow-ups' },
  { value: 'medium', label: 'Medium', title: 'Medium effort — multi-step questions' },
  { value: 'high', label: 'High', title: 'High effort — deep analysis, slowest' },
];

interface EffortSelectorProps {
  value: EffortOption;
  onChange: (v: EffortOption) => void;
  /** Hide the Auto option. For the workforce handoff card, which has no router. */
  hideAuto?: boolean;
  /**
   * Hide the Low option. The workforce queue floors at Medium, so offering Low
   * there would show a tier the server would silently raise.
   */
  hideLow?: boolean;
  className?: string;
}

/**
 * Compact pill shown inside the input box. Cycles through options on click.
 * Used in the web full-page chat view.
 */
interface EffortPillProps {
  value: EffortOption;
  onChange: (v: EffortOption) => void;
  className?: string;
}

export function EffortPill({ value, onChange, className }: EffortPillProps) {
  const allOpts = OPTIONS;
  const current = allOpts.find((o) => o.value === value) ?? allOpts[0];
  const next = allOpts[(allOpts.indexOf(current) + 1) % allOpts.length];
  return (
    <button
      type="button"
      title={`Effort: ${current.title}. Click to switch to ${next.label}.`}
      onClick={() => onChange(next.value)}
      className={cn(
        'shrink-0 h-8 px-3 rounded-lg text-xs font-medium transition-colors select-none',
        'bg-muted/70 hover:bg-muted border border-input',
        'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {current.label}
    </button>
  );
}

export function EffortSelector({
  value,
  onChange,
  hideAuto = false,
  hideLow = false,
  className,
}: EffortSelectorProps) {
  const opts = OPTIONS.filter(
    (o) => !(hideAuto && o.value === 'auto') && !(hideLow && o.value === 'low'),
  );
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-md border bg-muted p-0.5 text-xs',
        className,
      )}
      role="group"
      aria-label="Effort selection"
    >
      {opts.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.title}
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded px-2 py-0.5 font-medium transition-colors select-none',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
