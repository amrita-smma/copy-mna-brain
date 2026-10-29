"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api/client";
import { useLiveRefetchInterval, useLiveTopic } from "@/components/live/LiveEventsProvider";
import { LIVE_TOPICS } from "@/lib/live/topics";
import type {
  AnalysisSectionKey,
  EditSectionRequest,
} from "@/components/pipeline/CompanyOverviewSlide";

/** While the live stream is down, how often the slide re-reads the card for the edit. */
const FALLBACK_POLL_MS = 2_500;
/**
 * Stop waiting after this long. The copilot may still finish — the slide just
 * stops showing the section as busy.
 */
const WAIT_MS = 2 * 60_000;

interface PendingEdit {
  sectionKey: AnalysisSectionKey;
  sectionTitle: string;
  previousContent: string;
  deadline: number;
}

/**
 * The wait behind "Edit with AI" on an Overview slide section: after the
 * copilot is asked to rewrite one section, that section shows busy until the
 * `update_company_card_section` tool writes it. The tool publishes
 * `company-card`, so the slide re-reads the card on that frame; a timer at
 * the old cadence covers a stream that is down. Shared by the company page
 * and the pipeline dialog so both shells behave the same.
 */
export function useCompanyCardSectionEdit<A extends Record<AnalysisSectionKey, string | null>>(
  companyId: string | null | undefined,
  onUpdated: (analysis: A) => void,
) {
  const [editingSectionKey, setEditingSectionKey] = useState<AnalysisSectionKey | null>(null);
  const pendingRef = useRef<PendingEdit | null>(null);
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  const stop = useCallback(() => {
    pendingRef.current = null;
    setEditingSectionKey(null);
  }, []);

  const check = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending || !companyId) return;
    try {
      const data = await apiRequest<A>(
        `/api/company-analysis?companyId=${encodeURIComponent(companyId)}`,
      );
      if (pendingRef.current !== pending) return;
      const next = data?.[pending.sectionKey];
      if (data && typeof next === "string" && next.trim() !== pending.previousContent.trim()) {
        stop();
        onUpdatedRef.current(data);
        toast.success(`Updated "${pending.sectionTitle}"`);
        return;
      }
    } catch {
      // Transient: the next frame or tick re-reads.
    }
    if (pendingRef.current === pending && Date.now() > pending.deadline) stop();
  }, [companyId, stop]);

  /** Start showing `req.sectionKey` busy until its content changes. */
  const watch = useCallback(
    (req: Pick<EditSectionRequest, "sectionKey" | "sectionTitle" | "currentContent">) => {
      pendingRef.current = {
        sectionKey: req.sectionKey,
        sectionTitle: req.sectionTitle,
        previousContent: req.currentContent,
        deadline: Date.now() + WAIT_MS,
      };
      setEditingSectionKey(req.sectionKey);
    },
    [],
  );

  const pollMs = useLiveRefetchInterval(FALLBACK_POLL_MS);
  useEffect(() => {
    if (!editingSectionKey) return;
    const timer = setInterval(() => void check(), pollMs);
    return () => clearInterval(timer);
  }, [editingSectionKey, pollMs, check]);

  useLiveTopic(LIVE_TOPICS.companyCard, (ids) => {
    if (!pendingRef.current || !companyId || (ids && !ids.includes(companyId))) return;
    void check();
  });

  // A different company, or unmount, drops the wait.
  useEffect(() => stop, [companyId, stop]);

  return { editingSectionKey, watch };
}
