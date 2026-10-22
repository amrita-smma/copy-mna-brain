'use client';

import { useState } from 'react';
import { AlertCircle, AlertTriangle, Check, Clock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BotAvatar } from '@/components/bots/BotAvatar';
import { useChatActions } from '@/components/chat/ChatProvider';
import { createBot, createBotRoutine, updateBot } from '@/lib/api/bots';
import type { BotChangeApprovalPayload, BotChangeFields, ProposedBotRoutine } from '@/lib/bots/approval';
import { BOT_SHAPE_META, type BotShape } from '@/lib/bots/types';
import { describeSchedule } from '@/lib/routines/describe';
import { cn } from '@/lib/utils';
import { useApprovalResolution } from './ApprovalCardShell';
import { browserTimezone } from './BotRoutineApprovalCard';

export interface BotChangeApprovalCardProps {
  payload: BotChangeApprovalPayload;
  className?: string;
}

/** Only fields the bots API accepts — old cards may still carry retired keys (e.g. skills). */
function apiBotInput(input: Partial<BotChangeFields>): Partial<BotChangeFields> {
  const out: Partial<BotChangeFields> = {};
  if (input.name !== undefined) out.name = input.name;
  if (input.avatar !== undefined) out.avatar = input.avatar;
  if (input.persona_md !== undefined) out.persona_md = input.persona_md;
  if (input.visibility !== undefined) out.visibility = input.visibility;
  return out;
}

function lookOf(f: BotChangeFields): string {
  return `${BOT_SHAPE_META[f.avatar.shape as BotShape]?.label ?? f.avatar.shape}, hue ${f.avatar.hue}`;
}

function sharingOf(f: BotChangeFields): string {
  return f.visibility === 'workspace' ? 'Shared with the workspace' : 'Private';
}

/**
 * The one-line summary under the name. A create says what the bot looks like
 * and how many routines come with it; an update says what changes, compactly
 * ("Renamed to Atlas · Look → Nimbo, hue 28 · Shared with the workspace").
 */
type Outcome = 'proposed' | 'created' | 'updated' | 'cancelled';

function summaryOf(
  payload: BotChangeApprovalPayload,
  routines: ProposedBotRoutine[],
  outcome: Outcome,
  routinesIncomplete: boolean,
): string {
  const { after, before, input } = payload;
  if (payload.action === 'create') {
    const parts = [lookOf(after)];
    if (after.visibility === 'workspace') parts.push(sharingOf(after));
    if (routines.length > 0) {
      const n = `${routines.length} routine${routines.length === 1 ? '' : 's'}`;
      // What happened to them, not merely whether the card is settled.
      const phrase =
        outcome === 'proposed'
          ? 'to schedule'
          : outcome === 'cancelled'
            ? 'not scheduled'
            : routinesIncomplete
              ? 'not all scheduled'
              : 'scheduled';
      parts.push(`${n} ${phrase}`);
    }
    return parts.join(' · ');
  }
  const parts: string[] = [];
  if (input.name !== undefined) {
    parts.push(before && before.name !== after.name ? `Renamed from ${before.name}` : `Renamed to ${after.name}`);
  }
  if (input.avatar !== undefined) parts.push(`Look → ${lookOf(after)}`);
  if (input.visibility !== undefined) parts.push(sharingOf(after));
  if (input.persona_md !== undefined) parts.push(outcome === 'updated' ? 'Persona updated' : 'Persona changes');
  return parts.join(' · ') || lookOf(after);
}

/** The status pill beside the name. */
function StatusPill({ status }: { status: 'proposed' | 'created' | 'updated' | 'cancelled' }) {
  const label = { proposed: 'Proposed', created: 'Created', updated: 'Updated', cancelled: 'Cancelled' }[status];
  const done = status === 'created' || status === 'updated';
  return (
    <span
      data-testid="bot-change-status"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        done && 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
        status === 'proposed' && 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
        status === 'cancelled' && 'bg-muted text-muted-foreground',
      )}
    >
      {done && <Check className="h-3 w-3" />}
      {label}
    </span>
  );
}

/** "Persona · the first two lines…" with a toggle for the rest. */
function PersonaLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-sm" data-testid="bot-change-persona">
      <p className={cn('whitespace-pre-wrap break-words text-foreground/90', !open && 'line-clamp-2')}>
        <span className="font-semibold text-foreground">Persona</span>
        <span className="text-muted-foreground"> · </span>
        {text}
      </p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-0.5 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        {open ? 'Show less' : 'Show full persona'}
      </button>
    </div>
  );
}

/** One routine the bot starts with: when it runs, and what it is told. */
function RoutineRow({ routine }: { routine: ProposedBotRoutine }) {
  const timezone = routine.input.timezone || browserTimezone();
  return (
    <li className="flex items-start gap-3" data-testid="bot-change-routine">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Clock className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-semibold">{routine.input.title}</p>
          <p className="shrink-0 text-xs text-muted-foreground">
            {describeSchedule(routine.input.schedule_kind, routine.input.schedule_spec, timezone)}
          </p>
        </div>
        <p className="truncate text-sm text-muted-foreground">{routine.input.prompt}</p>
      </div>
    </li>
  );
}

