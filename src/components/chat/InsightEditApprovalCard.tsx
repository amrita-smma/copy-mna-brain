'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import {
  getInsight,
  getInsightHead,
  publishInsightVersion,
} from '@/lib/api/insights';
import type {
  InsightDetail,
  InsightEditApprovalPayload,
} from '@/lib/insights/types';
import {
  diffInsightVersions,
  highlightPreviewHtml,
} from '@/lib/insights/versionDiff';
import {
  BASE_POLL_INTERVAL_MS,
  baseMovedMessage,
  createInsightEditActions,
  editCandidate,
  editScopeText,
  hasBaseMoved,
  nextBaseMove,
  type BaseMove,
} from '@/lib/insights/editReview';
import { InsightFrame } from '@/components/insights/InsightFrame';
import { useChatThread } from '@/components/chat/ChatProvider';
import { useLiveRefetchInterval, useLiveTopic } from '@/components/live/LiveEventsProvider';
import { LIVE_TOPICS } from '@/lib/live/topics';
import {
  ApprovalCardShell,
  useApprovalResolution,
} from './ApprovalCardShell';
import { InsightEditReview, type InsightEditTab } from './InsightEditReview';

export interface InsightEditApprovalCardProps {
  payload: InsightEditApprovalPayload;
  className?: string;
}

const actions = createInsightEditActions({ publishInsightVersion });

