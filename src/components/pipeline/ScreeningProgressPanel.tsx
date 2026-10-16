'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  ArrowRight,
  HelpCircle,
  Bot,
} from 'lucide-react';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import type { ScreeningTaskStatus } from '@/lib/services/aiScreeningService';
import { isActiveAiScreeningTask } from '@/lib/screening/runningIndicator';
import PromoteDialog from '@/components/pipeline/PromoteDialog';
import { usePipelineStages } from '@/hooks/usePipelineStages';
import { FIRST_STAGE_KEY } from '@/lib/pipeline/stages';
import { DealStage } from '@/lib/types';
import { UNREVIEWED_STAGE, promoteTargetForStage } from '@/lib/constants';
import { getScreenings } from '@/lib/api/pipeline';
import { screeningVerdict, type ScreeningVerdict } from '@/lib/screening/verdict';

interface Screening {
  id: string;
  company_id: string;
  criteria_id: string;
  track_id: string | null;
  state: 'pending' | 'completed' | 'failed';
  result: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
  company?: {
    target: string | null;
    project_name: string | null;
    pipeline_stage: string;
  };
  criterias?: {
    name: string;
  };
  track?: {
    id: string;
    title: string | null;
  } | null;
}

interface CompanyScreeningSummary {
  /** Stable per-(company, track) group key. */
  key: string;
  company_id: string;
  company_name: string;
  /** `unreviewed` (Pending Confirmation) or `L0`. */
  pipeline_stage: string;
  track_name: string | null;
  total_criteria: number;
  completed_criteria: number;
  passed_criteria: number;
  failed_criteria: number;
  inconclusive_criteria: number;
  pending_criteria: number;
  all_passed: boolean;
  screenings: Screening[];
}

type TaskStatus = ScreeningTaskStatus['status'];

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Queued',
  resume_ready: 'Queued',
  running: 'Running',
  waiting_for_human_input: 'Needs input',
  waiting_for_subagent: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  rejected: 'Rejected',
  timed_out: 'Timed out',
};

const TASK_TONE: Partial<Record<TaskStatus, string>> = {
  running: 'border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300',
  waiting_for_subagent: 'border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300',
  waiting_for_human_input: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300',
  failed: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300',
  rejected: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300',
  timed_out: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300',
};

/**
 * The company's AI Workforce screening task: its status and a link to the
 * task. Stops the click so opening the task doesn't also open the company.
 */
function TaskLink({ task }: { task: ScreeningTaskStatus | undefined }) {
  if (!task) return null;
  return (
    <WorkspaceLink
      href={`/ai-workforce/tasks/${task.runId}`}
      data-testid={`screening-task-link-${task.companyId}`}
      onClick={(e) => e.stopPropagation()}
      title="Open this screening's task in AI Workforce"
      className={`inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs font-medium hover:underline ${
        TASK_TONE[task.status] ?? 'text-muted-foreground'
      }`}
    >
      {task.status === 'running' ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Bot className="h-3 w-3" />
      )}
      {TASK_STATUS_LABEL[task.status]} · View task
    </WorkspaceLink>
  );
}

/** Opens the company dialog; kept separate from links/buttons in the row (no nested interactives). */
function OpenCompanyHitTarget({
  onOpen,
  className,
  children,
}: {
  onOpen: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={className}
    >
      {children}
    </div>
  );
}

interface ScreeningProgressPanelProps {
  refreshTrigger?: number;
  onScreeningComplete?: () => void;
  onCompanyClick?: (companyId: string) => void;
  /**
   * Each company's newest AI Workforce screening task, live from the parent's
   * `/api/ai-screening/tasks/stream` subscription (Pipeline already holds one
   * for its row spinners, so the panel doesn't open a second).
   */
  tasks?: ScreeningTaskStatus[];
}

