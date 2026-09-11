import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  distinctEnglishName,
  partyBadge,
  signOf,
  type Amount,
  type FlowDirection,
  type PartyRef,
} from '@/lib/fundLedger';

export const FIELD_TEXT = 'text-[11px] md:text-[11px]';
export const FIELD_INPUT = `h-7 bg-background ${FIELD_TEXT}`;
export const FIELD_LABEL = 'text-[10px] uppercase tracking-wide text-muted-foreground';
export const FIELD_HINT = 'text-[10px] text-muted-foreground';

export function signClass(value: Amount): string {
  switch (signOf(value)) {
    case 'positive':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'negative':
      return 'text-red-600 dark:text-red-400';
    default:
      return 'text-muted-foreground';
  }
}

const DIRECTION_CLASS: Record<FlowDirection, string> = {
  out: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-900',
  in: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
  move: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
  flat: 'bg-muted text-muted-foreground border-border',
};

export function LedgerBadge({
  children,
  direction,
  className,
}: {
  children: ReactNode;
  direction?: FlowDirection;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        direction ? DIRECTION_CLASS[direction] : 'border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Party({
  party,
  instrument = false,
  wrap = false,
}: {
  party: PartyRef;
  instrument?: boolean;
  /** Match the sheet's "Wrap text" toggle instead of always truncating to one line. */
  wrap?: boolean;
}) {
  const overflowClass = wrap ? 'whitespace-normal break-words' : 'truncate';
  const english = distinctEnglishName(party.name, party.englishName);
  return (
    <span
      className="flex w-full min-w-0 items-start gap-1"
      title={english ? `${party.name} (${english})` : party.name}
    >
      <span
        className={cn(
          'shrink-0 rounded px-1 py-px text-[9px] font-semibold leading-none',
          instrument ? 'bg-muted text-muted-foreground' : 'bg-foreground/10 text-foreground/70',
        )}
      >
        {partyBadge(party.kind)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('min-w-0', overflowClass, instrument && 'text-muted-foreground')}>
          {party.name}
        </span>
        {english ? (
          <span className={cn('min-w-0 text-[10px] leading-tight text-muted-foreground/60', overflowClass)}>
            {english}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export function FlowArrow({ noCash }: { noCash: boolean }) {
  return (
    <span
      className={cn('text-muted-foreground', noCash && 'opacity-50')}
      title={noCash ? 'No cash moved' : undefined}
    >
      {noCash ? '⇢' : '→'}
    </span>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'bad' }) {
  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full',
        tone === 'bad'
          ? 'bg-red-500'
          : tone === 'warn'
            ? 'bg-amber-500'
            : 'bg-muted-foreground/40',
      )}
    />
  );
}

export function FieldKey({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{children}</div>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return <span className="text-[10px] text-muted-foreground">{open ? '▾' : '▸'}</span>;
}

export function SnakeCase({ value }: { value: string }) {
  const parts = value.split('_');
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {part}
          {index < parts.length - 1 && (
            <>
              _<wbr />
            </>
          )}
        </span>
      ))}
    </>
  );
}
