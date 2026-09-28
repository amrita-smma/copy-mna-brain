'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Bot, Check, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fetchSectorAgents, type SectorAgentEntry } from '@/lib/api/agents';
import { setInsightAgentBinding } from '@/lib/api/insights';
import { describeInsightAgent } from '@/lib/insights/agentLabel';
import type { InsightSummary } from '@/lib/insights/types';
import { cn } from '@/lib/utils';

export interface InsightAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  insightId: string;
  insightName: string;
  /** The insight's saved binding; null = general CoPilot. */
  currentAgentKey: string | null;
  onSaved?: (summary: InsightSummary) => void;
}

interface OptionCardProps {
  selected: boolean;
  onSelect: () => void;
  testId: string;
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  description: ReactNode;
}

function OptionCard({
  selected,
  onSelect,
  testId,
  icon,
  title,
  subtitle,
  description,
}: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        'w-full text-left rounded-lg border p-3 flex items-start gap-3 transition-colors',
        selected
          ? 'bg-muted border-primary ring-1 ring-primary'
          : 'bg-card border-border hover:bg-muted',
      )}
    >
      <div className="mt-0.5 h-8 w-8 shrink-0 rounded-md border border-border bg-card grid place-items-center text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap text-sm font-semibold text-foreground">
          {title}
        </div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        <p className="text-xs text-foreground leading-relaxed">{description}</p>
      </div>
      <div
        className={cn(
          'mt-1 h-4 w-4 shrink-0 rounded-full border grid place-items-center',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card',
        )}
      >
        {selected && <Check className="h-3 w-3" />}
      </div>
    </button>
  );
}

/**
 * The insight's sector agent binding (MB-546). Read-only toward the agents
 * themselves (MB-540): it lists the registry and picks one, nothing more.
 */
export function InsightAgentDialog({
  open,
  onOpenChange,
  insightId,
  insightName,
  currentAgentKey,
  onSaved,
}: InsightAgentDialogProps) {
  const [agents, setAgents] = useState<SectorAgentEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(currentAgentKey);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    setSelected(currentAgentKey);
    setLoading(true);
    setError(null);
    fetchSectorAgents()
      .then((list) => {
        if (mounted) setAgents(list);
      })
      .catch((err: unknown) => {
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load agents');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [open, currentAgentKey]);

  // `/api/agents` lists only bindable agents. A saved binding to an agent that
  // has since been deprecated is shown too, so the user sees what the insight
  // is on now — but only while it is the saved binding: once saved away, the
  // next open no longer offers it.
  const current = describeInsightAgent(currentAgentKey);
  const showCurrentDeprecated =
    current !== null && !agents.some((a) => a.key === current.key);

  const handleSave = async () => {
    if (saving || selected === currentAgentKey) return;
    setSaving(true);
    try {
      const summary = await setInsightAgentBinding(insightId, selected);
      const label = describeInsightAgent(summary.agent_key);
      toast.success(
        label ? `Bound to ${label.handle}` : 'Switched to the general CoPilot',
      );
      onSaved?.(summary);
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('Failed to update agent binding', err);
      toast.error(err instanceof Error ? err.message : 'Failed to update agent binding');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="insight-agent-dialog"
        className="max-w-lg p-0 gap-0 overflow-hidden bg-card max-h-[85vh] flex flex-col"
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border text-left space-y-1">
          <DialogTitle className="text-lg">Sector agent</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Choose which agent works on {insightName}.
          </DialogDescription>
        </DialogHeader>

        <div className="p-6 space-y-4 overflow-y-auto">
          <p className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground leading-relaxed">
            A change applies from the next CoPilot session or scheduled refresh. Past
            versions keep the agent that produced them.
          </p>

          {loading ? (
            <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading agents…
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive bg-card p-4 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          ) : (
            <div role="radiogroup" aria-label="Sector agent" className="space-y-2">
              <OptionCard
                selected={selected === null}
                onSelect={() => setSelected(null)}
                testId="insight-agent-option-general"
                icon={<Sparkles className="h-4 w-4" />}
                title="General CoPilot (no sector agent)"
                description="The general CoPilot, with no sector sources, metrics or guardrails."
              />

              {showCurrentDeprecated && current && (
                <OptionCard
                  selected={selected === current.key}
                  onSelect={() => setSelected(current.key)}
                  testId={`insight-agent-option-${current.key}`}
                  icon={<Bot className="h-4 w-4" />}
                  title={
                    <>
                      <span className="font-mono">{current.handle}</span>
                      {current.name && <span>{current.name}</span>}
                      <Badge
                        variant="outline"
                        data-testid="insight-agent-option-deprecated"
                        className="bg-card text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-800 text-[10px]"
                      >
                        Deprecated
                      </Badge>
                    </>
                  }
                  subtitle={current.sector}
                  description={
                    current.successorHandle
                      ? `Current binding. This agent is no longer offered; ${current.successorHandle} replaces it.`
                      : 'Current binding. This agent is no longer offered for new bindings.'
                  }
                />
              )}

              {agents.map((agent) => (
                <OptionCard
                  key={agent.key}
                  selected={selected === agent.key}
                  onSelect={() => setSelected(agent.key)}
                  testId={`insight-agent-option-${agent.key}`}
                  icon={<Bot className="h-4 w-4" />}
                  title={
                    <>
                      <span className="font-mono">{agent.handle}</span>
                      <span>{agent.name}</span>
                    </>
                  }
                  subtitle={agent.sector}
                  description={agent.description}
                />
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border bg-card">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="bg-card text-foreground border-border hover:bg-muted"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || loading || selected === currentAgentKey}
            data-testid="insight-agent-save"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
