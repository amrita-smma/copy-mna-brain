'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, Users, Vote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import UserCombobox from '@/components/pipeline/UserCombobox';
import type { UserSummary } from '@/lib/api/pipeline';
import { browserDraftStorage } from './ballotDraftStore';
import {
  clearStartVoteDraft,
  readStartVoteDraft,
  writeStartVoteDraft,
} from './startVoteDraftStore';


const DAY_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30];
const HOUR_OPTIONS = [0, 1, 2, 3, 4, 6, 8, 12, 18];
const DEFAULT_DAYS = 2;
const DEFAULT_HOURS = 0;

type Step = 'idle' | 'voters' | 'duration';

/**
 * A restored duration must still be one of the offered options — a Radix
 * `Select` given a value with no matching item renders blank.
 */
const pickOption = (options: number[], value: number | undefined, fallback: number) =>
  value !== undefined && options.includes(value) ? value : fallback;

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
  onStart: (input: {
    voterIds: string[];
    durationDays: number;
    durationHours: number;
  }) => void;
  /** Shown above the button when the company has been voted on before. */
  again?: boolean;
}

/**
 * The "Start Vote" flow: a single button that expands into voter selection,
 * then the duration picker, then the confirm.
 *
 * Deliberately staged rather than one big form — the initiator picks *who*
 * before they can sensibly judge *how long*.
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
  const [days, setDays] = useState(() =>
    pickOption(DAY_OPTIONS, restored?.days, DEFAULT_DAYS),
  );
  const [hours, setHours] = useState(() =>
    pickOption(HOUR_OPTIONS, restored?.hours, DEFAULT_HOURS),
  );

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
      days,
      hours,
    });
  }, [storage, companyId, afterSessionId, step, voterIds, days, hours]);

  const totalHours = days * 24 + hours;

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
            onClick={() => setStep('duration')}
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
    <div className="max-w-xl mx-auto space-y-4 py-8" data-testid="start-vote-duration">
      <h3 className="text-base font-semibold">How long should voting stay open?</h3>
      <p className="text-sm text-muted-foreground">
        Ballots still in draft when the deadline passes are submitted
        automatically as INCONCLUSIVE.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Days
          </Label>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="mt-2" data-testid="start-vote-days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAY_OPTIONS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} {d === 1 ? 'day' : 'days'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Hours
          </Label>
          <Select value={String(hours)} onValueChange={(v) => setHours(Number(v))}>
            <SelectTrigger className="mt-2" data-testid="start-vote-hours">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOUR_OPTIONS.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  {h} {h === 1 ? 'hour' : 'hours'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {voterIds.length} {voterIds.length === 1 ? 'voter' : 'voters'} selected ·{' '}
        {totalHours > 0
          ? `closes in ${totalHours} ${totalHours === 1 ? 'hour' : 'hours'}`
          : 'pick at least 1 hour'}
      </p>
      <div className="flex justify-between pt-2">
        <Button variant="ghost" onClick={() => setStep('voters')} disabled={starting}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <Button
          onClick={() =>
            onStart({ voterIds, durationDays: days, durationHours: hours })
          }
          disabled={starting || totalHours <= 0 || voterIds.length === 0}
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
