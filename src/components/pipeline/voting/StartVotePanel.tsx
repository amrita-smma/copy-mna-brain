'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Loader2, Users, Vote } from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import UserCombobox from '@/components/pipeline/UserCombobox';
import type { UserSummary } from '@/lib/api/pipeline';
import {
  combineDeadline,
  defaultDeadline,
  describeTimeRemaining,
  MAX_DEADLINE_LEAD_MS,
  MIN_DEADLINE_LEAD_MS,
  toDeadlineDay,
} from '@/lib/voting/deadline';
import { browserDraftStorage } from './ballotDraftStore';
import {
  clearStartVoteDraft,
  readStartVoteDraft,
  writeStartVoteDraft,
} from './startVoteDraftStore';

type Step = 'idle' | 'voters' | 'deadline';

export interface StartVotePanelProps {
  /** The company this round would be for — namespaces the local wizard cache. */
  companyId: string;
  /**
   * The round on screen behind this wizard (the completed one being voted on
   * again), or `null` when there is none. Stamped into the cache so a wizard
   * can never be resumed on top of a different round.
   */
  afterSessionId: string | null;
  users: UserSummary[];
  usersLoading?: boolean;
  starting?: boolean;
  /** `deadlineAt` is an absolute ISO instant, built from the picker's local time. */
  onStart: (input: { voterIds: string[]; deadlineAt: string }) => void;
  /** Shown above the button when the company has been voted on before. */
  again?: boolean;
}

/**
 * The "Start Vote" flow: a single button that expands into voter selection,
 * then the deadline picker, then the confirm.
 *
 * Deliberately staged rather than one big form — the initiator picks *who*
 * before they can sensibly judge *by when*.
 *
 * A wizard in progress survives leaving the tab: Radix unmounts an inactive
 * `TabsContent`, so without the `startVoteDraftStore` mirror below a panel the
 * initiator had just finished assembling would be gone on the way back.
 */
