"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { getCompanies } from "@/lib/api/pipeline";
import { getDashboardActivity } from "@/lib/api/dashboard";
import type { DashboardActivity } from "@/lib/services/dashboardActivityService";
import CompanyDetailDialog, {
  type CompanyData,
} from "@/components/pipeline/CompanyDetailDialog";
import {
  Building2,
  TrendingUp,
  ArrowUpRight,
  Loader2,
  Layers,
  Activity,
  XCircle,
  ChevronRight,
  MoveRight,
  FileText,
  CalendarIcon,
  Clock,
  LayoutGrid,
  Globe,
  ArrowLeftRight,
  Sparkles,
} from "lucide-react";
import { useChatContext } from "@/components/chat/ChatProvider";

interface StageCounts {
  stage: string;
  label: string;
  count: number;
  inbound?: number;
  outbound?: number;
}

const PIPELINE_STAGES: { stage: string; label: string; color: string }[] = [
  { stage: "L0", label: "Sourcing", color: "bg-blue-500" },
  { stage: "L1", label: "Screening", color: "bg-purple-500" },
  { stage: "L2", label: "Initial Review", color: "bg-amber-500" },
  { stage: "L3", label: "Due Diligence", color: "bg-green-500" },
  { stage: "L4", label: "Negotiation", color: "bg-teal-500" },
  { stage: "L5", label: "Closing", color: "bg-pink-500" },
];

// Solid pill colors for the L1–L5 stage columns (inbound = darker, outbound = lighter).
const stagePillColors: Record<string, { inbound: string; outbound: string }> = {
  L1: { inbound: "bg-violet-500", outbound: "bg-violet-300" },
  L2: { inbound: "bg-amber-500", outbound: "bg-amber-300" },
  L3: { inbound: "bg-emerald-500", outbound: "bg-emerald-300" },
  L4: { inbound: "bg-cyan-500", outbound: "bg-cyan-300" },
  L5: { inbound: "bg-pink-500", outbound: "bg-pink-300" },
};

type PresetKey = "7d" | "14d";

interface ActiveDateRange {
  from: Date;
  to: Date;
  preset: PresetKey | "custom";
}

function presetToRange(key: PresetKey): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (key === "7d" ? 7 : 14));
  return { from, to };
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function parsePipelineMoveAction(action: string | null): {
  from: string | null;
  to: string | null;
} {
  if (!action) return { from: null, to: null };
  const fromTo = action.match(/^PROMOTED_FROM_(\S+)_TO_(\S+)$/);
  if (fromTo) return { from: fromTo[1], to: fromTo[2] };
  const toOnly = action.match(/^PROMOTED_TO_(\S+)$/);
  if (toOnly) return { from: null, to: toOnly[1] };
  return { from: null, to: null };
}

function formatRelative(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  return `${diffDays}d ago`;
}

function formatShortDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Feed types ──────────────────────────────────────────────────────────────

type FeedEventType = "new_deal" | "stage_move" | "dropped" | "note_updated";
type FeedFilterKey = "all" | "new" | "moved" | "dropped" | "notes";

interface FeedEvent {
  id: string;
  type: FeedEventType;
  company_id: string;
  company_name: string;
  segment: string | null;
  geography: string | null;
  source: string | null;
  event_at: string;
  from_stage?: string | null;
  to_stage?: string | null;
  dropped_stage?: string | null;
  remarks?: string | null;
  thesis_content?: string | null;
  note_content?: string | null;
  note_stage?: string | null;
  revenue_usd_mn?: number | null;
  ebitda_usd_mn?: number | null;
  ev_usd_mn?: number | null;
  financial_year?: number | null;
}

/** Format a USD-millions figure as `USD 4.9B` / `USD 312M`, or null when absent. */
function formatUsdMn(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (Math.abs(value) >= 1000) return `USD ${(value / 1000).toFixed(1)}B`;
  return `USD ${Math.round(value)}M`;
}

