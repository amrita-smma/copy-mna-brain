'use client';

import { useState } from 'react';
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

export function NewRoutineModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('CMP & Lithography APAC Scan');
  const [instruction, setInstruction] = useState(
    'Each run, scan Inven.AI and SEMI directory for new companies in CMP slurry, lithography ancillaries, and advanced packaging materials across APAC (Korea, Japan, Taiwan). Apply L0 criteria. Surface qualifying candidates to Discoveries.',
  );
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [time, setTime] = useState('06:00');
  const [timezone, setTimezone] = useState(timezoneOptions[0]);
  const [cron, setCron] = useState('0 6 * * 1-5');

  const cronInterpretation = interpretCron(cron);
  const tzShort = timezone.match(/\(([^)]+)\)/)?.[1] ?? timezone;
  const cadenceLabel = cadenceOptions.find((c) => c.key === cadence)?.label ?? 'Daily';
  const scheduleLabel =
    cadence === 'custom'
      ? cronInterpretation.plain
      : `${cadenceLabel} at ${time} ${tzShort}`;

  const canContinue =
    name.trim().length > 0 &&
    instruction.trim().length > 0 &&
    (cadence !== 'custom' || cronInterpretation.valid);

  const reset = () => setStep(1);
  const handleClose = () => {
    onOpenChange(false);
    window.setTimeout(reset, 200);
  };
  const handleCreate = () => {
    handleClose();
    // Mock — in real implementation, dispatch routine create.
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b text-left space-y-1">
          <DialogTitle className="text-lg">New Standing Routine</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Routines run automatically on schedule when the on-demand queue is empty.
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
                  <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 px-3.5 py-3">
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
                onClick={handleCreate}
                className="bg-gradient-to-br from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700"
              >
                <Check className="h-3 w-3 mr-1" strokeWidth={3} />
                Create routine
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
