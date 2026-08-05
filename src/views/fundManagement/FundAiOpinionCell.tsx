'use client';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { isFundAiOpinionStale } from '@/lib/services/fundAiOpinionDataSufficiency';
import { TrendingUp, TrendingDown, MinusCircle, Sparkles, Loader2, RotateCcw } from 'lucide-react';
import type { FundAiOpinionConfidence, FundAiOpinionVerdict, Holding } from './types';

/**
 * Right-most "AI Opinion" cell for the Fund Management Asset table (MB-470).
 * Mirrors src/components/pipeline/AiOpinionCell.tsx, with a buy/hold/sell
 * verdict vocabulary in place of pass/fail/tentative.
 *
 * States:
 *  - processing (analyzing prop or holding.aiOpinionStatus==='processing'):
 *    spinner + "Analyzing…".
 *  - has verdict: buy → green up-trend, hold → amber dash, sell → red
 *    down-trend, plus confidence badge, as-of date, optional stale / sparse
 *    hints, the ≤50-word rationale, "Re-evaluate", and optional "Dive deeper"
 *    (seeds the copilot with the existing verdict).
 *  - empty: an "Analyze AI Opinion" button that hands the holding to the
 *    AI Workforce (with a limited-data hint when the holding is sparse).
 */

const VERDICT_META: Record<
  FundAiOpinionVerdict,
  { Icon: typeof TrendingUp; className: string; label: string }
> = {
  buy: {
    Icon: TrendingUp,
    className: 'text-green-600 dark:text-green-400',
    label: 'Buy',
  },
  hold: {
    Icon: MinusCircle,
    className: 'text-amber-600 dark:text-amber-400',
    label: 'Hold',
  },
  sell: {
    Icon: TrendingDown,
    className: 'text-red-600 dark:text-red-400',
    label: 'Sell',
  },
};

const CONFIDENCE_META: Record<
  FundAiOpinionConfidence,
  { label: string; className: string }
> = {
  high: {
    label: 'High',
    className: 'border-muted-foreground/30 text-muted-foreground',
  },
  medium: {
    label: 'Medium',
    className: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  },
  low: {
    label: 'Low',
    className: 'border-orange-500/50 text-orange-700 dark:text-orange-400',
  },
};

function formatAsOf(iso: string): string {
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return iso;
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function ConfidenceBadge({
  confidence,
  dataGaps,
}: {
  confidence: FundAiOpinionConfidence;
  dataGaps?: string | null;
}) {
  const meta = CONFIDENCE_META[confidence];
  const badge = (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide',
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );

  if (!dataGaps) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="cursor-default">
          {badge}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px]">
        <p className="text-xs">Based on limited data: {dataGaps}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function FundAiOpinionCell({
  holding,
  analyzing,
  onAnalyze,
  onDiveDeeper,
}: {
  holding: Holding;
  analyzing: boolean;
  onAnalyze: (holding: Holding) => void;
  /** Hand the existing verdict to the copilot for a deeper discussion. */
  onDiveDeeper?: (holding: Holding) => void;
}) {
  const isProcessing = analyzing || holding.aiOpinionStatus === 'processing';
  const verdict = holding.aiOpinionVerdict;

  if (isProcessing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
        Analyzing…
      </span>
    );
  }

  if (verdict && VERDICT_META[verdict]) {
    const { Icon, className, label } = VERDICT_META[verdict];
    const stale = isFundAiOpinionStale(
      holding.aiOpinionUpdatedAt,
      holding.latestValuationAsOf,
    );
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-1.5">
          <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', className)} />
          <div className="min-w-0 flex-1">
            <p
              className="text-xs text-muted-foreground whitespace-normal break-words leading-snug"
              title={holding.aiOpinionSummary ?? label}
            >
              {holding.aiOpinionSummary || label}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {holding.aiOpinionConfidence && (
                <ConfidenceBadge
                  confidence={holding.aiOpinionConfidence}
                  dataGaps={holding.aiOpinionDataGaps}
                />
              )}
              {holding.aiOpinionUpdatedAt && (
                <span className="text-[10px] text-muted-foreground/80">
                  as of {formatAsOf(holding.aiOpinionUpdatedAt)}
                </span>
              )}
            </div>
            {stale && (
              <p className="mt-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                Outdated — re-evaluate
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-fit gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onAnalyze(holding)}
          >
            <RotateCcw className="h-3 w-3" />
            Re-evaluate
          </Button>
          {onDiveDeeper && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-fit gap-1 px-1.5 text-[11px] text-blue-700 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
              onClick={() => onDiveDeeper(holding)}
            >
              <Sparkles className="h-3 w-3" />
              Dive deeper
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs text-blue-700 border-blue-200 hover:bg-blue-50 hover:text-blue-800 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-950/30"
        onClick={() => onAnalyze(holding)}
      >
        <Sparkles className="h-3.5 w-3.5" />
        Analyze AI Opinion
      </Button>
      {holding.aiOpinionIsSparse && (
        <span className="text-[10px] text-muted-foreground">Based on limited data</span>
      )}
    </div>
  );
}
