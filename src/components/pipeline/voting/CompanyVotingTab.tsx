'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  RotateCcw,
  ShieldQuestion,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { VoteChoice } from '@/lib/voting/tally';
import { getUsers, type UserSummary } from '@/lib/api/pipeline';
import {
  cancelVote,
  getVoteState,
  saveBallot,
  sendBackSubmissions,
  startVote,
  type VoteTabState,
} from '@/lib/api/votes';
import BallotPanel from './BallotPanel';
import { browserDraftStorage } from './ballotDraftStore';
import { clearStartVoteDraft, hasStartVoteDraft } from './startVoteDraftStore';
import StartVotePanel from './StartVotePanel';
import VoteResults from './VoteResults';
import VotingRules from './VotingRules';

/** While a round is open or the synthesis is running, refresh on this cadence. */
const POLL_MS = 15_000;

export interface CompanyVotingTabProps {
  companyId: string;
  /** Compact spacing for the dialog; roomier on the full-page view. */
  variant?: 'page' | 'dialog';
}

/**
 * The company Voting tab. Owns the whole round lifecycle for one company:
 * starting a round, casting/saving/submitting a ballot, the initiator's
 * cancel / send-back controls, and the concluded results card.
 *
 * Every mutation returns the recomputed state from the server, so the view
 * never has to guess what a write did to visibility or progress.
 */
