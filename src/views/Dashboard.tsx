"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceLink } from "@/components/WorkspaceLink";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";
import { useRouter } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import { useWorkspaceCurrency } from "@/components/layout/WorkspaceCurrencyContext";
import type { Currency } from "@/lib/currency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import {
  getCompanyTimeline,
  getDailyPulse,
  refreshDailyPulse,
  getDashboardActivity,
  getDashboardFeed,
  getDashboardOverview,
} from "@/lib/api/dashboard";
import type {
  DashboardActivity,
  DashboardOverview,
  FeedFilter,
} from "@/lib/services/dashboardActivityService";
import type { DailyPulse } from "@/lib/services/dailyPulseService";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import CompanyDetailDialog, {
  type CompanyData,
} from "@/components/pipeline/CompanyDetailDialog";
import InsightsModule from "@/components/dashboard/InsightsModule";
import {
  Building2,
  TrendingUp,
  Loader2,
  Layers,
  Activity,
  XCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MoveRight,
  FileText,
  CalendarIcon,
  Clock,
  ArrowLeftRight,
  Sparkles,
} from "lucide-react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "@/components/ui/carousel";
import { useChatContext } from "@/components/chat/ChatProvider";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { companyDisplayName, companyInitials } from "@/lib/companyDisplay";

interface StageCounts {
  stage: string;
  label: string;
  count: number;
  inbound?: number;
  outbound?: number;
}

const PIPELINE_STAGES: { stage: string; label: string; color: string }[] = [
  { stage: "L0", label: "Sourcing", color: "bg-blue-500" },
  { stage: "L1", label: "Screening", color: "bg-blue-500" },
  { stage: "L2", label: "Initial Review", color: "bg-amber-500" },
  { stage: "L3", label: "Due Diligence", color: "bg-green-500" },
  { stage: "L4", label: "Negotiation", color: "bg-teal-500" },
  { stage: "L5", label: "Closing", color: "bg-pink-500" },
];

// Solid pill colors for the L1–L5 stage columns (inbound = darker, outbound = lighter).
const stagePillColors: Record<string, { inbound: string; outbound: string }> = {
  L0: { inbound: "bg-blue-500", outbound: "bg-blue-300" },
  L1: { inbound: "bg-blue-500", outbound: "bg-blue-300" },
  L2: { inbound: "bg-amber-500", outbound: "bg-amber-300" },
  L3: { inbound: "bg-emerald-500", outbound: "bg-emerald-300" },
  L4: { inbound: "bg-cyan-500", outbound: "bg-cyan-300" },
  L5: { inbound: "bg-pink-500", outbound: "bg-pink-300" },
};

type PresetKey = "7d" | "30d" | "mtd" | "ytd";

// Quick-query presets shown above the calendar, in display order.
const PRESET_KEYS: PresetKey[] = ["ytd", "mtd", "30d", "7d"];

const PRESET_LABELS: Record<PresetKey, string> = {
  ytd: "Year-to-date",
  mtd: "Month-to-date",
  "30d": "30 days ago",
  "7d": "7 days ago",
};

// Recap card heading per preset — phrased for a title rather than a button.
const PRESET_RECAP_TITLES: Record<PresetKey, string> = {
  ytd: "Year-to-Date Recap",
  mtd: "Month-to-Date Recap",
  "30d": "30-Day Recap",
  "7d": "7-Day Recap",
};

interface ActiveDateRange {
  from: Date;
  to: Date;
  preset: PresetKey | "custom";
}

function presetToRange(key: PresetKey): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  switch (key) {
    case "7d":
      from.setDate(from.getDate() - 7);
      break;
    case "30d":
      from.setDate(from.getDate() - 30);
      break;
    case "mtd":
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      break;
    case "ytd":
      from.setMonth(0, 1);
      from.setHours(0, 0, 0, 0);
      break;
  }
  return { from, to };
}

