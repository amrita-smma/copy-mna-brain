'use client';

import { FileCode2 } from 'lucide-react';
import { toast } from 'sonner';

import { createInsightFromDocument } from '@/lib/api/insights';
import { useWorkspacePush } from '@/hooks/useWorkspaceHref';
import { useChatContext } from '@/components/chat/ChatProvider';
import type { InsightCreateApprovalPayload } from '@/lib/insights/types';
import { InsightFrame } from '@/components/insights/InsightFrame';
import {
  ApprovalCardShell,
  useApprovalResolution,
} from './ApprovalCardShell';

export interface InsightCreateApprovalCardProps {
  payload: InsightCreateApprovalPayload;
  className?: string;
}

export function InsightCreateApprovalCard({
  payload,
  className,
}: InsightCreateApprovalCardProps) {
  const push = useWorkspacePush();
  // The thread this card belongs to; the server stamps the new insight's v1
  // with that thread's agent.
  const { chatId } = useChatContext();
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
    payload.approval_id ? `insight_create_resolved_${payload.approval_id}` : null,
  );

  const handleApprove = async () => {
    if (status !== 'idle') return;
    setStatus('submitting');
    setError(null);

    try {
      const detail = await createInsightFromDocument({
        name: payload.name,
        description: payload.description,
        html: payload.html,
        kind: payload.kind,
        template_id: payload.template_id ?? null,
        chat_id: chatId,
      });

      const text = `Created "${payload.name}".`;
      resolve(text);
      toast.success(`Insight "${payload.name}" created`);

      push(`/insight/${detail.id}`);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to create insight';
      setError(message);
      setStatus('idle');
      toast.error('Failed to create insight', { description: message });
    }
  };

  const handleReject = () => {
    if (status !== 'idle') return;
    resolve('Rejected — insight not created.');
  };

  return (
    <ApprovalCardShell
      testId="insight-create-approval-card"
      className={className}
      isResolved={isResolved}
      isSubmitting={isSubmitting}
      resolutionText={resolutionText}
      error={error}
      tagIcon={<FileCode2 className="h-3.5 w-3.5" />}
      tagLabel="Approval needed · New Insight"
      rejectTestId="insight-create-reject-button"
      approveTestId="insight-create-approve-button"
      approveLabel="Create insight"
      submittingLabel="Creating…"
      onReject={handleReject}
      onApprove={handleApprove}
    >
      <h3 className="text-base font-semibold text-foreground mb-1.5">
        {payload.name}
      </h3>
      {payload.description && (
        <p className="text-sm text-muted-foreground leading-relaxed mb-3">
          {payload.description}
        </p>
      )}

      {/* Document Preview rendered via InsightFrame */}
      <div className="rounded-xl border border-border bg-card p-3 mb-4 space-y-2">
        <p className="text-xs font-medium text-foreground">
          A new self-contained HTML insight document will be created.
        </p>
        <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-lg border border-border bg-card p-1 min-w-0">
          <InsightFrame
            html={payload.html}
            title={payload.name}
            minHeight={250}
            maxHeight={500}
          />
        </div>
      </div>
    </ApprovalCardShell>
  );
}
