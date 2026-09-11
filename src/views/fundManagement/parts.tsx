'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FolderInput, Loader2, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { GlossaryTerm as SharedGlossaryTerm } from '@/components/common/GlossaryTerm';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatGrouped, regroupNumericInput } from './calc';
import { GLOSSARY } from './glossary';
import type { DisclosureReason } from './types';

/**
 * Kebab menu isolating a single destructive action behind a confirm step —
 * mirrors the AlertDialog-wrapping-DropdownMenu pattern used for row deletes
 * elsewhere in the app, so "delete" reads the same way everywhere rather than
 * inventing a fund-management-specific control.
 */
export function DeleteRowMenu({
  label,
  title,
  description,
  onConfirm,
  onEdit,
  editLabel = 'Edit',
  onMove,
  moveLabel = 'Move to group…',
  confirmLabel,
}: {
  label: string;
  title: string;
  description: string;
  onConfirm: () => Promise<void>;
  /** When provided, an "Edit" item is shown above the destructive action. */
  onEdit?: () => void;
  editLabel?: string;
  /** When provided, a "Move" item is shown above the destructive action. */
  onMove?: () => void;
  moveLabel?: string;
  confirmLabel?: string;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      // Failure is already toasted by the context provider — just stop spinning.
      setBusy(false);
    }
  };

  return (
    <AlertDialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            aria-label="Row actions"
            disabled={busy}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 data-[state=open]:bg-muted data-[state=open]:text-foreground"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[8rem]">
          {onEdit && (
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" />
              {editLabel}
            </DropdownMenuItem>
          )}
          {onMove && (
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onMove();
              }}
            >
              <FolderInput className="mr-2 h-3.5 w-3.5" />
              {moveLabel}
            </DropdownMenuItem>
          )}
          <AlertDialogTrigger asChild>
            <DropdownMenuItem
              onSelect={(e) => e.preventDefault()}
              onClick={(e) => e.stopPropagation()}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {label}
            </DropdownMenuItem>
          </AlertDialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={confirm}
          >
            {confirmLabel ?? 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type InlineKind = 'text' | 'num' | 'select' | 'textarea' | 'date';

/**
 * Click-to-edit value. Renders as text until clicked, then swaps to an
 * input/select/textarea. Commits on blur / Enter (Cmd+Enter for textarea),
 * cancels on Escape. `onCommit` receives the raw string; the caller parses.
 */
export function InlineEdit({
  value,
  display,
  kind = 'text',
  options,
  onCommit,
  align = 'left',
  placeholder = '—',
  className,
}: {
  value: string | number | null | undefined;
  display?: ReactNode;
  kind?: InlineKind;
  options?: string[];
  onCommit: (raw: string) => void;
  align?: 'left' | 'right';
  placeholder?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);
  // Key actions can unmount the editor and trigger blur in the same event
  // cycle. Guard the edit session so Escape never falls through to commit and
  // Enter never submits twice through keydown + blur.
  const finishedRef = useRef(false);

  useLayoutEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      if ('select' in ref.current && kind !== 'select') {
        try {
          (ref.current as HTMLInputElement).select();
        } catch {
          /* noop */
        }
      }
    }
  }, [editing, kind]);

  const start = () => {
    finishedRef.current = false;
    if (kind === 'num' && value != null && value !== '') {
      const n = Number(value);
      setDraft(Number.isFinite(n) ? formatGrouped(n) : String(value));
    } else {
      setDraft(value == null ? '' : String(value));
    }
    setEditing(true);
  };
  const commit = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setEditing(false);
    onCommit(kind === 'num' ? draft.trim().replace(/,/g, '') : draft.trim());
  };
  const cancel = () => {
    finishedRef.current = true;
    setEditing(false);
  };

  // Numeric/date fields are sized to their content (narrow); text/select fill the cell.
  const widthCls = kind === 'num' ? 'w-36' : kind === 'date' ? 'w-[9.5rem]' : 'w-full';
  const inputCls = cn(
    'rounded-md border border-accent bg-background px-1.5 py-0.5 text-[13px] text-foreground outline-none',
    widthCls,
  );

  if (editing) {
    if (kind === 'select') {
      return (
        <select
          ref={ref as React.RefObject<HTMLSelectElement>}
          value={draft}
          onChange={(e) => {
            setEditing(false);
            onCommit(e.target.value);
          }}
          onBlur={() => setEditing(false)}
          className={cn(inputCls, className)}
        >
          {options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    if (kind === 'textarea') {
      return (
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          className={cn(inputCls, 'min-h-[44px] resize-y leading-snug', className)}
        />
      );
    }
    return (
      <input
        ref={ref as React.RefObject<HTMLInputElement>}
        type={kind === 'date' ? 'date' : 'text'}
        inputMode={kind === 'num' ? 'decimal' : undefined}
        value={draft}
        onChange={(e) => {
          if (kind !== 'num') { setDraft(e.target.value); return; }
          const el = e.currentTarget;
          const next = regroupNumericInput(el.value, el.selectionStart ?? el.value.length, {
            allowSuffix: true,
          });
          setDraft(next.text);
          // Restore the cursor after React re-renders, or re-grouping drops it
          // at the end of the field.
          requestAnimationFrame(() => {
            (ref.current as HTMLInputElement | null)?.setSelectionRange(next.caret, next.caret);
          });
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        className={cn(inputCls, align === 'right' && 'text-right', className)}
      />
    );
  }

  const empty = value == null || value === '';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        start();
      }}
      className={cn(
        'group inline-flex max-w-full items-center gap-1 rounded px-1 -mx-1 text-left align-middle hover:bg-muted hover:ring-1 hover:ring-border',
        align === 'right' && 'justify-end text-right',
        empty && 'text-muted-foreground',
        className,
      )}
    >
      <span className="truncate">{display ?? (empty ? placeholder : String(value))}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        ✎
      </span>
    </button>
  );
}

/**
 * A dotted term that reveals a plain-English definition on hover, looked up in
 * the fund-management glossary. The presentation lives in
 * `@/components/common/GlossaryTerm`, which other pages bind to their own
 * vocabulary the same way.
 */
export function GlossaryTerm({
  term,
  children,
  className,
}: {
  term: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SharedGlossaryTerm entry={GLOSSARY[term]} className={className}>
      {children}
    </SharedGlossaryTerm>
  );
}

const PARTIAL_VALUATION_HINT =
  'Some holdings lack a valuation. This amount only includes positions that have a mark.';

/** Amount with a hover explanation when the roll-up is only partially valued. */
export function PartialValuationAmount({
  partial,
  children,
}: {
  partial: boolean;
  children: ReactNode;
}) {
  if (!partial) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help border-b border-dotted border-muted-foreground/60">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">
        <div className="text-xs leading-relaxed">{PARTIAL_VALUATION_HINT}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Small neutral pill/badge. */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded border bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

const DISCLOSURE_CONFIG: Record<DisclosureReason, { label: string; tooltip: string }> = {
  external_fund: {
    label: 'External · not managed',
    tooltip: 'This fund is managed externally and is excluded from portfolio totals.',
  },
  liquidated_fund: {
    label: 'Liquidated',
    tooltip: 'This fund has been liquidated and is excluded from active portfolio totals.',
  },
  no_holder: {
    label: 'No holder linked',
    tooltip: 'This asset exists but has no position linking it to a fund or holding entity, so it carries no figures.',
  },
  unresolved_target: {
    label: 'Unresolved holding',
    tooltip: 'This holding references a fund not found in the portfolio, so its figures are excluded from totals.',
  },
};

export function DisclosureBadge({ reason }: { reason: DisclosureReason }) {
  const config = DISCLOSURE_CONFIG[reason];
  if (!config) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help">
          <Pill className="border-amber-300 bg-muted text-amber-800 dark:border-amber-700 dark:text-amber-300">
            {config.label}
          </Pill>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">
        <div className="text-xs leading-relaxed">{config.tooltip}</div>
      </TooltipContent>
    </Tooltip>
  );
}

export function DisclosureFootnote({ className }: { className?: string }) {
  return (
    <p className={cn('mt-2 text-xs text-muted-foreground italic', className)}>
      Rows marked with a badge are shown for completeness and are excluded from all totals.
    </p>
  );
}

/** Section label used above uppercase field values. */
export function FieldKey({ children }: { children: ReactNode }) {
  return (
    <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

/** A quarter-over-quarter delta chip. */
export function DeltaBadge({ pct, goodUp = true }: { pct: number | null; goodUp?: boolean }) {
  if (pct === null) {
    return (
      <span className="text-[11px] text-muted-foreground">
        – unavailable <GlossaryTerm term="vslast">vs last quarter</GlossaryTerm>
      </span>
    );
  }
  if (Math.abs(pct) < 0.05) {
    return (
      <span className="text-[11px] text-muted-foreground">
        – no change <GlossaryTerm term="vslast">vs last quarter</GlossaryTerm>
      </span>
    );
  }
  const up = pct > 0;
  const good = up === goodUp;
  return (
    <span
      className={cn('text-[11px] font-medium', good ? 'text-success' : 'text-destructive')}
    >
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%{' '}
      <span className="font-normal text-muted-foreground">
        <GlossaryTerm term="vslast">vs last quarter</GlossaryTerm>
      </span>
    </span>
  );
}

/** Tiny inline trend sparkline. */
export function MiniSpark({
  data,
  positive,
  width = 64,
  height = 18,
}: {
  data: number[];
  positive: boolean;
  width?: number;
  height?: number;
}) {
  if (!data.length) return null;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const r = mx - mn || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * width,
    height - 2 - ((v - mn) / r) * (height - 5),
  ]);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const stroke = positive ? 'hsl(var(--success))' : 'hsl(var(--destructive))';
  return (
    <svg width={width} height={height} className="block overflow-visible">
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r={2.2} fill={stroke} />
    </svg>
  );
}

/** Chevron affordance for expandable rows. */
export function Chevron({ open }: { open: boolean }) {
  return <span className="inline-block w-3 text-xs text-muted-foreground">{open ? '▾' : '▸'}</span>;
}
