"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api/client";
import { isAnalysisInProgress, type AnalysisJobStatus } from "@/lib/constants";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";
import { useLiveRefetchInterval, useLiveTopic } from "@/components/live/LiveEventsProvider";
import { LIVE_TOPICS } from "@/lib/live/topics";

/**
 * How often the Overview re-reads the card while a run is in flight and the
 * live stream is down. While it is up, the `company-card` and `workforce`
 * topics drive the refresh.
 */
const POLL_INTERVAL_MS = 3000;

interface GenerationState<A> {
  analysis: A | null;
  run: { id: string; status: string } | null;
}

/**
 * The AI Company Card and its AI Workforce run, shared by the company page and
 * the pipeline dialog so the two show the same Overview.
 *
 * "Generating" is read from the server, not remembered locally: a card run is
 * an AI Workforce task, and `GET /api/company-analysis/state` reports the
 * in-flight run even before it has written a `company_analyses` row. So a
 * reload, a reopened dialog, or another user's click all land on
 * "Generating…" with a link to the task, and polling runs for as long as the
 * run does rather than for a fixed window.
 */
export function useCompanyCardGeneration<A extends { status: string }>(
  companyId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const router = useRouter();
  const workforceHref = useWorkspaceHref("/ai-workforce");

  const [analysis, setAnalysis] = useState<A | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Drops a response for a company the hook is no longer showing.
  const companyIdRef = useRef(companyId);
  companyIdRef.current = companyId;

  const refresh = useCallback(async () => {
    if (!companyId) return;
    try {
      const state = await apiRequest<GenerationState<A>>(
        `/api/company-analysis/state?companyId=${encodeURIComponent(companyId)}`,
      );
      if (companyIdRef.current !== companyId) return;
      setAnalysis(state.analysis);
      setRunId(state.run?.id ?? null);
    } catch (error) {
      console.error("Error fetching Company Card state:", error);
    } finally {
      if (companyIdRef.current === companyId) setLoaded(true);
    }
  }, [companyId]);

  useEffect(() => {
    setAnalysis(null);
    setRunId(null);
    setLoaded(false);
    setStarting(false);
    setCancelling(false);
  }, [companyId]);

  useEffect(() => {
    if (enabled && companyId) void refresh();
  }, [enabled, companyId, refresh]);

  const generating =
    starting ||
    runId != null ||
    isAnalysisInProgress(analysis?.status as AnalysisJobStatus | undefined);

  const pollIntervalMs = useLiveRefetchInterval(POLL_INTERVAL_MS);
  useEffect(() => {
    if (!enabled || !companyId || !generating || starting) return;
    const interval = setInterval(() => void refresh(), pollIntervalMs);
    return () => clearInterval(interval);
  }, [enabled, companyId, generating, starting, refresh, pollIntervalMs]);

  // The card row changes as the run writes it; the run itself is a workforce
  // task (queued, running, cancelled, finished). Either event re-reads the
  // state, but only while the Overview is watching a run.
  const onLiveEvent = (ids: string[] | undefined) => {
    if (!enabled || !companyId || !generating || starting) return;
    if (ids && !ids.includes(companyId) && !(runId && ids.includes(runId))) return;
    void refresh();
  };
  useLiveTopic(LIVE_TOPICS.companyCard, onLiveEvent);
  useLiveTopic(LIVE_TOPICS.workforce, onLiveEvent);

  const taskHref = runId ? `${workforceHref}/tasks/${runId}` : null;

  /**
   * Queue a card run on the AI Workforce. `force` regenerates a card that
   * already exists (the existing row is kept — the run date-ranks it against
   * the company's documents).
   */
  const generate = useCallback(
    async (force = false) => {
      if (!companyId) return;
      setStarting(true);
      try {
        const data = await apiRequest<A & { runId?: string }>("/api/company-analysis", {
          method: "POST",
          body: JSON.stringify({ companyId, force }),
        });
        if (companyIdRef.current !== companyId) return;
        if (data.runId) {
          const href = `${workforceHref}/tasks/${data.runId}`;
          setRunId(data.runId);
          toast.success("Company Card queued on the AI Workforce", {
            action: { label: "View task", onClick: () => router.push(href) },
          });
          return;
        }
        // A completed card already existed — the POST returned it as-is.
        setAnalysis(data);
      } catch (error) {
        console.error("Error generating Company Card:", error);
        // 409: a run is already in flight — the refresh below picks it up.
        if ((error as { status?: number }).status !== 409) {
          toast.error((error as Error).message || "Failed to generate AI Company Card");
        }
        await refresh();
      } finally {
        setStarting(false);
      }
    },
    [companyId, refresh, router, workforceHref],
  );

  const cancel = useCallback(async () => {
    if (!companyId) return;
    setCancelling(true);
    try {
      await apiRequest("/api/company-analysis/cancel", {
        method: "POST",
        body: JSON.stringify({ companyId }),
      });
      setRunId(null);
      toast.success("Company Card generation cancelled");
      await refresh();
    } catch (error) {
      console.error("Error cancelling Company Card generation:", error);
      toast.error((error as Error).message || "Failed to cancel Company Card generation");
    } finally {
      setCancelling(false);
    }
  }, [companyId, refresh]);

  return {
    analysis,
    /** For an in-place section edit landing outside a card run. */
    setAnalysis,
    /** False until the first state read returns — render nothing card-shaped yet. */
    loaded,
    generating,
    cancelling,
    /** The in-flight run's AI Workforce task page, or null. */
    taskHref,
    generate,
    regenerate: useCallback(() => generate(true), [generate]),
    cancel,
    refresh,
  };
}

/**
 * Whether there is a card to show on the Overview slide. A regeneration keeps
 * the previous card's text on the row, so content counts as a card even while
 * the row is back in progress.
 */
export function hasCompanyCard(
  analysis: { status: string; business_overview?: string | null } | null,
): boolean {
  return analysis?.status === "completed" || !!analysis?.business_overview;
}