export default function CompanyVotingTab({
  companyId,
  variant = 'page',
}: CompanyVotingTabProps) {
  const [state, setState] = useState<VoteTabState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [busy, setBusy] = useState<
    'start' | 'save' | 'submit' | 'cancel' | 'send_back' | null
  >(null);
  // `sessionStorage`, or null when unavailable — see `ballotDraftStore`.
  const storage = useMemo(() => browserDraftStorage(), []);

  // Set by "Vote again" — shows the start flow over the previous results.
  const [startingNew, setStartingNew] = useState(false);

  // Guards the polling effect against writing a stale response over a fresher
  // one from a mutation the user just made.
  const requestSeq = useRef(0);
  // Bumped whenever the tab switches company. A mutation cannot use
  // `requestSeq` for this — it deliberately outranks any poll that started
  // while it was in flight — so it needs its own generation to notice that the
  // company it was fired for is no longer the one on screen.
  const companyGeneration = useRef(0);

  // `CompanyDetailDialog` keeps one instance alive and swaps `companyId` on it.
  // Resetting in an effect would be too late: the render in between paints the
  // previous company's round under the new id, and the freshly mounted
  // `StartVotePanel` would clear the new company's wizard as "not mine" before
  // its own state has even loaded. Adjusting during render discards that paint
  // — React re-runs this component before it renders any children.
  const [loadedCompanyId, setLoadedCompanyId] = useState(companyId);
  if (loadedCompanyId !== companyId) {
    setLoadedCompanyId(companyId);
    setState(null);
    setLoading(true);
    setStartingNew(false);
    setError(null);
    setBusy(null);
    // Retire anything still in flight for the company we just left, so its
    // response cannot land as if it were this one's.
    requestSeq.current += 1;
    companyGeneration.current += 1;
  }

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const next = await getVoteState(companyId);
      if (seq === requestSeq.current) {
        setState(next);
        setError(null);
      }
    } catch (err) {
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Failed to load the voting round');
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Voters are only needed for the picker, so fetch them once alongside.
  useEffect(() => {
    let cancelled = false;
    setUsersLoading(true);
    getUsers()
      .then((rows) => !cancelled && setUsers(rows))
      .catch(() => !cancelled && setUsers([]))
      .finally(() => !cancelled && setUsersLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll while there is something that can change without us: an open round
  // (someone else submitting, the deadline sweep) or a running synthesis.
  const session = state?.session ?? null;
  // Recomputed only when the round itself changes, so a poll that returns the
  // same round never re-reads the cache out from under the open wizard.
  const resumableWizard = useMemo(
    () => hasStartVoteDraft(storage, companyId, session?.id ?? null),
    [storage, companyId, session?.id],
  );
  const shouldPoll =
    session?.status === 'active' ||
    session?.ai?.status === 'processing' ||
    session?.ai?.status === 'pending';

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, load]);

  const runMutation = async (
    kind: NonNullable<typeof busy>,
    action: () => Promise<VoteTabState>,
    successMessage: string,
  ) => {
    const generation = companyGeneration.current;
    setBusy(kind);
    try {
      const next = await action();
      // The tab moved to another company while this was in flight — its result
      // describes a round that is no longer on screen.
      if (generation !== companyGeneration.current) return false;
      requestSeq.current += 1;
      setState(next);
      setError(null);
      if (next.notice) {
        // e.g. the round opened but the invitation job could not be queued.
        toast.warning(next.notice, { duration: 10_000 });
      } else {
        toast.success(successMessage);
      }
      return true;
    } catch (err) {
      if (generation !== companyGeneration.current) return false;
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    } finally {
      if (generation === companyGeneration.current) setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="voting-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !state) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-16 text-center"
        data-testid="voting-error"
      >
        <AlertCircle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  const gap = variant === 'dialog' ? 'space-y-4' : 'space-y-6';
  // `startingNew` only ever means "Vote again on a finished round" — it must
  // never hide the ballot of a round that is still open.
  //
  // A wizard left mid-flight counts as still being in it, so a tab switch
  // during "Vote again" comes back to the wizard rather than to the results.
  // It is only honoured for the round it was launched from: a wizard abandoned
  // before someone else opened a round must not reappear over that round.
  const showStartFlow =
    !session ||
    session.status === 'cancelled' ||
    (session.status === 'completed' && (startingNew || resumableWizard));

  const startPanel = (
    <StartVotePanel
      key={companyId}
      companyId={companyId}
      afterSessionId={session?.id ?? null}
      users={users}
      usersLoading={usersLoading}
      starting={busy === 'start'}
      again={Boolean(session)}
      onStart={async (input) => {
        const ok = await runMutation(
          'start',
          () => startVote(companyId, input),
          'Vote started — invitations are on their way.',
        );
        if (ok) {
          clearStartVoteDraft(storage, companyId);
          setStartingNew(false);
        }
      }}
    />
  );

  return (
    <div className={cn(gap, 'pb-4')} data-testid="company-voting-tab">
      {showStartFlow ? (
        <>
          {session?.status === 'cancelled' && (
            <div
              className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
              data-testid="vote-cancelled-banner"
            >
              <XCircle className="h-4 w-4 shrink-0" />
              <span>
                The previous round was cancelled by {session.initiatedBy.name}
                {session.cancelledAt
                  ? ` on ${safeDate(session.cancelledAt, 'd MMM yyyy')}`
                  : ''}
                .
              </span>
            </div>
          )}
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div>{startPanel}</div>
            <VotingRules />
          </div>
        </>
      ) : session.status === 'completed' ? (
        <VoteResults
          session={session}
          voteAgainDisabled={busy !== null}
          onVoteAgain={() => setStartingNew(true)}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-5">
            <ActiveRoundHeader
              session={session}
              viewer={state!.viewer}
              busy={busy}
              onCancel={() =>
                void runMutation(
                  'cancel',
                  () => cancelVote(companyId, session.id),
                  'Vote cancelled.',
                )
              }
              onSendBack={() =>
                void runMutation(
                  'send_back',
                  () => sendBackSubmissions(companyId, session.id),
                  'Submissions sent back — voters can edit again.',
                )
              }
            />

            {state!.viewer.ballot ? (
              <BallotPanel
                sessionId={session.id}
                ballot={state!.viewer.ballot}
                locked={new Date(session.deadlineAt).getTime() <= Date.now()}
                saving={busy === 'save'}
                submitting={busy === 'submit'}
                onSave={({ choice, bodyHtml }) =>
                  void runMutation(
                    'save',
                    () =>
                      saveBallot(companyId, {
                        sessionId: session.id,
                        choice,
                        bodyHtml,
                      }),
                    'Draft saved.',
                  )
                }
                onSubmit={({ choice, bodyHtml }) =>
                  void runMutation(
                    'submit',
                    () =>
                      saveBallot(companyId, {
                        sessionId: session.id,
                        choice: choice as VoteChoice,
                        bodyHtml,
                        submit: true,
                      }),
                    'Vote submitted.',
                  )
                }
              />
            ) : (
              <div
                className="flex flex-col items-center gap-3 rounded-lg border bg-card py-14 text-center"
                data-testid="voting-in-progress"
              >
                <ShieldQuestion className="h-7 w-7 text-muted-foreground" />
                <div>
                  <h3 className="text-base font-semibold">Voting in progress</h3>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    You are not a voter on this round. Individual votes and
                    rationales stay hidden until the round closes.
                  </p>
                </div>
              </div>
            )}
          </div>
          <VotingRules />
        </div>
      )}
    </div>
  );
}

/** Deadline, progress roster, and the initiator's round controls. */
function ActiveRoundHeader({
  session,
  viewer,
  busy,
  onCancel,
  onSendBack,
}: {
  session: NonNullable<VoteTabState['session']>;
  viewer: VoteTabState['viewer'];
  busy: string | null;
  onCancel: () => void;
  onSendBack: () => void;
}) {
  const overdue = new Date(session.deadlineAt).getTime() <= Date.now();
  const anySubmitted = session.voters.some((v) => v.status === 'submitted');

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="vote-progress">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Clock className={cn('h-4 w-4', overdue && 'text-amber-500')} />
            {overdue ? 'Deadline passed — closing shortly' : 'Voting open'}
          </span>
          <span className="text-muted-foreground">
            Closes {safeDate(session.deadlineAt, "d MMM yyyy, HH:mm")}
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Users className="h-4 w-4" />
            {session.submittedCount}/{session.voterCount} submitted
          </span>
          <span className="text-muted-foreground">
            Started by {session.initiatedBy.name}
          </span>
        </div>

        {viewer.isInitiator && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !anySubmitted}
              title={
                anySubmitted
                  ? 'Turn every submitted ballot back into a draft'
                  : 'Nobody has submitted yet'
              }
              data-testid="vote-send-back"
              onClick={onSendBack}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Send back submissions
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              className="text-destructive hover:text-destructive"
              data-testid="vote-cancel"
              onClick={onCancel}
            >
              <XCircle className="h-4 w-4 mr-2" />
              Cancel vote
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <AiParticipantChip participant={session.aiParticipant} />
        {session.voters.map((voter) => (
          <span
            key={voter.userId}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
              voter.status === 'submitted'
                ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300'
                : 'text-muted-foreground',
            )}
            data-testid={`vote-voter-${voter.userId}`}
          >
            {voter.status === 'submitted' ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <Clock className="h-3.5 w-3.5" />
            )}
            {voter.name}
            {voter.userId === viewer.userId && ' (you)'}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The AI Opinion's seat in the roster. It votes like anyone else, but it has no
 * ballot to submit — it is "ready" once the company has an opinion on record,
 * and shows as generating while the run is in flight.
 */
function AiParticipantChip({
  participant,
}: {
  participant: NonNullable<VoteTabState['session']>['aiParticipant'];
}) {
  const generating =
    participant.opinionStatus === 'processing' || participant.opinionStatus === 'pending';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
        generating
          ? 'text-muted-foreground'
          : 'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300',
      )}
      title="The AI Opinion counts as one voter. Its vote is recorded when the round closes."
      data-testid="vote-voter-ai"
    >
      {generating ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
      AI Opinion
      {generating && ' (generating)'}
    </span>
  );
}

function safeDate(iso: string | null, pattern: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : format(date, pattern);
}