function buildFeedEvents(activity: DashboardActivity): FeedEvent[] {
  const events: FeedEvent[] = [];

  for (const c of activity.newL0Companies) {
    events.push({
      id: `new-${c.id}-${c.event_at}`,
      type: "new_deal",
      company_id: c.id,
      company_name: c.target || c.project_name || "—",
      segment: c.segment ?? null,
      geography: c.geography ?? null,
      source: c.source ?? null,
      event_at: c.event_at,
      revenue_usd_mn: c.revenue_usd_mn ?? null,
      ebitda_usd_mn: c.ebitda_usd_mn ?? null,
      ev_usd_mn: c.ev_usd_mn ?? null,
      financial_year: c.financial_year ?? null,
    });
  }

  for (const m of activity.pipelineMoves) {
    if (!m.created_at) continue;
    const { from: fromStage, to: toStage } = parsePipelineMoveAction(m.action);
    events.push({
      id: `move-${m.id}`,
      type: "stage_move",
      company_id: m.company_id ?? "",
      company_name: m.target || m.project_name || "—",
      segment: m.segment ?? null,
      geography: m.geography ?? null,
      source: m.source ?? null,
      event_at: m.created_at,
      from_stage: fromStage,
      to_stage: toStage,
      remarks: m.remarks ?? null,
      thesis_content: m.thesis_content ?? null,
      revenue_usd_mn: m.revenue_usd_mn ?? null,
      ebitda_usd_mn: m.ebitda_usd_mn ?? null,
      ev_usd_mn: m.ev_usd_mn ?? null,
      financial_year: m.financial_year ?? null,
    });
  }

  for (const d of activity.droppedDeals) {
    if (!d.dropped_at) continue;
    events.push({
      id: `dropped-${d.id}`,
      type: "dropped",
      company_id: d.id,
      company_name: d.target || d.project_name || "—",
      segment: d.segment ?? null,
      geography: d.geography ?? null,
      source: d.source ?? null,
      event_at: d.dropped_at,
      dropped_stage: d.pipeline_stage ?? null,
      thesis_content: d.thesis_content ?? null,
      revenue_usd_mn: d.revenue_usd_mn ?? null,
      ebitda_usd_mn: d.ebitda_usd_mn ?? null,
      ev_usd_mn: d.ev_usd_mn ?? null,
      financial_year: d.financial_year ?? null,
    });
  }

  for (const n of activity.notesUpdated) {
    if (!n.updated_at) continue;
    events.push({
      id: `note-${n.id}`,
      type: "note_updated",
      company_id: n.company_id,
      company_name: n.target || n.project_name || "—",
      segment: n.segment ?? null,
      geography: n.geography ?? null,
      source: n.source ?? null,
      event_at: n.updated_at,
      note_content: n.content ?? null,
      note_stage: n.stage ?? null,
      remarks: n.remarks ?? null,
      thesis_content: n.thesis_content ?? null,
      revenue_usd_mn: n.revenue_usd_mn ?? null,
      ebitda_usd_mn: n.ebitda_usd_mn ?? null,
      ev_usd_mn: n.ev_usd_mn ?? null,
      financial_year: n.financial_year ?? null,
    });
  }

  return events.sort((a, b) => b.event_at.localeCompare(a.event_at));
}

function groupEventsByDate(
  events: FeedEvent[],
): { dateLabel: string; events: FeedEvent[] }[] {
  const groups: { dateLabel: string; events: FeedEvent[] }[] = [];
  const seen = new Map<string, number>();
  for (const event of events) {
    const d = new Date(event.event_at);
    const label = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    if (seen.has(label)) {
      groups[seen.get(label)!].events.push(event);
    } else {
      seen.set(label, groups.length);
      groups.push({ dateLabel: label, events: [event] });
    }
  }
  return groups;
}

// ─── Stage chip ──────────────────────────────────────────────────────────────

const stageChipColors: Record<string, string> = {
  L0: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  L1: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  L2: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  L3: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  L4: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  L5: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
};

