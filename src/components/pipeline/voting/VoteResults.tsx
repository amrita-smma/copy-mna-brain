'use client';

import { AlertTriangle, Loader2, Minus, Sparkles, TrendingDown, TrendingUp, Vote } from 'lucide-react';
import { format } from 'date-fns';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { VoteTabState } from '@/lib/api/votes';
import { choiceStyle } from './choiceStyles';
import { plainTextLength, reviewerColumnWeights } from './reviewerLayout';

type Session = NonNullable<VoteTabState['session']>;

export interface VoteResultsProps {
  session: Session;
  onVoteAgain: () => void;
  voteAgainDisabled?: boolean;
}

/**
 * The concluded-round results card: outcome headline, the AI-written synthesis
 * / key positives / key concerns, the company's standing AI Opinion, and every
 * reviewer's verbatim rationale side by side.
 */
export default function VoteResults({
  session,
  onVoteAgain,
  voteAgainDisabled,
}: VoteResultsProps) {
  const tally = session.tally;
  const ai = session.ai;
  const asOf = session.concludedAt ?? session.createdAt;
  const columnWeights = useMemo(
    () => reviewerColumnWeights(session.voters.map((v) => plainTextLength(v.bodyHtml))),
    [session.voters],
  );

  return (
    <div className="space-y-6" data-testid="vote-results">
      {/* Outcome header */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
        {tally && <OutcomePill outcome={tally.outcome} label={tally.outcomeLabel} />}
        {tally && (
          <span
            className={cn(
              'text-lg font-bold tracking-tight',
              tally.outcome === 'proceed' && 'text-emerald-700 dark:text-emerald-400',
              tally.outcome === 'decline' && 'text-rose-700 dark:text-rose-400',
              tally.outcome === 'split' && 'text-amber-700 dark:text-amber-400',
            )}
            data-testid="vote-headline"
          >
            {tally.headline}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          Data as of{' '}
          <span className="font-semibold text-foreground">
            {safeDate(asOf, 'd MMM yyyy')}
          </span>
        </span>
        {tally && tally.inconclusiveCount > 0 && (
          <span className="text-xs text-muted-foreground">
            · {tally.inconclusiveCount} inconclusive
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          · {session.voterCount} {session.voterCount === 1 ? 'voter' : 'voters'} incl.
          AI Opinion
        </span>
      </div>

      {/* Synthesis / positives / concerns / AI opinion */}
      <div className="grid gap-5 rounded-lg border bg-card p-5 lg:grid-cols-4">
        <div className="lg:col-span-1">
          <SectionLabel className="text-sky-700 dark:text-sky-400">
            SYNTHESIS
          </SectionLabel>
          <AiBlock status={ai?.status} error={ai?.error}>
            {ai?.synthesis ? (
              <p className="text-xs leading-relaxed" data-testid="vote-synthesis">
                {ai.synthesis}
              </p>
            ) : null}
          </AiBlock>
        </div>

        <div>
          <SectionLabel className="text-emerald-700 dark:text-emerald-400">
            KEY POSITIVES
          </SectionLabel>
          <AiBlock status={ai?.status} error={ai?.error}>
            <BulletList items={ai?.keyPositives ?? []} testId="vote-key-positives" />
          </AiBlock>
        </div>

        <div>
          <SectionLabel className="text-rose-700 dark:text-rose-400">
            KEY CONCERNS
          </SectionLabel>
          <AiBlock status={ai?.status} error={ai?.error}>
            <BulletList items={ai?.keyConcerns ?? []} testId="vote-key-concerns" />
          </AiBlock>
        </div>

        <div className="rounded-lg border bg-muted p-3">
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <Sparkles className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-400">
              AI Opinion
            </span>
            {/* The AI votes as one participant, so its ballot shows here with
                the same badge treatment the reviewers get. */}
            {session.aiParticipant?.choice && (
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase',
                  choiceStyle(session.aiParticipant.choice).badge,
                )}
                data-testid="vote-ai-choice"
              >
                {choiceStyle(session.aiParticipant.choice).label}
              </span>
            )}
          </div>
          {ai?.opinionVerdict || ai?.opinionSummary ? (
            <div className="text-xs leading-relaxed" data-testid="vote-ai-opinion">
              {ai.opinionVerdict && (
                <span
                  className={cn(
                    'mr-2 inline-block rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase',
                    verdictClass(ai.opinionVerdict),
                  )}
                >
                  {ai.opinionVerdict}
                </span>
              )}
              {ai.opinionSummary}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No AI Opinion was on record when this round closed.
            </p>
          )}
        </div>
      </div>

      {/* Verbatim reviewer feedback */}
      <div className="rounded-lg border bg-card p-5">
        <SectionLabel className="text-muted-foreground">
          REVIEWER FEEDBACK — VERBATIM
        </SectionLabel>
        {session.voters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ballots were cast.</p>
        ) : (
          // Equal-width columns would leave one long rationale towering over
          // four short ones, so each reviewer's share of the row is scaled to
          // how much they wrote (see `reviewerColumnWeights`).
          //
          // The 12rem floor is what lets 4–5 reviewers sit on one row while
          // still leaving the weights room to move; below it the row wraps
          // instead of shrinking anyone into an unreadable ribbon, and the
          // `min(100%, …)` keeps the floor from overflowing a container
          // narrower than a single column (the dialog variant on a phone).
          // The 36rem ceiling stops a lone reviewer — or an orphan wrapped
          // onto the last row — from stretching across the whole card.
          <div className="flex flex-wrap gap-4" data-testid="vote-reviewers">
            {session.voters.map((voter, index) => (
              <div
                key={voter.userId}
                className="flex min-w-[min(100%,12rem)] max-w-[36rem] basis-0"
                style={{ flexGrow: columnWeights[index] }}
              >
                <ReviewerCard voter={voter} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-center">
        <Button
          onClick={onVoteAgain}
          disabled={voteAgainDisabled}
          data-testid="vote-again-button"
        >
          <Vote className="h-4 w-4 mr-2" />
          Vote again
        </Button>
      </div>
    </div>
  );
}

/**
 * One reviewer's ballot. The rationale is shown in full — never clipped, never
 * scrolled; the column it sits in is widened instead (see `reviewerLayout`).
 */
function ReviewerCard({ voter }: { voter: Session['voters'][number] }) {
  return (
    <div
      className="flex w-full flex-col rounded-md border bg-muted p-3"
      data-testid={`vote-reviewer-${voter.userId}`}
    >
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-sm font-bold">{voter.name}</span>
        {voter.choice ? (
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase',
              choiceStyle(voter.choice).badge,
            )}
            data-testid={`vote-reviewer-choice-${voter.userId}`}
          >
            {choiceStyle(voter.choice).label}
          </span>
        ) : (
          <span className="rounded border bg-background px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
            No vote
          </span>
        )}
        {voter.autoSubmitted && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            auto-submitted
          </span>
        )}
      </div>
      {voter.bodyHtml ? (
        // Sanitized server-side by `sanitizeBallotHtml` before it was ever
        // stored, which is what makes this render safe. `break-words` stops an
        // unbroken URL from pushing the card past its column.
        <div
          className="prose prose-xs dark:prose-invert max-w-none break-words text-xs leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5"
          data-testid={`vote-reviewer-body-${voter.userId}`}
          dangerouslySetInnerHTML={{ __html: voter.bodyHtml }}
        />
      ) : (
        <p className="text-xs italic text-muted-foreground">
          No rationale written.
        </p>
      )}
    </div>
  );
}

function OutcomePill({
  outcome,
  label,
}: {
  outcome: 'proceed' | 'decline' | 'split';
  label: string;
}) {
  const Icon =
    outcome === 'proceed' ? TrendingUp : outcome === 'decline' ? TrendingDown : Minus;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold',
        outcome === 'proceed' &&
          'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
        outcome === 'decline' &&
          'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300',
        outcome === 'split' &&
          'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300',
      )}
      data-testid="vote-outcome-pill"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-2 text-[11px] font-bold uppercase tracking-wider',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Shows the synthesis state while the model call is still in flight. */
function AiBlock({
  status,
  error,
  children,
}: {
  status?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  if (status === 'processing' || status === 'pending') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Generating…
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span>{error || 'The AI synthesis could not be generated.'}</span>
      </div>
    );
  }
  return <>{children}</>;
}

function BulletList({ items, testId }: { items: string[]; testId: string }) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing recorded.</p>;
  }
  return (
    <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed" data-testid={testId}>
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

function verdictClass(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v === 'pass') {
    return 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  }
  if (v === 'fail') {
    return 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300';
  }
  return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300';
}

function safeDate(iso: string | null, pattern: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : format(date, pattern);
}
