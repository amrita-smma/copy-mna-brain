'use client';

import { PageHeader } from '@/components/layout/PageHeader';

import { WorkforceTasks } from './WorkforceTasks';

interface AIWorkforceProps {
  initialTaskId?: string | null;
}

/**
 * AI Workspace — the Workforce task queue.
 *
 * This used to be three tabs (AI CoPilot, Workforce Tasks, File Ingestion).
 * The copilot now lives in the shell's own pane, available on every page, so a
 * second in-page copy was redundant; File Ingestion never shipped past a
 * "coming soon" placeholder. What's left is the queue, rendered immediately
 * rather than behind a one-item tab strip.
 */
export default function AIWorkforce({ initialTaskId = null }: AIWorkforceProps) {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        className="flex-shrink-0"
        title="AI Workspace"
        subtitle="Delegate tasks to the Workforce and follow their progress"
      />

      <WorkforceTasks initialTaskId={initialTaskId} />
    </div>
  );
}
