'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CalendarClock,
  Loader2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { apiRoutineToUi, type ApiRoutine } from '@/views/AIWorkforce/routineApi';
import { NewRoutineModal } from '@/views/AIWorkforce/NewRoutineModal';

export interface InsightRefreshScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  insightId: string;
  insightName: string;
  /** The insight's current binding, for naming the agent in a paused notice. */
  agentKey?: string | null;
  /** Opens the insight's Agent dialog — the way to resume a system pause. */
  onOpenAgent?: () => void;
  /** Called after the schedule changes, so the insight face can refresh its marker. */
  onChanged?: () => void;
}

export function InsightRefreshScheduleDialog({
  open,
  onOpenChange,
  insightId,
  insightName,
  agentKey = null,
  onOpenAgent,
  onChanged,
}: InsightRefreshScheduleDialogProps) {
  const [routine, setRoutine] = useState<ApiRoutine | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const fetchRoutine = useCallback(async () => {
    if (!insightId) return;
    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      const res = await fetch(`/api/insights/${insightId}/refresh-routine`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to fetch refresh schedule (HTTP ${res.status})`);
      }
      const json = (await res.json()) as { data: ApiRoutine | null };
      setRoutine(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedule');
    } finally {
      setLoading(false);
    }
  }, [insightId]);

  useEffect(() => {
    if (open) {
      void fetchRoutine();
    }
  }, [open, fetchRoutine]);

  const handleToggle = async () => {
    if (!routine) return;
    setActionError(null);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/routines/${routine.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !routine.enabled }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to update routine (HTTP ${res.status})`);
      }
      await fetchRoutine();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update routine');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRunNow = async () => {
    if (!routine) return;
    setActionError(null);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/routines/${routine.id}/runs`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to trigger routine run (HTTP ${res.status})`);
      }
      await fetchRoutine();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to trigger run');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!routine) return;
    if (!window.confirm('Delete this refresh schedule? This cannot be undone.')) return;
    setActionError(null);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/routines/${routine.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to delete routine (HTTP ${res.status})`);
      }
      await fetchRoutine();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete routine');
    } finally {
      setActionLoading(false);
    }
  };

  const ui = routine ? apiRoutineToUi(routine, { insightAgentKey: agentKey }) : null;
  // A system pause for a broken agent binding (MB-560): the server refuses
  // Resume and Run now until the insight is rebound, so both are disabled.
  const agentPaused = Boolean(ui?.pausedReason);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          data-testid="insight-refresh-schedule-dialog"
          className="max-w-lg p-0 gap-0 overflow-hidden bg-card"
        >
          <DialogHeader className="px-6 pt-6 pb-4 border-b text-left space-y-1">
            <DialogTitle className="text-lg">Refresh schedule</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Automate scheduled updates for {insightName}.
            </DialogDescription>
          </DialogHeader>

          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading schedule…
              </div>
            ) : error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950 p-4 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                <span>{error}</span>
              </div>
            ) : !routine ? (
              <div className="rounded-xl border bg-muted p-6 text-center space-y-3">
                <div className="mx-auto w-10 h-10 rounded-full bg-card grid place-items-center text-muted-foreground border">
                  <CalendarClock className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-foreground">No refresh scheduled</h4>
                  <p className="text-xs text-muted-foreground mt-1">
                    Set up an automated schedule to keep this insight up to date with new data.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  data-testid="insight-refresh-setup-button"
                  onClick={() => {
                    setIsEditing(false);
                    setModalOpen(true);
                  }}
                  className="bg-primary text-primary-foreground hover:opacity-90"
                >
                  <CalendarClock className="h-4 w-4 mr-1.5" />
                  Set up schedule
                </Button>
              </div>
            ) : ui ? (
              <div className="rounded-xl border bg-card p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                      Schedule
                    </div>
                    <div className="text-sm font-semibold text-foreground">
                      {ui.scheduleDetailed}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-xs font-semibold px-2 py-0.5',
                      routine.enabled
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'border-border bg-muted text-muted-foreground',
                    )}
                  >
                    {routine.enabled ? 'Active' : 'Paused'}
                  </Badge>
                </div>

                {ui.pausedNotice && (
                  <div
                    data-testid="insight-schedule-paused-reason"
                    className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 p-3 text-xs text-amber-800 dark:text-amber-200 space-y-2"
                  >
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{ui.pausedNotice}</span>
                    </div>
                    {onOpenAgent && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="insight-schedule-paused-rebind"
                        onClick={onOpenAgent}
                        className="h-7 bg-card hover:bg-muted"
                      >
                        <Bot className="h-3.5 w-3.5 mr-1" />
                        Change agent…
                      </Button>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 text-xs border-t pt-3">
                  <div>
                    <span className="text-muted-foreground">Next run: </span>
                    <span className="font-semibold text-foreground">{ui.nextRun}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Last run: </span>
                    <span className="font-semibold text-foreground">
                      {routine.last_fired_at
                        ? `${formatDistanceToNow(new Date(routine.last_fired_at))} ago`
                        : 'Never'}
                    </span>
                  </div>
                </div>

                {actionError && (
                  <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950 p-2.5 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                    <span>{actionError}</span>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="insight-refresh-edit-button"
                    onClick={() => {
                      setIsEditing(true);
                      setModalOpen(true);
                    }}
                    disabled={actionLoading}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="insight-refresh-toggle-button"
                    onClick={handleToggle}
                    disabled={actionLoading || agentPaused}
                  >
                    {routine.enabled ? (
                      <>
                        <Pause className="h-3.5 w-3.5 mr-1" />
                        Pause
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5 mr-1" />
                        Resume
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="insight-refresh-run-now-button"
                    onClick={handleRunNow}
                    disabled={actionLoading || agentPaused}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    Run now
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="insight-refresh-delete-button"
                    onClick={handleDelete}
                    disabled={actionLoading}
                    className="ml-auto text-destructive hover:text-destructive hover:bg-muted"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground pt-1">
                  Also visible under AI Workforce → Routines.
                </p>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <NewRoutineModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreated={() => {
          void fetchRoutine();
          onChanged?.();
        }}
        routine={isEditing ? (routine ?? undefined) : undefined}
        insight={{ id: insightId, name: insightName }}
      />
    </>
  );
}
