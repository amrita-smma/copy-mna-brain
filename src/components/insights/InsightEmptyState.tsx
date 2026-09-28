'use client';

import type { ComponentType } from 'react';
import { Button } from '@/components/ui/button';
import { FileCode2, Plus } from 'lucide-react';

export interface InsightEmptyStateProps {
  onNewInsight: () => void;
  title?: string;
  body?: string;
  actionLabel?: string;
  icon?: ComponentType<{ className?: string }>;
  actionIcon?: ComponentType<{ className?: string }>;
}

export function InsightEmptyState({
  onNewInsight,
  title = 'No Insights Yet',
  body = 'Insights are self-contained, interactive HTML documents — reports, briefs and one-off analyses — authored end-to-end by the CoPilot.',
  actionLabel = 'New insight',
  icon: Icon = FileCode2,
  actionIcon: ActionIcon = Plus,
}: InsightEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center p-12 my-12 mx-auto max-w-lg text-center rounded-2xl border border-border bg-card shadow-sm">
      <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center mb-4 text-primary">
        <Icon className="h-7 w-7" />
      </div>
      <h2 className="text-lg font-semibold text-foreground mb-2">
        {title}
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mb-6">
        {body}
      </p>
      <Button
        type="button"
        onClick={onNewInsight}
        className="gap-2"
      >
        <ActionIcon className="h-4 w-4" />
        {actionLabel}
      </Button>
    </div>
  );
}