/** Format a Date as `DD/MM/YYYY` for the type-able range inputs. */
function formatDMY(d: Date | undefined): string {
  if (!d) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Parse a `DD/MM/YYYY` string into a Date, or undefined when malformed. */
function parseDMY(text: string): Date | undefined {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  // Reject overflow dates like 31/02/2026 that Date silently rolls over.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return undefined;
  }
  return d;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Today's Recap (daily pulse) rendering helpers ─────────────────────────────

/** Collapsed height (px) of the recap prose before a "Read more" toggle appears.
 * Matches the `max-h-40` clamp (10rem) applied to the collapsed body. */
const PULSE_COLLAPSED_MAX_PX = 160;

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

type FeedEventType =
  | "new_deal"
  | "stage_move"
  | "dropped"
  | "note_updated"
  | "ai_discovered";
type FeedFilterKey = "all" | "new" | "moved" | "dropped" | "notes";

interface FeedEvent {
  id: string;
  type: FeedEventType;
  company_id: string;
  company_name: string;
  logo_url: string | null;
  segment: string | null;
  geography: string | null;
  source: string | null;
  event_at: string;
  from_stage?: string | null;
  to_stage?: string | null;
  dropped_stage?: string | null;
  dropped_reason?: string | null;
  remarks?: string | null;
  thesis_content?: string | null;
  promoted_reasons?: string | null;
  note_content?: string | null;
  note_stage?: string | null;
  revenue_usd_mn?: number | null;
  ebitda_usd_mn?: number | null;
  ev_usd_mn?: number | null;
  financial_year?: number | null;
  /** The company's status **today**, not at the time this event happened —
   * drives the "new"/"moved"/"dropped" filters, which key off where a
   * company presently sits rather than which event fired in the window. */
  current_status?: "active" | "dropped" | null;
  /** The company's pipeline stage **today**, not at the time this event
   * happened — see {@link current_status}. */
  current_pipeline_stage?: string | null;
}

/**
 * Whether `event`'s company is *presently* in the lifecycle state named by
 * `filterKey` (`"new"` | `"moved"` | `"dropped"`) — not whether this
 * particular event's own type matches. A company can pick up several
 * lifecycle events within one window (e.g. promoted, then dropped); this
 * looks at where it landed, not every step along the way, so it only ever
 * matches one of the three buckets.
 */
function matchesCurrentStatus(
  event: FeedEvent,
  filterKey: "new" | "moved" | "dropped",
): boolean {
  if (filterKey === "dropped") return event.current_status === "dropped";
  if (event.current_status !== "active") return false;
  if (filterKey === "new") return event.current_pipeline_stage === "L0";
  return (
    event.current_pipeline_stage != null &&
    event.current_pipeline_stage !== "L0"
  );
}

/** Format a millions figure as `IDR 4.9B` / `USD 312M`, or null when absent.
 * The code prefix follows the workspace display currency (relabel only — the
 * underlying value is not converted). */
function formatUsdMn(value: number | null | undefined, currency: Currency): string | null {
  if (value === null || value === undefined) return null;
  if (Math.abs(value) >= 1000) return `${currency} ${(value / 1000).toFixed(1)}B`;
  return `${currency} ${Math.round(value)}M`;
}

function buildFeedEvents(activity: DashboardActivity): FeedEvent[] {
  const events: FeedEvent[] = [];

  for (const c of activity.discoveredCompanies) {
    if (!c.event_at) continue;
    events.push({
      id: `discovered-${c.id}-${c.event_at}`,
      type: "ai_discovered",
      company_id: c.id,
      company_name: companyDisplayName(c, "—"),
      logo_url: c.logo_url ?? null,
      segment: c.segment ?? null,
      geography: c.geography ?? null,
      source: c.source ?? null,
      event_at: c.event_at,
      remarks: c.remarks ?? null,
      thesis_content: c.thesis_content ?? null,
      revenue_usd_mn: c.revenue_usd_mn ?? null,
      ebitda_usd_mn: c.ebitda_usd_mn ?? null,
      ev_usd_mn: c.ev_usd_mn ?? null,
      financial_year: c.financial_year ?? null,
    });
  }

  for (const c of activity.newL0Companies) {
    events.push({
      id: `new-${c.id}-${c.event_at}`,
      type: "new_deal",
      company_id: c.id,
      company_name: companyDisplayName(c, "—"),
      logo_url: c.logo_url ?? null,
      segment: c.segment ?? null,
      geography: c.geography ?? null,
      source: c.source ?? null,
      event_at: c.event_at,
      remarks: c.remarks ?? null,
      thesis_content: c.thesis_content ?? null,
      revenue_usd_mn: c.revenue_usd_mn ?? null,
      ebitda_usd_mn: c.ebitda_usd_mn ?? null,
      ev_usd_mn: c.ev_usd_mn ?? null,
      financial_year: c.financial_year ?? null,
      current_status: c.status ?? null,
      current_pipeline_stage: c.pipeline_stage ?? null,
    });
  }

  for (const m of activity.pipelineMoves) {
    if (!m.created_at) continue;
    const { from: fromStage, to: toStage } = parsePipelineMoveAction(m.action);
    events.push({
      id: `move-${m.id}`,
      type: "stage_move",
      company_id: m.company_id ?? "",
      company_name: companyDisplayName(m, "—"),
      logo_url: m.logo_url ?? null,
      segment: m.segment ?? null,
      geography: m.geography ?? null,
      source: m.source ?? null,
      event_at: m.created_at,
      from_stage: fromStage,
      to_stage: toStage,
      remarks: m.remarks ?? null,
      thesis_content: m.thesis_content ?? null,
      promoted_reasons: m.promoted_reasons ?? null,
      revenue_usd_mn: m.revenue_usd_mn ?? null,
      ebitda_usd_mn: m.ebitda_usd_mn ?? null,
      ev_usd_mn: m.ev_usd_mn ?? null,
      financial_year: m.financial_year ?? null,
      current_status: m.status ?? null,
      current_pipeline_stage: m.pipeline_stage ?? null,
    });
  }

  for (const d of activity.droppedDeals) {
    if (!d.dropped_at) continue;
    events.push({
      id: `dropped-${d.id}`,
      type: "dropped",
      company_id: d.id,
      company_name: companyDisplayName(d, "—"),
      logo_url: d.logo_url ?? null,
      segment: d.segment ?? null,
      geography: d.geography ?? null,
      source: d.source ?? null,
      event_at: d.dropped_at,
      dropped_stage: d.pipeline_stage ?? null,
      dropped_reason: d.dropped_reason ?? null,
      remarks: d.remarks ?? null,
      thesis_content: d.thesis_content ?? null,
      revenue_usd_mn: d.revenue_usd_mn ?? null,
      ebitda_usd_mn: d.ebitda_usd_mn ?? null,
      ev_usd_mn: d.ev_usd_mn ?? null,
      financial_year: d.financial_year ?? null,
      current_status: d.status ?? null,
      current_pipeline_stage: d.pipeline_stage ?? null,
    });
  }

  for (const n of activity.notesUpdated) {
    if (!n.created_at) continue;
    events.push({
      id: `note-${n.id}`,
      type: "note_updated",
      company_id: n.company_id,
      company_name: companyDisplayName(n, "—"),
      logo_url: n.logo_url ?? null,
      segment: n.segment ?? null,
      geography: n.geography ?? null,
      source: n.source ?? null,
      event_at: n.created_at,
      note_content: n.content ?? null,
      note_stage: n.stage ?? null,
      remarks: n.remarks ?? null,
      thesis_content: n.thesis_content ?? null,
      revenue_usd_mn: n.revenue_usd_mn ?? null,
      ebitda_usd_mn: n.ebitda_usd_mn ?? null,
      ev_usd_mn: n.ev_usd_mn ?? null,
      financial_year: n.financial_year ?? null,
      current_status: n.status ?? null,
      current_pipeline_stage: n.pipeline_stage ?? null,
    });
  }

  return events.sort((a, b) => b.event_at.localeCompare(a.event_at));
}

// A single company's slice of the feed: every event that touched it, ordered
// oldest → newest (the carousel reads "from the beginning to the end").
interface CompanyFeedGroup {
  company_id: string;
  company_name: string;
  /** Latest analysis logo for the company, when one exists. */
  logo_url: string | null;
  /** Chronological, oldest first. */
  events: FeedEvent[];
  /** ISO timestamp of the most recent event — drives feed/date ordering. */
  latestEventAt: string;
}

// Collapse a newest-first event list into one group per company, so a company
// never appears more than once in the feed. Companies come out ordered by their
// most recent event (newest first); each group's events are oldest → newest.
function groupEventsByCompany(events: FeedEvent[]): CompanyFeedGroup[] {
  const groups: CompanyFeedGroup[] = [];
  const seen = new Map<string, number>();
  for (const event of events) {
    if (seen.has(event.company_id)) {
      groups[seen.get(event.company_id)!].events.push(event);
    } else {
      seen.set(event.company_id, groups.length);
      // First encounter wins for ordering: with a newest-first input this is the
      // company's latest event.
      groups.push({
        company_id: event.company_id,
        company_name: event.company_name,
        logo_url: event.logo_url,
        events: [event],
        latestEventAt: event.event_at,
      });
    }
  }
  // Input is newest-first, so each group collected events newest → oldest;
  // reverse to read chronologically.
  for (const group of groups) group.events.reverse();
  return groups;
}

// Bucket company groups (already ordered newest-first by latest activity) under
// a date header derived from each company's most recent event.
function groupCompaniesByDate(
  companies: CompanyFeedGroup[],
): { dateLabel: string; companies: CompanyFeedGroup[] }[] {
  const groups: { dateLabel: string; companies: CompanyFeedGroup[] }[] = [];
  const seen = new Map<string, number>();
  for (const company of companies) {
    const label = new Date(company.latestEventAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    if (seen.has(label)) {
      groups[seen.get(label)!].companies.push(company);
    } else {
      seen.set(label, groups.length);
      groups.push({ dateLabel: label, companies: [company] });
    }
  }
  return groups;
}

// Per-slide date label (e.g. "MAR 1 2026") shown on carousel event cards, whose
// individual dates differ from the company's date-section header.
function formatFeedEventDate(iso: string): string {
  return new Date(iso)
    .toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .replace(",", "");
}

// ─── Stage chip ──────────────────────────────────────────────────────────────

const stageChipColors: Record<string, string> = {
  L0: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  L1: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  L2: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  L3: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  L4: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  L5: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
};

// Stages below L0 (e.g. "unreviewed") aren't part of the L0–L5 funnel — surface
// them as "pre-L0" so drop messaging reads "Dropped at pre-L0".
function stageLabel(stage: string): string {
  return stage in stageChipColors ? stage : "pre-L0";
}

function StageChip({ stage }: { stage: string }) {
  const label = stageLabel(stage);
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${stageChipColors[stage] ?? "bg-muted text-muted-foreground"}`}
    >
      {label}
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
          ? "text-[10px] px-1.5 py-0.5 min-h-4 capitalize bg-emerald-500/20 text-emerald-600 hover:bg-emerald-500/30"
          : "text-[10px] px-1.5 py-0.5 min-h-4 capitalize bg-blue-500/20 text-blue-600 hover:bg-blue-500/30"
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
  ai_discovered: "bg-blue-500",
};

const eventTypeLabels: Record<FeedEventType, string> = {
  new_deal: "New Deal",
  stage_move: "Stage Move",
  dropped: "Dropped",
  note_updated: "Note Updated",
  ai_discovered: "AI Discovered",
};

// ─── Ask-AI button ───────────────────────────────────────────────────────────

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
              className={`text-xs ${isDropped
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
  showInsightsDashboard?: boolean;
}

export default function Dashboard({
  showInsightsDashboard = false,
}: DashboardProps) {
  const [loading, setLoading] = useState(true);
  const [activityInitialising, setActivityInitialising] = useState(true);
  const [companies, setCompanies] = useState<any[]>([]);
  const [totalCompanies, setTotalCompanies] = useState(0);
  const [stageCounts, setStageCounts] = useState<StageCounts[]>([]);
  const [activity, setActivity] = useState<DashboardActivity | null>(null);
  // Cohort snapshot backing the tally sections (Total Companies Added, Recap,
  // Pipeline Stages). All three derive from this single payload so they tally.
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(
    null,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const router = useRouter();
  const isMobile = useIsMobile();
  const pipelineHref = useWorkspaceHref("/pipeline");
  const dashboardHref = useWorkspaceHref("/dashboard");

  // Date range
  const defaultRange = presetToRange("7d");
  const [dateRange, setDateRange] = useState<ActiveDateRange>({
    ...defaultRange,
    preset: "7d",
  });
  const [customFrom, setCustomFrom] = useState<Date | undefined>(undefined);
  const [customTo, setCustomTo] = useState<Date | undefined>(undefined);
  const [customPickerOpen, setCustomPickerOpen] = useState(false);
  // Mirror of the From/To dates as raw text so the fields are type-able.
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");

  // Feed
  const [feedFilter, setFeedFilter] = useState<FeedFilterKey>("all");

  // Today's Recap — the daily pipeline pulse. Independent of the date range
  // filter (always a trailing-7d-vs-prior-7d view ending today), cached
  // server-side once per day.
  const [pulse, setPulse] = useState<DailyPulse | null>(null);
  const [pulseLoading, setPulseLoading] = useState(true);
  const [pulseError, setPulseError] = useState(false);
  // The recap is generated once a day by the cron; a plain read returns null
  // until then. `pulseGenerating` covers the on-demand "Generate now" run, which
  // triggers the (slow) inline agent generation.
  const [pulseGenerating, setPulseGenerating] = useState(false);
  // "Read more / See less" for the recap prose: expand state + whether the body
  // actually overflows the collapsed clamp (measured, so the toggle only shows
  // when there's more to read).
  const [pulseExpanded, setPulseExpanded] = useState(false);
  const [pulseOverflowing, setPulseOverflowing] = useState(false);
  const pulseObserverRef = useRef<ResizeObserver | null>(null);

  // Measure whether the recap prose overflows the collapsed clamp, so "Read
  // more" only shows when there's more to read. This is a CALLBACK ref, not an
  // effect keyed on `pulse`: the view early-returns a page spinner while the
  // companies fetch is in flight, so the fast (cached) pulse often resolves
  // before the recap card is mounted — a `[pulse]`-keyed effect then measures
  // a null ref, and with `pulse` never changing again it would never re-run.
  // The callback ref fires exactly when the body div actually mounts (and on
  // unmount with null), so the measurement can't miss it. The ResizeObserver
  // re-measures on any later size change (font swap, content update);
  // `scrollHeight` reports full content height even while the parent is clamped.
  const pulseBodyRef = useCallback((node: HTMLDivElement | null) => {
    pulseObserverRef.current?.disconnect();
    pulseObserverRef.current = null;
    if (!node) {
      setPulseOverflowing(false);
      return;
    }
    const measure = () =>
      setPulseOverflowing(node.scrollHeight > PULSE_COLLAPSED_MAX_PX + 8);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    pulseObserverRef.current = observer;
  }, []);

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
        // Fetch the activity feed and the cohort snapshot together so the tally
        // sections (which need `overview`) and the feed render in one pass.
        const [activityData, overviewData] = await Promise.all([
          getDashboardActivity({ from: range.from, to: range.to }),
          getDashboardOverview({ from: range.from, to: range.to }),
        ]);
        setActivity(activityData);
        setOverview(overviewData);
      } catch (error) {
        console.error("Error fetching activity:", error);
      } finally {
        if (initialLoad) setActivityInitialising(false);
      }
    },
    [],
  );

  const fetchPulse = useCallback(async () => {
    setPulseLoading(true);
    setPulseError(false);
    try {
      const data = await getDailyPulse();
      setPulse(data);
    } catch (error) {
      console.error("Error fetching daily pulse:", error);
      setPulseError(true);
    } finally {
      setPulseLoading(false);
    }
  }, []);

  // On-demand generation for the "Generate now" action (miss) and error retry.
  // Runs the inline agent, so it can take tens of seconds — hence its own state.
  const generatePulse = useCallback(async () => {
    setPulseGenerating(true);
    setPulseError(false);
    try {
      const data = await refreshDailyPulse();
      setPulse(data);
    } catch (error) {
      console.error("Error generating daily pulse:", error);
      setPulseError(true);
    } finally {
      setPulseGenerating(false);
    }
  }, []);

  const handleCompanyClick = useCallback(
    async (id: string) => {
      // On mobile, open the full-screen company profile instead of the dialog.
      // Back returns here to the activity feed (dashboard).
      if (isMobile) {
        router.push(`${pipelineHref}/${id}?from=${encodeURIComponent(dashboardHref)}`);
        return;
      }
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
    [companies, isMobile, router, pipelineHref, dashboardHref],
  );

  useEffect(() => {
    fetchPipelineData();
  }, [fetchPipelineData]);

  useEffect(() => {
    fetchPulse();
  }, [fetchPulse]);

  // Collapse the recap whenever its content changes, so a newly loaded pulse
  // always starts clamped with the "Read more" affordance.
  useEffect(() => {
    setPulseExpanded(false);
  }, [pulse]);

  const isFirstLoad = activity === null;
  useEffect(() => {
    fetchActivity(dateRange, isFirstLoad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange, fetchActivity]);

  const applyPreset = (key: PresetKey) => {
    const range = presetToRange(key);
    setDateRange({ ...range, preset: key });
    setCustomPickerOpen(false);
  };

  const shiftDateRange = (direction: "left" | "right") => {
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysDiff = Math.round(
      (dateRange.to.getTime() - dateRange.from.getTime()) / msPerDay,
    );
    const msOffset = daysDiff * msPerDay;
    if (direction === "left") {
      setDateRange({
        from: new Date(dateRange.from.getTime() - msOffset),
        to: new Date(dateRange.to.getTime() - msOffset),
        preset: "custom",
      });
    } else {
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const newTo = new Date(
        Math.min(dateRange.to.getTime() + msOffset, todayEnd.getTime()),
      );
      const newFrom = new Date(newTo.getTime() - msOffset);
      setDateRange({ from: newFrom, to: newTo, preset: "custom" });
    }
  };

  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    const to = new Date(customTo);
    to.setHours(23, 59, 59, 999);
    setDateRange({ from: customFrom, to, preset: "custom" });
    setCustomPickerOpen(false);
  };

  // Set both the canonical Date and its text mirror for a range field.
  const setFromDate = (d: Date | undefined) => {
    setCustomFrom(d);
    setFromText(formatDMY(d));
  };
  const setToDate = (d: Date | undefined) => {
    setCustomTo(d);
    setToText(formatDMY(d));
  };

  // Typing in a field: keep the raw text, and update the Date only when the
  // input parses cleanly (or clears the Date when the field is emptied).
  const handleFromText = (value: string) => {
    setFromText(value);
    if (value.trim() === "") return setCustomFrom(undefined);
    const parsed = parseDMY(value);
    if (parsed) setCustomFrom(parsed);
  };
  const handleToText = (value: string) => {
    setToText(value);
    if (value.trim() === "") return setCustomTo(undefined);
    const parsed = parseDMY(value);
    if (parsed) setCustomTo(parsed);
  };

  const setToToday = () => setToDate(new Date());

  // The label shown on the picker trigger — a preset name or the custom range.
  const activeRangeLabel =
    dateRange.preset === "custom"
      ? `${formatDate(dateRange.from)} – ${formatDate(dateRange.to)}`
      : PRESET_LABELS[dateRange.preset];

  const isAtLatestDate = (() => {
    const today = new Date();
    return (
      dateRange.to.getFullYear() === today.getFullYear() &&
      dateRange.to.getMonth() === today.getMonth() &&
      dateRange.to.getDate() === today.getDate()
    );
  })();

  // ─── Copilot quick-analysis ─────────────────────────────────────────────────

  const { analyzeWithAI } = useChatContext();

  const askCopilot = useCallback(
    (topic: string) => {
      const range = `${formatDate(dateRange.from)} – ${formatDate(dateRange.to)}`;
      analyzeWithAI(
        `In the current period (${range}), analyze the ${topic} and provide insights.`,
      );
    },
    [analyzeWithAI, dateRange.from, dateRange.to],
  );

  // ─── Recap derivations ──────────────────────────────────────────────────────

  // New Deals & Dropped come from the cohort (overview) so they tally with the
  // Total Companies Added and Pipeline Stages sections. Stage Moves stays an
  // informational activity list (not part of the tally).
  const recapDropped = overview?.droppedCompanies ?? [];
  const recapNewDeals = overview?.addedCompanies ?? [];
  const recapStageMoves = activity?.pipelineMoves ?? [];
  const recapNewInbound = recapNewDeals.filter(
    (c) => c.source?.toLowerCase() === "inbound",
  );
  const recapNewOutbound = recapNewDeals.filter(
    (c) => c.source?.toLowerCase() !== "inbound",
  );

  // Recap columns render their full list inside a fixed-height scroll box, which
  // bloats the DOM when a date range has hundreds of items. Cap each column at a
  // page size and reveal more on demand.
  const RECAP_PAGE_SIZE = 10;
  const [recapDroppedCount, setRecapDroppedCount] = useState(RECAP_PAGE_SIZE);
  const [recapNewDealsCount, setRecapNewDealsCount] = useState(RECAP_PAGE_SIZE);
  const [recapStageMovesCount, setRecapStageMovesCount] =
    useState(RECAP_PAGE_SIZE);

  // Reset the windows whenever a fresh activity payload arrives (e.g. date-range
  // change), so a new range never inherits a previously expanded count.
  useEffect(() => {
    setRecapDroppedCount(RECAP_PAGE_SIZE);
    setRecapNewDealsCount(RECAP_PAGE_SIZE);
    setRecapStageMovesCount(RECAP_PAGE_SIZE);
  }, [activity]);

  // ─── Feed derivations ───────────────────────────────────────────────────────

  const allFeedEvents = useMemo(() => {
    if (!activity) return [];
    return buildFeedEvents(activity);
  }, [activity]);

  const filteredFeedEvents = useMemo(() => {
    if (feedFilter === "all") return allFeedEvents;
    // "notes" stays a plain event-type filter — a note doesn't change a
    // company's current lifecycle state. "new"/"moved"/"dropped" instead key
    // off where the company presently sits (see matchesCurrentStatus), so a
    // company that moved and was later dropped in the same window only shows
    // under "dropped".
    if (feedFilter === "notes") {
      return allFeedEvents.filter((e) => e.type === "note_updated");
    }
    return allFeedEvents.filter(
      (e) =>
        (e.type === "new_deal" || e.type === "stage_move" || e.type === "dropped") &&
        matchesCurrentStatus(e, feedFilter),
    );
  }, [allFeedEvents, feedFilter]);

  // Collapse the filtered events into one group per company (no duplicate
  // companies in the feed); each company's events become a swipable carousel.
  const feedCompanies = useMemo(
    () => groupEventsByCompany(filteredFeedEvents),
    [filteredFeedEvents],
  );

  // Render the feed in pages, revealing more companies on demand via "Show More".
  const FEED_PAGE_SIZE = 10;
  const [feedVisibleCount, setFeedVisibleCount] = useState(FEED_PAGE_SIZE);

  // Reset the window whenever the underlying list changes (filter switch or a
  // fresh activity fetch).
  useEffect(() => {
    setFeedVisibleCount(FEED_PAGE_SIZE);
  }, [feedFilter, allFeedEvents]);

  const hasMoreFeed = feedVisibleCount < feedCompanies.length;

  const groupedFeedCompanies = useMemo(
    () => groupCompaniesByDate(feedCompanies.slice(0, feedVisibleCount)),
    [feedCompanies, feedVisibleCount],
  );

  // ─── Cohort-based pipeline stage counts ─────────────────────────────────────
  // Everything below reads from `overview` (the added cohort) so the Total
  // Companies Added, Recap, and Pipeline Stages sections tally: the per-stage
  // `count`/inbound/outbound are the ACTIVE deals sitting in each stage today,
  // and `droppedByStage` is the cohort deals dropped at each stage. Their sum
  // equals `displayTotal` (= overview.totalAdded) by construction.

  const displayStageCounts = useMemo((): StageCounts[] => {
    const byStage = new Map(overview?.stages.map((s) => [s.stage, s]) ?? []);
    return PIPELINE_STAGES.map(({ stage, label }) => {
      const b = byStage.get(stage);
      return {
        stage,
        label,
        count: b?.active ?? 0,
        inbound: b?.activeInbound ?? 0,
        outbound: b?.activeOutbound ?? 0,
      };
    });
  }, [overview]);

  // Cumulative funnel counts for the Pipeline Stages card. A deal at a later
  // stage passed through every earlier one, so each stage rolls in itself plus
  // every stage after it. Counts include active AND dropped deals, split by
  // source — the card no longer separates dropped out.
  const cumulativeStageCounts = useMemo((): StageCounts[] => {
    const byStage = new Map(overview?.stages.map((s) => [s.stage, s]) ?? []);
    const raw = PIPELINE_STAGES.map(({ stage, label }) => {
      const b = byStage.get(stage);
      return {
        stage,
        label,
        inbound: b?.inbound ?? 0,
        outbound: b?.outbound ?? 0,
        total: b?.total ?? 0,
      };
    });
    return raw.map((item, i) => {
      const rolled = raw.slice(i).reduce(
        (acc, s) => ({
          inbound: acc.inbound + s.inbound,
          outbound: acc.outbound + s.outbound,
          total: acc.total + s.total,
        }),
        { inbound: 0, outbound: 0, total: 0 },
      );
      return {
        stage: item.stage,
        label: item.label,
        count: rolled.total,
        inbound: rolled.inbound,
        outbound: rolled.outbound,
      };
    });
  }, [overview]);

  const displayTotal = overview?.totalAdded ?? 0;
  // L0 rolls in every later stage, so its cumulative counts equal the whole
  // cohort by source — the top of the funnel.
  const displayL0 = cumulativeStageCounts[0]?.count || 0;
  const displayL0Inbound = cumulativeStageCounts[0]?.inbound ?? 0;
  const displayL0Outbound = cumulativeStageCounts[0]?.outbound ?? 0;
  const droppedByStage = (overview?.stages ?? []).reduce(
    (acc, s) => {
      if (s.dropped > 0) acc[s.stage] = s.dropped;
      return acc;
    },
    {} as Record<string, number>,
  );
  const stageConversions = PIPELINE_STAGES.slice(0, -1).map((stage, i) => {
    const promoted =
      displayStageCounts.find((s) => s.stage === PIPELINE_STAGES[i + 1].stage)
        ?.count ?? 0;
    const dropped = droppedByStage[stage.stage] ?? 0;
    const denom = promoted + dropped;
    return {
      label: `${stage.stage} → ${PIPELINE_STAGES[i + 1].stage}`,
      pct: denom > 0 ? Math.round((promoted / denom) * 100) : 0,
      promoted,
      denom,
    };
  });
  const pctOfTotal = (n: number) =>
    displayTotal > 0 ? Math.round((n / displayTotal) * 100) : 0;

  if (loading) {
    return (
      <>
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground text-sm">
              Loading dashboard...
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="p-6 lg:p-8 space-y-8 animate-fade-in">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
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

          {/* Global date range filter — desktop only; the mobile feed scrolls
              infinitely and has no date window. Two components: the active
              date range trigger and the date picker popover. */}
          <div className="hidden md:flex items-center gap-1 shrink-0 self-start sm:mt-1">
            <button
              type="button"
              data-testid="dashboard-date-shift-left"
              onClick={() => shiftDateRange("left")}
              className="flex items-center justify-center h-9 w-9 rounded-lg border border-border/50 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Previous period"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <Popover
              open={customPickerOpen}
              onOpenChange={(open) => {
                setCustomPickerOpen(open);
                if (open) {
                  // Seed the fields from whatever range is currently active so
                  // the calendar and inputs open pre-filled.
                  setFromDate(dateRange.from);
                  setToDate(dateRange.to);
                }
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="dashboard-date-range-trigger"
                  className="flex items-center gap-2 h-9 px-3 text-sm font-medium rounded-lg border border-border/50 bg-muted/50 text-foreground hover:bg-muted transition-colors"
                >
                  <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>{activeRangeLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[308px] p-4 space-y-3" align="end">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Date Range
                </p>
                {/* Quick queries above the calendar — two rows of two. */}
                <div className="grid grid-cols-2 gap-1.5">
                  {PRESET_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      data-testid={`dashboard-date-preset-${key}`}
                      onClick={() => applyPreset(key)}
                      className={[
                        "h-7 px-3 text-xs font-medium rounded-md border transition-colors",
                        dateRange.preset === key
                          ? "bg-primary text-primary-foreground border-primary shadow-sm"
                          : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
                      ].join(" ")}
                    >
                      {PRESET_LABELS[key]}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">From</p>
                    <input
                      type="text"
                      inputMode="numeric"
                      data-testid="dashboard-custom-date-from-input"
                      placeholder="DD/MM/YYYY"
                      value={fromText}
                      onChange={(e) => handleFromText(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">To</p>
                      <button
                        type="button"
                        data-testid="dashboard-custom-date-to-today"
                        onClick={setToToday}
                        className="text-[10px] font-medium text-primary hover:underline"
                      >
                        Today
                      </button>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      data-testid="dashboard-custom-date-to-input"
                      placeholder="DD/MM/YYYY"
                      value={toText}
                      onChange={(e) => handleToText(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
                <Calendar
                  mode="range"
                  className="mx-auto"
                  defaultMonth={customFrom}
                  selected={{ from: customFrom, to: customTo }}
                  onSelect={(range) => {
                    setFromDate(range?.from);
                    setToDate(range?.to);
                  }}
                  disabled={(d) => d > new Date()}
                  classNames={{
                    // Highlight the picked start/end and the days in between with
                    // a light background instead of the default solid primary fill.
                    day_selected:
                      "bg-primary/15 text-primary hover:bg-primary/25 focus:bg-primary/25 rounded-md",
                    day_range_middle:
                      "aria-selected:bg-primary/10 aria-selected:text-foreground",
                  }}
                  initialFocus
                />
                <div className="flex gap-2 pt-1">
                  <Button
                    type="button"
                    data-testid="dashboard-custom-date-cancel-button"
                    variant="outline"
                    size="sm"
                    className="flex-1 h-8 text-xs"
                    onClick={() => setCustomPickerOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    data-testid="dashboard-custom-date-apply-button"
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
            <button
              type="button"
              data-testid="dashboard-date-shift-right"
              onClick={() => shiftDateRange("right")}
              disabled={isAtLatestDate}
              className="flex items-center justify-center h-9 w-9 rounded-lg border border-border/50 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Next period"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Today's Recap — the daily pipeline pulse. Hidden on mobile (Activity
            Feed only). The Analyst agent's markdown, cached once per day and
            shown as-is. */}
        <Card
          data-testid="dashboard-todays-recap-card"
          className="hidden md:block border bg-gradient-to-br from-muted/40 to-muted/10"
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-foreground" />
              <CardTitle className="text-lg font-semibold">Today&apos;s Recap</CardTitle>
              <span className="text-xs text-muted-foreground">
                {pulse?.dateLabel ?? formatDate(new Date())}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {pulse ? (
              <div>
                <div
                  className={`relative overflow-hidden ${
                    pulseExpanded ? "" : "max-h-40"
                  }`}
                >
                  <div ref={pulseBodyRef}>
                    <MarkdownRenderer
                      variant="card"
                      content={pulse.content}
                      className="text-sm"
                    />
                  </div>
                  {!pulseExpanded && pulseOverflowing && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
                  )}
                </div>
                {pulseOverflowing && (
                  <button
                    type="button"
                    onClick={() => setPulseExpanded((v) => !v)}
                    className="mt-2 flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    data-testid="dashboard-recap-toggle"
                  >
                    {pulseExpanded ? "See less" : "Read more"}
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${
                        pulseExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                )}
              </div>
            ) : (
              // No recap yet: the "Generate now" surface. The button stays
              // disabled while the cache read is in flight (and during
              // generation), and becomes actionable once the read settles with
              // no content or fails.
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {pulseGenerating
                    ? "Generating today's recap… this can take a moment."
                    : pulseError
                      ? "Couldn't load today's recap."
                      : pulseLoading
                        ? "Checking for today's recap…"
                        : "Today's recap isn't ready yet."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => generatePulse()}
                  disabled={pulseLoading || pulseGenerating}
                  data-testid="dashboard-recap-generate"
                >
                  {pulseGenerating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Generating…
                    </>
                  ) : (
                    "Generate now"
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Mobile activity feed — infinite scroll, no date window. */}
        <MobileActivityFeed onCompanyClick={handleCompanyClick} />

        {activityInitialising ? (
          <div className="hidden md:flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Loading activity...
              </p>
            </div>
          </div>
        ) : activity && overview ? (
          <>
            {/* ── 7-Day Recap Section ─────────────────────────────────────────────── */}
            <Card className="hidden md:block border bg-card" data-testid="recap-section">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-2">
                  <CalendarIcon className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-lg font-semibold" data-testid="recap-title">
                    {dateRange.preset === "custom"
                      ? "Custom Recap"
                      : PRESET_RECAP_TITLES[dateRange.preset]}
                  </CardTitle>
                  <span className="text-sm text-muted-foreground">
                    {formatDate(dateRange.from)} – {formatDate(dateRange.to)}
                  </span>
                </div>
              </CardHeader>

              <CardContent className="space-y-6">
                {/* 3 summary counters */}
                <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide" data-testid="recap-new-deals-heading">
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
                          <button type="button" data-testid="recap-new-deals-inbound-trigger" className="text-left">
                            <p className="text-xl font-bold text-blue-600 dark:text-blue-400 leading-none underline decoration-dotted underline-offset-2">
                              {recapNewInbound.length}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Inbound
                            </p>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64 p-3" align="start">
                          <p className="text-xs font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-2">
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
                                      {companyDisplayName(c, "—")}
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
                          <button type="button" data-testid="recap-new-deals-outbound-trigger" className="text-left">
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
                                      {companyDisplayName(c, "—")}
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
                  <div className="rounded-lg border border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide" data-testid="recap-dropped-heading">
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
                  <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900/50 dark:bg-blue-950/20 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide" data-testid="recap-stage-moves-heading">
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
                <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-6">

                  {/* New Deals Column */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide" data-testid="recap-new-deals-this-week-heading">
                        New Deals This Week
                      </span>
                    </div>
                    <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                      {recapNewDeals.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          No new deals
                        </p>
                      ) : (
                        <>
                          {recapNewDeals
                            .slice(0, recapNewDealsCount)
                            .map((c) => (
                              <Tooltip key={`${c.id}-${c.event_at}`}>
                                <TooltipTrigger asChild>
                                  <div
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
                                          {companyDisplayName(c, "—")}
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
                                            className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                          >
                                            {c.segment}
                                          </Badge>
                                        )}
                                        {c.geography && (
                                          <Badge
                                            variant="outline"
                                            className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                          >
                                            {c.geography}
                                          </Badge>
                                        )}
                                        {c.deal_sponsor_name && (
                                          <Badge
                                            variant="outline"
                                            className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                          >
                                            Deal Sponsor: {c.deal_sponsor_name}
                                          </Badge>
                                        )}
                                        {c.entered_by_name && (
                                          <Badge
                                            variant="outline"
                                            className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                          >
                                            Entered By: {c.entered_by_name}
                                          </Badge>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </TooltipTrigger>
                                {c.remarks && (
                                  <TooltipContent className="max-w-xs space-y-1">
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Remarks</p>
                                    <p className="text-xs leading-relaxed">{c.remarks}</p>
                                  </TooltipContent>
                                )}
                              </Tooltip>
                            ))}
                          {recapNewDeals.length > recapNewDealsCount && (
                            <button
                              type="button"
                              data-testid="recap-new-deals-show-more-button"
                              onClick={() =>
                                setRecapNewDealsCount(
                                  (c) => c + RECAP_PAGE_SIZE,
                                )
                              }
                              className="w-full text-xs font-medium text-primary hover:underline py-1.5"
                            >
                              Show more (
                              {recapNewDeals.length - recapNewDealsCount} more)
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Dropped Deals Column */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-red-500" />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide" data-testid="recap-dropped-deals-heading">
                        Dropped Deals
                      </span>
                    </div>
                    <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                      {recapDropped.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          No dropped deals
                        </p>
                      ) : (
                        <>
                          {recapDropped.slice(0, recapDroppedCount).map((d) => (
                            <Tooltip key={d.id}>
                              <TooltipTrigger asChild>
                                <div
                                  className="flex items-start gap-2 p-2 rounded-lg hover:bg-muted/40 transition-colors cursor-pointer"
                                  onClick={() => handleCompanyClick(d.id)}
                                >
                                  <div className="flex h-6 w-6 items-center justify-center rounded bg-red-100 dark:bg-red-900/30 shrink-0">
                                    <XCircle className="h-3.5 w-3.5 text-red-500" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-start justify-between gap-2">
                                      <p className="text-sm font-medium truncate">
                                        {companyDisplayName(d, "—")}
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
                                          className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                        >
                                          {d.segment}
                                        </Badge>
                                      )}
                                      {d.geography && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                        >
                                          {d.geography}
                                        </Badge>
                                      )}
                                      {d.deal_sponsor_name && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                        >
                                          Deal Sponsor: {d.deal_sponsor_name}
                                        </Badge>
                                      )}
                                      {d.entered_by_name && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                        >
                                          Entered By: {d.entered_by_name}
                                        </Badge>
                                      )}
                                    </div>
                                    {d.pipeline_stage && (
                                      <p className="text-xs text-muted-foreground mt-1">
                                        Dropped at {stageLabel(d.pipeline_stage)}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </TooltipTrigger>
                              {d.dropped_reason && (
                                <TooltipContent className="max-w-xs space-y-1">
                                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Dropped Reason</p>
                                  <p className="text-xs leading-relaxed">{d.dropped_reason}</p>
                                </TooltipContent>
                              )}
                            </Tooltip>
                          ))}
                          {recapDropped.length > recapDroppedCount && (
                            <button
                              type="button"
                              data-testid="recap-dropped-deals-show-more-button"
                              onClick={() =>
                                setRecapDroppedCount((c) => c + RECAP_PAGE_SIZE)
                              }
                              className="w-full text-xs font-medium text-primary hover:underline py-1.5"
                            >
                              Show more (
                              {recapDropped.length - recapDroppedCount} more)
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Pipeline Stage Movements Column */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-blue-500" />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide" data-testid="recap-pipeline-stage-movements-heading">
                        Pipeline Stage Movements
                      </span>
                    </div>
                    <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                      {recapStageMoves.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          No stage movements
                        </p>
                      ) : (
                        <>
                          {recapStageMoves
                            .slice(0, recapStageMovesCount)
                            .map((m) => {
                              const { from: fromStage, to: toStage } =
                                parsePipelineMoveAction(m.action);
                              return (
                                <Tooltip key={m.id}>
                                  <TooltipTrigger asChild>
                                    <div
                                      className="flex items-start gap-2 p-2 rounded-lg hover:bg-muted/40 transition-colors cursor-pointer"
                                      onClick={() =>
                                        m.company_id &&
                                        handleCompanyClick(m.company_id)
                                      }
                                    >
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                          <p className="text-sm font-medium truncate">
                                            {companyDisplayName(m, "—")}
                                          </p>
                                          <div className="flex items-center gap-1 shrink-0">
                                            {fromStage && (
                                              <StageChip stage={fromStage} />
                                            )}
                                            {fromStage && toStage && (
                                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                            )}
                                            {toStage && (
                                              <StageChip stage={toStage} />
                                            )}
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
                                              className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                            >
                                              {m.geography}
                                            </Badge>
                                          )}
                                          {m.deal_sponsor_name && (
                                            <Badge
                                              variant="outline"
                                              className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                            >
                                              Deal Sponsor: {m.deal_sponsor_name}
                                            </Badge>
                                          )}
                                          {m.entered_by_name && (
                                            <Badge
                                              variant="outline"
                                              className="text-[10px] px-1.5 py-0.5 min-h-4 rounded-md whitespace-normal break-words text-left leading-snug"
                                            >
                                              Entered By: {m.entered_by_name}
                                            </Badge>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </TooltipTrigger>
                                  {(m.promoted_reasons || m.remarks) && (
                                    <TooltipContent className="max-w-xs space-y-1">
                                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        {m.promoted_reasons ? "Promoted Reason" : "Remarks"}
                                      </p>
                                      <p className="text-xs leading-relaxed">{m.promoted_reasons ?? m.remarks}</p>
                                    </TooltipContent>
                                  )}
                                </Tooltip>
                              );
                            })}
                          {recapStageMoves.length > recapStageMovesCount && (
                            <button
                              type="button"
                              data-testid="recap-stage-moves-show-more-button"
                              onClick={() =>
                                setRecapStageMovesCount(
                                  (c) => c + RECAP_PAGE_SIZE,
                                )
                              }
                              className="w-full text-xs font-medium text-primary hover:underline py-1.5"
                            >
                              Show more (
                              {recapStageMoves.length - recapStageMovesCount}{" "}
                              more)
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ── Pipeline Stages ────────────────────────────────────────────── */}
            <Card data-testid="dashboard-pipeline-stages-card" className="hidden md:block border bg-card">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <CardTitle className="flex items-center gap-3 text-lg font-semibold">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                        <TrendingUp className="h-4 w-4 text-primary" />
                      </div>
                      Deal Funnel
                    </CardTitle>
                    <span className="text-sm text-muted-foreground">
                      {formatDate(dateRange.from)} – {formatDate(dateRange.to)}
                    </span>
                  </div>
                  <AskAIButton
                    label="Analyze pipeline stages with AI"
                    onClick={() => askCopilot("pipeline stage distribution")}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  Current status of companies added in this period
                </p>
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
                  <div className="flex items-stretch gap-3 overflow-x-auto">
                    {/* L1 – L5 stage columns */}
                    <div className="flex flex-1 items-stretch gap-2 min-w-[360px]">
                      {cumulativeStageCounts.map((item) => {
                        const pills = stagePillColors[item.stage] ?? {
                          inbound: "bg-gray-400",
                          outbound: "bg-gray-300",
                        };
                        const conversionPercentStage =
                          displayL0 > 0
                            ? Math.round((item.count / displayL0) * 100)
                            : 0;
                        return (
                          <WorkspaceLink
                            key={item.stage}
                            data-testid={`dashboard-stage-${item.stage.toLowerCase()}-link`}
                            href={`/pipeline?stage=${item.stage}`}
                            className="group flex flex-1 flex-col items-center gap-1 no-underline text-inherit"
                          >
                            <div className="flex items-baseline gap-1.5 justify-center">
                              <div className="text-lg font-bold transition-transform group-hover:scale-110">
                                {item.count}
                              </div>
                              <div className="text-[10px] text-muted-foreground transition-transform group-hover:scale-110">
                                ({conversionPercentStage}%)
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
                            <div className="mt-1 text-sm font-bold">
                              {item.stage}
                            </div>
                            <div className="text-center text-[10px] text-muted-foreground">
                              {item.label}
                            </div>
                          </WorkspaceLink>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Activity Feed ──────────────────────────────────────────────── */}
            <Card data-testid="dashboard-activity-feed-card" className="hidden md:block border bg-card">
              <CardHeader className="pb-4">
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
                <div className="flex flex-wrap items-center gap-2 pt-3">
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
                      data-testid={`dashboard-feed-filter-${key}`}
                      onClick={() => setFeedFilter(key)}
                      className={[
                        "h-7 px-3 text-xs font-medium rounded-full transition-colors",
                        feedFilter === key
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                    >
                      {FEED_FILTER_LABELS[key]}
                    </button>
                  ))}
                </div>
              </CardHeader>

              {/* Events — one card each, capped height with inner scroll */}
              <CardContent className="space-y-4 max-h-[600px] overflow-y-auto">
                {filteredFeedEvents.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <p className="text-sm">No activity in this period</p>
                  </div>
                ) : (
                  <>
                    {groupedFeedCompanies.map(({ dateLabel, companies }) => (
                      <div key={dateLabel} className="space-y-3">
                        {/* Date header — the company's most recent event date */}
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {new Date(companies[0]?.latestEventAt)
                            .toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                            .toUpperCase()
                            .replace(",", "")}
                        </p>

                        {/* One swipable carousel per company for this date */}
                        {companies.map((company) => (
                          <CompanyFeedCarousel
                            key={company.company_id}
                            company={company}
                            onCompanyClick={handleCompanyClick}
                            analyzeVariant="icon"
                            matchEventType={FEED_FILTER_TO_EVENT_TYPE[feedFilter]}
                          />
                        ))}
                      </div>
                    ))}

                    {/* Show More — reveal the next page of companies */}
                    {hasMoreFeed && (
                      <button
                        type="button"
                        data-testid="dashboard-feed-show-more-button"
                        onClick={() =>
                          setFeedVisibleCount((c) => c + FEED_PAGE_SIZE)
                        }
                        className="w-full text-sm font-medium text-primary hover:underline py-2"
                      >
                        Show More ({feedCompanies.length - feedVisibleCount} more)
                      </button>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}

        {/* ── Insights ──────────────────────────────────────────────────────
            Self-contained module: fetches its own aggregated metrics for the
            active date range (funnel, stale deals, banker/segment/country
            breakdowns, AI throughput). Desktop-only, like the sections above. */}
        {showInsightsDashboard && (
          <InsightsModule from={dateRange.from} to={dateRange.to} />
        )}
      </div>

      {
        selectedCompany && (
          <CompanyDetailDialog
            company={selectedCompany}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onUpdate={fetchPipelineData}
          />
        )
      }
    </>
  );
}

// ─── FeedEventRow ─────────────────────────────────────────────────────────────

interface FeedEventRowProps {
  event: FeedEvent;
  onCompanyClick: (id: string) => void;
  /** When provided, renders a contextual "Analyze using AI" trigger inside the card. */
  analyzeLabel?: string;
  onAnalyze?: () => void;
  /** "button" (mobile) renders the full-width labelled pill; "icon" (desktop) the compact sparkles icon. */
  analyzeVariant?: "icon" | "button";
  /** Hide the company name header — used inside a carousel where the name is a shared header. */
  showCompanyName?: boolean;
  /** Render as a seamless carousel slide (no border/shadow) and surface the event's own date. */
  bare?: boolean;
}

const eventTypeBadgeStyles: Record<FeedEventType, string> = {
  new_deal:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  stage_move:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  dropped: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  note_updated:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  ai_discovered:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
};

const eventTypeBadgeLabels: Record<FeedEventType, string> = {
  new_deal: "NEW DEAL",
  stage_move: "STAGE MOVE",
  dropped: "DROPPED",
  note_updated: "NOTE UPDATED",
  ai_discovered: "AI DISCOVERED",
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
  const currency = useWorkspaceCurrency();
  const metrics: { label: string; value: string | null }[] = [
    { label: "Rev", value: formatUsdMn(revenue, currency) },
    { label: "EBITDA", value: formatUsdMn(ebitda, currency) },
    { label: "EV", value: formatUsdMn(ev, currency) },
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

// Circular company avatar for the activity feed: the analysis logo when one
// exists, otherwise English-only initials on a tinted disc (mirrors the company
// detail header's logo/fallback pattern).
function FeedAvatar({
  name,
  logoUrl,
  className = "h-8 w-8",
}: {
  name: string;
  logoUrl: string | null | undefined;
  className?: string;
}) {
  return (
    <div
      className={`${className} shrink-0 overflow-hidden rounded-full border border-blue-200 bg-blue-100 dark:border-blue-700 dark:bg-blue-900/40 flex items-center justify-center`}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={name}
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
            (
              e.currentTarget.nextSibling as HTMLElement | null
            )?.removeAttribute("style");
          }}
        />
      ) : null}
      <span
        className="text-xs font-bold text-blue-600 dark:text-blue-300"
        style={logoUrl ? { display: "none" } : undefined}
      >
        {companyInitials({ name })}
      </span>
    </div>
  );
}

function FeedEventRow({
  event,
  onCompanyClick,
  analyzeLabel,
  onAnalyze,
  analyzeVariant = "button",
  showCompanyName = true,
  bare = false,
}: FeedEventRowProps) {
  const inlineNote =
    event.type === "note_updated"
      ? event.note_content
      : event.type === "stage_move"
        ? (event.promoted_reasons ?? event.remarks ?? null)
        : (event.remarks ?? null);

  const inlineLabel =
    event.type === "note_updated"
      ? null
      : event.type === "stage_move"
        ? (event.promoted_reasons ? "Promoted Reason" : "Remarks")
        : "Remarks";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onCompanyClick(event.company_id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCompanyClick(event.company_id);
        }
      }}
      className={
        bare
          ? "rounded-md cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          : "rounded-lg border bg-card p-4 shadow-sm cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      }
    >
      {/* Header row: leading avatar (company rows) or plain event-type dot
          (bare carousel slides, where the company avatar already sits in the
          shared header) + the company name / date and desktop analyze icon. */}
      <div className="flex items-start gap-3">
        {showCompanyName ? (
          <div className="relative shrink-0">
            <FeedAvatar name={event.company_name} logoUrl={event.logo_url} />
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card ${dotColors[event.type]}`}
            />
          </div>
        ) : (
          <div className="mt-1.5 shrink-0">
            <div className={`h-2.5 w-2.5 rounded-full ${dotColors[event.type]}`} />
          </div>
        )}

        <div className="flex flex-1 min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            {showCompanyName && (
              <button
                type="button"
                data-testid={`feed-event-company-button-${event.company_id}`}
                onClick={(e) => { e.stopPropagation(); onCompanyClick(event.company_id); }}
                className="text-sm font-semibold text-left hover:text-primary transition-colors"
              >
                {event.company_name}
              </button>
            )}
            {bare && (
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {formatFeedEventDate(event.event_at)}
              </p>
            )}
          </div>
          {onAnalyze && analyzeLabel && analyzeVariant === "icon" && (
            <span onClick={(e) => e.stopPropagation()}>
              <AskAIButton
                variant="icon"
                label={analyzeLabel}
                onClick={onAnalyze}
              />
            </span>
          )}
        </div>
      </div>

      {/* Card contents (chips, remarks, financials, badges) — a full-width row
          below the avatar and company name. */}
      <div className="space-y-1.5 mt-2">
        {/* Event detail line — only rendered for event types that have chips */}
        {(event.type === "stage_move" || event.type === "dropped") && (
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
        )}

        {/* Dropped reason */}
        {event.type === "dropped" && event.dropped_reason && (
          <div className="space-y-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Dropped Reason</p>
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{event.dropped_reason}</p>
          </div>
        )}

        {/* Inline note / remarks */}
        {inlineNote && (
          <div className="space-y-0.5">
            {inlineLabel && (
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{inlineLabel}</p>
            )}
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{inlineNote}</p>
          </div>
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
              className="text-[10px] px-1.5 py-0.5 min-h-4 font-normal rounded-md whitespace-normal break-words text-left leading-snug"
            >
              {event.geography}
            </Badge>
          )}
          {event.segment && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0.5 min-h-4 font-normal rounded-md whitespace-normal break-words text-left leading-snug"
            >
              {event.segment}
            </Badge>
          )}
        </div>

        {/* Mobile "Analyze using AI" pill — bottom of card */}
        {onAnalyze && analyzeLabel && analyzeVariant === "button" && (
          <span onClick={(e) => e.stopPropagation()}>
            <AskAIButton
              variant="button"
              label={analyzeLabel}
              onClick={onAnalyze}
              className="mt-0.5 w-full justify-center"
            />
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Company feed carousel ─────────────────────────────────────────────────────
// One company's events collapsed into a single swipable card. Each slide is a
// unique timeline event (oldest → newest); swipe on touch, arrows on desktop.
// A company with a single event renders as a plain card (no carousel chrome).
//
// The feed itself is event-paginated, so the events handed in for a company may
// be an incomplete slice (split across pages, or outside the date window). On
// mount we fetch the company's COMPLETE timeline so the carousel is never
// missing slides. Results are cached module-wide so re-renders (mobile regroups
// on every page load) never refetch the same company.

const companyTimelineCache = new Map<string, FeedEvent[]>();

// The slide a carousel opens on, given events in oldest → newest order. With a
// filter active we default to the LATEST event of the matching type (the reason
// the company is in this filtered view); otherwise the latest event overall.
function defaultCarouselIndex(
  events: FeedEvent[],
  matchEventType?: FeedEventType,
): number {
  if (matchEventType) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === matchEventType) return i;
    }
  }
  return Math.max(0, events.length - 1);
}

function CompanyFeedCarousel({
  company,
  onCompanyClick,
  analyzeVariant,
  matchEventType,
}: {
  company: CompanyFeedGroup;
  onCompanyClick: (id: string) => void;
  analyzeVariant: "icon" | "button";
  /** Active feed filter's event type — carousel opens on this event when set. */
  matchEventType?: FeedEventType;
}) {
  const { analyzeWithAI } = useChatContext();
  const [api, setApi] = useState<CarouselApi>();
  const [timeline, setTimeline] = useState<FeedEvent[] | null>(
    () => companyTimelineCache.get(company.company_id) ?? null,
  );
  // Seed the position so the counter/arrows are correct on first paint, before
  // the carousel API mounts — the filter-matching (or latest) slide.
  const [current, setCurrent] = useState(() => {
    const source = companyTimelineCache.get(company.company_id) ?? company.events;
    return defaultCarouselIndex(
      [...source].sort((a, b) => a.event_at.localeCompare(b.event_at)),
      matchEventType,
    );
  });

  // Hydrate the full timeline once per company. Until it resolves we render the
  // events already in the feed, then swap to the complete set.
  useEffect(() => {
    const cached = companyTimelineCache.get(company.company_id);
    if (cached) {
      setTimeline(cached);
      return;
    }
    let cancelled = false;
    getCompanyTimeline(company.company_id)
      .then((events) => {
        companyTimelineCache.set(company.company_id, events);
        if (!cancelled) setTimeline(events);
      })
      .catch((err) => {
        console.error("Error loading company timeline:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [company.company_id]);

  // Prefer the complete timeline; fall back to the in-feed slice while loading.
  // A non-empty timeline is authoritative (and a superset of the feed slice); an
  // empty one never replaces events we already have. Both sources are normalised
  // to oldest → newest so slide order is stable when the fuller list arrives.
  const events = useMemo(() => {
    const source = timeline && timeline.length > 0 ? timeline : company.events;
    return [...source].sort((a, b) => a.event_at.localeCompare(b.event_at));
  }, [timeline, company.events]);
  const count = events.length;

  // The slide to open on — recomputed when the events grow (timeline load) or
  // the active filter changes.
  const defaultIndex = useMemo(
    () => defaultCarouselIndex(events, matchEventType),
    [events, matchEventType],
  );

  useEffect(() => {
    if (!api) return;
    const onSelect = () => setCurrent(api.selectedScrollSnap());
    onSelect();
    api.on("select", onSelect);
    api.on("reInit", onSelect);
    return () => {
      api.off("select", onSelect);
      api.off("reInit", onSelect);
    };
  }, [api]);

  // Pin the view to the default slide on mount, and re-pin when it changes
  // (filter switch or the full timeline arriving). `true` = jump, no animation.
  useEffect(() => {
    if (!api) return;
    api.scrollTo(defaultIndex, true);
  }, [api, defaultIndex]);

  const renderEvent = (event: FeedEvent, showCompanyName: boolean, bare: boolean) => (
    <FeedEventRow
      event={event}
      onCompanyClick={onCompanyClick}
      analyzeLabel={feedAnalysisLabel(event)}
      onAnalyze={() => analyzeWithAI(feedAnalysisPrompt(event))}
      analyzeVariant={analyzeVariant}
      showCompanyName={showCompanyName}
      bare={bare}
    />
  );

  // Single event → nothing to swipe through; render the familiar card as-is.
  if (count === 1) {
    return renderEvent(events[0], true, false);
  }

  return (
    <div
      data-testid={`feed-company-carousel-${company.company_id}`}
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      {/* Header: company avatar + name + position indicator and desktop arrows */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <FeedAvatar
            name={company.company_name}
            logoUrl={company.logo_url}
            className="h-7 w-7"
          />
          <button
            type="button"
            data-testid={`feed-event-company-button-${company.company_id}`}
            onClick={() => onCompanyClick(company.company_id)}
            className="text-sm font-semibold text-left hover:text-primary transition-colors truncate"
          >
            {company.company_name}
          </button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            aria-label="Previous event"
            data-testid={`feed-carousel-prev-${company.company_id}`}
            onClick={() => api?.scrollPrev()}
            disabled={current === 0}
            className="hidden md:inline-flex h-6 w-6 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span
            data-testid={`feed-carousel-counter-${company.company_id}`}
            className="text-[10px] font-medium tabular-nums text-muted-foreground px-1"
          >
            {current + 1} / {count}
          </span>
          <button
            type="button"
            aria-label="Next event"
            data-testid={`feed-carousel-next-${company.company_id}`}
            onClick={() => api?.scrollNext()}
            disabled={current === count - 1}
            className="hidden md:inline-flex h-6 w-6 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Open on the default slide — the filter-matching event, or the latest
          when unfiltered. A scrollTo effect re-pins it if the slide set grows
          or the filter changes; startIndex avoids a first-paint flash. */}
      <Carousel
        setApi={setApi}
        opts={{ align: "start", startIndex: defaultIndex }}
        className="w-full"
      >
        <CarouselContent className="ml-0">
          {events.map((event) => (
            <CarouselItem key={event.id} className="pl-0 flex flex-col justify-center">
              {renderEvent(event, false, true)}
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>

      {/* Dot indicators — tappable jump-to-slide, doubling as a swipe hint. */}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {events.map((event, i) => (
          <button
            key={event.id}
            type="button"
            aria-label={`Go to event ${i + 1}`}
            onClick={() => api?.scrollTo(i)}
            className={`h-1.5 rounded-full transition-all ${i === current ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30"
              }`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Mobile activity feed ──────────────────────────────────────────────────────

const FEED_FILTER_LABELS: Record<FeedFilterKey, string> = {
  all: "All",
  new: "New",
  moved: "Moved",
  dropped: "Dropped",
  notes: "Notes",
};

const FEED_FILTER_TO_API: Record<FeedFilterKey, FeedFilter> = {
  all: "all",
  new: "new_deal",
  moved: "stage_move",
  dropped: "dropped",
  notes: "note_updated",
};

// The event type a filter pill selects (undefined for "All"). When a filter is
// active, a company's carousel defaults to the matching event rather than the
// latest one, so the reason the company surfaced is what you see first.
const FEED_FILTER_TO_EVENT_TYPE: Record<FeedFilterKey, FeedEventType | undefined> = {
  all: undefined,
  new: "new_deal",
  moved: "stage_move",
  dropped: "dropped",
  notes: "note_updated",
};

/** Contextual one-line label for the per-card "Analyze using AI" pill. */
function feedAnalysisLabel(event: FeedEvent): string {
  const name = event.company_name;
  switch (event.type) {
    case "new_deal":
      return `Analyze why ${name} was added`;
    case "dropped":
      return `Analyze why ${name} was dropped`;
    case "stage_move":
      return `Analyze ${name}'s stage move`;
    case "note_updated":
      return `Analyze ${name}'s note update`;
    case "ai_discovered":
      return `Analyze why ${name} was discovered`;
  }
}

/** The richer prompt actually sent to the copilot for a given feed event. */
function feedAnalysisPrompt(event: FeedEvent): string {
  const name = event.company_name;
  switch (event.type) {
    case "new_deal":
      return `Analyze why ${name} was added to the deal pipeline and assess the opportunity.`;
    case "dropped":
      return `Analyze why ${name} was dropped${event.dropped_stage ? ` at ${event.dropped_stage}` : ""
        }${event.dropped_reason ? ` (reason: ${event.dropped_reason})` : ""
        } and whether that was the right call.`;
    case "stage_move":
      return `Analyze why ${name}${event.from_stage && event.to_stage
        ? ` moved from ${event.from_stage} to ${event.to_stage}`
        : " advanced in the pipeline"
        } and what it means for the deal.`;
    case "note_updated":
      return `Analyze the latest note update on ${name} and summarize the key takeaways.`;
    case "ai_discovered":
      return `Analyze why ${name} was surfaced as an AI-discovered company through the relationship graph and assess whether it's worth pursuing as a deal.`;
  }
}

const MOBILE_FEED_PAGE_SIZE = 15;

// A feed window with no date selector reaches back far enough to cover the
// entire history; "to" is clamped to now at fetch time.
const MOBILE_FEED_FROM = new Date("2000-01-01T00:00:00.000Z");

function MobileActivityFeed({
  onCompanyClick,
}: {
  onCompanyClick: (id: string) => void;
}) {
  const isMobile = useIsMobile();
  const [filter, setFilter] = useState<FeedFilterKey>("all");
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initialised, setInitialised] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Guards against a stale in-flight request applying its results after the
  // filter changed (each filter switch bumps the token).
  const requestToken = useRef(0);

  const loadPage = useCallback(
    async (nextOffset: number, replace: boolean, token: number) => {
      setLoading(true);
      try {
        const page = await getDashboardFeed({
          from: MOBILE_FEED_FROM,
          to: new Date(),
          offset: nextOffset,
          limit: MOBILE_FEED_PAGE_SIZE,
          filter: FEED_FILTER_TO_API[filter],
        });
        if (token !== requestToken.current) return;
        setEvents((prev) =>
          replace ? page.events : [...prev, ...page.events],
        );
        setHasMore(page.hasMore);
        setOffset(nextOffset + page.events.length);
      } catch (err) {
        console.error("Error loading activity feed:", err);
        if (token === requestToken.current) setHasMore(false);
      } finally {
        if (token === requestToken.current) {
          setLoading(false);
          setInitialised(true);
        }
      }
    },
    [filter],
  );

  // Reset and reload whenever the filter changes (including first mount).
  // Desktop never fetches — the feed is mobile-only.
  useEffect(() => {
    if (!isMobile) return;
    const token = ++requestToken.current;
    setEvents([]);
    setOffset(0);
    setHasMore(true);
    setInitialised(false);
    loadPage(0, true, token);
  }, [loadPage, isMobile]);

  // Infinite scroll — fetch the next page as the sentinel nears the viewport.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loading || !initialised) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadPage(offset, false, requestToken.current);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, initialised, offset, loadPage]);

  // Group the full accumulated event list by company (deduping across pages),
  // then bucket those companies under their latest-event date header.
  const grouped = useMemo(
    () => groupCompaniesByDate(groupEventsByCompany(events)),
    [events],
  );

  if (!isMobile) return null;

  return (
    <div className="md:hidden space-y-4">
      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          ["all", "new", "moved", "dropped", "notes"] as FeedFilterKey[]
        ).map(
          (key) => (
            <button
              key={key}
              type="button"
              data-testid={`mobile-feed-filter-${key}`}
              onClick={() => setFilter(key)}
              className={[
                "h-7 px-3 text-xs font-medium rounded-full transition-colors",
                filter === key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {FEED_FILTER_LABELS[key]}
            </button>
          ),
        )}
      </div>

      {!initialised && events.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-sm">No activity yet</p>
        </div>
      ) : (
        <>
          {grouped.map(({ dateLabel, companies }) => (
            <div key={dateLabel} className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {new Date(companies[0]?.latestEventAt)
                  .toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                  .toUpperCase()
                  .replace(",", "")}
              </p>
              {companies.map((company) => (
                <CompanyFeedCarousel
                  key={company.company_id}
                  company={company}
                  onCompanyClick={onCompanyClick}
                  analyzeVariant="button"
                  matchEventType={FEED_FILTER_TO_EVENT_TYPE[filter]}
                />
              ))}
            </div>
          ))}

          {/* Infinite-scroll sentinel + loading indicator */}
          {hasMore && <div ref={sentinelRef} className="h-1" />}
          {loading && events.length > 0 && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
