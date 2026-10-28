'use client';

import { CalendarClock, Users } from 'lucide-react';
import { toast } from 'sonner';
import { createBotRoutine } from '@/lib/api/bots';
import type { BotRoutineApprovalPayload } from '@/lib/bots/approval';
import { describeSchedule } from '@/lib/routines/describe';
import { ApprovalCardShell, useApprovalResolution } from './ApprovalCardShell';

/** The viewer's own timezone, for a routine the bot proposed without one. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Approval card for propose_create_routine: the routine's title, schedule and
 * the message the bot will be sent, then Schedule. Scheduling goes through the
 * bot routines API, which validates and checks permission again; the routine
 * runs as whoever approves it. A shared bot's routines are visible to and
 * editable by everyone in the workspace, which the card says.
 */
export function BotRoutineApprovalCard({
  payload,
  className,
}: {
  payload: BotRoutineApprovalPayload;
  className?: string;
}) {
  const { status, setStatus, resolutionText, error, setError, isResolved, isSubmitting, resolve } =
    useApprovalResolution({ cardId: payload.approval_id, toolName: 'propose_create_routine' });
  const timezone = payload.input.timezone || browserTimezone();
  const scheduleLabel = describeSchedule(payload.input.schedule_kind, payload.input.schedule_spec, timezone);

  const handleApprove = async () => {
    if (status !== 'idle') return;
    setStatus('submitting');
    setError(null);
    try {
      const saved = await createBotRoutine(payload.bot_id, { ...payload.input, timezone });
      resolve(`Scheduled “${saved.title}” — ${saved.schedule_label}.`, 'accepted', {
        routine_id: saved.id,
      });
      toast.success(`Routine scheduled on ${payload.bot_name}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not schedule the routine');
      setStatus('idle');
    }
  };

  return (
    <ApprovalCardShell
      testId="bot-routine-card"
      className={className}
      isResolved={isResolved}
      isSubmitting={isSubmitting}
      resolutionText={resolutionText}
      error={error}
      resolvedBgClassName="bg-muted"
      tagIcon={<CalendarClock className="h-3.5 w-3.5" />}
      tagLabel="Proposed · New routine"
      rejectLabel="Cancel"
      rejectTestId="bot-routine-reject"
      approveTestId="bot-routine-approve"
      approveLabel="Schedule"
      submittingLabel="Scheduling…"
      onReject={() => status === 'idle' && resolve('Cancelled — nothing was scheduled.', 'declined')}
      onApprove={handleApprove}
    >
      <p className="text-base font-semibold">{payload.input.title}</p>
      <dl className="mt-2 space-y-1.5 text-sm">
        <div className="grid grid-cols-[5.5rem_1fr] gap-2">
          <dt className="text-muted-foreground">When</dt>
          <dd>{scheduleLabel}</dd>
        </div>
        <div className="grid grid-cols-[5.5rem_1fr] gap-2">
          <dt className="text-muted-foreground">Message</dt>
          <dd className="min-w-0">
            <p className="whitespace-pre-wrap rounded-md border bg-muted p-2 text-xs">{payload.input.prompt}</p>
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Each run sends this message to {payload.bot_name} as you, in your chat with it.
      </p>
      {payload.shared && (
        <p
          className="mt-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          data-testid="bot-routine-shared-warning"
        >
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {payload.bot_name} is shared: everyone in the workspace will see this routine and can edit or delete it.
        </p>
      )}
    </ApprovalCardShell>
  );
}
