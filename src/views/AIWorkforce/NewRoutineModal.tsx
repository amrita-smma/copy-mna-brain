'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ApiRoutine } from './routineApi';

type Cadence = 'daily' | 'weekly' | 'monthly' | 'custom';

const cadenceOptions: { key: Cadence; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'custom', label: 'Custom (cron)' },
];

const timezoneOptions = [
  'Asia/Jakarta (ICT, UTC+7)',
  'Asia/Tokyo (JST, UTC+9)',
  'America/New_York (EST)',
  'Europe/London (GMT)',
];

// 0=Sun..6=Sat matches cron's day-of-week convention used by the backend.
const WEEKDAYS: { value: number; short: string; long: string }[] = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 0, short: 'Sun', long: 'Sunday' },
];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const cronExamples: Record<string, string> = {
  '0 6 * * 1-5': 'At 06:00 on every weekday',
  '0 9 * * 1': 'At 09:00 every Monday',
  '0 */4 * * *': 'Every 4 hours, at minute 0',
  '0 0 1 * *': 'At 00:00 on the 1st of every month',
  '30 14 * * 5': 'At 14:30 every Friday',
  '0 0 * * 0': 'At 00:00 every Sunday',
  '*/15 * * * *': 'Every 15 minutes',
  '0 8-18 * * 1-5': 'Every hour from 08:00 to 18:00 on weekdays',
};

function interpretCron(expr: string): { plain: string; valid: boolean } {
  const trimmed = expr.trim();
  if (!trimmed) return { plain: 'Enter a cron expression', valid: false };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return { plain: 'Invalid — must have 5 fields', valid: false };
  return { plain: cronExamples[trimmed] ?? 'Custom schedule', valid: true };
}

// Maps the dropdown label back to its IANA timezone. The label shows the
// abbreviation in parens for readability; the API needs the IANA form.
const TIMEZONE_MAP: Record<string, string> = {
  'Asia/Jakarta (ICT, UTC+7)': 'Asia/Jakarta',
  'Asia/Tokyo (JST, UTC+9)': 'Asia/Tokyo',
  'America/New_York (EST)': 'America/New_York',
  'Europe/London (GMT)': 'Europe/London',
};

// Default form state — kept blank so each new-routine flow starts fresh.
// The Input/Textarea placeholders still show example text to guide the user;
// pre-filling actual values made it feel like the form was locked to one
// routine after the first create.
const DEFAULTS = {
  name: '',
  instruction: '',
  cadence: 'daily' as Cadence,
  time: '06:00',
  timezone: timezoneOptions[0],
  cron: '0 6 * * 1-5',
  weekday: 1, // Monday
  dayOfMonth: 1,
};

// Reverse of TIMEZONE_MAP — given an IANA tz (what the server stores),
// find the human-readable label the modal uses. Falls back to the IANA
// itself when no mapping exists so unfamiliar tz values still display.
const IANA_TO_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(TIMEZONE_MAP).map(([label, iana]) => [iana, label]),
);

interface FormState {
  name: string;
  instruction: string;
  cadence: Cadence;
  time: string;
  timezone: string;
  cron: string;
  weekday: number;
  dayOfMonth: number;
}

// Convert a server-side routine row into the form's local state shape.
// Reverses what `normalizeSchedule` does at write time.
function routineToFormState(routine: ApiRoutine): FormState {
  const spec = (routine.schedule_spec ?? {}) as {
    time?: string;
    expression?: string;
    weekdays?: number[];
    day?: number;
  };
  let cadence: Cadence;
  let cron = DEFAULTS.cron;
  if (routine.schedule_kind === 'cron') {
    cadence = 'custom';
    cron = spec.expression ?? routine.cron_expression ?? DEFAULTS.cron;
  } else {
    cadence = routine.schedule_kind;
  }
  return {
    name: routine.title,
    instruction: routine.prompt,
    cadence,
    time: spec.time ?? DEFAULTS.time,
    timezone: IANA_TO_LABEL[routine.timezone] ?? routine.timezone,
    cron,
    weekday:
      Array.isArray(spec.weekdays) && spec.weekdays.length > 0
        ? spec.weekdays[0]
        : DEFAULTS.weekday,
    dayOfMonth: typeof spec.day === 'number' ? spec.day : DEFAULTS.dayOfMonth,
  };
}

