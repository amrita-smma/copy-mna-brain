'use client';

import { cn } from '@/lib/utils';

export type ModelOption = 'auto' | 'sonnet' | 'opus';

export const OPTIONS: { value: ModelOption; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Let the system choose (Sonnet)' },
  { value: 'sonnet', label: 'Sonnet', title: 'Claude Sonnet — fast and capable' },
  { value: 'opus', label: 'Opus', title: 'Claude Opus — most powerful, slower' },
];

interface ModelSelectorProps {
  value: ModelOption;
  onChange: (v: ModelOption) => void;
  /** Show only Sonnet/Opus (no Auto option). For workforce handoff card. */
  hideAuto?: boolean;
  className?: string;
}

/**
 * Compact pill shown inside the input box. Cycles through options on click.
 * Used in the web full-page chat view.
 */
interface ModelPillProps {
  value: ModelOption;
  onChange: (v: ModelOption) => void;
  className?: string;
}

export function ModelPill({ value, onChange, className }: ModelPillProps) {
  const allOpts = OPTIONS;
  const current = allOpts.find((o) => o.value === value) ?? allOpts[0];
  const next = allOpts[(allOpts.indexOf(current) + 1) % allOpts.length];
  return (
    <button
      type="button"
      title={`Model: ${current.title}. Click to switch to ${next.label}.`}
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

export function ModelSelector({ value, onChange, hideAuto = false, className }: ModelSelectorProps) {
  const opts = hideAuto ? OPTIONS.filter((o) => o.value !== 'auto') : OPTIONS;
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-md border bg-muted p-0.5 text-xs',
        className,
      )}
      role="group"
      aria-label="Model selection"
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
