import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  formatDiffSummary,
  type FigureChange,
  type InsightVersionDiff,
  type SectionStatus,
} from '@/lib/insights/versionDiff';

export type InsightEditTab = 'changes' | 'after' | 'before';

/** Opaque light/dark pairs: a badge never lets the card show through. */
const STATUS_BADGE: Record<SectionStatus, { label: string; className: string }> = {
  changed: {
    label: 'Changed',
    className:
      'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  },
  added: {
    label: 'Added',
    className:
      'border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  },
  removed: {
    label: 'Removed',
    className:
      'border-rose-300 bg-rose-100 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200',
  },
  unchanged: {
    label: 'Unchanged',
    className: 'border-border bg-muted text-muted-foreground',
  },
};

const TABS: Array<{ id: InsightEditTab; label: string; testId?: string }> = [
  { id: 'changes', label: 'Changes', testId: 'insight-diff-tab' },
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
];

export interface InsightEditReviewProps {
  activeTab: InsightEditTab;
  onTabChange: (tab: InsightEditTab) => void;
  /** The diff against the current version, or null while it loads / when there is none. */
  diff: InsightVersionDiff | null;
  /** True while the current version is being fetched. */
  loadingCurrent: boolean;
  /** Shown above the tabs when a newer version landed while the card was open. */
  baseMovedNotice: string | null;
  /** The caption beside the tabs, e.g. "Current version (v5)". */
  caption: string;
  beforePane: ReactNode;
  afterPane: ReactNode;
}

/**
 * The review body of the insight edit card (MB-554): the Changes / Before /
 * After tabs, the base-moved notice, and the diff itself. Presentational only
 * — the card owns the state and the frames.
 */
export function InsightEditReview({
  activeTab,
  onTabChange,
  diff,
  loadingCurrent,
  baseMovedNotice,
  caption,
  beforePane,
  afterPane,
}: InsightEditReviewProps) {
  return (
    <div className="space-y-3">
      {baseMovedNotice && (
        <div
          role="status"
          data-testid="insight-diff-base-moved"
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{baseMovedNotice}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              data-testid={tab.testId}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                'rounded-md px-2.5 py-1 font-medium transition-colors',
                activeTab === tab.id
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground">{caption}</div>
      </div>

      {activeTab === 'changes' ? (
        <InsightDiffPanel diff={diff} loadingCurrent={loadingCurrent} />
      ) : activeTab === 'before' ? (
        beforePane
      ) : (
        afterPane
      )}
    </div>
  );
}

function InsightDiffPanel({
  diff,
  loadingCurrent,
}: {
  diff: InsightVersionDiff | null;
  loadingCurrent: boolean;
}) {
  if (!diff) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted py-8 text-xs text-muted-foreground">
        {loadingCurrent ? (
          <>
            <Loader2 className="mb-2 h-5 w-5 animate-spin text-primary" />
            Comparing with the current version…
          </>
        ) : (
          'No published version exists yet to compare against.'
        )}
      </div>
    );
  }

  const { sections, figures, summary } = diff;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <p data-testid="insight-diff-summary" className="text-sm font-medium text-foreground">
        {formatDiffSummary(summary)}
      </p>

      {sections.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Sections
          </h4>
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {sections.map((s, idx) => {
              const badge = STATUS_BADGE[s.status];
              return (
                <li
                  key={`${s.key ?? 'block'}-${idx}`}
                  data-testid={`insight-diff-section-${s.status}`}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs',
                    s.status === 'unchanged'
                      ? 'border-border bg-card text-muted-foreground'
                      : 'border-border bg-muted text-foreground',
                  )}
                >
                  <span className="min-w-0 truncate" title={s.key ?? undefined}>
                    {s.heading}
                    {s.key && s.key !== s.heading && (
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                        {s.key}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                      badge.className,
                    )}
                  >
                    {badge.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {figures.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Figures
          </h4>
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full min-w-[28rem] border-collapse text-xs">
              <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">Figure</th>
                  <th className="px-2 py-1 font-medium">Before</th>
                  <th className="w-4 px-0 py-1" aria-hidden />
                  <th className="px-2 py-1 font-medium">After</th>
                </tr>
              </thead>
              <tbody className="bg-card">
                {figures.map((f, idx) => (
                  <FigureRow key={idx} figure={f} />
                ))}
              </tbody>
            </table>
          </div>
          {summary.figuresOmitted > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              +{summary.figuresOmitted} more figure changes not listed
            </p>
          )}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Changed and added sections are outlined in the After preview. A figure
        that was recomputed but came out the same is not listed.
      </p>
    </div>
  );
}

function FigureRow({ figure }: { figure: FigureChange }) {
  return (
    <tr data-testid="insight-diff-figure-row" className="border-t border-border align-top">
      <td className="px-2 py-1 text-foreground">
        <div>{figure.label}</div>
        <div className="text-[10px] text-muted-foreground">{figure.sectionHeading}</div>
      </td>
      <td
        className={cn(
          'whitespace-nowrap px-2 py-1 tabular-nums',
          figure.before === null ? 'text-muted-foreground' : 'text-rose-700 line-through dark:text-rose-300',
        )}
      >
        {figure.before ?? '—'}
      </td>
      <td className="px-0 py-1 text-muted-foreground">
        <ArrowRight className="h-3 w-3" aria-hidden />
      </td>
      <td
        className={cn(
          'whitespace-nowrap px-2 py-1 font-medium tabular-nums',
          figure.after === null ? 'text-muted-foreground' : 'text-emerald-700 dark:text-emerald-300',
        )}
      >
        {figure.after ?? '—'}
      </td>
    </tr>
  );
}
