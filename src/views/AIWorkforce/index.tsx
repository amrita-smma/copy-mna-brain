'use client';

import { Sparkles } from 'lucide-react';

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
      {/* Header */}
      <div className="flex-shrink-0 px-8 pt-8 pb-4 bg-card">
        <div className="flex items-start gap-4">
          <div className="relative">
            <div className="absolute inset-0 rounded-2xl blur-md opacity-50 bg-gradient-to-br from-blue-400 to-blue-500" />
            <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-lg">
              <Sparkles className="h-6 w-6 text-white" />
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">AI Workspace</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Delegate tasks to the Workforce and follow their progress
            </p>
          </div>
        </div>
      </div>

      <WorkforceTasks initialTaskId={initialTaskId} />
    </div>
  );
}
