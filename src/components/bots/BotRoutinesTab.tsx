"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Pencil, Play, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  createBotRoutine,
  deleteBotRoutine,
  listBotRoutines,
  runBotRoutine,
  updateBotRoutine,
} from '@/lib/api/bots';
import {
  BOT_ROUTINE_PROMPT_MAX_LENGTH,
  BOT_ROUTINE_TITLE_MAX_LENGTH,
  type BotRoutineDto,
  type BotRoutineInput,
} from '@/lib/bots/routineTypes';
import type { BotDto } from '@/lib/bots/types';
import type { ScheduleKind } from '@/lib/routines/schedule';
import { describeSchedule } from '@/lib/routines/describe';

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

const KIND_LABELS: Record<ScheduleKind, string> = {
  daily: 'Every day',
  weekly: 'Weekly',
  monthly: 'Monthly',
  cron: 'Custom (cron)',
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The form's fields, flattened from a routine's (kind, spec). */
interface RoutineDraft {
  title: string;
  prompt: string;
  kind: ScheduleKind;
  time: string;
  weekdays: number[];
  day: number;
  cron: string;
  timezone: string;
}

function draftOf(routine: BotRoutineDto | null): RoutineDraft {
  const spec = routine?.schedule_spec ?? {};
  return {
    title: routine?.title ?? '',
    prompt: routine?.prompt ?? '',
    kind: routine?.schedule_kind ?? 'weekly',
    time: typeof spec.time === 'string' ? spec.time : '09:00',
    weekdays: Array.isArray(spec.weekdays) ? (spec.weekdays as number[]) : [1, 2, 3, 4, 5],
    day: typeof spec.day === 'number' ? spec.day : 1,
    cron: typeof spec.expression === 'string' ? spec.expression : '0 9 * * 1',
    timezone: routine?.timezone ?? browserTimezone(),
  };
}

function inputOf(d: RoutineDraft): BotRoutineInput {
  const spec: Record<string, unknown> =
    d.kind === 'daily'
      ? { time: d.time }
      : d.kind === 'weekly'
        ? { time: d.time, weekdays: d.weekdays }
        : d.kind === 'monthly'
          ? { time: d.time, day: d.day }
          : { expression: d.cron.trim() };
  return { title: d.title.trim(), prompt: d.prompt.trim(), schedule_kind: d.kind, schedule_spec: spec, timezone: d.timezone.trim() };
}

/**
 * The bot's routines, in its edit dialog: scheduled messages the bot is sent,
 * each as the person who created it, in their own chat with the bot. On a
 * shared bot they are shared — everyone sees them and anyone can change them —
 * which the banner says before anything else.
 */
export function BotRoutinesTab({ bot }: { bot: BotDto }) {
  // Brain Bot's routines are each person's own, never shared.
  const shared = !bot.is_default && bot.visibility === 'workspace';
  const [routines, setRoutines] = useState<BotRoutineDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // `null`: no form; `'new'`: adding; a routine: editing it.
  const [editing, setEditing] = useState<BotRoutineDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BotRoutineDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Drops a slow earlier load that lands after a newer one.
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const rows = await listBotRoutines(bot.id);
      if (seq !== loadSeqRef.current) return;
      setRoutines(rows);
      setLoadError(null);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setLoadError((err as Error).message || 'Could not load the routines');
    }
  }, [bot.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (routine: BotRoutineDto, enabled: boolean) => {
    setBusyId(routine.id);
    try {
      const saved = await updateBotRoutine(bot.id, routine.id, { enabled });
      setRoutines((rows) => rows?.map((r) => (r.id === saved.id ? saved : r)) ?? rows);
    } catch (err) {
      toast.error((err as Error).message || 'Could not change the routine');
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (routine: BotRoutineDto) => {
    setBusyId(routine.id);
    try {
      await runBotRoutine(bot.id, routine.id);
      toast.success(`Sent “${routine.title}” — ${bot.name} will answer in your chat`);
    } catch (err) {
      toast.error((err as Error).message || 'Could not run the routine');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const routine = deleting;
    setDeleting(null);
    if (!routine) return;
    try {
      await deleteBotRoutine(bot.id, routine.id);
      setRoutines((rows) => rows?.filter((r) => r.id !== routine.id) ?? rows);
      toast.success(`Deleted “${routine.title}”`);
    } catch (err) {
      toast.error((err as Error).message || 'Could not delete the routine');
    }
  };

  return (
    <div className="space-y-4" data-testid="bot-routines-tab">
      {shared && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          data-testid="bot-routines-shared-warning"
        >
          <Users className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="font-medium">{bot.name} is shared.</span> Its routines are visible to everyone in the
            workspace, and anyone can edit or delete them. Each routine runs as the person who created it, in their
            chat with the bot.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          A routine sends {bot.name} a message on a schedule; it does the task and answers in the chat.
        </p>
        {editing === null && (
          <Button size="sm" className="shrink-0 gap-1.5" onClick={() => setEditing('new')} data-testid="bot-routine-add">
            <Plus className="h-3.5 w-3.5" />
            Add routine
          </Button>
        )}
      </div>

      {editing !== null && (
        <RoutineForm
          key={editing === 'new' ? 'new' : editing.id}
          routine={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            const saved =
              editing === 'new'
                ? await createBotRoutine(bot.id, input)
                : await updateBotRoutine(bot.id, editing.id, input);
            setEditing(null);
            toast.success(editing === 'new' ? `Scheduled “${saved.title}”` : `Saved “${saved.title}”`);
            await load();
          }}
        />
      )}

      {loadError ? (
        <p className="rounded-md border bg-card px-3 py-4 text-sm text-destructive">{loadError}</p>
      ) : routines === null ? (
        <div className="space-y-2">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      ) : routines.length === 0 ? (
        editing === null && (
          <div className="rounded-lg border border-dashed bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            <CalendarClock className="mx-auto mb-2 h-5 w-5" />
            No routines yet. Add one here, or ask {bot.name} in chat — for example “every weekday at 9, summarise what
            moved in my pipeline”.
          </div>
        )
      ) : (
        <ul className="space-y-2" data-testid="bot-routine-list">
          {routines.map((r) => (
            <li key={r.id} className="rounded-lg border bg-card p-3" data-testid={`bot-routine-${r.id}`}>
              <div className="flex items-start gap-3">
                <Switch
                  checked={r.enabled}
                  disabled={busyId === r.id}
                  onCheckedChange={(v) => void toggle(r, v)}
                  aria-label={r.enabled ? `Pause ${r.title}` : `Turn on ${r.title}`}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.schedule_label}
                    {r.enabled ? ` · next ${formatWhen(r.next_fire_at)}` : ' · paused'}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{r.prompt}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Runs as {r.is_mine ? 'you' : (r.created_by_name ?? 'a teammate')}
                    {r.last_fired_at ? ` · last ran ${formatWhen(r.last_fired_at)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0"
                    aria-label={`Run ${r.title} now`}
                    title="Run now (as you)"
                    disabled={busyId === r.id}
                    onClick={() => void runNow(r)}
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0"
                    aria-label={`Edit ${r.title}`}
                    onClick={() => setEditing(r)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 text-muted-foreground"
                    aria-label={`Delete ${r.title}`}
                    onClick={() => setDeleting(r)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops running{shared ? ' for everyone' : ''}. Answers it already got stay in the chat.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RoutineForm({
  routine,
  onCancel,
  onSave,
}: {
  routine: BotRoutineDto | null;
  onCancel: () => void;
  onSave: (input: BotRoutineInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RoutineDraft>(() => draftOf(routine));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof RoutineDraft>(key: K, value: RoutineDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const input = inputOf(draft);
  const canSave =
    !saving &&
    input.title.length > 0 &&
    input.prompt.length > 0 &&
    (draft.kind !== 'weekly' || draft.weekdays.length > 0) &&
    (draft.kind !== 'cron' || draft.cron.trim().length > 0);

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(input);
    } catch (err) {
      setError((err as Error).message || 'Could not save the routine');
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted p-3" data-testid="bot-routine-form">
      <div className="space-y-1.5">
        <Label htmlFor="routine-title">Title</Label>
        <Input
          id="routine-title"
          value={draft.title}
          maxLength={BOT_ROUTINE_TITLE_MAX_LENGTH}
          placeholder="Morning pipeline summary"
          onChange={(e) => set('title', e.target.value)}
          className="bg-background"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="routine-prompt">Message</Label>
        <Textarea
          id="routine-prompt"
          value={draft.prompt}
          maxLength={BOT_ROUTINE_PROMPT_MAX_LENGTH}
          rows={3}
          placeholder="Summarise what moved in my pipeline since yesterday and flag anything stalled."
          onChange={(e) => set('prompt', e.target.value)}
          className="bg-background"
        />
        <p className="text-xs text-muted-foreground">Sent to the bot as you each time the routine runs.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label>Repeats</Label>
          <Select value={draft.kind} onValueChange={(v) => set('kind', v as ScheduleKind)}>
            <SelectTrigger className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABELS) as ScheduleKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {draft.kind !== 'cron' ? (
          <div className="space-y-1.5">
            <Label htmlFor="routine-time">At</Label>
            <Input
              id="routine-time"
              type="time"
              value={draft.time}
              onChange={(e) => set('time', e.target.value)}
              className="bg-background"
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="routine-cron">Cron</Label>
            <Input
              id="routine-cron"
              value={draft.cron}
              onChange={(e) => set('cron', e.target.value)}
              className="bg-background font-mono"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="routine-tz">Timezone</Label>
          <Input
            id="routine-tz"
            value={draft.timezone}
            onChange={(e) => set('timezone', e.target.value)}
            className="bg-background"
          />
        </div>
      </div>
      {draft.kind === 'weekly' && (
        <ToggleGroup
          type="multiple"
          size="sm"
          value={draft.weekdays.map(String)}
          onValueChange={(v) => set('weekdays', v.map(Number))}
          className="flex-wrap justify-start"
          aria-label="Days"
        >
          {WEEKDAYS.map((d) => (
            <ToggleGroupItem key={d.value} value={String(d.value)} className="bg-background">
              {d.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {draft.kind === 'monthly' && (
        <div className="flex items-center gap-2 text-sm">
          <Label htmlFor="routine-day">On day</Label>
          <Input
            id="routine-day"
            type="number"
            min={1}
            max={31}
            value={draft.day}
            onChange={(e) => set('day', Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
            className="w-20 bg-background"
          />
          <span className="text-xs text-muted-foreground">(31 runs on the month&apos;s last day)</span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {describeSchedule(input.schedule_kind, input.schedule_spec, input.timezone || undefined)}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={!canSave} data-testid="bot-routine-save">
          {saving ? 'Saving…' : routine ? 'Save routine' : 'Schedule'}
        </Button>
      </div>
    </div>
  );
}
