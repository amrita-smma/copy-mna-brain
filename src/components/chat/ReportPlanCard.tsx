'use client';

import { useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { toast } from 'sonner';

import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useChatActions } from './ChatProvider';
import type { ReportPlanApprovalPayload } from '@/lib/reports/plan';
import {
  ApprovalCardShell,
  useApprovalResolution,
} from './ApprovalCardShell';

export interface ReportPlanCardProps {
  payload: ReportPlanApprovalPayload;
  className?: string;
}

export function ReportPlanCard({
  payload,
  className,
}: ReportPlanCardProps) {
  const { sendMessage } = useChatActions();
  const {
    status,
    setStatus,
    resolutionText,
    error,
    setError,
    isResolved,
    isSubmitting,
    resolve,
  } = useApprovalResolution(
    payload.approval_id ? `report_plan_resolved_${payload.approval_id}` : null,
  );

  // Pre-select recommended option where one exists
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const q of payload.questions ?? []) {
      const rec = q.options.find((opt) => opt.recommended);
      if (rec) {
        initial[q.id] = rec.label;
      }
    }
    return initial;
  });

  const handleConfirm = async () => {
    if (status !== 'idle') return;
    setStatus('submitting');
    setError(null);

    try {
      const lines: string[] = [
        `Confirmed methodology: ${payload.methodology}`,
      ];

      if (payload.questions && payload.questions.length > 0) {
        lines.push('', 'Clarifications:');
        for (const q of payload.questions) {
          const chosen =
            selectedAnswers[q.id] ||
            q.options.find((opt) => opt.recommended)?.label ||
            'no preference — use your judgement';
          lines.push(`- ${q.question}: ${chosen}`);
        }
      }

      lines.push('', 'Proceed with the report using the confirmed plan.');

      const text = lines.join('\n');
      await sendMessage({ text });

      resolve('Plan confirmed.');
      toast.success('Report plan confirmed');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to confirm plan';
      setError(message);
      setStatus('idle');
      toast.error('Failed to confirm plan', { description: message });
    }
  };

  const handleCancel = () => {
    if (status !== 'idle') return;
    resolve('Plan declined.');
    toast.info('Report plan declined');
  };

  return (
    <ApprovalCardShell
      testId="report-plan-card"
      className={className}
      isResolved={isResolved}
      isSubmitting={isSubmitting}
      resolutionText={resolutionText}
      error={error}
      tagIcon={<ClipboardList className="h-3.5 w-3.5" />}
      tagLabel="Plan Review · Clarifying Questions"
      rejectLabel="Cancel"
      rejectTestId="report-plan-cancel-button"
      approveTestId="report-plan-confirm-button"
      approveLabel="Confirm plan"
      submittingLabel="Confirming…"
      onReject={handleCancel}
      onApprove={handleConfirm}
    >
      <h3 className="text-base font-semibold text-foreground mb-2">
        {payload.request}
      </h3>

      {/* Methodology prominently displayed */}
      <div className="rounded-xl border border-border bg-muted p-3.5 mb-4 space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Proposed Methodology
        </p>
        <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
          {payload.methodology}
        </p>
      </div>

      {/* Questions with Radio Groups */}
      {payload.questions && payload.questions.length > 0 && (
        <div className="space-y-4 mb-4">
          {payload.questions.map((q, qIdx) => (
            <div
              key={q.id || qIdx}
              className="rounded-xl border border-border bg-card p-3.5 space-y-2.5"
            >
              <p className="text-sm font-medium text-foreground">
                {q.question}
              </p>
              <RadioGroup
                value={selectedAnswers[q.id] ?? ''}
                onValueChange={(val) => {
                  if (isResolved || isSubmitting) return;
                  setSelectedAnswers((prev) => ({ ...prev, [q.id]: val }));
                }}
                disabled={isResolved || isSubmitting}
                className="space-y-1.5"
              >
                {q.options.map((opt, optIdx) => {
                  const optId = `${payload.approval_id || 'plan'}-${q.id}-opt-${optIdx}`;
                  const isSelected = selectedAnswers[q.id] === opt.label;
                  return (
                    <div
                      key={optIdx}
                      className={cn(
                        'flex items-center space-x-2.5 rounded-lg border p-2.5 transition-colors',
                        isSelected
                          ? 'border-indigo-300 dark:border-indigo-800 bg-muted'
                          : 'border-border bg-muted',
                      )}
                    >
                      <RadioGroupItem value={opt.label} id={optId} />
                      <Label
                        htmlFor={optId}
                        className="flex-1 text-sm text-foreground cursor-pointer flex items-center justify-between gap-2 select-none"
                      >
                        <span>{opt.label}</span>
                        {opt.recommended && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border border-border bg-card text-foreground">
                            Recommended
                          </span>
                        )}
                      </Label>
                    </div>
                  );
                })}
              </RadioGroup>
            </div>
          ))}
        </div>
      )}
    </ApprovalCardShell>
  );
}
