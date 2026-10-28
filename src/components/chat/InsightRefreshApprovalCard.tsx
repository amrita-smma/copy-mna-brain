'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { WorkspaceLink } from '@/components/WorkspaceLink';
import { refreshInsightNow } from '@/lib/api/insights';
import type { InsightRefreshApprovalPayload } from '@/lib/insights/types';
import {
  ApprovalCardShell,
  useApprovalResolution,
} from './ApprovalCardShell';

export interface InsightRefreshApprovalCardProps {
  payload: InsightRefreshApprovalPayload;
  className?: string;
}

/** The text the card resolves to once the refresh is queued (or found live). */
export function refreshResolutionText(created: boolean): string {
  return created
    ? 'Refresh queued — a new version publishes when the run finishes.'
    : 'A refresh of this insight is already running — no second run was added.';
}

/**
 * "Refresh this insight now" (MB-552 AC3): offered by `propose_insight_refresh`
 * after CoPilot shows a retrieved figure that contradicts the open insight.
 * Accepting runs the insight's refresh routine now, or a one-off refresh run
 * when it has none; a paused binding comes back as the error text.
 */
export function InsightRefreshApprovalCard({
  payload,
  className,
}: InsightRefreshApprovalCardProps) {
  const {
    status,
    setStatus,
    resolutionText,
    error,
    setError,
    isResolved,
    isSubmitting,
    resolve,
    decisionData,
  } = useApprovalResolution({ cardId: payload.approval_id, toolName: 'propose_insight_refresh' });
  // The run just queued (or found live), for the "View task" link; on a
  // reload, the run the stored decision recorded.
  const [queuedRunId, setRunId] = useState<string | null>(null);
  const runId = queuedRunId ?? (typeof decisionData?.run_id === 'string' ? decisionData.run_id : null);

  const handleAccept = async () => {
    if (status !== 'idle') return;
    setStatus('submitting');
    setError(null);
    try {
      const result = await refreshInsightNow(payload.insight_id);
      setRunId(result.runId);
      resolve(refreshResolutionText(result.created), 'accepted', { run_id: result.runId });
      toast.success(result.created ? 'Insight refresh queued' : 'A refresh is already running');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to refresh the insight';
      setError(message);
      setStatus('idle');
      toast.error('Could not refresh the insight', { description: message });
    }
  };

  const handleDismiss = () => {
    if (status !== 'idle') return;
    resolve('Dismissed — the insight was not refreshed.', 'declined');
  };

  return (
    <ApprovalCardShell
      testId="insight-refresh-card"
      className={className}
      isResolved={isResolved}
      isSubmitting={isSubmitting}
      resolutionText={resolutionText}
      error={error}
      resolvedBgClassName="bg-muted"
      tagIcon={<RefreshCw className="h-3.5 w-3.5" />}
      tagLabel="Suggested · Insight refresh"
      rejectLabel="Not now"
      rejectTestId="insight-refresh-dismiss"
      approveTestId="insight-refresh-accept"
      approveLabel="Refresh this insight now"
      submittingLabel="Queuing refresh…"
      onReject={handleDismiss}
      onApprove={handleAccept}
    >
      <h3 className="text-base font-semibold text-foreground mb-1.5">
        Refresh this insight now
      </h3>
      <div
        data-testid="insight-refresh-reason"
        className="rounded-xl border border-border bg-card p-3 mb-4 text-sm text-foreground"
      >
        {payload.reason}
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        The refresh re-fetches the insight&apos;s documented sources and publishes a
        new version when it finishes; the current version stays in history.{' '}
        <WorkspaceLink
          href={`/insight/${payload.insight_id}`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Open the insight
        </WorkspaceLink>
        {runId && (
          <>
            {' · '}
            <WorkspaceLink
              href={`/ai-workforce/tasks/${runId}`}
              data-testid="insight-refresh-task-link"
              className="underline underline-offset-2 hover:text-foreground"
            >
              View task
            </WorkspaceLink>
          </>
        )}
      </p>
    </ApprovalCardShell>
  );
}