function StageChip({ stage }: { stage: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${stageChipColors[stage] ?? "bg-muted text-muted-foreground"}`}
    >
      {stage}
    </span>
  );
}

// ─── Source chip (Inbound / Outbound) ────────────────────────────────────────
// Mirrors the inbound/outbound color palette used in the Pipeline view.

function SourceChip({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  const isInbound = source.toLowerCase() === "inbound";
  return (
    <Badge
      variant="secondary"
      className={
        isInbound
          ? "text-[10px] px-1.5 py-0 h-4 capitalize bg-emerald-500/20 text-emerald-600 hover:bg-emerald-500/30"
          : "text-[10px] px-1.5 py-0 h-4 capitalize bg-blue-500/20 text-blue-600 hover:bg-blue-500/30"
      }
    >
      {source}
    </Badge>
  );
}

// ─── Event dot color ─────────────────────────────────────────────────────────

const dotColors: Record<FeedEventType, string> = {
  new_deal: "bg-blue-500",
  stage_move: "bg-emerald-500",
  dropped: "bg-red-500",
  note_updated: "bg-amber-500",
};

const eventTypeLabels: Record<FeedEventType, string> = {
  new_deal: "New Deal",
  stage_move: "Stage Move",
  dropped: "Dropped",
  note_updated: "Note Updated",
};

// ─── Ask-AI button ───────────────────────────────────────────────────────────

function AskAIButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-purple-500 transition-colors hover:bg-purple-500/10 hover:text-purple-600 dark:hover:text-purple-400"
    >
      <Sparkles className="h-3.5 w-3.5" />
    </button>
  );
}

// ─── Notes modal ─────────────────────────────────────────────────────────────

interface NotesModalProps {
  event: FeedEvent | null;
  onClose: () => void;
}

function NotesModal({ event, onClose }: NotesModalProps) {
  if (!event) return null;
  const isStageMove = event.type === "stage_move";
  const isDropped = event.type === "dropped";
  const showStageContext = isStageMove || isDropped;

  return (
    <Dialog
      open={!!event}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span>{event.company_name}</span>
            {event.segment && (
              <Badge variant="secondary" className="text-xs font-normal">
                {event.segment}
              </Badge>
            )}
            <Badge
              className={`text-xs ${
                isDropped
                  ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                  : isStageMove
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
              }`}
            >
              {eventTypeLabels[event.type]}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {showStageContext && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 text-sm">
              {isStageMove && (
                <>
                  {event.from_stage && <StageChip stage={event.from_stage} />}
                  {event.from_stage && (
                    <MoveRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  {event.to_stage && <StageChip stage={event.to_stage} />}
                </>
              )}
              {isDropped && (
                <>
                  <span className="text-muted-foreground">Dropped at</span>
                  {event.dropped_stage && (
                    <StageChip stage={event.dropped_stage} />
                  )}
                </>
              )}
            </div>
          )}

          {event.type === "note_updated" && event.note_content && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400 mb-1.5 flex items-center gap-1.5">
                <FileText className="h-3 w-3" />
                Note
                {event.note_stage && (
                  <span className="normal-case font-normal text-muted-foreground ml-1">
                    — at {event.note_stage}
                  </span>
                )}
              </p>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                {event.note_content}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Key Rationale
              </p>
              <p className="text-sm text-foreground leading-relaxed">
                {event.remarks || (
                  <span className="text-muted-foreground italic">
                    No rationale recorded.
                  </span>
                )}
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Additional Remarks
              </p>
              <p className="text-sm text-foreground leading-relaxed">
                {event.thesis_content || (
                  <span className="text-muted-foreground italic">
                    No additional remarks.
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

interface DashboardProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}

export default function Dashboard({
  showCrm = false,
  showAiWorkforce = false,
}: DashboardProps) {
  const [loading, setLoading] = useState(true);
  const [activityInitialising, setActivityInitialising] = useState(true);
  const [companies, setCompanies] = useState<any[]>([]);
  const [totalCompanies, setTotalCompanies] = useState(0);
  const [stageCounts, setStageCounts] = useState<StageCounts[]>([]);
  const [activity, setActivity] = useState<DashboardActivity | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(
    null,
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  // Date range
  const defaultRange = presetToRange("7d");
  const [dateRange, setDateRange] = useState<ActiveDateRange>({
    ...defaultRange,
    preset: "7d",
  });
  const [customFrom, setCustomFrom] = useState<Date | undefined>(undefined);
  const [customTo, setCustomTo] = useState<Date | undefined>(undefined);
  const [customPickerOpen, setCustomPickerOpen] = useState(false);

  // Which field the next calendar click will fill — drives the highlight on
  // the From/To display fields. Range mode fills `from` first, then `to`.
  const nextRangeField: 'from' | 'to' = customFrom && !customTo ? 'to' : 'from';

  // Feed
  const [feedFilter, setFeedFilter] = useState<FeedFilterKey>("all");

  const fetchPipelineData = useCallback(async () => {
    try {
      const companiesData = await getCompanies({
        excludeDropped: true,
        orderBy: "updated_at",
        orderDir: "desc",
      });

      if (companiesData) {
        setCompanies(companiesData);
        setTotalCompanies(companiesData.length);

        const stageMap = new Map<
          string,
          { count: number; inbound: number; outbound: number }
        >();
        PIPELINE_STAGES.forEach(({ stage }) => {
          stageMap.set(stage, { count: 0, inbound: 0, outbound: 0 });
        });

        companiesData.forEach((company: any) => {
          const stage = company.pipeline_stage || "L0";
          const current = stageMap.get(stage) || {
            count: 0,
            inbound: 0,
            outbound: 0,
          };
          current.count += 1;
          const src = company.source?.toLowerCase();
          if (src === "inbound") current.inbound += 1;
          else if (src === "outbound") current.outbound += 1;
          else {
            const status = company.watchlist_status?.toLowerCase() || "";
            if (status.includes("inbound") || status === "active")
              current.inbound += 1;
            else current.outbound += 1;
          }
          stageMap.set(stage, current);
        });

        const counts: StageCounts[] = PIPELINE_STAGES.map(
          ({ stage, label }) => {
            const data = stageMap.get(stage) || {
              count: 0,
              inbound: 0,
              outbound: 0,
            };
            return {
              stage,
              label,
              count: data.count,
              inbound: data.inbound,
              outbound: data.outbound,
            };
          },
        );

        setStageCounts(counts);
      }
    } catch (error) {
      console.error("Error fetching pipeline data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchActivity = useCallback(
    async (range: ActiveDateRange, initialLoad = false) => {
      if (initialLoad) setActivityInitialising(true);
      try {
        const data = await getDashboardActivity({
          from: range.from,
          to: range.to,
        });
        setActivity(data);
      } catch (error) {
        console.error("Error fetching activity:", error);
      } finally {
        if (initialLoad) setActivityInitialising(false);
      }
    },
    [],
  );

  const handleCompanyClick = useCallback(
    async (id: string) => {
      const cached = companies.find((c: any) => c.id === id);
      if (cached) {
        setSelectedCompany(cached as CompanyData);
        setDialogOpen(true);
        return;
      }
      try {
        // `getCompanies({ id })` hits the single-company endpoint, which returns
        // one DTO object (not an array). Dropped companies are excluded from the
        // cached `companies` list, so they always take this path.
        const company = await getCompanies({ id });
        if (company) {
          setSelectedCompany(company as CompanyData);
          setDialogOpen(true);
        }
      } catch (err) {
        console.error("Failed to load company details", err);
      }
    },
    [companies],
  );

  useEffect(() => {
    fetchPipelineData();
  }, [fetchPipelineData]);

  const isFirstLoad = activity === null;
  useEffect(() => {
    fetchActivity(dateRange, isFirstLoad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange, fetchActivity]);

  const applyPreset = (key: PresetKey) => {
    const range = presetToRange(key);
    setDateRange({ ...range, preset: key });
  };

  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    setDateRange({ from: customFrom, to: customTo, preset: "custom" });
    setCustomPickerOpen(false);
  };

  // ─── Copilot quick-analysis ─────────────────────────────────────────────────

  const { sendMessage } = useChatContext();

  const askCopilot = useCallback(
    (topic: string) => {
      const range = `${formatDate(dateRange.from)} – ${formatDate(dateRange.to)}`;
      sendMessage({
        text: `In the current period (${range}), analyze the ${topic} and provide insights.`,
      });
    },
    [sendMessage, dateRange.from, dateRange.to],
  );

  // ─── Recap derivations ──────────────────────────────────────────────────────

  const recapDropped = activity?.droppedDeals ?? [];
  const recapNewDeals = activity?.newL0Companies ?? [];
  const recapStageMoves = activity?.pipelineMoves ?? [];
  const recapNewInbound = recapNewDeals.filter(
    (c) => c.source?.toLowerCase() === "inbound",
  );
  const recapNewOutbound = recapNewDeals.filter(
    (c) => c.source?.toLowerCase() !== "inbound",
  );

  // ─── Feed derivations ───────────────────────────────────────────────────────

  const allFeedEvents = useMemo(() => {
    if (!activity) return [];
    return buildFeedEvents(activity);
  }, [activity]);

  const filteredFeedEvents = useMemo(() => {
    if (feedFilter === "all") return allFeedEvents;
    const typeMap: Record<FeedFilterKey, FeedEventType> = {
      all: "new_deal",
      new: "new_deal",
      moved: "stage_move",
      dropped: "dropped",
      notes: "note_updated",
    };
    return allFeedEvents.filter((e) => e.type === typeMap[feedFilter]);
  }, [allFeedEvents, feedFilter]);

  const groupedFeedEvents = useMemo(
    () => groupEventsByDate(filteredFeedEvents),
    [filteredFeedEvents],
  );

  // ─── Date-filtered pipeline stage counts ────────────────────────────────────

  const filteredStageCounts = useMemo((): StageCounts[] => {
    if (!activity) return stageCounts;

    const stageMap = new Map<
      string,
      { count: number; inbound: number; outbound: number }
    >();
    PIPELINE_STAGES.forEach(({ stage }) =>
      stageMap.set(stage, { count: 0, inbound: 0, outbound: 0 }),
    );

    for (const c of activity.newL0Companies) {
      const e = stageMap.get("L0")!;
      e.count += 1;
      if (c.source?.toLowerCase() === "inbound") e.inbound += 1;
      else e.outbound += 1;
    }

    for (const m of activity.pipelineMoves) {
      const { to: toStage } = parsePipelineMoveAction(m.action);
      if (!toStage) continue;
      const e = stageMap.get(toStage);
      if (!e) continue;
      e.count += 1;
      if (m.source?.toLowerCase() === "inbound") e.inbound += 1;
      else e.outbound += 1;
    }

    return PIPELINE_STAGES.map(({ stage, label }) => {
      const data = stageMap.get(stage) ?? { count: 0, inbound: 0, outbound: 0 };
      return {
        stage,
        label,
        count: data.count,
        inbound: data.inbound,
        outbound: data.outbound,
      };
    });
  }, [activity, stageCounts]);

  const displayStageCounts = filteredStageCounts;
  const displayTotal = displayStageCounts.reduce((s, x) => s + x.count, 0);
  const displayInbound = displayStageCounts.reduce(
    (s, x) => s + (x.inbound ?? 0),
    0,
  );
  const displayOutbound = displayStageCounts.reduce(
    (s, x) => s + (x.outbound ?? 0),
    0,
  );
  const displayL0 = displayStageCounts[0]?.count || 0;
  const displayL0Inbound = displayStageCounts[0]?.inbound ?? 0;
  const displayL0Outbound = displayStageCounts[0]?.outbound ?? 0;
  const stageConversions = PIPELINE_STAGES.slice(0, -1).map((stage, i) => {
    const from = displayStageCounts.find((s) => s.stage === stage.stage)?.count ?? 0;
    const to =
      displayStageCounts.find((s) => s.stage === PIPELINE_STAGES[i + 1].stage)
        ?.count ?? 0;
    return {
      label: `${stage.stage} → ${PIPELINE_STAGES[i + 1].stage}`,
      pct: from > 0 ? Math.round((to / from) * 100) : 0,
      from,
      to,
    };
  });
  const pctOfTotal = (n: number) =>
    displayTotal > 0 ? Math.round((n / displayTotal) * 100) : 0;
  const droppedByStage = (activity?.droppedDeals ?? []).reduce(
    (acc, d) => {
      const stage = d.pipeline_stage ?? "L0";
      acc[stage] = (acc[stage] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  if (loading) {
    return (
      <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground text-sm">
              Loading dashboard...
            </p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <div className="p-6 lg:p-8 space-y-8 animate-fade-in">
        {/* Header */}
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/10">
                <Layers className="h-5 w-5 text-foreground" />
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Dashboard
              </h1>
            </div>
            <p className="text-muted-foreground ml-[52px]">
              Real-time overview of your M&A deal pipeline
            </p>
          </div>

          {/* Global date range filter */}
          <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-lg border border-border/50 shrink-0 mt-1">
            {(["7d", "14d"] as PresetKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                className={[
                  "h-7 px-3 text-xs font-medium rounded-md transition-colors",
                  dateRange.preset === key
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {key === "7d" ? "7 days" : "14 days"}
              </button>
            ))}
            <Popover
              open={customPickerOpen}
              onOpenChange={(open) => {
                setCustomPickerOpen(open);
                if (open && dateRange.preset === 'custom') {
                  setCustomFrom(dateRange.from);
                  setCustomTo(dateRange.to);
                }
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={[
                    "h-7 px-3 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5",
                    dateRange.preset === "custom" || customPickerOpen
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  <CalendarIcon className="h-3 w-3 shrink-0" />
                  Custom
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-4 space-y-3" align="end">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Custom Date Range
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">From</p>
                    <div
                      className={[
                        'w-full flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                        nextRangeField === 'from'
                          ? 'border-primary ring-1 ring-primary bg-background'
                          : 'border-border bg-muted/40',
                      ].join(' ')}
                    >
                      <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span
                        className={
                          customFrom
                            ? "text-foreground"
                            : "text-muted-foreground"
                        }
                      >
                        {customFrom
                          ? customFrom.toLocaleDateString("en-GB")
                          : "DD/MM/YYYY"}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">To</p>
                    <div
                      className={[
                        'w-full flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                        nextRangeField === 'to'
                          ? 'border-primary ring-1 ring-primary bg-background'
                          : 'border-border bg-muted/40',
                      ].join(' ')}
                    >
                      <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span
                        className={
                          customTo ? "text-foreground" : "text-muted-foreground"
                        }
                      >
                        {customTo
                          ? customTo.toLocaleDateString("en-GB")
                          : "DD/MM/YYYY"}
                      </span>
                    </div>
                  </div>
                </div>
                <Calendar
                  mode="range"
                  defaultMonth={customFrom}
                  selected={{ from: customFrom, to: customTo }}
                  onSelect={(range) => {
                    setCustomFrom(range?.from);
                    setCustomTo(range?.to);
                  }}
                  disabled={(d) => d > new Date()}
                  classNames={{
                    // Highlight the picked start/end and the days in between with
                    // a light background instead of the default solid primary fill.
                    day_selected:
                      'bg-primary/15 text-primary hover:bg-primary/25 focus:bg-primary/25 rounded-md',
                    day_range_middle: 'aria-selected:bg-primary/10 aria-selected:text-foreground',
                  }}
                  initialFocus
                />
                <div className="flex gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="flex-1 h-8 text-xs"
                    onClick={() => setCustomPickerOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="flex-1 h-8 text-xs"
                    disabled={!customFrom || !customTo}
                    onClick={applyCustom}
                  >
                    Apply
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Overview section card */}
        <Card className="border bg-gradient-to-br from-muted/40 to-muted/10">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <LayoutGrid className="h-5 w-5 text-foreground" />
              <CardTitle className="text-lg font-semibold">Overview</CardTitle>
              <span className="text-sm text-muted-foreground">
                {formatDate(dateRange.from)} – {formatDate(dateRange.to)}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Total Deals */}
              <div className="rounded-xl border bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
                    <Globe className="h-4 w-4 text-blue-500" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Total Deals
                  </p>
                </div>
                <p className="text-3xl font-semibold">{displayTotal}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {activity ? "Added in period" : "Active in pipeline"}
                </p>
              </div>

              {/* Inbound */}
              <div className="rounded-xl border bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10">
                    <ArrowUpRight className="h-4 w-4 text-emerald-500" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Inbound
                  </p>
                </div>
                <p className="text-3xl font-semibold">{displayInbound}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {displayTotal > 0
                    ? Math.round((displayInbound / displayTotal) * 100)
                    : 0}
                  % of total
                </p>
              </div>

              {/* Outbound */}
              <div className="rounded-xl border bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/10">
                    <Activity className="h-4 w-4 text-rose-500" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Outbound
                  </p>
                </div>
                <p className="text-3xl font-semibold">{displayOutbound}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {displayTotal > 0
                    ? Math.round((displayOutbound / displayTotal) * 100)
                    : 0}
                  % of total
                </p>
              </div>

              {/* Conversion */}
              <div className="rounded-xl border bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10">
                    <ArrowLeftRight className="h-4 w-4 text-amber-500" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Conversion
                  </p>
                </div>
                <div className="space-y-1.5">
                  {stageConversions.map((sc) => (
                    <div
                      key={sc.label}
                      className="flex items-center justify-between"
                    >
                      <span className="text-xs text-muted-foreground">
                        {sc.label}
                      </span>
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-sm font-semibold">{sc.pct}%</span>
                        <span className="text-[10px] text-muted-foreground">
                          {sc.to}/{sc.from}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {activityInitialising ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Loading activity...
              </p>
            </div>
          </div>
        ) : activity ? (
          <>
            {/* ── 7-Day Recap Section ─────────────────────────────────────────────── */}
            <Card className="border bg-card">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-2">
                  <CalendarIcon className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-lg font-semibold">
                    {dateRange.preset === "7d"
                      ? "7-Day Recap"
                      : dateRange.preset === "14d"
                        ? "14-Day Recap"
                        : "Custom Recap"}
                  </CardTitle>
                  <span className="text-sm text-muted-foreground">
                    {formatDate(dateRange.from)} – {formatDate(dateRange.to)}
                  </span>
                </div>
              </CardHeader>

              <CardContent className="space-y-6">
                {/* 3 summary counters */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="rounded-lg border border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
                        Dropped
                      </p>
                      <AskAIButton
                        label="Analyze dropped deals with AI"
                        onClick={() => askCopilot("dropped deals")}
                      />
                    </div>
                    <p className="text-3xl font-bold mt-1">
                      {recapDropped.length}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      deals removed
                    </p>
                  </div>
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                        New Deals
                      </p>
                      <AskAIButton
                        label="Analyze new deals with AI"
                        onClick={() => askCopilot("new deals")}
                      />
                    </div>
                    <div className="flex items-end gap-4 mt-2">
                      <div>
                        <p className="text-3xl font-bold leading-none">
                          {recapNewDeals.length}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          total
                        </p>
                      </div>
                      <div className="w-px h-8 bg-emerald-200 dark:bg-emerald-800/50 self-center" />
                      <Popover>
                        <PopoverTrigger asChild>
                          <button type="button" className="text-left">
                            <p className="text-xl font-bold text-violet-600 dark:text-violet-400 leading-none underline decoration-dotted underline-offset-2">
                              {recapNewInbound.length}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Inbound
                            </p>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64 p-3" align="start">
                          <p className="text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400 mb-2">
                            Inbound · New Deals
                          </p>
                          {recapNewInbound.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No inbound deals this period
                            </p>
                          ) : (
                            <div className="space-y-0">
                              {recapNewInbound.map((c) => (
                                <div
                                  key={`${c.id}-${c.event_at}`}
                                  className="flex items-start justify-between gap-2 py-2 border-b border-border/40 last:border-0"
                                >
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-semibold truncate">
                                      {c.target || c.project_name || "—"}
                                    </p>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      {c.segment && (
                                        <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-medium">
                                          {c.segment}
                                        </span>
                                      )}
                                      {c.geography && (
                                        <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-medium">
                                          {c.geography}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
                                    {formatShortDate(c.event_at)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </PopoverContent>
                      </Popover>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button type="button" className="text-left">
                            <p className="text-xl font-bold text-blue-600 dark:text-blue-400 leading-none underline decoration-dotted underline-offset-2">
                              {recapNewOutbound.length}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Outbound
                            </p>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64 p-3" align="start">
                          <p className="text-xs font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-2">
                            Outbound · New Deals
                          </p>
                          {recapNewOutbound.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No outbound deals this period
                            </p>
                          ) : (
                            <div className="space-y-0">
                              {recapNewOutbound.map((c) => (
                                <div
                                  key={`${c.id}-${c.event_at}`}
                                  className="flex items-start justify-between gap-2 py-2 border-b border-border/40 last:border-0"
                                >
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-semibold truncate">
                                      {c.target || c.project_name || "—"}
                                    </p>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      {c.segment && (
                                        <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-medium">
                                          {c.segment}
                                        </span>
                                      )}
                                      {c.geography && (
                                        <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-medium">
                                          {c.geography}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
                                    {formatShortDate(c.event_at)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                  <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900/50 dark:bg-blue-950/20 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">
                        Stage Moves
                      </p>
                      <AskAIButton
                        label="Analyze stage moves with AI"
                        onClick={() => askCopilot("stage moves")}
                      />
                    </div>
                    <p className="text-3xl font-bold mt-1">
                      {recapStageMoves.length}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      pipeline movements
                    </p>
                  </div>
                </div>

                {/* 3 detail columns side-by-side */}
                <div className="grid grid-cols-3 gap-6">
                  {/* Dropped Deals Column */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-red-500" />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Dropped Deals
                      </span>
                    </div>
                    <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                      {recapDropped.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          No dropped deals
                        </p>
                      ) : (
                        recapDropped.map((d) => (
                          <div
                            key={d.id}
                            className="flex items-start gap-2 p-2 rounded-lg hover:bg-muted/40 transition-colors cursor-pointer"
                            onClick={() => handleCompanyClick(d.id)}
                          >
                            <div className="flex h-6 w-6 items-center justify-center rounded bg-red-100 dark:bg-red-900/30 shrink-0">
                              <XCircle className="h-3.5 w-3.5 text-red-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-sm font-medium truncate">
                                  {d.target || d.project_name || "—"}
                                </p>
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {formatShortDate(d.dropped_at)}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                <SourceChip source={d.source} />
                                {d.segment && (
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px] px-1.5 py-0 h-4"
                                  >
                                    {d.segment}
                                  </Badge>
                                )}
                                {d.geography && (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] px-1.5 py-0 h-4"
                                  >
                                    {d.geography}
                                  </Badge>
                                )}
                              </div>
                              {d.pipeline_stage && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  Dropped at {d.pipeline_stage}
                                </p>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* New Deals Column */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        New Deals This Week
                      </span>
                    </div>
                    <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                      {recapNewDeals.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          No new deals
                        </p>
                      ) : (
                        recapNewDeals.map((c) => (
                          <div
                            key={`${c.id}-${c.event_at}`}
                            className="flex items-start gap-2 p-2 rounded-lg hover:bg-muted/40 transition-colors cursor-pointer"
                            onClick={() => handleCompanyClick(c.id)}
                          >
                            <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-100 dark:bg-emerald-900/30 shrink-0">
                              <span className="text-emerald-600 dark:text-emerald-400 text-sm font-bold">
                                +
                              </span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-sm font-medium truncate">
                                  {c.target || c.project_name || "—"}
                                </p>
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {formatShortDate(c.event_at)}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                <SourceChip source={c.source} />
                                {c.segment && (
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px] px-1.5 py-0 h-4"
                                  >
                                    {c.segment}
                                  </Badge>
                                )}
                                {c.geography && (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] px-1.5 py-0 h-4"
                                  >
                                    {c.geography}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Pipeline Stage Movements Column */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-blue-500" />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Pipeline Stage Movements
                      </span>
                    </div>
                    <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                      {recapStageMoves.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          No stage movements
                        </p>
                      ) : (
                        recapStageMoves.map((m) => {
                          const { from: fromStage, to: toStage } =
                            parsePipelineMoveAction(m.action);
                          return (
                            <div
                              key={m.id}
                              className="flex items-start gap-2 p-2 rounded-lg hover:bg-muted/40 transition-colors cursor-pointer"
                              onClick={() =>
                                m.company_id && handleCompanyClick(m.company_id)
                              }
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-sm font-medium truncate">
                                    {m.target || m.project_name || "—"}
                                  </p>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {fromStage && (
                                      <StageChip stage={fromStage} />
                                    )}
                                    {fromStage && toStage && (
                                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                    )}
                                    {toStage && <StageChip stage={toStage} />}
                                    <span className="text-xs text-muted-foreground ml-1">
                                      {formatShortDate(m.created_at)}
                                    </span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                  <SourceChip source={m.source} />
                                  {m.geography && (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] px-1.5 py-0 h-4"
                                    >
                                      {m.geography}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ── Pipeline Stages ────────────────────────────────────────────── */}
            <Card className="border bg-card">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-3">
                  <CardTitle className="flex items-center gap-3 text-lg font-semibold">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                      <TrendingUp className="h-4 w-4 text-primary" />
                    </div>
                    Pipeline Stages
                  </CardTitle>
                  <span className="text-sm text-muted-foreground">
                    {formatDate(dateRange.from)} – {formatDate(dateRange.to)}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                {displayTotal === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Building2 className="mx-auto h-12 w-12 mb-4 opacity-40" />
                    <p className="text-base font-medium">
                      No pipeline activity in this period.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-stretch gap-3">
                    {/* L0 · Sourcing — split into inbound / outbound */}
                    <div className="flex w-[180px] shrink-0 flex-col gap-2">
                      <p className="text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        L0 · Sourcing
                      </p>
                      <Link
                        href="/pipeline?stage=L0"
                        className="flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl bg-gradient-to-br from-indigo-400 to-indigo-600 p-3 text-white no-underline transition-transform hover:scale-[1.02]"
                      >
                        <span className="text-[10px] font-bold uppercase tracking-wide opacity-90">
                          Inbound
                        </span>
                        <span className="text-2xl font-extrabold leading-none">
                          {displayL0Inbound}
                        </span>
                        <span className="text-[10px] text-white/70">
                          {pctOfTotal(displayL0Inbound)}% of total
                        </span>
                      </Link>
                      <Link
                        href="/pipeline?stage=L0"
                        className="flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl bg-gradient-to-br from-blue-400 to-blue-600 p-3 text-white no-underline transition-transform hover:scale-[1.02]"
                      >
                        <span className="text-[10px] font-bold uppercase tracking-wide opacity-90">
                          Outbound
                        </span>
                        <span className="text-2xl font-extrabold leading-none">
                          {displayL0Outbound}
                        </span>
                        <span className="text-[10px] text-white/70">
                          {pctOfTotal(displayL0Outbound)}% of total
                        </span>
                      </Link>
                      {(droppedByStage["L0"] ?? 0) > 0 && (
                        <div className="flex items-center justify-between rounded-md bg-red-500/10 px-2 py-1 text-[10px] font-bold text-red-600 dark:text-red-400">
                          <span>DROPPED</span>
                          <span>{droppedByStage["L0"]}</span>
                        </div>
                      )}
                    </div>

                    {/* divider */}
                    <div className="w-px shrink-0 bg-border" />

                    {/* L1 – L5 stage columns */}
                    <div className="flex flex-1 items-stretch gap-2">
                      {displayStageCounts.slice(1).map((item) => {
                        const pills = stagePillColors[item.stage] ?? {
                          inbound: "bg-gray-400",
                          outbound: "bg-gray-300",
                        };
                        const conversionPercentStage =
                          displayL0 > 0
                            ? Math.round((item.count / displayL0) * 100)
                            : 0;
                        return (
                          <Link
                            key={item.stage}
                            href={`/pipeline?stage=${item.stage}`}
                            className="group flex flex-1 flex-col items-center gap-1 no-underline text-inherit"
                          >
                            <div className="text-center">
                              <div className="text-lg font-bold transition-transform group-hover:scale-110">
                                {item.count}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {conversionPercentStage}%
                              </div>
                            </div>
                            <div className="flex w-full flex-1 flex-col gap-1">
                              <div
                                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[10px] font-bold text-white ${pills.inbound}`}
                              >
                                <span>IN</span>
                                <span>{item.inbound || 0}</span>
                              </div>
                              <div
                                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[10px] font-bold text-white ${pills.outbound}`}
                              >
                                <span>OUT</span>
                                <span>{item.outbound || 0}</span>
                              </div>
                            </div>
                            {(droppedByStage[item.stage] ?? 0) > 0 && (
                              <div className="flex w-full items-center justify-between rounded-md bg-red-500/10 px-2 py-1 text-[10px] font-bold text-red-600 dark:text-red-400">
                                <span>DROPPED</span>
                                <span>{droppedByStage[item.stage]}</span>
                              </div>
                            )}
                            <div className="mt-1 text-sm font-bold">
                              {item.stage}
                            </div>
                            <div className="text-center text-[10px] text-muted-foreground">
                              {item.label}
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Activity Feed ──────────────────────────────────────────────── */}
            <Card className="border bg-card">
              <CardHeader className="pb-4">
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Clock className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-lg font-semibold">
                      Activity Feed
                    </CardTitle>
                    <span className="text-sm text-muted-foreground">
                      {formatDate(dateRange.from)} – {formatDate(dateRange.to)}
                    </span>
                  </div>

                  {/* Filter pills */}
                  <div className="flex items-center gap-2">
                    {(
                      [
                        "all",
                        "new",
                        "moved",
                        "dropped",
                        "notes",
                      ] as FeedFilterKey[]
                    ).map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setFeedFilter(key)}
                        className={[
                          "h-7 px-3 text-xs font-medium rounded-full transition-colors",
                          feedFilter === key
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:text-foreground",
                        ].join(" ")}
                      >
                        {key === "all"
                          ? "All"
                          : key === "new"
                            ? "New"
                            : key === "moved"
                              ? "Moved"
                              : key === "dropped"
                                ? "Dropped"
                                : "Notes"}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="pt-0">
                {/* Events — scrollable canvas capped at ~70vh */}
                <div className="space-y-0 max-h-[70vh] overflow-y-auto pr-1">
                  {groupedFeedEvents.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <p className="text-sm">No activity in this period</p>
                    </div>
                  ) : (
                    groupedFeedEvents.map(({ dateLabel, events }) => (
                      <div key={dateLabel}>
                        {/* Date header */}
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pt-4 pb-2">
                          {new Date(events[0]?.event_at)
                            .toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                            .toUpperCase()
                            .replace(",", "")}
                        </p>

                        {/* Events for this date */}
                        {events.map((event) => (
                          <FeedEventRow
                            key={event.id}
                            event={event}
                            onCompanyClick={handleCompanyClick}
                          />
                        ))}
                      </div>
                    ))
                  )}

                  {/* End of feed marker */}
                  {groupedFeedEvents.length > 0 && (
                    <div className="text-center py-8">
                      <span className="text-sm text-muted-foreground">
                        — End of recent activity —
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>

      {selectedCompany && (
        <CompanyDetailDialog
          company={selectedCompany}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onUpdate={fetchPipelineData}
        />
      )}
    </DashboardLayout>
  );
}

// ─── FeedEventRow ─────────────────────────────────────────────────────────────

interface FeedEventRowProps {
  event: FeedEvent;
  onCompanyClick: (id: string) => void;
}

const eventTypeBadgeStyles: Record<FeedEventType, string> = {
  new_deal:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  stage_move:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  dropped: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  note_updated:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

const eventTypeBadgeLabels: Record<FeedEventType, string> = {
  new_deal: "NEW DEAL",
  stage_move: "STAGE MOVE",
  dropped: "DROPPED",
  note_updated: "NOTE UPDATED",
};

// ─── Financial summary row ────────────────────────────────────────────────────

function FinancialSummary({
  revenue,
  ebitda,
  ev,
  year,
}: {
  revenue?: number | null;
  ebitda?: number | null;
  ev?: number | null;
  year?: number | null;
}) {
  const metrics: { label: string; value: string | null }[] = [
    { label: "Rev", value: formatUsdMn(revenue) },
    { label: "EBITDA", value: formatUsdMn(ebitda) },
    { label: "EV", value: formatUsdMn(ev) },
  ];

  // Hide the row entirely when no figures are available for this company.
  if (metrics.every((m) => m.value === null)) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {metrics.map((m) => (
        <span key={m.label}>
          <span className="font-semibold text-foreground/80">{m.label}</span>{" "}
          {year != null && (
            <span className="text-[10px] text-muted-foreground/70">
              ({year})
            </span>
          )}{" "}
          {m.value ?? (
            <span className="italic text-muted-foreground/60">N/A</span>
          )}
        </span>
      ))}
    </div>
  );
}

function FeedEventRow({ event, onCompanyClick }: FeedEventRowProps) {
  const inlineNote =
    event.type === "note_updated"
      ? event.note_content
      : (event.remarks ?? null);

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/40 last:border-b-0">
      {/* Color dot */}
      <div className="mt-1.5 shrink-0">
        <div className={`h-2.5 w-2.5 rounded-full ${dotColors[event.type]}`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1.5">
        {/* Company name */}
        <button
          type="button"
          onClick={() => onCompanyClick(event.company_id)}
          className="text-sm font-semibold text-left hover:text-primary transition-colors block"
        >
          {event.company_name}
        </button>

        {/* Event detail line */}
        <div className="flex items-center gap-2 flex-wrap">
          {event.type === "stage_move" && (
            <>
              {event.from_stage && <StageChip stage={event.from_stage} />}
              {event.from_stage && event.to_stage && (
                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
              {event.to_stage && <StageChip stage={event.to_stage} />}
            </>
          )}

          {event.type === "dropped" && (
            <>
              <span className="text-xs text-muted-foreground">Dropped at</span>
              {event.dropped_stage && <StageChip stage={event.dropped_stage} />}
            </>
          )}
        </div>

        {/* Inline note / remarks */}
        {inlineNote && (
          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
            {inlineNote}
          </p>
        )}

        {/* Financial summary — Rev / EBITDA / EV for the company's reported year */}
        <FinancialSummary
          revenue={event.revenue_usd_mn}
          ebitda={event.ebitda_usd_mn}
          ev={event.ev_usd_mn}
          year={event.financial_year}
        />

        {/* Event type badge + metadata badges */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${eventTypeBadgeStyles[event.type]}`}
          >
            {eventTypeBadgeLabels[event.type]}
          </span>
          <SourceChip source={event.source} />
          {event.geography && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 font-normal"
            >
              {event.geography}
            </Badge>
          )}
          {event.segment && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 font-normal"
            >
              {event.segment}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}