export function NewRoutineModal({
  open,
  onOpenChange,
  onCreated,
  // When provided, the modal operates in EDIT mode: form pre-fills from the
  // routine, the title/CTA copy switches, and the submit calls PATCH instead
  // of POST. Caller is responsible for clearing this back to undefined after
  // the modal closes so a subsequent "New Routine" click gets a clean slate.
  routine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void | Promise<void>;
  routine?: ApiRoutine;
}) {
  const isEditMode = !!routine;
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(DEFAULTS.name);
  const [instruction, setInstruction] = useState(DEFAULTS.instruction);
  const [cadence, setCadence] = useState<Cadence>(DEFAULTS.cadence);
  const [time, setTime] = useState(DEFAULTS.time);
  const [timezone, setTimezone] = useState(DEFAULTS.timezone);
  const [cron, setCron] = useState(DEFAULTS.cron);
  const [weekday, setWeekday] = useState(DEFAULTS.weekday);
  const [dayOfMonth, setDayOfMonth] = useState(DEFAULTS.dayOfMonth);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset every time the dialog opens. The Radix Dialog keeps the content
  // tree mounted across open/close cycles, so without this useState values
  // would persist from the previous create/edit — the user would see stale
  // form values and assume the form was stuck. In edit mode we prefill from
  // the routine; otherwise we go back to blank defaults.
  //
  // Dependency includes routine?.id so opening for a different routine
  // re-prefills even if the modal was already mounted with `open=true` for
  // a prior routine.
  useEffect(() => {
    if (!open) return;
    const seed = routine ? routineToFormState(routine) : DEFAULTS;
    setStep(1);
    setName(seed.name);
    setInstruction(seed.instruction);
    setCadence(seed.cadence);
    setTime(seed.time);
    setTimezone(seed.timezone);
    setCron(seed.cron);
    setWeekday(seed.weekday);
    setDayOfMonth(seed.dayOfMonth);
    setSubmitError(null);
    setSubmitting(false);
  }, [open, routine?.id, routine]);

  const cronInterpretation = interpretCron(cron);
  const tzShort = timezone.match(/\(([^)]+)\)/)?.[1] ?? timezone;
  let scheduleLabel: string;
  if (cadence === 'custom') {
    scheduleLabel = cronInterpretation.plain;
  } else if (cadence === 'weekly') {
    const dayLabel = WEEKDAYS.find((d) => d.value === weekday)?.long ?? 'Monday';
    scheduleLabel = `Weekly on ${dayLabel} at ${time} ${tzShort}`;
  } else if (cadence === 'monthly') {
    scheduleLabel = `Monthly on the ${ordinal(dayOfMonth)} at ${time} ${tzShort}`;
  } else {
    scheduleLabel = `Daily at ${time} ${tzShort}`;
  }

  const canContinue =
    name.trim().length > 0 &&
    instruction.trim().length > 0 &&
    (cadence !== 'custom' || cronInterpretation.valid);

  const reset = () => {
    setStep(1);
    setName(DEFAULTS.name);
    setInstruction(DEFAULTS.instruction);
    setCadence(DEFAULTS.cadence);
    setTime(DEFAULTS.time);
    setTimezone(DEFAULTS.timezone);
    setCron(DEFAULTS.cron);
    setWeekday(DEFAULTS.weekday);
    setDayOfMonth(DEFAULTS.dayOfMonth);
    setSubmitError(null);
  };
  const handleClose = () => {
    onOpenChange(false);
    window.setTimeout(reset, 200);
  };
  const handleSubmit = async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const iana = TIMEZONE_MAP[timezone] ?? timezone;
      const scheduleKind = cadence === 'custom' ? 'cron' : cadence;
      let scheduleSpec: Record<string, unknown>;
      if (cadence === 'custom') {
        scheduleSpec = { expression: cron };
      } else if (cadence === 'weekly') {
        scheduleSpec = { time, weekdays: [weekday] };
      } else if (cadence === 'monthly') {
        scheduleSpec = { time, day: dayOfMonth };
      } else {
        scheduleSpec = { time };
      }

      const payload = {
        title: name.trim(),
        prompt: instruction.trim(),
        schedule_kind: scheduleKind,
        schedule_spec: scheduleSpec,
        timezone: iana,
      };

      const res = isEditMode
        ? await fetch(`/api/routines/${routine!.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/routines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          body.error ?? `${isEditMode ? 'Save' : 'Create'} failed (HTTP ${res.status})`,
        );
      }
      await onCreated?.();
      handleClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : `Failed to ${isEditMode ? 'save' : 'create'} routine`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b text-left space-y-1">
          <DialogTitle className="text-lg">
            {isEditMode ? 'Edit Routine' : 'New Standing Routine'}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {isEditMode
              ? 'Update the schedule or instruction. The next scheduled fire is recomputed from the new schedule.'
              : 'Routines run automatically on schedule when the on-demand queue is empty.'}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="px-6 py-3 bg-muted/30 border-b flex items-center gap-2 text-xs">
          <StepDot num={1} label="Configure" current={step} />
          <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          <StepDot num={2} label="Review" current={step} />
        </div>

        {/* Body */}
        <div className="px-6 py-5 max-h-[60vh] overflow-y-auto">
          {step === 1 ? (
            <div className="space-y-5">
              {/* Name */}
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-2">
                  Routine name <span className="text-red-600">*</span>
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. CMP & Lithography APAC Scan"
                />
              </div>

              {/* Instruction */}
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-2">
                  What should it do <span className="text-red-600">*</span>
                </label>
                <Textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  rows={4}
                  placeholder="Describe what the Workforce should do each run…"
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground/80 flex items-start gap-1.5">
                  <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
                  Be specific about what to scan, what to filter for, and what counts as a qualifying result.
                </p>
              </div>

              {/* Schedule */}
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-2">
                  Schedule <span className="text-red-600">*</span>
                </label>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {cadenceOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => setCadence(option.key)}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors',
                        cadence === option.key
                          ? 'border-violet-500 bg-violet-50 text-violet-700'
                          : 'border-border bg-card text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {cadence !== 'custom' ? (
                  <div className="rounded-lg border bg-muted/30 px-3.5 py-3 space-y-3">
                    {cadence === 'weekly' && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Day of week
                        </p>
                        <div className="flex gap-1">
                          {WEEKDAYS.map((d) => (
                            <button
                              key={d.value}
                              type="button"
                              onClick={() => setWeekday(d.value)}
                              className={cn(
                                'flex-1 min-w-[36px] rounded-md border py-1.5 text-[11px] font-semibold transition-colors',
                                weekday === d.value
                                  ? 'border-violet-500 bg-violet-50 text-violet-700'
                                  : 'border-border bg-card text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {d.short}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {cadence === 'monthly' && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Day of month
                        </p>
                        <Select
                          value={String(dayOfMonth)}
                          onValueChange={(v) => setDayOfMonth(Number(v))}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DAYS_OF_MONTH.map((d) => (
                              <SelectItem key={d} value={String(d)}>
                                {ordinal(d)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {dayOfMonth >= 29 && (
                          <p className="mt-1.5 text-[11px] text-muted-foreground/80 flex items-start gap-1.5">
                            <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
                            <span>
                              Months with fewer than {dayOfMonth} days fire on the last day instead.
                            </span>
                          </p>
                        )}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Run at
                        </p>
                        <Input
                          type="time"
                          value={time}
                          onChange={(e) => setTime(e.target.value)}
                        />
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Timezone
                        </p>
                        <Select value={timezone} onValueChange={setTimezone}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {timezoneOptions.map((tz) => (
                              <SelectItem key={tz} value={tz}>
                                {tz}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border bg-muted/30 px-3.5 py-3 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Cron expression
                        </p>
                        <Input
                          value={cron}
                          onChange={(e) => setCron(e.target.value)}
                          className="font-mono"
                          placeholder="0 6 * * 1-5"
                        />
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Timezone
                        </p>
                        <Select value={timezone} onValueChange={setTimezone}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {timezoneOptions.map((tz) => (
                              <SelectItem key={tz} value={tz}>
                                {tz}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div
                      className={cn(
                        'rounded-md border bg-card px-3 py-2 flex items-center gap-2',
                        !cronInterpretation.valid && 'border-red-200 bg-red-50/40',
                      )}
                    >
                      {cronInterpretation.valid ? (
                        <Check className="h-3 w-3 text-emerald-600" strokeWidth={3} />
                      ) : (
                        <AlertCircle className="h-3 w-3 text-red-600" />
                      )}
                      <span
                        className={cn(
                          'text-xs font-medium',
                          cronInterpretation.valid ? 'text-foreground' : 'text-red-700',
                        )}
                      >
                        {cronInterpretation.plain}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-3">
                Review your routine
              </p>
              <div className="rounded-xl border bg-gradient-to-br from-violet-50/40 to-card px-4 py-3.5 space-y-3 text-sm">
                <SummaryRow label="Name">
                  <span className="font-semibold text-violet-700">{name}</span>
                </SummaryRow>
                <SummaryRow label="Schedule">{scheduleLabel}</SummaryRow>
                <SummaryRow label="Instruction">
                  <span className="text-[12.5px] text-muted-foreground leading-relaxed">
                    {instruction}
                  </span>
                </SummaryRow>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground/80 flex items-start gap-1.5">
                <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
                You can pause, edit, or delete this routine anytime from the Workforce sidebar.
              </p>
              {submitError && (
                <div className="mt-3 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 flex items-start gap-2 text-[12px] text-red-700">
                  <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-muted/30 border-t flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Step {step} of 2</span>
          <div className="flex gap-2">
            {step > 1 && (
              <Button variant="outline" size="sm" onClick={() => setStep(1)}>
                <ChevronLeft className="h-3 w-3 mr-1" />
                Back
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleClose}>
              Cancel
            </Button>
            {step === 1 ? (
              <Button
                size="sm"
                disabled={!canContinue}
                onClick={() => setStep(2)}
                className="bg-gradient-to-br from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700"
              >
                Continue
                <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={submitting}
                className="bg-gradient-to-br from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700"
              >
                <Check className="h-3 w-3 mr-1" strokeWidth={3} />
                {submitting
                  ? isEditMode
                    ? 'Saving…'
                    : 'Creating…'
                  : isEditMode
                    ? 'Save changes'
                    : 'Create routine'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepDot({ num, label, current }: { num: 1 | 2; label: string; current: 1 | 2 }) {
  const state = num === current ? 'active' : num < current ? 'done' : 'pending';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-semibold',
        state === 'active' && 'text-violet-700',
        state === 'done' && 'text-emerald-700',
        state === 'pending' && 'text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'h-[18px] w-[18px] rounded-full grid place-items-center text-[10px] font-bold',
          state === 'active' && 'bg-violet-500 text-white',
          state === 'done' && 'bg-emerald-500 text-white',
          state === 'pending' && 'bg-border text-muted-foreground',
        )}
      >
        {state === 'done' ? <Check className="h-2.5 w-2.5" strokeWidth={3.5} /> : num}
      </span>
      {label}
    </span>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 pb-2.5 border-b border-border last:border-0 last:pb-0">
      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground pt-0.5">
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}
