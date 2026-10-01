'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  getInsight,
  listInsightFailedRefreshRuns,
  rollbackInsight,
} from '@/lib/api/insights';
import type {
  InsightDetail,
  InsightFailedRefreshRun,
  InsightVersionSummary,
} from '@/lib/insights/types';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { formatInsightDate } from '@/lib/insights/format';
import { describeInsightAgent } from '@/lib/insights/agentLabel';
import { InsightFrame } from './InsightFrame';
import {
  Loader2,
  History,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Eye,
  ExternalLink,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

/**
 * One row of the history: a version, or a refresh run that failed and so
 * wrote no version. Both are listed so every refresh run is visible here.
 */
type HistoryEntry =
  | { kind: 'version'; at: string; version: InsightVersionSummary }
  | { kind: 'failed_run'; at: string; run: InsightFailedRefreshRun };

function runHref(runId: string): string {
  return `/ai-workforce/tasks/${runId}`;
}

interface InsightHistoryDialogProps {
  insightId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentVersionNo?: number;
  onVersionChanged?: (detail: InsightDetail) => void;
}

export function InsightHistoryDialog({
  insightId,
  open,
  onOpenChange,
  currentVersionNo,
  onVersionChanged,
}: InsightHistoryDialogProps) {
  const [versions, setVersions] = useState<InsightVersionSummary[]>([]);
  const [failedRuns, setFailedRuns] = useState<InsightFailedRefreshRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rollback prompt state
  const [rollbackTarget, setRollbackTarget] = useState<InsightVersionSummary | null>(null);
  const [rollbackSubmitting, setRollbackSubmitting] = useState(false);

  // Preview state
  const [previewVersion, setPreviewVersion] = useState<{ versionNo: number; html: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!open || !insightId) return;

    let mounted = true;
    setLoading(true);
    setError(null);
    setRollbackTarget(null);
    setPreviewVersion(null);

    Promise.all([
      getInsight(insightId),
      // Failed runs are supplementary: if they can't load, the versions still show.
      listInsightFailedRefreshRuns(insightId).catch((err: unknown) => {
        console.error('Failed to load failed refresh runs', err);
        return [] as InsightFailedRefreshRun[];
      }),
    ])
      .then(([detail, runs]) => {
        if (mounted) {
          setVersions(detail.versions ?? []);
          setFailedRuns(runs);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load version history');
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [open, insightId]);

  // Newest first, versions and failed runs interleaved by time. A failed run
  // is placed at when it ended (falling back to when it was queued).
  const entries = useMemo<HistoryEntry[]>(() => {
    const all: HistoryEntry[] = [
      ...versions.map((version) => ({
        kind: 'version' as const,
        at: version.created_at,
        version,
      })),
      ...failedRuns.map((run) => ({
        kind: 'failed_run' as const,
        at: run.ended_at ?? run.created_at,
        run,
      })),
    ];
    return all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [versions, failedRuns]);

  const handleStartRollback = (version: InsightVersionSummary) => {
    setRollbackTarget(version);
    setPreviewVersion(null);
  };

  const handleConfirmRollback = async () => {
    if (!rollbackTarget) return;

    setRollbackSubmitting(true);
    try {
      const newDetail = await rollbackInsight(insightId, {
        toVersionNo: rollbackTarget.version_no,
      });

      toast.success(
        `Rolled back to version ${rollbackTarget.version_no} (now version ${newDetail.version_no})`,
      );

      setRollbackTarget(null);
      onVersionChanged?.(newDetail);
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('Failed to rollback insight', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to rollback insight',
      );
    } finally {
      setRollbackSubmitting(false);
    }
  };

  const handlePreviewVersion = async (versionNo: number) => {
    setPreviewLoading(true);
    try {
      const detail = await getInsight(insightId, versionNo);
      setPreviewVersion({ versionNo, html: detail.html });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load version preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const formatTrigger = (trigger: string) => {
    switch (trigger) {
      case 'routine':
        return 'Scheduled refresh';
      case 'workforce':
        return 'Workforce';
      case 'copilot_create':
        return 'Initial creation';
      case 'upload':
        return 'Uploaded file';
      case 'copilot_edit':
        return 'CoPilot edit';
      case 'rollback':
        return 'Rollback';
      case 'duplicate':
        return 'Duplicated';
      default:
        return trigger;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-rollback would fire onVersionChanged on a closed dialog.
        if (!next && rollbackSubmitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="bg-card text-card-foreground border border-border sm:max-w-2xl max-h-[85vh] flex flex-col p-6 shadow-lg"
        onPointerDownOutside={(e) => {
          if (rollbackSubmitting) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (rollbackSubmitting) e.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            <DialogTitle className="text-xl font-semibold">Version History</DialogTitle>
          </div>
          <DialogDescription className="text-muted-foreground">
            Review past revisions of this insight or roll back to a prior snapshot.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <span className="ml-2 text-sm text-muted-foreground">Loading versions...</span>
          </div>
        ) : error ? (
          <div className="p-4 my-4 rounded-lg border border-destructive bg-card text-destructive flex items-center gap-3">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        ) : rollbackTarget ? (
          /* Rollback Confirmation View */
          <div className="flex flex-col gap-5 py-4">
            <div className="p-4 rounded-lg bg-muted border border-border text-foreground space-y-2">
              <h4 className="font-semibold text-sm">
                Roll back to Version {rollbackTarget.version_no}
              </h4>
              <p className="text-xs text-muted-foreground">
                Originally created on {formatInsightDate(rollbackTarget.created_at)} via{' '}
                {formatTrigger(rollbackTarget.trigger)}.
              </p>
              <p className="text-xs text-muted-foreground">
                Rolling back appends a new version carrying the HTML from Version{' '}
                {rollbackTarget.version_no}. Historical versions are never deleted.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRollbackTarget(null)}
                disabled={rollbackSubmitting}
                className="bg-card text-foreground border-border hover:bg-muted"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleConfirmRollback}
                disabled={rollbackSubmitting}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {rollbackSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Rolling back...
                  </>
                ) : (
                  <>
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Apply Rollback
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : previewVersion ? (
          /* Version Preview View */
          <div className="flex flex-col gap-4 py-2 flex-1 min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">
                Previewing Version {previewVersion.versionNo}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPreviewVersion(null)}
                className="bg-card text-foreground border-border hover:bg-muted text-xs"
              >
                Back to versions
              </Button>
            </div>
            <div className="flex-1 overflow-auto border border-border rounded-lg bg-card min-h-[300px]">
              <InsightFrame
                html={previewVersion.html}
                title={`Preview Version ${previewVersion.versionNo}`}
                minHeight={300}
              />
            </div>
          </div>
        ) : (
          /* Version List View */
          <div className="flex-1 overflow-y-auto space-y-3 py-2 pr-1">
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No versions recorded yet.
              </p>
            ) : (
              entries.map((entry) => {
                if (entry.kind === 'failed_run') {
                  const run = entry.run;
                  return (
                    <div
                      key={`run-${run.run_id}`}
                      data-testid="insight-history-failed-run"
                      className="p-4 rounded-lg border border-destructive/60 bg-card"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1 font-semibold text-sm text-destructive">
                              <XCircle className="h-3.5 w-3.5" />
                              Refresh failed
                            </span>
                            <Badge variant="secondary" className="bg-muted text-foreground text-xs">
                              {formatTrigger('routine')}
                            </Badge>
                          </div>
                          <p className="text-xs text-foreground break-words">{run.reason}</p>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                            <span>
                              {run.ended_at ? 'Ended' : 'Queued'} {formatInsightDate(entry.at)}
                            </span>
                            <span>The current version was left unchanged.</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            asChild
                            variant="outline"
                            size="sm"
                            className="bg-card hover:bg-muted text-foreground border-border text-xs"
                          >
                            <WorkspaceLink href={runHref(run.run_id)}>
                              <ExternalLink className="h-3.5 w-3.5 mr-1" />
                              Open run
                            </WorkspaceLink>
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                }

                const ver = entry.version;
                const isCurrent = ver.version_no === currentVersionNo;
                return (
                  <div
                    key={ver.id}
                    className={`p-4 rounded-lg border transition-colors ${
                      isCurrent
                        ? 'bg-card border-primary/60'
                        : 'bg-card border-border hover:bg-muted'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1.5 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-foreground">
                            v{ver.version_no}
                          </span>
                          {isCurrent && (
                            <Badge
                              variant="outline"
                              className="bg-card text-primary border-primary text-xs"
                            >
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Current
                            </Badge>
                          )}
                          <Badge variant="secondary" className="bg-muted text-foreground text-xs">
                            {formatTrigger(ver.trigger)}
                          </Badge>
                          {ver.is_unchanged && (
                            <Badge
                              variant="outline"
                              data-testid="insight-history-no-changes"
                              className="bg-muted text-muted-foreground border-border text-xs"
                            >
                              No changes
                            </Badge>
                          )}
                          {ver.agent_key && (
                            <Badge
                              variant="outline"
                              data-testid="insight-history-agent"
                              title={describeInsightAgent(ver.agent_key)?.sector ?? undefined}
                              className="bg-muted text-muted-foreground border-border text-xs font-mono"
                            >
                              {describeInsightAgent(ver.agent_key)?.handle}
                            </Badge>
                          )}
                        </div>

                        {ver.label && (
                          <p className="text-xs font-medium text-foreground">{ver.label}</p>
                        )}

                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          <span>Created {formatInsightDate(ver.created_at)}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {ver.source_run_id && (
                          <Button
                            asChild
                            variant="outline"
                            size="sm"
                            className="bg-card hover:bg-muted text-foreground border-border text-xs"
                          >
                            <WorkspaceLink href={runHref(ver.source_run_id)}>
                              <ExternalLink className="h-3.5 w-3.5 mr-1" />
                              Open run
                            </WorkspaceLink>
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={previewLoading}
                          onClick={() => handlePreviewVersion(ver.version_no)}
                          className="bg-card hover:bg-muted text-foreground border-border text-xs"
                        >
                          <Eye className="h-3.5 w-3.5 mr-1" />
                          View
                        </Button>
                        {!isCurrent && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleStartRollback(ver)}
                            className="bg-card hover:bg-muted text-foreground border-border text-xs"
                          >
                            <RotateCcw className="h-3.5 w-3.5 mr-1" />
                            Rollback
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