export default function ScreeningProgressPanel({
  refreshTrigger = 0,
  onScreeningComplete,
  onCompanyClick,
  tasks = [],
}: ScreeningProgressPanelProps) {
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const taskByCompany = new Map(tasks.map((t) => [t.companyId, t]));
  const [loading, setLoading] = useState(true);
  const [completedPage, setCompletedPage] = useState(0);
  const [promoteDialogOpen, setPromoteDialogOpen] = useState(false);
  const [promotingCompany, setPromotingCompany] = useState<{
    id: string;
    name: string;
    stage: DealStage;
    nextStage: DealStage;
  } | null>(null);
  // A Pending Confirmation company promotes to L0. A passed L0 deal promotes
  // into whichever stage follows L0 (L1 by default); a workspace with nothing
  // after L0 gets no promote button for L0 rows rather than a failing one.
  // Nothing is offered for L0 until the stages load: the built-in fallback
  // would name L1 even where another stage follows L0.
  const { liveKeys, code: stageCode, loading: stagesLoading } = usePipelineStages();
  const promoteTargetFor = (stage: string): DealStage | null => {
    if (stage === UNREVIEWED_STAGE) {
      return stagesLoading
        ? FIRST_STAGE_KEY
        : promoteTargetForStage(UNREVIEWED_STAGE, liveKeys);
    }
    if (stagesLoading) return null;
    return promoteTargetForStage(stage, liveKeys);
  };
  const stageLabel = (stage: string) =>
    stage === UNREVIEWED_STAGE ? 'Pending Confirmation' : stageCode(stage);
  const ITEMS_PER_PAGE = 5;

  const fetchScreenings = async () => {
    try {
      const data = await getScreenings({ inScreening: true });
      setScreenings(data);
    } catch (error) {
      console.error('Error fetching screenings:', error);
    } finally {
      setLoading(false);
    }
  };

  // Refetch on mount and whenever the parent bumps `refreshTrigger`, which it
  // does from the `/api/screenings/stream` SSE subscription. That stream is the
  // live-update mechanism; this panel used to run its own unconditional 5s poll
  // alongside it.
  useEffect(() => {
    fetchScreenings();
  }, [refreshTrigger]);

  // Group screenings by (company, track): a company matched to N tracks shows N
  // entries, one per track, each with its own criteria progress.
  const groupByCompany = (screenings: Screening[]): CompanyScreeningSummary[] => {
    const grouped = new Map<string, CompanyScreeningSummary>();

    screenings.forEach((s) => {
      const companyId = s.company_id;
      const target = s.company?.target?.trim() || '';
      const projectName = s.company?.project_name?.trim() || '';
      const companyName =
        target && projectName
          ? `${target} — ${projectName}`
          : target || projectName || 'Unknown';
      const key = `${companyId}::${s.track_id ?? 'none'}`;

      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          company_id: companyId,
          company_name: companyName,
          pipeline_stage: s.company?.pipeline_stage ?? FIRST_STAGE_KEY,
          track_name: s.track?.title?.trim() || null,
          total_criteria: 0,
          completed_criteria: 0,
          passed_criteria: 0,
          failed_criteria: 0,
          inconclusive_criteria: 0,
          pending_criteria: 0,
          all_passed: false,
          screenings: [],
        });
      }

      const summary = grouped.get(key)!;
      summary.screenings.push(s);
      summary.total_criteria++;

      if (s.state === 'completed') {
        summary.completed_criteria++;
        if (s.result === 'pass') {
          summary.passed_criteria++;
        } else if (s.result === 'fail' || s.result === 'error') {
          summary.failed_criteria++;
        } else if (s.result === 'inconclusive') {
          summary.inconclusive_criteria++;
        }
      } else if (s.state === 'pending') {
        summary.pending_criteria++;
      } else if (s.state === 'failed') {
        summary.completed_criteria++;
        summary.failed_criteria++;
      }
    });

    grouped.forEach((summary) => {
      summary.all_passed = getOverallStatus(summary) === 'pass';
    });

    return Array.from(grouped.values());
  };

  // The verdict rule is shared with the server's Pending Confirmation
  // auto drop/promote pass (src/lib/screening/verdict.ts).
  const getOverallStatus = (summary: CompanyScreeningSummary): ScreeningVerdict =>
    screeningVerdict({
      passed: summary.passed_criteria,
      failed: summary.failed_criteria,
    });

  const handlePromoteClick = (summary: CompanyScreeningSummary) => {
    const nextStage = promoteTargetFor(summary.pipeline_stage);
    if (!nextStage) return;
    setPromotingCompany({
      id: summary.company_id,
      name: summary.company_name,
      stage: summary.pipeline_stage as DealStage,
      nextStage,
    });
    setPromoteDialogOpen(true);
  };

  const companySummaries = groupByCompany(screenings);
  // Queued or running tasks for companies with no screening rows yet (an
  // Auto-scan arrival: its rows appear once the task starts screening).
  const screenedCompanyIds = new Set(companySummaries.map((cs) => cs.company_id));
  const queuedOnly = tasks.filter(
    (t) => isActiveAiScreeningTask(t.status) && !screenedCompanyIds.has(t.companyId),
  );

  // Separate in-progress and completed
  const inProgress = companySummaries.filter(
    (cs) => cs.pending_criteria > 0 || cs.completed_criteria < cs.total_criteria
  );
  const completed = companySummaries.filter(
    (cs) => cs.pending_criteria === 0 && cs.completed_criteria === cs.total_criteria
  );

  // Pagination for completed
  const totalCompletedPages = Math.ceil(completed.length / ITEMS_PER_PAGE);
  const paginatedCompleted = completed.slice(
    completedPage * ITEMS_PER_PAGE,
    (completedPage + 1) * ITEMS_PER_PAGE
  );

  // Passed (min 3 pass AND max 1 fail) and promotable from their stage.
  const passedCount = completed.filter(
    (c) =>
      getOverallStatus(c) === 'pass' && promoteTargetFor(c.pipeline_stage) !== null,
  ).length;

  const handlePromoteSuccess = async () => {
    if (!promotingCompany) return;

    // We no longer delete screening data, just refresh the list. A company
    // promoted out of L0 leaves the list; one promoted from Pending
    // Confirmation stays, now as L0.
    toast.success(`${promotingCompany.name} promoted to ${stageCode(promotingCompany.nextStage)}`);

    setPromotingCompany(null);
    onScreeningComplete?.();
    fetchScreenings();
  };

  const header = (
    <CardHeader className="pb-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-blue-600" />
          <div>
            <CardTitle className="text-lg">AI Screening Progress</CardTitle>
            <CardDescription>
              Real-time status of company screenings
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {passedCount > 0 && (
            <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
              {passedCount} ready to promote
            </Badge>
          )}
        </div>
      </div>
    </CardHeader>
  );

  // The panel is the whole of the Pipeline page's AI Screening tab, so it
  // shows its loading and empty states rather than rendering nothing.
  if (screenings.length === 0 && queuedOnly.length === 0) {
    return (
      <Card className="shadow-md" data-testid="screening-progress-panel">
        {header}
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <p
              data-testid="screening-progress-empty"
              className="py-12 text-center text-sm text-muted-foreground"
            >
              No AI screenings for Pending Confirmation or L0 deals yet. Use Scan now
              on Pending Confirmation, or Run AI Screening from a pending company&apos;s
              actions.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-md" data-testid="screening-progress-panel">
      {header}
      <CardContent className="space-y-4">
        {/* Queued in AI Workforce, nothing screened yet */}
        {queuedOnly.length > 0 && (
          <div className="space-y-2" data-testid="screening-queued-section">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              Queued in AI Workforce ({queuedOnly.length})
            </h4>
            <div className="grid gap-2">
              {queuedOnly.map((task) => (
                <div
                  key={task.runId}
                  className="flex items-center justify-between p-3 rounded-lg border bg-muted hover:border-primary/40"
                >
                  <OpenCompanyHitTarget
                    onOpen={() => onCompanyClick?.(task.companyId)}
                    className="min-w-0 flex-1 cursor-pointer"
                  >
                    <span className="font-medium">{task.companyName}</span>
                    <Badge
                      variant="outline"
                      className="ml-2 font-normal text-[10px] px-1.5 py-0 align-middle"
                    >
                      {stageLabel(task.pipelineStage ?? FIRST_STAGE_KEY)}
                    </Badge>
                    <div className="text-xs text-muted-foreground">
                      Waiting for its AI Workforce task to start screening
                    </div>
                  </OpenCompanyHitTarget>
                  <TaskLink task={task} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* In Progress Section */}
        {inProgress.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-yellow-600" />
              In Progress ({inProgress.length})
            </h4>
            <div className="grid gap-2">
              {inProgress.map((summary) => (
                <div
                  key={summary.key}
                  className="flex items-center justify-between p-3 rounded-lg border bg-yellow-50 border-yellow-200 hover:border-yellow-400 dark:bg-yellow-950/20 dark:border-yellow-900/50"
                >
                  <OpenCompanyHitTarget
                    onOpen={() => onCompanyClick?.(summary.company_id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                  >
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-yellow-600" />
                    <div>
                      <span className="font-medium hover:text-primary transition-colors">
                        {summary.company_name}
                      </span>
                      <Badge
                        variant="outline"
                        data-testid="screening-stage-badge"
                        className="ml-2 font-normal text-[10px] px-1.5 py-0 align-middle"
                      >
                        {stageLabel(summary.pipeline_stage)}
                      </Badge>
                      {summary.track_name && (
                        <Badge
                          variant="secondary"
                          className="ml-2 font-normal text-[10px] px-1.5 py-0 align-middle"
                        >
                          {summary.track_name}
                        </Badge>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {summary.completed_criteria} / {summary.total_criteria} criteria evaluated
                      </div>
                    </div>
                  </OpenCompanyHitTarget>
                  <div className="flex shrink-0 items-center gap-2">
                    <TaskLink task={taskByCompany.get(summary.company_id)} />
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <span className="text-green-600 dark:text-green-400">{summary.passed_criteria}✓</span>
                      <span className="text-red-600 dark:text-red-400">{summary.failed_criteria}✗</span>
                      {summary.inconclusive_criteria > 0 && (
                        <span className="text-amber-600 flex items-center">
                          {summary.inconclusive_criteria}<HelpCircle className="h-3 w-3 ml-0.5" />
                        </span>
                      )}
                    </span>
                    <Badge variant="secondary">
                      In Progress
                    </Badge>
                    {promoteTargetFor(summary.pipeline_stage) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-green-600 border-green-300 hover:bg-green-50 hover:text-green-700"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePromoteClick(summary);
                        }}
                      >
                        <ArrowRight className="h-3 w-3 mr-1" />
                        Promote to {stageCode(promoteTargetFor(summary.pipeline_stage)!)}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Completed Section */}
        {completed.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Completed ({completed.length})
            </h4>
            <div className="grid gap-2">
              {paginatedCompleted.map((summary) => {
                const status = getOverallStatus(summary);
                return (
                <div
                  key={summary.key}
                  className={`flex items-center justify-between p-3 rounded-lg border hover:shadow-sm ${status === 'pass'
                    ? 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-900/50'
                    : status === 'fail'
                      ? 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-900/50'
                      : 'bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900/50'
                    }`}
                >
                  <OpenCompanyHitTarget
                    onOpen={() => onCompanyClick?.(summary.company_id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                  >
                    {status === 'pass' ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                    ) : status === 'fail' ? (
                      <XCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    ) : (
                      <HelpCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    )}
                    <div>
                      <span className="font-medium hover:text-primary transition-colors">
                        {summary.company_name}
                      </span>
                      <Badge
                        variant="outline"
                        data-testid="screening-stage-badge"
                        className="ml-2 font-normal text-[10px] px-1.5 py-0 align-middle"
                      >
                        {stageLabel(summary.pipeline_stage)}
                      </Badge>
                      {summary.track_name && (
                        <Badge
                          variant="secondary"
                          className="ml-2 font-normal text-[10px] px-1.5 py-0 align-middle"
                        >
                          {summary.track_name}
                        </Badge>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {summary.total_criteria} criteria evaluated
                      </div>
                    </div>
                  </OpenCompanyHitTarget>
                  <div className="flex shrink-0 items-center gap-2">
                    <TaskLink task={taskByCompany.get(summary.company_id)} />
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <span className="text-green-600 dark:text-green-400">{summary.passed_criteria}✓</span>
                      <span className="text-red-600 dark:text-red-400">{summary.failed_criteria}✗</span>
                      {summary.inconclusive_criteria > 0 && (
                        <span className="text-amber-600 flex items-center">
                          {summary.inconclusive_criteria}<HelpCircle className="h-3 w-3 ml-0.5" />
                        </span>
                      )}
                    </span>
                    {status === 'pass' ? (
                      <Badge variant="default" className="bg-green-600">
                        Passed
                      </Badge>
                    ) : status === 'fail' ? (
                      <Badge variant="destructive">
                        Failed
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700">
                        Inconclusive
                      </Badge>
                    )}
                    {status === 'pass' && promoteTargetFor(summary.pipeline_stage) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-green-600 border-green-300 hover:bg-green-50 hover:text-green-700"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePromoteClick(summary);
                        }}
                      >
                        <ArrowRight className="h-3 w-3 mr-1" />
                        Promote to {stageCode(promoteTargetFor(summary.pipeline_stage)!)}
                      </Button>
                    )}
                  </div>
                </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalCompletedPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCompletedPage((p) => Math.max(0, p - 1))}
                  disabled={completedPage === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {completedPage + 1} of {totalCompletedPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCompletedPage((p) => Math.min(totalCompletedPages - 1, p + 1))}
                  disabled={completedPage >= totalCompletedPages - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>

      {promotingCompany && (
        <PromoteDialog
          open={promoteDialogOpen}
          onOpenChange={setPromoteDialogOpen}
          dealId={promotingCompany.id}
          companyName={promotingCompany.name}
          currentStage={promotingCompany.stage}
          nextStage={promotingCompany.nextStage}
          onSuccess={handlePromoteSuccess}
        />
      )}
    </Card>
  );
}