export default function StartVotePanel({
  companyId,
  afterSessionId,
  users,
  usersLoading,
  starting,
  onStart,
  again,
}: StartVotePanelProps) {
  // `sessionStorage`, or null when unavailable (SSR / storage disabled), in
  // which case the wizard simply starts from scratch every time.
  const storage = useMemo(() => browserDraftStorage(), []);
  const restored = useMemo(
    () => readStartVoteDraft(storage, companyId, afterSessionId),
    [storage, companyId, afterSessionId],
  );
  const [step, setStep] = useState<Step>(() => restored?.step ?? 'idle');
  const [voterIds, setVoterIds] = useState<string[]>(() => restored?.voterIds ?? []);
  // Empty until the browser fills them in below — see the effect.
  const [day, setDay] = useState(() => restored?.deadlineDay ?? '');
  const [time, setTime] = useState(() => restored?.deadlineTime ?? '');
  const [calendarOpen, setCalendarOpen] = useState(false);

  // The default deadline is a *wall-clock* one, so it can only be computed in
  // the browser. Next.js server-renders client components too, and `new Date()`
  // there is the server's zone (UTC on Vercel) — seeding this state during
  // render would prefill the picker hours, or a whole calendar day, off for
  // anyone outside that zone. Running it in an effect guarantees it is the
  // viewer's own clock, and only when a restored draft did not supply one.
  useEffect(() => {
    if (day && time) return;
    const fallback = defaultDeadline(new Date());
    setDay((current) => current || fallback.day);
    setTime((current) => current || fallback.time);
  }, [day, time]);

  // Mirror the wizard out while it is in flight, and drop the cache the moment
  // there is nothing in progress left to protect.
  useEffect(() => {
    if (!storage) return;
    if (step === 'idle') {
      clearStartVoteDraft(storage, companyId);
      return;
    }
    writeStartVoteDraft(storage, companyId, {
      afterSessionId,
      step,
      voterIds,
      deadlineDay: day,
      deadlineTime: time,
    });
  }, [storage, companyId, afterSessionId, step, voterIds, day, time]);

  // The picked wall-clock deadline as an absolute instant, or null when the
  // two fields do not describe a real one.
  const deadline = useMemo(() => combineDeadline(day, time), [day, time]);
  // Recomputed on every render rather than ticking: the only thing that has to
  // stay honest is the moment the initiator presses Start, and the server
  // re-validates the instant it receives regardless. Both bounds are mirrored
  // from `parseDeadline` so the form explains a rejection instead of letting
  // the POST fail with one.
  const lead = deadline === null ? null : deadline.getTime() - Date.now();
  const tooSoon = lead === null || lead < MIN_DEADLINE_LEAD_MS;
  const tooFar = lead !== null && lead > MAX_DEADLINE_LEAD_MS;

  if (step === 'idle') {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 py-16 text-center"
        data-testid="start-vote-idle"
      >
        <Vote className="h-8 w-8 text-muted-foreground" />
        <div>
          <h3 className="text-base font-semibold">
            {again ? 'Run another round' : 'No votes recorded yet'}
          </h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            {again
              ? 'Start a fresh voting round on this company with a new panel and deadline.'
              : 'Start a voting round to collect the committee’s verdict on this company.'}
          </p>
        </div>
        <Button
          onClick={() => setStep('voters')}
          data-testid="start-vote-button"
          className="mt-1"
        >
          <Vote className="h-4 w-4 mr-2" />
          {again ? 'Vote again' : 'Start Vote'}
        </Button>
      </div>
    );
  }

  if (step === 'voters') {
    return (
      <div className="max-w-xl mx-auto space-y-4 py-8" data-testid="start-vote-voters">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">Who is voting?</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Pick everyone who should cast a ballot. They will each be emailed an
          invitation with the company card attached.
        </p>
        <div>
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Voters
          </Label>
          <div className="mt-2">
            <UserCombobox
              users={users}
              selectedUserIds={voterIds}
              onChange={setVoterIds}
              loading={usersLoading}
              placeholder="Select voters…"
            />
          </div>
        </div>
        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={() => setStep('idle')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <Button
            onClick={() => setStep('deadline')}
            disabled={voterIds.length === 0}
            data-testid="start-vote-next"
          >
            Next
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-4 py-8" data-testid="start-vote-deadline">
      <h3 className="text-base font-semibold">When does voting close?</h3>
      <p className="text-sm text-muted-foreground">
        Ballots still in draft when the deadline passes are submitted
        automatically as INCONCLUSIVE.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Date
          </Label>
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="mt-2 w-full justify-start font-normal"
                data-testid="start-vote-date"
              >
                <CalendarDays className="h-4 w-4 mr-2 text-muted-foreground" />
                {deadline ? format(deadline, 'd MMM yyyy') : 'Pick a date'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={deadline ?? undefined}
                defaultMonth={deadline ?? undefined}
                // A deadline in the past is never a legitimate choice, so the
                // calendar refuses it rather than letting the confirm button
                // explain it after the fact.
                disabled={{ before: new Date() }}
                onSelect={(picked) => {
                  if (!picked) return;
                  setDay(toDeadlineDay(picked));
                  setCalendarOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
        <div>
          <Label
            className="text-xs uppercase tracking-wide text-muted-foreground"
            htmlFor="start-vote-time"
          >
            Time
          </Label>
          <Input
            id="start-vote-time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="mt-2"
            data-testid="start-vote-time"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="start-vote-summary">
        {voterIds.length} {voterIds.length === 1 ? 'voter' : 'voters'} selected ·{' '}
        {deadline === null
          ? 'pick a valid date and time'
          : tooSoon
            ? 'the deadline must be at least 15 minutes from now'
            : tooFar
              ? 'the deadline must be within a year from now'
              : `closes ${format(deadline, 'd MMM yyyy, HH:mm')} — in ${describeTimeRemaining(deadline, new Date())}`}
      </p>
      <div className="flex justify-between pt-2">
        <Button variant="ghost" onClick={() => setStep('voters')} disabled={starting}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <Button
          onClick={() =>
            deadline && onStart({ voterIds, deadlineAt: deadline.toISOString() })
          }
          disabled={starting || tooSoon || tooFar || voterIds.length === 0}
          data-testid="start-vote-confirm"
        >
          {starting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Vote className="h-4 w-4 mr-2" />
          )}
          Start Vote
        </Button>
      </div>
    </div>
  );
}