export function InsightEditApprovalCard({
  payload,
  className,
}: InsightEditApprovalCardProps) {
  // The thread this card belongs to; the server stamps the published version
  // with that thread's agent.
  const { chatId } = useChatThread();
  const {
    status,
    setStatus,
    resolutionText,
    error,
    setError,
    isResolved,
    isSubmitting,
    resolve,
  } = useApprovalResolution({ cardId: payload.approval_id, toolName: 'propose_insight_edit' });

  const [isStale, setIsStale] = useState(false);
  // The current version the diff is against — replaced when the base moves.
  const [insightDetail, setInsightDetail] = useState<InsightDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(!isResolved);
  const [baseMove, setBaseMove] = useState<BaseMove | null>(null);
  // Null until the user picks a tab: Changes when the diff finds any, else After.
  const [chosenTab, setChosenTab] = useState<InsightEditTab | null>(null);

  const firstVersionNoRef = useRef<number | null>(null);
  const currentVersionNoRef = useRef<number | null>(null);
  const checkingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(true);

  const adoptDetail = useCallback((detail: InsightDetail) => {
    if (firstVersionNoRef.current === null) {
      firstVersionNoRef.current = detail.version_no;
    }
    currentVersionNoRef.current = detail.version_no;
    setInsightDetail(detail);
  }, []);

  // Fetch the current version to diff against (skipped if already resolved).
  useEffect(() => {
    if (isResolved) return;
    let mounted = true;
    setLoadingDetail(true);
    getInsight(payload.insight_id)
      .then((detail) => {
        if (mounted && detail) adoptDetail(detail);
      })
      .catch(() => {
        // Ignore errors — the card falls back to the proposed document alone.
      })
      .finally(() => {
        if (mounted) setLoadingDetail(false);
      });
    return () => {
      mounted = false;
    };
  }, [payload.insight_id, isResolved, adoptDetail]);

  /**
   * Check whether a newer version landed (a scheduled refresh, typically).
   * When it did, refetch it and re-diff; the approve base follows the HTML
   * now on screen, never the head number alone. Resolves true on a move.
   */
  const checkBase = useCallback(async (): Promise<boolean> => {
    const diffedVersionNo = currentVersionNoRef.current;
    if (checkingRef.current || diffedVersionNo === null) return false;
    checkingRef.current = true;
    try {
      const head = await getInsightHead(payload.insight_id);
      if (!hasBaseMoved(diffedVersionNo, head)) return false;
      const detail = await getInsight(payload.insight_id);
      if (detail.version_no === diffedVersionNo) return false;
      adoptDetail(detail);
      setBaseMove(nextBaseMove(firstVersionNoRef.current ?? diffedVersionNo, detail, head));
      setIsStale(false);
      return true;
    } catch {
      return false;
    } finally {
      checkingRef.current = false;
    }
  }, [payload.insight_id, adoptDetail]);

  // Only a card on screen polls: a long thread can hold several open cards.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      setOnScreen(entry?.isIntersecting ?? true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // While unresolved and visible: when the stream says this insight gained a
  // version, on window focus, and on a timer only while the stream is down.
  const watching = !isResolved && !!insightDetail && onScreen;
  const pollMs = useLiveRefetchInterval(BASE_POLL_INTERVAL_MS);
  useLiveTopic(LIVE_TOPICS.insights, (ids) => {
    if (!watching || (ids && !ids.includes(payload.insight_id))) return;
    void checkBase();
  });
  useEffect(() => {
    if (!watching) return;
    const visible = () =>
      typeof document === 'undefined' || document.visibilityState === 'visible';
    const tick = () => {
      if (visible()) void checkBase();
    };
    const interval = window.setInterval(tick, pollMs);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [watching, pollMs, checkBase]);

  const currentHtml = insightDetail?.html ?? '';
  // A section proposal carries only its fragment: the document shown as
  // "after" is the current version with the fragment spliced in. Null while
  // the current version loads; an error when the section is gone from it.
  const candidate = useMemo(
    () => editCandidate(payload, insightDetail ? insightDetail.html : null),
    [payload, insightDetail],
  );
  const candidateHtml = candidate.html;
  const diff = useMemo(
    () => (currentHtml && candidateHtml ? diffInsightVersions(currentHtml, candidateHtml) : null),
    [currentHtml, candidateHtml],
  );
  // The highlight is for the preview only; approve publishes payload.html
  // (the whole document, or the fragment for the server to splice).
  const previewHtml = useMemo(
    () => (candidateHtml && diff ? highlightPreviewHtml(candidateHtml, diff) : candidateHtml),
    [diff, candidateHtml],
  );
  const activeTab: InsightEditTab =
    chosenTab ?? (diff?.summary.hasChanges ? 'changes' : 'after');

  const insightName = insightDetail?.name || null;

  const handleApprove = async () => {
    if (status !== 'idle') return;
    setStatus('submitting');
    setError(null);

    try {
      const updated = await actions.approve({
        insightId: payload.insight_id,
        html: payload.html,
        section: payload.section ?? null,
        summary: payload.summary,
        baseVersionNo: insightDetail?.version_no ?? null,
        chatId,
      });

      const versionNo = updated.version_no;
      resolve(`Approved — published as version ${versionNo}.`, 'accepted', { version_no: versionNo });

      toast.success(`Insight updated to version ${versionNo}`);

      // Dispatch event so active insight view reloads instantly
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('insight:version-published', {
            detail: { insightId: payload.insight_id, versionNo },
          }),
        );
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to publish insight version';
      // 409 means the insight moved on after the diff was taken: re-diff
      // against the new current version and let the user approve again.
      const httpStatus = (err as { status?: number } | undefined)?.status;
      const moved = httpStatus === 409 && (await checkBase());
      setStatus('idle');
      if (moved) {
        setChosenTab('changes');
        toast.info('This insight changed while you were reviewing', {
          description: 'The changes are now shown against the new current version. Review them and approve again.',
        });
        return;
      }
      setIsStale(httpStatus === 409);
      setError(message);
      toast.error(
        httpStatus === 409
          ? 'Insight has changed since this was proposed'
          : 'Failed to approve insight edit',
        { description: message },
      );
    }
  };

  const handleReject = () => {
    if (status !== 'idle') return;
    // Writes nothing: no version, no draft row, no request.
    resolve(actions.reject(), 'declined');
  };

  const caption =
    activeTab === 'after'
      ? 'Proposed changes'
      : insightDetail
        ? `Current version (v${insightDetail.version_no})`
        : loadingDetail
          ? 'Loading current version…'
          : 'No current version';

  const frameBox =
    'max-h-96 overflow-y-auto overflow-x-auto rounded-lg border border-border bg-card p-1 min-w-0';

  return (
    <ApprovalCardShell
      testId="insight-edit-approval-card"
      className={className}
      isResolved={isResolved}
      isSubmitting={isSubmitting}
      resolutionText={resolutionText}
      error={error}
      errorTitle={isStale ? 'Out of date: ' : 'Error: '}
      errorDescription={
        isStale && (
          <p className="mt-1">
            Ask the CoPilot to propose this change again so it builds on
            the current version.
          </p>
        )
      }
      resolvedBgClassName="bg-muted"
      resolvedBannerBorderClassName="border-emerald-300 dark:border-emerald-800"
      tagIcon={<FileCode2 className="h-3.5 w-3.5" />}
      tagLabel="Approval needed · Insight Edit"
      rejectTestId="insight-edit-reject-button"
      approveTestId="insight-edit-approve-button"
      approveLabel="Approve & Publish"
      submittingLabel="Publishing…"
      approveDisabled={isStale || isSubmitting || !!candidate.error}
      onReject={handleReject}
      onApprove={handleApprove}
    >
      <div ref={rootRef}>
        {/* Insight Badge */}
        {insightName && (
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <Badge
              variant="outline"
              className="text-xs bg-card text-foreground font-medium border-border"
            >
              {insightName}
            </Badge>
          </div>
        )}

        {/* Summary */}
        <h3 className="text-base font-semibold text-foreground mb-1.5">
          {payload.summary}
        </h3>

        {isResolved ? (
          <div className="mb-4 space-y-2">
            {payload.section && (
              <p className="text-xs text-muted-foreground">
                Section “{payload.section}” as proposed. The published version is the full insight with
                this section replaced.
              </p>
            )}
            <div className={frameBox}>
              <InsightFrame
                html={payload.html}
                title={payload.section ? `Proposed section: ${payload.section}` : 'Proposed changes'}
                minHeight={250}
                maxHeight={500}
              />
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-3 mb-4 space-y-3">
            <p className="text-xs font-medium text-foreground">
              {editScopeText(payload.section)}
            </p>
            {candidate.error && (
              <p
                className="text-xs text-destructive"
                data-testid="insight-edit-section-missing"
              >
                This section is no longer in the current version ({candidate.error}) so the edit
                cannot be applied. Ask the CoPilot to propose it again.
              </p>
            )}

            <div className="pt-2 border-t border-border">
              <InsightEditReview
                activeTab={activeTab}
                onTabChange={setChosenTab}
                diff={diff}
                loadingCurrent={loadingDetail}
                baseMovedNotice={baseMove ? baseMovedMessage(baseMove) : null}
                caption={caption}
                afterPane={
                  previewHtml ? (
                    <div className={frameBox}>
                      <InsightFrame
                        html={previewHtml}
                        title="Proposed changes"
                        minHeight={250}
                        maxHeight={500}
                      />
                    </div>
                  ) : (
                    <div className="p-6 text-center text-xs text-muted-foreground bg-card border border-border rounded-lg">
                      {candidate.error
                        ? 'The proposed section cannot be shown against the current version.'
                        : 'Loading current version…'}
                    </div>
                  )
                }
                beforePane={
                  insightDetail?.html ? (
                    <div className={frameBox}>
                      <InsightFrame
                        html={insightDetail.html}
                        title={`Current version (${insightDetail.version_no})`}
                        minHeight={250}
                        maxHeight={500}
                      />
                    </div>
                  ) : (
                    <div className="p-6 text-center text-xs text-muted-foreground bg-card border border-border rounded-lg">
                      {loadingDetail
                        ? 'Loading current version…'
                        : 'No published version exists yet to compare against.'}
                    </div>
                  )
                }
              />
            </div>
          </div>
        )}
      </div>
    </ApprovalCardShell>
  );
}