/**
 * Approval card for propose_create_bot / update_bot: a compact
 * record of the bot — avatar, name, a status pill, one line on its look and
 * routines (or on what changes), the persona folded to two lines, and the
 * routines it starts with — then Cancel / Create (or Apply). Nothing is
 * editable here; the bot is edited in its own chat or on the Bots page.
 * Approving goes through the bots API, which checks the user's permission
 * again; a create then schedules each routine through the routines API, and a
 * routine that could not be scheduled is an alert on the card while the bot
 * stands.
 */
export function BotChangeApprovalCard({ payload, className }: BotChangeApprovalCardProps) {
  const { refreshBots } = useChatActions();
  const { status, setStatus, resolutionText, error, setError, isResolved, isSubmitting, resolve } =
    useApprovalResolution(`bot_change_resolved_${payload.approval_id}`);
  const isCreate = payload.action === 'create';
  const routines = isCreate ? (payload.routines ?? []) : [];
  const persona = isCreate
    ? payload.after.persona_md?.trim()
    : payload.input.persona_md !== undefined
      ? payload.after.persona_md?.trim()
      : '';
  const personaShown = isCreate || payload.input.persona_md !== undefined;
  const pill: Outcome = !isResolved
    ? 'proposed'
    : resolutionText?.startsWith('Cancelled')
      ? 'cancelled'
      : isCreate
        ? 'created'
        : 'updated';

  const handleApprove = async () => {
    if (status !== 'idle') return;
    setStatus('submitting');
    setError(null);
    try {
      const body = apiBotInput(payload.input);
      const saved =
        isCreate || !payload.bot_id
          ? await createBot(body)
          : await updateBot(payload.bot_id, body);
      // The routines, each on its own: one failing does not undo the bot.
      const failed: string[] = [];
      for (const routine of routines) {
        try {
          await createBotRoutine(saved.id, {
            ...routine.input,
            timezone: routine.input.timezone || browserTimezone(),
          });
        } catch (err: unknown) {
          failed.push(`${routine.input.title}: ${err instanceof Error ? err.message : 'could not be scheduled'}`);
        }
      }
      const scheduled = routines.length - failed.length;
      const routineNote =
        routines.length === 0
          ? ''
          : ` Scheduled ${scheduled}${failed.length > 0 ? ` of ${routines.length}` : ''} routine${routines.length === 1 ? '' : 's'}.`;
      resolve(isCreate ? `Created ${saved.name}.${routineNote}` : `Updated ${saved.name}.`);
      if (failed.length > 0) {
        // The bot stands, so the card resolves — but a routine that was not
        // scheduled is an alert on it, not a footnote.
        setError(failed.join('; '));
        toast.error(`${saved.name} created, but ${failed.length} routine${failed.length === 1 ? '' : 's'} could not be scheduled`);
      } else {
        toast.success(isCreate ? `${saved.name} created` : `${saved.name} updated`);
      }
      void refreshBots();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not save the bot';
      setError(message);
      setStatus('idle');
    }
  };

  return (
    <div
      data-testid="bot-change-card"
      className={cn('w-full rounded-2xl border bg-card p-4 shadow-sm', className)}
    >
      <div className="flex items-start gap-3">
        <BotAvatar avatar={payload.after.avatar} size="md" label={payload.after.name} trackCursor={false} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-base font-semibold">{payload.after.name}</p>
            <StatusPill status={pill} />
          </div>
          <p className="text-sm text-muted-foreground">{summaryOf(payload, routines, pill, Boolean(error))}</p>
        </div>
      </div>

      {personaShown && (
        <div className="mt-3">
          {persona ? (
            <PersonaLine text={persona} />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="bot-change-persona">
              <span className="font-semibold text-foreground">Persona</span>
              {isCreate ? ' · blank — it will ask who it is in its first chat.' : ' · cleared.'}
            </p>
          )}
        </div>
      )}

      {routines.length > 0 && (
        <ul className="mt-3 space-y-3 border-t pt-3" data-testid="bot-change-routines">
          {routines.map((routine, i) => (
            <RoutineRow key={`${routine.input.title}-${i}`} routine={routine} />
          ))}
        </ul>
      )}

      {payload.warning && !isResolved && (
        <div
          role="note"
          data-testid="bot-change-warning"
          className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/60 bg-card p-3 text-xs text-amber-800 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{payload.warning}</span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg border border-destructive bg-card p-3 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <span className="font-semibold">{isResolved ? 'Not scheduled: ' : 'Error: '}</span>
            <span>{error}</span>
          </div>
        </div>
      )}

      {isResolved ? (
        resolutionText && routines.length > 0 && pill !== 'cancelled' ? (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="bot-change-resolution">
            {resolutionText}
          </p>
        ) : null
      ) : (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button
            data-testid="bot-change-reject"
            variant="outline"
            onClick={() => status === 'idle' && resolve('Cancelled — nothing was changed.')}
            disabled={isSubmitting}
            className="bg-card"
          >
            Cancel
          </Button>
          <Button data-testid="bot-change-approve" onClick={handleApprove} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Check className="mr-1.5 h-4 w-4" />
                {isCreate
                  ? routines.length > 0
                    ? `Create bot + ${routines.length} routine${routines.length === 1 ? '' : 's'}`
                    : 'Create bot'
                  : payload.warning
                    ? 'Confirm change'
                    : 'Apply change'}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
