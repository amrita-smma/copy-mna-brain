'use client';

import { useState, useEffect } from 'react';
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
  Eye,
  EyeOff,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import PromoteDialog from '@/components/pipeline/PromoteDialog';
import { usePipelineStages } from '@/hooks/usePipelineStages';
import { FIRST_STAGE_KEY, screeningTargetKey } from '@/lib/pipeline/stages';
import { DealStage } from '@/lib/types';
import { getScreenings } from '@/lib/api/pipeline';

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

interface ScreeningProgressPanelProps {
  refreshTrigger?: number;
  onScreeningComplete?: () => void;
  onCompanyClick?: (companyId: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function ScreeningProgressPanel({
  refreshTrigger = 0,
  onScreeningComplete,
  onCompanyClick,
  collapsed = false,
  onToggleCollapse,
}: ScreeningProgressPanelProps) {
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [loading, setLoading] = useState(true);
  const [completedPage, setCompletedPage] = useState(0);
  const [promoteDialogOpen, setPromoteDialogOpen] = useState(false);
  const [promotingCompany, setPromotingCompany] = useState<{ id: string; name: string; stage?: string } | null>(null);
  // Screening promotes passed L0 deals into whichever stage follows L0 (L1 by
  // default). A workspace with nothing after L0 gets no promote button here
  // rather than a failing one. Nothing is offered until the stages load: the
  // built-in fallback would name L1 even where another stage follows L0.
  const { liveKeys, code: stageCode, loading: stagesLoading } = usePipelineStages();
  const screeningTarget = stagesLoading ? null : screeningTargetKey(liveKeys);
  const canPromote = screeningTarget !== null;
  const targetLabel = screeningTarget ? stageCode(screeningTarget) : '';
  const ITEMS_PER_PAGE = 5;

  const fetchScreenings = async () => {
    setLoading(true);
    try {
      const data = await getScreenings({ onlyL0: true });
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

    // Calculate all_passed after all screenings are processed
    // Pass: min 3 pass AND max 1 fail
    // Failed: at least 1 fail (and doesn't qualify as Pass)
    // Inconclusive: at least 3 inconclusive (or default fallback)
    grouped.forEach((summary) => {
      summary.all_passed =
        summary.passed_criteria >= 3 && summary.failed_criteria <= 1;
    });

    return Array.from(grouped.values());
  };

  const getOverallStatus = (summary: CompanyScreeningSummary): 'pass' | 'fail' | 'inconclusive' => {
    // Pass: minimum 3 pass AND maximum 1 fail
    if (summary.passed_criteria >= 3 && summary.failed_criteria <= 1) {
      return 'pass';
    }
    // Failed: at least 1 fail (but didn't qualify as pass)
    if (summary.failed_criteria >= 1) {
      return 'fail';
    }
    // Inconclusive: everything else (e.g. 3+ inconclusive, or not enough passes)
    return 'inconclusive';
  };

  const handlePromoteClick = (companyId: string, companyName: string) => {
    setPromotingCompany({ id: companyId, name: companyName, stage: 'L0' });
    setPromoteDialogOpen(true);
  };

  const companySummaries = groupByCompany(screenings);

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

  // Count how many passed (min 3 pass AND max 1 fail)
  const passedCount = completed.filter((c) => c.passed_criteria >= 3 && c.failed_criteria <= 1).length;

  if (loading && screenings.length === 0) {
    return null;
  }

  if (screenings.length === 0) {
    return null;
  }

  const handlePromoteSuccess = async () => {
    if (!promotingCompany) return;

    // We no longer delete screening data, just refresh the list.
    // The list filters out non-L0 companies, so this company will disappear.
    toast.success(`${promotingCompany.name} promoted to ${targetLabel}`);

    setPromotingCompany(null);
    onScreeningComplete?.();
    fetchScreenings();
  };

  return (
    <Card className="shadow-md">
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
            {passedCount > 0 && canPromote && (
              <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                {passedCount} ready for {targetLabel}
              </Badge>
            )}
            {/* Visibility toggle — always rightmost */}
            {onToggleCollapse && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggleCollapse}
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {collapsed ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                {collapsed ? 'Show' : 'Hide'}
                {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="space-y-4">
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
                    className="flex items-center justify-between p-3 rounded-lg border bg-yellow-50 border-yellow-200 dark:bg-yellow-950/20 dark:border-yellow-900/50"
                  >
                    <div className="flex items-center gap-3">
                      <Loader2 className="h-4 w-4 animate-spin text-yellow-600" />
                      <div>
                        <button
                          onClick={() => onCompanyClick?.(summary.company_id)}
                          className="font-medium hover:text-primary hover:underline transition-colors text-left"
                        >
                          {summary.company_name}
                        </button>
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
                    </div>
                    <div className="flex items-center gap-2">
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
                      {canPromote && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-600 border-green-300 hover:bg-green-50 hover:text-green-700"
                          onClick={() => handlePromoteClick(summary.company_id, summary.company_name)}
                        >
                          <ArrowRight className="h-3 w-3 mr-1" />
                          Promote to {targetLabel}
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
                    className={`flex items-center justify-between p-3 rounded-lg border ${status === 'pass'
                      ? 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-900/50'
                      : status === 'fail'
                        ? 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-900/50'
                        : 'bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900/50'
                      }`}
                  >
                    <div className="flex items-center gap-3">
                      {status === 'pass' ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                      ) : status === 'fail' ? (
                        <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                      ) : (
                        <HelpCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                      )}
                      <div>
                        <button
                          onClick={() => onCompanyClick?.(summary.company_id)}
                          className="font-medium hover:text-primary hover:underline transition-colors text-left"
                        >
                          {summary.company_name}
                        </button>
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
                    </div>
                    <div className="flex items-center gap-2">
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
                      {canPromote && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-600 border-green-300 hover:bg-green-50 hover:text-green-700"
                          onClick={() => handlePromoteClick(summary.company_id, summary.company_name)}
                        >
                          <ArrowRight className="h-3 w-3 mr-1" />
                          Promote to {targetLabel}
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
      )}

      {promotingCompany && screeningTarget && (
        <PromoteDialog
          open={promoteDialogOpen}
          onOpenChange={setPromoteDialogOpen}
          dealId={promotingCompany.id}
          companyName={promotingCompany.name}
          currentStage={FIRST_STAGE_KEY}
          nextStage={screeningTarget}
          onSuccess={handlePromoteSuccess}
        />
      )}
    </Card>
  );
}
