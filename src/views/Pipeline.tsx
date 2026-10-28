"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useSetPageDetail } from "@/components/layout/PageContextProvider";
import { useQuery } from "@tanstack/react-query";
import { getWorkspaceSlugFromUrl } from "@/lib/api/client";
import { getAiScreeningTasks, getProcessingAiOpinions, getScreenings } from "@/lib/api/pipeline";
import { useLiveRefetchInterval } from "@/components/live/LiveEventsProvider";
import { LIVE_TOPICS } from "@/lib/live/topics";
import { useSearchParams, useRouter } from "next/navigation";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";
import { useChatActions } from "@/components/chat/ChatProvider";
import { useLayoutControl } from "@/components/layout/LayoutControlContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Settings,
  HelpCircle,
  ChevronDown,
  PencilLine,
  Sparkles,
  Upload,
  Presentation,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import PromoteDialog from "@/components/pipeline/PromoteDialog";
import { DealStage, L1Status } from "@/lib/types";
import CompanyDetailDialog, {
  type CompanyDialogTab,
} from "@/components/pipeline/CompanyDetailDialog";
import InboundCompaniesTable from "@/components/pipeline/InboundCompaniesTable";
import OutboundCompaniesTable from "@/components/pipeline/OutboundCompaniesTable";
import PipelineSettingsDialog from "@/components/pipeline/PipelineSettingsDialog";
import PipelineHeadingDialog from "@/components/pipeline/PipelineHeadingDialog";
import PendingAutomationToggles from "@/components/pipeline/PendingAutomationToggles";
import { PageHeader } from "@/components/layout/PageHeader";
import { usePipelineHeading } from "@/components/layout/PipelineHeadingContext";
import { usePipelineStages } from "@/hooks/usePipelineStages";
import { PipelinePresentationDialog } from "@/components/pipeline/PipelinePresentationDialog";
import {
  buildPipelinePresentation,
  type PipelinePresentation,
} from "@/lib/pipeline/presentation";
import type { ColumnDef } from "@/components/table";
import { usePublishSourcingPendingCount } from "@/hooks/useSourcingPendingCount";
import { useRestoreDeal } from "@/components/pipeline/useRestoreDeal";
import AddCompanyForm from "@/components/pipeline/AddCompanyForm";
import { buildAddCompanyPrompt } from "@/lib/pipeline/addCompanyPrompt";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import TrackMultiSelect, {
  UNASSIGNED_TRACK_ID,
} from "@/components/pipeline/TrackMultiSelect";
import { resolveTrackIds, effectiveDealLead } from "@/lib/tracks/matchTracks";
import {
  DOC_TYPE_OPTIONS,
  demoteTargetForStage,
  promoteTargetForStage,
} from "@/lib/constants";
import {
  DEFAULT_INBOUND_STATUS_OPTIONS,
  DEFAULT_OUTBOUND_STATUS_OPTIONS,
} from "@/components/pipeline/StatusCombobox";
import MarketScreeningStatus from "@/components/pipeline/MarketScreeningStatus";
import MarketScreeningResults from "@/components/pipeline/MarketScreeningResults";
import ScreeningProgressPanel from "@/components/pipeline/ScreeningProgressPanel";
import { TriageBanner } from "@/components/pipeline/TriageBanner";
import { BulkTriageModal } from "@/components/pipeline/BulkTriageModal";
import { cn } from "@/lib/utils";
import {
  matchesSearchScope,
  matchesStageView,
  parseStageView,
  stageCellLabel,
  stageSortRank,
  type StageView,
} from "@/lib/pipeline/stageView";
import {
  matchesSourceFilter,
  sourceTypeLabel,
  type SourceFilter,
  type SourceType,
} from "@/lib/pipeline/sourceType";
import { screeningTargetKey } from "@/lib/pipeline/stages";
import { mergeRunningScreeningCompanyIds } from "@/lib/screening/runningIndicator";
import type { ScreeningTaskStatus } from "@/lib/services/aiScreeningService";
import { companyDisplayName } from "@/lib/companyDisplay";
import { isDealLive } from "@/lib/dealStatus";
import posthog from "posthog-js";
import {
  getCompanies,
  getCompaniesCount,
  dropDeal,
  updateCompany,
  getTracks,
  analyzeAiOpinion,
  startAIScreening,
  type Track,
} from "@/lib/api/pipeline";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { formatDealType } from "@/lib/companies/dealTypes";

/** The old SSE snapshot cadence; now only the fallback while the live stream is down. */
const LIVE_FALLBACK_POLL_MS = 5_000;
const EMPTY_SCREENING_TASKS: ScreeningTaskStatus[] = [];

/** Pipeline Status filter: every deal, live deals only, or dropped deals only. */
export type PipelineViewMode = "all" | "active" | "dropped";

export interface PipelineCompany {
  id: string;
  target: string;
  project_name: string | null;
  segment: string;
  geo: string | null;
  website: string | null;
  watchlist_status: string | null;
  revenue_2021_usd_mn: number | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  revenue_2025_usd_mn: number | null;
  ebitda_2021_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  ebitda_2025_usd_mn: number | null;
  ev_2024: number | null;
  pipeline_stage: DealStage;
  l1_screening_result: string | null;
  pic: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
  source: string | null;
  status: string | null;
  dropped_reason: string | null;
  dropped_at: string | null;
  promoted_reasons: string | null;
  ownership: string | null;
  geography: string | null;
  deal_type: string | null;
  entered_by: string | null;
  entered_by_name: string | null;
  originator: string | null;
  // uuid FKs to users.id; `*_name` carries the resolved display name.
  deal_sponsor: string | null;
  deal_sponsor_name: string | null;
  deal_captain: string | null;
  deal_captain_name: string | null;
  last_activity_at: string | null;
  banker: string | null;
  advisor: string | null;
  doc_type: string | null;
  nbo_date: string | null;
  is_live: boolean | null;
  stake: string | null;
  deal_size: string | null;
  workflow_status: string | null;
  key_rationale: string | null;
  banker_source: string | null;
  possible_duplicate_company_id: string | null;
  matched_track_ids: string[];
  track_specific_variables?: Record<string, Record<string, string>> | null;
  slide_track_variable_ids?: string[] | null;
  ai_opinion_verdict: string | null;
  ai_opinion_summary: string | null;
  ai_opinion_status: string | null;
  ai_opinion_updated_at: string | null;
  financials_raw?: import("@/lib/repositories").Tables<"company_financials">[];
}

const PENDING_DESCRIPTION =
  "Inbound leads awaiting confirmation before entering the pipeline at L0.";

/** The selected stage's description is cut to this length, with "Show more" opening the full list. */
const STAGE_DESCRIPTION_PREVIEW_CHARS = 160;

type SourcingTab = "pending" | "scanning";

/** Pipeline's page tabs: the deal table, and the AI Screening progress (`?tab=screening`). */
type PipelineTab = "pipeline" | "screening";

const PAGE_TAB_CLASS =
  "shrink-0 rounded-none border-b-2 border-transparent px-3 py-2 -mb-px text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none";

// "Resurface at" presets offered when dropping a deal.
const RESURFACE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "none", label: "Don't resurface" },
  { value: "1m", label: "In 1 month" },
  { value: "3m", label: "In 3 months" },
  { value: "6m", label: "In 6 months" },
  { value: "1y", label: "In 1 year" },
  { value: "custom", label: "Custom date…" },
];

const RESURFACE_MONTHS: Record<string, number> = {
  "1m": 1,
  "3m": 3,
  "6m": 6,
  "1y": 12,
};

// Resolve the dialog's resurface selection to an ISO timestamp (or null when
// resurfacing is off / the custom date is empty or unparsable).
const computeResurfaceAt = (
  option: string,
  customDate: string,
): string | null => {
  if (option === "custom") {
    if (!customDate) return null;
    const d = new Date(`${customDate}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const months = RESURFACE_MONTHS[option];
  if (!months) return null;
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
};

interface PipelineProps {
  /**
   * `sourcing` renders the Sourcing page: the Pending Confirmation bucket and
   * AI Market Scanning, on the same deal data, row actions and dialogs as the
   * pipeline table.
   */
  page?: "pipeline" | "sourcing";
}

export default function Pipeline({ page = "pipeline" }: PipelineProps = {}) {
  const isSourcing = page === "sourcing";
  const searchParams = useSearchParams();
  const router = useRouter();
  const pipelineHref = useWorkspaceHref("/pipeline");
  const sourcingHref = useWorkspaceHref("/sourcing");
  const chatHref = useWorkspaceHref("/chat");
  const smartFilesHref = useWorkspaceHref("/smart-files");
  const { prefillComposer } = useChatActions();
  const { focusCopilot } = useLayoutControl();
  const isMobile = useIsMobile();
  const pipelineStages = usePipelineStages();
  const { restore: restoreWithStagePrompt, restoreStageDialog } = useRestoreDeal();
  const { liveKeys: stageKeys, captainKeys } = pipelineStages;
  // Screening promotes L0 deals into whichever stage follows L0, so that is
  // the tab that offers the screening-result filter (L1 by default). Unset
  // until the stages load, so the built-in fallback can't pick the wrong tab.
  const screeningStage = pipelineStages.loading ? null : screeningTargetKey(stageKeys);
  // Sourcing only ever shows the pending bucket; nothing there changes it. A
  // `?stage=` naming an added stage is kept until the stages load, then
  // checked below.
  const [stageView, setStageView] = useState<StageView>(() =>
    isSourcing ? "pending" : parseStageView(searchParams.get("stage"), [searchParams.get("stage") ?? ""]),
  );
  const [sourcingTab, setSourcingTab] = useState<SourcingTab>(() =>
    searchParams.get("tab") === "scanning" ? "scanning" : "pending",
  );
  const [pipelineTab, setPipelineTab] = useState<PipelineTab>(() =>
    searchParams.get("tab") === "screening" ? "screening" : "pipeline",
  );
  const [companies, setCompanies] = useState<PipelineCompany[]>([]);
  const [loading, setLoading] = useState(true);
  // True once a fetch has succeeded — until then `companies` is an empty
  // placeholder, not a real zero, and must not reach the sidebar badge.
  const [companiesLoaded, setCompaniesLoaded] = useState(false);
  const [updatingCompanyIds, setUpdatingCompanyIds] = useState<Set<string>>(
    new Set(),
  );
  // Pipeline keeps its search in `?q=` so a search can be shared or bookmarked.
  const [searchQuery, setSearchQuery] = useState(() =>
    isSourcing ? "" : (searchParams.get("q") ?? ""),
  );
  const [selectedCompany, setSelectedCompany] =
    useState<PipelineCompany | null>(null);
  // When true, the company detail dialog opens directly into the Details tab
  // with the Company Information card in inline edit mode (the "Update" action).
  const [openDetailInEdit, setOpenDetailInEdit] = useState(false);
  // Tab the detail dialog opens on; the AI Screening panel opens it on the
  // company's Pre-pipeline Filters. Reset with the selection on close.
  const [detailInitialTab, setDetailInitialTab] = useState<CompanyDialogTab | null>(null);
  const [marketScreeningRefresh, setMarketScreeningRefresh] = useState(0);
  const [screeningProgressRefresh, setScreeningProgressRefresh] = useState(0);
  const [pendingScreeningCompanyIds, setPendingScreeningCompanyIds] = useState<
    Set<string>
  >(new Set());
  const [startingScreeningCompanyIds, setStartingScreeningCompanyIds] =
    useState<Set<string>>(new Set());
  // Live queries (see `LiveEventsProvider`): keyed under their topic so the
  // workspace stream invalidates them, with a slow fallback poll while it is
  // down. `LIVE_FALLBACK_POLL_MS` is the cadence the old SSE snapshots ran at.
  const workspaceSlug = getWorkspaceSlugFromUrl();
  const liveRefetchInterval = useLiveRefetchInterval(LIVE_FALLBACK_POLL_MS);
  // Active AI Workforce screening tasks — a pending_scan run can be queued or
  // matching tracks before any screening row exists, so row spinners also need
  // this (see mergeRunningScreeningCompanyIds).
  const { data: screeningTasksData } = useQuery({
    queryKey: [LIVE_TOPICS.workforce, workspaceSlug, "ai-screening-tasks"],
    queryFn: getAiScreeningTasks,
    refetchInterval: liveRefetchInterval,
  });
  const screeningTasks: ScreeningTaskStatus[] = screeningTasksData ?? EMPTY_SCREENING_TASKS;
  // Optimistic "AI Opinion is being analyzed" ids — set on click before the
  // companies refetch reflects ai_opinion_status='processing'.
  const [analyzingAiOpinionIds, setAnalyzingAiOpinionIds] = useState<
    Set<string>
  >(new Set());
  const [newCandidatesCount, setNewCandidatesCount] = useState(0);

  // Sorting state
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  // L1 status filter
  const [l1StatusFilter, setL1StatusFilter] = useState<"all" | L1Status>("all");

  // Pipeline Status filter. Both pages open on Active (live deals only);
  // Sourcing has no status filter. A search ignores it and looks through
  // active and dropped deals alike (see `effectiveViewMode`).
  const [viewMode, setViewMode] = useState<PipelineViewMode>("active");

  // Sector filter
  const [sectorFilter, setSectorFilter] = useState<string>("all");

  // Per-column multi-select filters (field -> selected values)
  const [columnFilters, setColumnFilters] = useState<Record<string, string[]>>(
    {},
  );

  // Inbound vs outbound — two tables with different columns. All Sources
  // (the default) shows both in the inbound table's layout, told apart by
  // Source Type.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  // "Present": the table as a StarCapital table deck (null = closed), and the
  // open columns the table reports for it.
  const [presentDeck, setPresentDeck] = useState<PipelinePresentation | null>(null);
  const openColumnsRef = useRef<ColumnDef<PipelineCompany>[]>([]);
  const [stageHelpOpen, setStageHelpOpen] = useState(false);
  // Origin (document type) filter — Sourcing's pending table only.
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");

  // Tracks (investment theses) + matched-track filter
  const [tracks, setTracks] = useState<Track[]>([]);
  const [pipelineSettingsOpen, setPipelineSettingsOpen] = useState(false);
  // The pipeline page's heading is a workspace setting (see
  // PipelineHeadingContext). Sourcing keeps its own fixed copy.
  const { heading: pipelineHeading, setHeading: setPipelineHeading } =
    usePipelineHeading();
  const [headingDialogOpen, setHeadingDialogOpen] = useState(false);
  const [addCompanyOpen, setAddCompanyOpen] = useState(false);
  // "Add Company → Ask AI": the add-company brief staged in the active bot's
  // composer for the user to fill in and send — not sent on their behalf.
  const handleAddCompanyWithAI = () => {
    prefillComposer(buildAddCompanyPrompt(tracks));
    if (isMobile) {
      router.push(chatHref);
      return;
    }
    focusCopilot();
  };
  const [trackFilter, setTrackFilter] = useState<string[]>([]);
  // Bumped after Pipeline Settings saves so the AI Market Scanning banner refetches.
  const [tracksRefreshKey, setTracksRefreshKey] = useState(0);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Promote/Demote dialog state
  const [promoteDialogOpen, setPromoteDialogOpen] = useState(false);
  const [promotingCompany, setPromotingCompany] =
    useState<PipelineCompany | null>(null);
  const [dialogMode, setDialogMode] = useState<"promote" | "demote">("promote");

  // Drop deal dialog state
  const [dropDealCompany, setDropDealCompany] =
    useState<PipelineCompany | null>(null);
  const [dropReason, setDropReason] = useState("");
  // Optional automatic resurface: "none" | months preset | "custom" (+ date).
  const [dropResurfaceOption, setDropResurfaceOption] = useState("none");
  const [dropResurfaceDate, setDropResurfaceDate] = useState("");
  const [isDropping, setIsDropping] = useState(false);
  const [showTriageModal, setShowTriageModal] = useState(false);

  const fetchCompanies = async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const data = await getCompanies({
        stageNotNull: true,
        excludeStage: "market_screening",
        orderBy: "created_at",
        orderDir: "desc",
      });

      const formatted: PipelineCompany[] =
        data?.map((company: any) => ({
          id: company.id,
          target: company.target || "",
          project_name: company.project_name ?? null,
          segment: company.segment || "",
          geo: company.geography || company.geo || null,
          website: company.website ?? null,
          watchlist_status: company.watchlist_status,
          revenue_2021_usd_mn: company.revenue_2021_usd_mn,
          revenue_2022_usd_mn: company.revenue_2022_usd_mn,
          revenue_2023_usd_mn: company.revenue_2023_usd_mn,
          revenue_2024_usd_mn: company.revenue_2024_usd_mn,
          revenue_2025_usd_mn: company.revenue_2025_usd_mn,
          ebitda_2021_usd_mn: company.ebitda_2021_usd_mn,
          ebitda_2022_usd_mn: company.ebitda_2022_usd_mn,
          ebitda_2023_usd_mn: company.ebitda_2023_usd_mn,
          ebitda_2024_usd_mn: company.ebitda_2024_usd_mn,
          ebitda_2025_usd_mn: company.ebitda_2025_usd_mn,
          ev_2024: company.ev_2024,
          pipeline_stage: (company.pipeline_stage || "L0") as DealStage,
          l1_screening_result: company.l1_screening_result,
          pic:
            Array.isArray(company.assignees) && company.assignees.length > 0
              ? company.assignees
                .map((a: { name: string | null }) => a.name)
                .filter(Boolean)
                .join(", ")
              : (company.pic ?? null),
          remarks: company.remarks || null,
          created_at: company.created_at,
          updated_at: company.updated_at,
          source: company.source || null,
          status: company.status ?? null,
          dropped_reason: company.dropped_reason ?? null,
          dropped_at: company.dropped_at ?? null,
          promoted_reasons: company.promoted_reasons ?? null,
          ownership: company.ownership ?? null,
          geography: company.geography ?? null,
          deal_type: company.deal_type ?? null,
          entered_by: company.entered_by ?? null,
          entered_by_name: company.entered_by_name ?? null,
          originator: company.originator ?? null,
          deal_sponsor: company.deal_sponsor ?? null,
          deal_sponsor_name: company.deal_sponsor_name ?? null,
          deal_captain: company.deal_captain ?? null,
          deal_captain_name: company.deal_captain_name ?? null,
          last_activity_at: company.last_activity_at ?? null,
          banker: company.banker ?? null,
          advisor: company.advisor ?? null,
          doc_type: company.doc_type ?? null,
          nbo_date: company.nbo_date ?? null,
          is_live: company.is_live ?? null,
          stake: company.stake ?? null,
          deal_size: company.deal_size ?? null,
          workflow_status: company.workflow_status ?? null,
          key_rationale: company.key_rationale ?? null,
          banker_source: company.banker_source ?? null,
          possible_duplicate_company_id:
            company.possible_duplicate_company_id ?? null,
          matched_track_ids: company.matched_track_ids ?? [],
          track_specific_variables: company.track_specific_variables ?? null,
          slide_track_variable_ids: company.slide_track_variable_ids ?? null,
          ai_opinion_verdict: company.ai_opinion_verdict ?? null,
          ai_opinion_summary: company.ai_opinion_summary ?? null,
          ai_opinion_status: company.ai_opinion_status ?? null,
          ai_opinion_updated_at: company.ai_opinion_updated_at ?? null,
          financials_raw: company.financials_raw,
        })) || [];

      setCompanies(formatted);
      setCompaniesLoaded(true);
    } catch (error: any) {
      console.error("Error fetching companies:", error);
      toast.error("Failed to load companies");
    } finally {
      if (!opts.silent) setLoading(false);
    }
  };

  const refetchAfterCompanyUpdate = async (companyId: string) => {
    setUpdatingCompanyIds((prev) => {
      const next = new Set(prev);
      next.add(companyId);
      return next;
    });
    try {
      await fetchCompanies({ silent: true });
    } finally {
      setUpdatingCompanyIds((prev) => {
        const next = new Set(prev);
        next.delete(companyId);
        return next;
      });
    }
  };

  const fetchNewCandidatesCount = async () => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const count = await getCompaniesCount({
        stage: "market_screening",
        createdAfter: sevenDaysAgo.toISOString(),
      });
      setNewCandidatesCount(count || 0);
    } catch (error) {
      console.error("Error fetching candidates count:", error);
    }
  };

  useEffect(() => {
    fetchCompanies();
    // The new-candidates count is only shown on Sourcing's AI Market Scanning tab.
    if (isSourcing) fetchNewCandidatesCount();
  }, [isSourcing]);

  // Every Pipeline URL keeps the page tab, the stage and the search, so
  // switching tabs and back restores the table's filter.
  const pipelineUrl = (
    view: StageView,
    query: string,
    tab: PipelineTab = pipelineTab,
  ) => {
    const params = new URLSearchParams({ stage: view });
    if (query.trim()) params.set("q", query.trim());
    if (tab === "screening") params.set("tab", tab);
    return `${pipelineHref}?${params.toString()}`;
  };

  const handleStageViewChange = (value: StageView) => {
    posthog.capture("pipeline_stage_changed", {
      from_stage: stageView,
      to_stage: value,
    });

    setStageView(value);
    setCurrentPage(1);
    router.push(pipelineUrl(value, searchQuery));
  };

  // A `?stage=` for a stage this workspace doesn't have (deleted, or a stale
  // link) falls back to every stage once the stage list has loaded.
  useEffect(() => {
    if (isSourcing || pipelineStages.loading) return;
    if (stageView === "all" || stageView === "pending") return;
    if (!stageKeys.includes(stageView)) {
      setStageView("all");
      router.replace(pipelineUrl("all", searchQuery));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check only when the stage list or view changes
  }, [pipelineStages.loading, stageKeys, stageView, isSourcing]);

  // A search looks through every stage, Pending Confirmation included, and
  // the stage filter is disabled while it runs; the selected stage is left as
  // it was, so clearing the search goes back to it.
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    // replaceState, not the router: a keystroke shouldn't add history entries
    // or refetch the page.
    window.history.replaceState(null, "", pipelineUrl(stageView, value));
  };

  // Load tracks (investment theses) once, for matching + filtering + editing.
  const fetchTracks = () => {
    getTracks()
      .then(setTracks)
      .catch((err) => console.error("Failed to load tracks:", err));
  };
  useEffect(() => {
    fetchTracks();
  }, []);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [
    searchQuery,
    sectorFilter,
    l1StatusFilter,
    stageView,
    viewMode,
    sourceFilter,
    trackFilter,
    docTypeFilter,
    columnFilters,
  ]);

  // Clear per-column filters when the underlying pool changes, since their
  // option lists (and therefore selections) no longer apply.
  useEffect(() => {
    setColumnFilters({});
  }, [stageView, viewMode, sourceFilter]);

  const handleColumnFilterChange = (field: string, values: string[]) => {
    setColumnFilters((prev) => {
      const next = { ...prev };
      if (values.length === 0) delete next[field];
      else next[field] = values;
      return next;
    });
  };

  const isSearching = searchQuery.trim() !== "";
  // A search finds a deal whether it is live or dropped, so it overrides the
  // Pipeline Status filter (which keeps its selection for when it's cleared).
  const effectiveViewMode: PipelineViewMode = isSearching ? "all" : viewMode;

  const isDropped = (c: PipelineCompany) => c.status === "dropped";
  const isActive = (c: PipelineCompany) => !isDropped(c);
  const matchesViewMode = (c: PipelineCompany) =>
    effectiveViewMode === "all" ||
    (effectiveViewMode === "dropped" ? isDropped(c) : isActive(c));

  // Workflow status options: per-source defaults ∪ distinct values already
  // saved on the single `workflow_status` column.
  const savedStatuses = companies
    .map((c) => c.workflow_status)
    .filter((s): s is string => !!s && s.trim() !== "");
  const inboundStatusOptions = [
    ...new Set([...DEFAULT_INBOUND_STATUS_OPTIONS, ...savedStatuses]),
  ];
  const outboundStatusOptions = [
    ...new Set([...DEFAULT_OUTBOUND_STATUS_OPTIONS, ...savedStatuses]),
  ];

  // Persist a free-text workflow status change, optimistically first.
  const handleStatusChange = async (company: PipelineCompany, next: string) => {
    setCompanies((prev) =>
      prev.map((c) =>
        c.id === company.id ? { ...c, workflow_status: next } : c,
      ),
    );
    try {
      await updateCompany(company.id, { workflow_status: next });
    } catch (err: any) {
      console.error("Failed to update status:", err);
      toast.error("Failed to update status");
      fetchCompanies({ silent: true });
    }
  };

  // Value accessors for per-column multi-select filters. The returned string is
  // matched against the user's selected values; `null` means "no value" and is
  // surfaced as a "—" option.
  const COLUMN_FILTER_ACCESSORS: Record<
    string,
    (c: PipelineCompany) => string | null
  > = {
    sector: (c) => c.segment || null,
    geo: (c) => c.geo || null,
    deal_type: (c) => c.deal_type || null,
    status: (c) => c.workflow_status || null,
    entered_by: (c) => c.entered_by_name || null,
    source_type: (c) => sourceTypeLabel(c.source),
    banker: (c) => c.banker ?? c.banker_source ?? null,
    advisor: (c) => c.advisor || null,
    is_live: (c) => (isDealLive(c) ? "Live" : "Not live"),
    stake: (c) => c.stake || null,
    stage: (c) => stageCellLabel(c.pipeline_stage, pipelineStages.code),
    // Deal Sponsor (L0–L2) / Deal Captain (L3+), read at the row's own stage
    // since All Stages mixes both: the stored per-company override, else the
    // matched Track's PIC(s). Mirrors the table cell so the filter options
    // match what's actually displayed.
    deal_lead: (c) => effectiveDealLead(c, c.pipeline_stage, tracks, captainKeys),
  };

  const EMPTY_FILTER_VALUE = "__empty__";

  // Pipeline's search ignores the stage filter; Sourcing searches its own
  // Pending Confirmation list.
  const searchesAllStages = !isSourcing && isSearching;
  const matchesStageScope = (company: PipelineCompany) =>
    searchesAllStages
      ? matchesSearchScope(company)
      : matchesStageView(company, stageView);

  // Pool the column-filter option lists are derived from: everything in the
  // current stage/source/view, before the search text and the column filters
  // themselves.
  const columnFilterPool = companies.filter(
    (company) =>
      matchesStageScope(company) &&
      matchesSourceFilter(company, sourceFilter) &&
      matchesViewMode(company),
  );

  const getColumnFilterOptions = (field: string) => {
    const accessor = COLUMN_FILTER_ACCESSORS[field];
    if (!accessor) return [];
    const values = new Set<string>();
    let hasEmpty = false;
    for (const company of columnFilterPool) {
      const raw = accessor(company);
      if (raw === null || raw.trim() === "") hasEmpty = true;
      else values.add(raw);
    }
    // deal_type is stored as a snake_case enum value; everything else is
    // already free text the user typed.
    const labelFor = (value: string) =>
      field === "deal_type" ? (formatDealType(value) ?? value) : value;
    const options = [...values]
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, label: labelFor(value) }));
    if (hasEmpty) options.push({ value: EMPTY_FILTER_VALUE, label: "—" });
    return options;
  };

  const filterOptions: Record<string, { value: string; label: string }[]> =
    Object.fromEntries(
      Object.keys(COLUMN_FILTER_ACCESSORS).map((field) => [
        field,
        getColumnFilterOptions(field),
      ]),
    );

  const matchesColumnFilters = (company: PipelineCompany) =>
    Object.entries(columnFilters).every(([field, selected]) => {
      if (selected.length === 0) return true;
      const accessor = COLUMN_FILTER_ACCESSORS[field];
      if (!accessor) return true;
      const raw = accessor(company);
      const value =
        raw === null || raw.trim() === "" ? EMPTY_FILTER_VALUE : raw;
      return selected.includes(value);
    });

  // Every filter except the stage view (and the L1-only screening result), so
  // a search can count its matches per stage tab. `source` overrides the
  // selected source for the other-source hint, which also skips the column
  // filters — those belong to the table on screen and reset on a source switch.
  const matchesNonStageFilters = (
    company: PipelineCompany,
    opts: { source?: SourceType; skipColumnFilters?: boolean } = {},
  ) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      companyDisplayName(company, "").toLowerCase().includes(q) ||
      (company.project_name || "").toLowerCase().includes(q) ||
      (company.segment || "").toLowerCase().includes(q);
    const matchesSector =
      sectorFilter === "all" || company.segment === sectorFilter;
    const matchesSource = matchesSourceFilter(
      company,
      opts.source ?? sourceFilter,
    );
    const matchesDocType =
      docTypeFilter === "all" || company.doc_type === docTypeFilter;
    const matchesView = matchesViewMode(company);
    const companyTrackIds = resolveTrackIds(company, tracks);
    const matchesTrack =
      trackFilter.length === 0 ||
      (trackFilter.includes(UNASSIGNED_TRACK_ID) &&
        companyTrackIds.length === 0) ||
      companyTrackIds.some((id) => trackFilter.includes(id));
    return (
      matchesSearch &&
      matchesSector &&
      matchesSource &&
      matchesDocType &&
      matchesView &&
      matchesTrack &&
      (opts.skipColumnFilters || matchesColumnFilters(company))
    );
  };

  // The screening-result dropdown only shows on the screening stage's tab, so
  // it only applies there (and not during a search, which spans every stage).
  const matchesL1Status = (company: PipelineCompany) =>
    searchesAllStages ||
    stageView !== screeningStage ||
    l1StatusFilter === "all" ||
    company.l1_screening_result === l1StatusFilter;

  const filteredCompanies = companies.filter(
    (company) =>
      matchesStageScope(company) &&
      matchesL1Status(company) &&
      matchesNonStageFilters(company),
  );

  // While searching on Pipeline: matches in the other source's table. All
  // Sources already shows both, so there is no other table to point at.
  const otherSource: SourceType =
    sourceFilter === "inbound" ? "outbound" : "inbound";
  const otherSourceMatchCount = searchesAllStages && sourceFilter !== "all"
    ? companies.filter(
        (company) =>
          matchesSearchScope(company) &&
          matchesNonStageFilters(company, {
            source: otherSource,
            skipColumnFilters: true,
          }),
      ).length
    : 0;

  // Apply sorting
  const sortedCompanies = [...filteredCompanies].sort((a, b) => {
    // Default sort (no column actively selected):
    // - Dropped view: newest dropped date first
    // - Active view: newest created date first
    if (!sortField) {
      if (effectiveViewMode === "dropped") {
        const aDropped = a.dropped_at ? new Date(a.dropped_at).getTime() : 0;
        const bDropped = b.dropped_at ? new Date(b.dropped_at).getTime() : 0;
        return bDropped - aDropped;
      }
      const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bCreated - aCreated;
    }

    let aVal: any;
    let bVal: any;

    switch (sortField) {
      case "name":
        aVal = `${a.target} ${a.project_name ?? ""}`.trim().toLowerCase();
        bVal = `${b.target} ${b.project_name ?? ""}`.trim().toLowerCase();
        break;
      case "sector":
        aVal = (a.segment || "").toLowerCase();
        bVal = (b.segment || "").toLowerCase();
        break;
      case "geo":
        aVal = (a.geo || "").toLowerCase();
        bVal = (b.geo || "").toLowerCase();
        break;
      case "deal_type":
        // Sort on the rendered label, not the raw enum value, so the column
        // orders the way the user reads it ("M&A Advisory", not "ma_advisory").
        aVal = (formatDealType(a.deal_type) ?? "").toLowerCase();
        bVal = (formatDealType(b.deal_type) ?? "").toLowerCase();
        break;
      case "stake":
        aVal = (a.stake || "").toLowerCase();
        bVal = (b.stake || "").toLowerCase();
        break;
      case "status":
        aVal = (a.workflow_status || "").toLowerCase();
        bVal = (b.workflow_status || "").toLowerCase();
        break;
      case "source_type":
        aVal = sourceTypeLabel(a.source) ?? "";
        bVal = sourceTypeLabel(b.source) ?? "";
        break;
      case "entered_by":
        aVal = (a.entered_by_name || "").toLowerCase();
        bVal = (b.entered_by_name || "").toLowerCase();
        break;
      case "deal_lead":
        aVal = (effectiveDealLead(a, a.pipeline_stage, tracks, captainKeys) || "").toLowerCase();
        bVal = (effectiveDealLead(b, b.pipeline_stage, tracks, captainKeys) || "").toLowerCase();
        break;
      case "stage":
        aVal = stageSortRank(a.pipeline_stage, stageKeys);
        bVal = stageSortRank(b.pipeline_stage, stageKeys);
        break;
      case "banker":
        aVal = (a.banker ?? a.banker_source ?? "").toLowerCase();
        bVal = (b.banker ?? b.banker_source ?? "").toLowerCase();
        break;
      case "advisor":
        aVal = (a.advisor ?? "").toLowerCase();
        bVal = (b.advisor ?? "").toLowerCase();
        break;
      case "created":
        aVal = a.created_at ? new Date(a.created_at).getTime() : 0;
        bVal = b.created_at ? new Date(b.created_at).getTime() : 0;
        break;
      case "last_activity":
        aVal = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0;
        bVal = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0;
        break;
      case "nbo_date":
        aVal = a.nbo_date ? new Date(a.nbo_date).getTime() : 0;
        bVal = b.nbo_date ? new Date(b.nbo_date).getTime() : 0;
        break;
      case "is_live":
        aVal = isDealLive(a) ? 1 : 0;
        bVal = isDealLive(b) ? 1 : 0;
        break;
      case "dropped_on":
        aVal = a.dropped_at ? new Date(a.dropped_at).getTime() : 0;
        bVal = b.dropped_at ? new Date(b.dropped_at).getTime() : 0;
        break;
      case "revenue":
        aVal = a.revenue_2024_usd_mn || 0;
        bVal = b.revenue_2024_usd_mn || 0;
        break;
      case "ebitda":
        aVal = a.ebitda_2024_usd_mn || 0;
        bVal = b.ebitda_2024_usd_mn || 0;
        break;
      case "valuation":
        aVal = a.ev_2024 || 0;
        bVal = b.ev_2024 || 0;
        break;
      case "updated":
        aVal = new Date(a.updated_at).getTime();
        bVal = new Date(b.updated_at).getTime();
        break;
      default:
        return 0;
    }

    if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
    if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  // Direction-aware sort setter for the column right-click menu.
  const setSortColumn = (field: string, direction: "asc" | "desc") => {
    setSortField(field);
    setSortDirection(direction);
  };

  const totalPages = Math.max(
    1,
    Math.ceil(sortedCompanies.length / itemsPerPage),
  );
  const paginatedCompanies = sortedCompanies.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage,
  );
  // Pending Confirmation (any source) and inbound L0 show every row on one
  // page.
  const showsEveryRow =
    !searchesAllStages &&
    effectiveViewMode !== "dropped" &&
    (stageView === "pending" ||
      (stageView === "L0" && sourceFilter === "inbound"));
  // Pending Confirmation is reviewed in the inbound table layout whatever the
  // source, so outbound pending rows get the same Add to L0 · Delete menu and
  // review flags as inbound ones.
  const reviewsPending = stageView === "pending" && !searchesAllStages;

  // "Sort by" preset: Newest is the default order (created date, or dropped
  // date in the Dropped view); Oldest is that same date ascending. Any other
  // column sort shows as a custom sort.
  const dateSortField = effectiveViewMode === "dropped" ? "dropped_on" : "created";
  const sortPreset: "newest" | "oldest" | "" = !sortField
    ? "newest"
    : sortField === dateSortField
      ? sortDirection === "asc"
        ? "oldest"
        : "newest"
      : "";
  const visibleCompanies = showsEveryRow
    ? sortedCompanies
    : paginatedCompanies;

  // Tell the copilot what this table is currently showing, so "summarize this
  // page" or "why are these stalled?" resolves against the user's actual view
  // instead of the whole pipeline. Memoized on the filter values so the context
  // isn't rewritten on every keystroke-driven re-render.
  useSetPageDetail(
    useMemo(() => {
      if (!isSourcing && pipelineTab === 'screening') {
        return 'The Deal Pipeline page, AI Screening tab: the progress and results of AI screening runs on Pending Confirmation and L0 deals against their matched tracks.';
      }
      if (isSourcing) {
        if (sourcingTab === 'scanning') {
          return 'The Sourcing page, AI Market Scanning tab: the market scan status and the AI-discovered companies waiting to be added to L0.';
        }
        const filters = [
          docTypeFilter !== 'all' ? `origin ${docTypeFilter}` : null,
          trackFilter.length > 0 ? `${trackFilter.length} track filter(s)` : null,
          searchQuery.trim() ? `search "${searchQuery.trim()}"` : null,
        ].filter(Boolean);
        return [
          'The Sourcing page, Pending Confirmation tab: unreviewed deals (inbound and outbound) awaiting triage before they enter L0',
          filters.length > 0 ? `, filtered to: ${filters.join(', ')}.` : '.',
          ` ${sortedCompanies.length} deal(s) match.`,
        ].join('');
      }
      const stageScope = isSearching
        ? 'every pipeline stage and Pending Confirmation (a search ignores the stage filter)'
        : stageView === 'all'
          ? 'every pipeline stage'
          : stageView === 'pending'
            ? 'Pending Confirmation (unreviewed deals awaiting triage)'
            : `stage ${pipelineStages.label(stageView)}`;
      const filters = [
        stageScope,
        sourceFilter === 'all' ? 'inbound and outbound deals' : sourceFilter,
        effectiveViewMode === 'all'
          ? 'active and dropped deals'
          : effectiveViewMode === 'dropped'
            ? 'dropped deals'
            : 'active deals',
        sectorFilter !== 'all' ? `sector ${sectorFilter}` : null,
        stageView === screeningStage && l1StatusFilter !== 'all'
          ? `screening result ${l1StatusFilter}`
          : null,
        trackFilter.length > 0 ? `${trackFilter.length} track filter(s)` : null,
        isSearching ? `search "${searchQuery.trim()}"` : null,
      ].filter(Boolean);
      return [
        `The deal pipeline table, filtered to: ${filters.join(', ')}.`,
        `${sortedCompanies.length} deal(s) match; ${visibleCompanies.length} shown on this page.`,
      ].join(' ');
    }, [
      isSourcing,
      sourcingTab,
      pipelineTab,
      docTypeFilter,
      stageView,
      pipelineStages,
      screeningStage,
      isSearching,
      sourceFilter,
      effectiveViewMode,
      sectorFilter,
      l1StatusFilter,
      trackFilter.length,
      searchQuery,
      sortedCompanies.length,
      visibleCompanies.length,
    ]),
  );

  // MB-225: every active unreviewed company, independent of the current
  // filters, so the triage modal always covers the whole bucket.
  const allUnreviewedCompanies = companies.filter(
    (c) => c.pipeline_stage === "unreviewed" && isActive(c),
  );

  // Handler for bulk triage confirm
  async function handleTriageConfirm(
    decisions: Array<{ id: string; action: "keep" | "drop"; reason?: string }>,
  ): Promise<{ keepErrors?: Array<{ id: string; missingFields: string[] }> }> {
    const res = await fetch("/api/companies/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    });
    const json = await res.json();
    if (res.status === 422 && json.keepErrors) {
      await fetchCompanies({ silent: true });
      return { keepErrors: json.keepErrors };
    }
    if (!res.ok) throw new Error(json.error || "Triage failed");
    await fetchCompanies({ silent: true });
    toast.success("Triage applied");
    return {};
  }

  useEffect(() => {
    setCurrentPage(1);
  }, [stageView, searchQuery, sectorFilter, l1StatusFilter]);

  // Live pending-screening set: the Pending Confirmation + L0 screenings list,
  // refetched whenever a screening changes state; we derive the pending
  // company ids and reconcile the optimistic "starting" set.
  const { data: inScreeningRows } = useQuery({
    queryKey: [LIVE_TOPICS.screenings, workspaceSlug, "in-screening"],
    queryFn: () =>
      getScreenings({ inScreening: true }) as Promise<
        Array<{ state: string; company_id: string }>
      >,
    refetchInterval: liveRefetchInterval,
  });
  useEffect(() => {
    // react-query keeps the reference when the rows are unchanged, so this
    // runs only when a screening actually changed state.
    if (!inScreeningRows) return;
    const pendingIds = new Set(
      inScreeningRows
        .filter((screening) => screening.state === "pending")
        .map((screening) => screening.company_id),
    );
    setPendingScreeningCompanyIds(pendingIds);
    setStartingScreeningCompanyIds((prev) => {
      const next = new Set(prev);
      pendingIds.forEach((id) => next.delete(id));
      return next.size === prev.size ? prev : next;
    });
    // Drive the progress panel off this same query. It used to poll every
    // 5s on its own, forever, even with nothing running — this refetches it
    // exactly when a screening actually changed state.
    setScreeningProgressRefresh((n) => n + 1);
  }, [inScreeningRows]);

  const runningScreeningCompanyIds = mergeRunningScreeningCompanyIds(
    pendingScreeningCompanyIds,
    startingScreeningCompanyIds,
    screeningTasks,
  );

  // While any company has an in-flight AI Opinion run, watch the compact
  // set of processing companies; when it changes (a run finished) refresh the
  // list once so the spinner swaps for the verdict.
  const hasProcessingAiOpinion = companies.some(
    (c) => c.ai_opinion_status === "processing",
  );
  const { data: processingAiOpinions } = useQuery({
    queryKey: [LIVE_TOPICS.aiOpinion, workspaceSlug, "processing"],
    queryFn: getProcessingAiOpinions,
    enabled: hasProcessingAiOpinion,
    refetchInterval: liveRefetchInterval,
  });
  const processingAiOpinionSignature = processingAiOpinions
    ?.map((r) => `${r.id}:${r.ai_opinion_status ?? ""}`)
    .sort()
    .join("|");
  const lastProcessingAiOpinionSignature = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!hasProcessingAiOpinion || processingAiOpinionSignature === undefined) return;
    if (lastProcessingAiOpinionSignature.current === processingAiOpinionSignature) return;
    lastProcessingAiOpinionSignature.current = processingAiOpinionSignature;
    void fetchCompanies({ silent: true });
  }, [hasProcessingAiOpinion, processingAiOpinionSignature]);

  const runScreeningForCompany = async (company: PipelineCompany) => {
    if (runningScreeningCompanyIds.has(company.id)) return;

    setStartingScreeningCompanyIds((prev) => new Set(prev).add(company.id));

    try {
      const { alreadyQueued, trackCount } = await startAIScreening(company.id);
      setStartingScreeningCompanyIds((prev) => {
        const next = new Set(prev);
        next.delete(company.id);
        return next;
      });
      const name = companyDisplayName(company, "this company");
      toast.success(
        alreadyQueued
          ? `AI screening for ${name} is already queued in AI Workforce`
          : trackCount > 0
            ? `Queued AI screening for ${name} across ${trackCount} ${trackCount === 1 ? "track" : "tracks"} — follow it in AI Workforce`
            : `Queued AI screening for ${name} — it will match tracks first; follow it in AI Workforce`,
      );
      setScreeningProgressRefresh((prev) => prev + 1);
      fetchCompanies({ silent: true });
    } catch (error: any) {
      console.error("Screening error:", error);
      setStartingScreeningCompanyIds((prev) => {
        const next = new Set(prev);
        next.delete(company.id);
        return next;
      });
      toast.error(error.message || "Failed to start AI screening");
    }
  };

  const runAiOpinionForCompany = async (company: PipelineCompany) => {
    if (analyzingAiOpinionIds.has(company.id)) return;

    setAnalyzingAiOpinionIds((prev) => new Set(prev).add(company.id));
    try {
      await analyzeAiOpinion(company.id);
      toast.success(
        `AI Workforce is forming an opinion on ${companyDisplayName(company, "this company")}`,
      );
      // Pull in the optimistic ai_opinion_status='processing' the dispatch set,
      // then let the poll below swap in the verdict once the run completes.
      // Refresh is best-effort — a fetch failure must not look like analyze failed.
      try {
        await fetchCompanies({ silent: true });
      } catch (refreshErr) {
        console.error("Failed to refresh companies after AI Opinion dispatch:", refreshErr);
      }
    } catch (error: any) {
      console.error("AI Opinion error:", error);
      toast.error(error.message || "Failed to start AI Opinion analysis");
    } finally {
      setAnalyzingAiOpinionIds((prev) => {
        const next = new Set(prev);
        next.delete(company.id);
        return next;
      });
    }
  };

  // Stage the promote/demote dialog will move `promotingCompany` to. Mirrors
  // the row-menu logic in the Inbound/Outbound tables — including the
  // fallback out of L0 into Pending Confirmation — so the dialog can never
  // target a stage the menu that opened it wouldn't offer.
  // `null` (nothing to move to) keeps the dialog unmounted entirely.
  const stageMoveTarget: DealStage | null = promotingCompany
    ? dialogMode === "demote"
      ? demoteTargetForStage(promotingCompany.pipeline_stage, stageKeys)
      : promoteTargetForStage(promotingCompany.pipeline_stage, stageKeys)
    : null;

  const handleRestoreDeal = async (company: PipelineCompany) => {
    try {
      const { restored, stage } = await restoreWithStagePrompt({
        id: company.id,
        name: companyDisplayName(company, "This deal"),
        currentStage: company.pipeline_stage,
      });
      if (!restored) return;
      posthog.capture("deal_restored", {
        deal_id: company.id,
        company_name: companyDisplayName(company, ""),
        to_stage: stage,
      });
      toast.success(`Restored ${companyDisplayName(company, "company")}`);
      fetchCompanies();
    } catch (err: any) {
      console.error("Error restoring deal:", err);
      toast.error(`Failed to restore deal: ${err.message || "Unknown error"}`);
    }
  };

  const pendingCount = allUnreviewedCompanies.length;

  // Keep the sidebar's Sourcing badge in step with triage/promote/drop here.
  const publishPendingCount = usePublishSourcingPendingCount();
  useEffect(() => {
    if (companiesLoaded) publishPendingCount(pendingCount);
  }, [companiesLoaded, pendingCount, publishPendingCount]);

  const pendingActive = stageView === "pending";

  // Stage the tables are scoped to, or undefined when rows span stages. The
  // Pending Confirmation bucket sits under L0, so it shares L0's columns.
  const tableStage: DealStage | undefined =
    searchesAllStages
      ? undefined
      : stageView === "pending"
      ? "L0"
      : stageView === "all"
        ? undefined
        : stageView;

  const handlePipelineTabChange = (tab: PipelineTab) => {
    setPipelineTab(tab);
    router.replace(pipelineUrl(stageView, searchQuery, tab));
  };

  const handleSourcingTabChange = (tab: SourcingTab) => {
    setSourcingTab(tab);
    router.replace(`${sourcingHref}?tab=${tab}`);
  };

  const stageDescription =
    stageView === "all"
      ? null
      : stageView === "pending"
        ? PENDING_DESCRIPTION
        : pipelineStages.description(stageView) || null;
  // The description reads as one line under the tabs; the full text (lists
  // and all) is in the Pipeline Stages help dialog.
  const stageDescriptionFlat = stageDescription?.replace(/\s*\n+\s*/g, " ").trim() ?? "";
  const stageDescriptionTruncated =
    stageDescriptionFlat.length > STAGE_DESCRIPTION_PREVIEW_CHARS;
  const stageDescriptionPreview = stageDescriptionTruncated
    ? `${stageDescriptionFlat.slice(0, STAGE_DESCRIPTION_PREVIEW_CHARS).trimEnd()}…`
    : stageDescriptionFlat;

  // The stage filter's tabs: every stage, then each live stage as "L0 · Company Sourcing".
  const stageTabs: { value: StageView; label: string }[] = [
    { value: "all", label: "All Stages" },
    ...pipelineStages.live.map((stage) => ({
      value: stage.key,
      label: pipelineStages.label(stage.key),
    })),
  ];
  // "Present": a snapshot of the table as the user has it — every row its
  // stage, source, search and column filters let through (all pages, not just
  // this one), in its sort order, with exactly its open columns in their order
  // (the table reports them through `openColumnsRef`; hidden columns and
  // collapsed groups are left out). Built when Present is clicked; the dialog
  // is modal, so nothing it reflects can change while it is open.
  const openPresentation = () => {
    const columns = openColumnsRef.current.map((col) => ({
      label: col.label,
      text: (c: PipelineCompany) => col.text?.(c) ?? "",
      align:
        typeof col.cellClassName === "string" && /\btext-right\b/.test(col.cellClassName)
          ? ("right" as const)
          : ("left" as const),
    }));
    setPresentDeck(
      buildPipelinePresentation(sortedCompanies, columns, {
        subtitle: [
          isSearching
            ? `Search "${searchQuery.trim()}"`
            : stageView === "all"
              ? "All stages"
              : stageView === "pending"
                ? "Pending Confirmation"
                : pipelineStages.label(stageView),
          sourceFilter === "all"
            ? "Inbound & outbound"
            : sourceFilter === "inbound"
              ? "Inbound"
              : "Outbound",
          effectiveViewMode === "all"
            ? "Active & dropped"
            : effectiveViewMode === "dropped"
              ? "Dropped"
              : "Active",
          sectorFilter !== "all" ? sectorFilter : null,
          stageView === screeningStage && l1StatusFilter !== "all"
            ? `Screening: ${l1StatusFilter}`
            : null,
          trackFilter.length > 0
            ? `${trackFilter.length} track filter${trackFilter.length === 1 ? "" : "s"}`
            : null,
          Object.keys(columnFilters).length > 0
            ? `${Object.keys(columnFilters).length} column filter${Object.keys(columnFilters).length === 1 ? "" : "s"}`
            : null,
          `${sortedCompanies.length} ${sortedCompanies.length === 1 ? "company" : "companies"}`,
          new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
        ]
          .filter(Boolean)
          .join(" · "),
      }),
    );
  };
  const stageHelpItems: { key: string; label: string; description: string }[] = [
    { key: "pending", label: "Pending Confirmation", description: PENDING_DESCRIPTION },
    ...pipelineStages.live.map((stage) => ({
      key: stage.key,
      label: pipelineStages.label(stage.key),
      description: stage.description,
    })),
  ];

  const openCompanyDetail = (company: PipelineCompany) => {
    posthog.capture("company_detail_viewed", {
      company_id: company.id,
      company_name: companyDisplayName(company, ""),
      pipeline_stage: company.pipeline_stage,
    });
    setOpenDetailInEdit(false);
    setDetailInitialTab(null);
    setSelectedCompany(company);
  };

  // Props shared by the inbound and outbound tables.
  const tableProps = {
    openColumnsRef,
    tracks,
    stage: tableStage,
    viewMode: effectiveViewMode,
    updatingCompanyIds,
    onRunScreening: runScreeningForCompany,
    runningScreeningCompanyIds,
    onAnalyzeAiOpinion: runAiOpinionForCompany,
    analyzingAiOpinionIds,
    sortField,
    sortDirection,
    onSort: toggleSort,
    onSortColumn: setSortColumn,
    columnFilters,
    filterOptions,
    onColumnFilterChange: handleColumnFilterChange,
    onOpenDetail: openCompanyDetail,
    onStatusChange: handleStatusChange,
    onUpdate: (company: PipelineCompany) => {
      setOpenDetailInEdit(true);
      setDetailInitialTab(null);
      setSelectedCompany(company);
    },
    onPromote: (company: PipelineCompany) => {
      setDialogMode("promote");
      setPromotingCompany(company);
      setPromoteDialogOpen(true);
    },
    onDemote: (company: PipelineCompany) => {
      setDialogMode("demote");
      setPromotingCompany(company);
      setPromoteDialogOpen(true);
    },
    onDrop: (company: PipelineCompany) => setDropDealCompany(company),
    onRestore: handleRestoreDeal,
  };

  // The deal table and its pager, shared by Pipeline and Sourcing.
  const companiesTable =
    loading ? (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    ) : (
      <>
        <div className="overflow-x-auto">
          {sourceFilter === "inbound" ? (
            <InboundCompaniesTable
              {...tableProps}
              companies={visibleCompanies}
              statusOptions={inboundStatusOptions}
              showSourceType={!isSourcing}
              groupByReviewState={false}
              onTriageAll={() => setShowTriageModal(true)}
            />
          ) : sourceFilter === "all" || reviewsPending ? (
            <InboundCompaniesTable
              {...tableProps}
              companies={visibleCompanies}
              statusOptions={inboundStatusOptions}
              outboundStatusOptions={outboundStatusOptions}
              // Sourcing keeps the column layout it saved before it held
              // outbound deals too.
              layoutId={isSourcing ? "pipeline-inbound" : "pipeline-all"}
              groupByReviewState={false}
            />
          ) : (
            <OutboundCompaniesTable
              {...tableProps}
              companies={visibleCompanies}
              statusOptions={outboundStatusOptions}
            />
          )}
        </div>
        {!showsEveryRow && totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t">
            <p className="text-sm text-muted-foreground">
              Page {currentPage} of {totalPages} (
              {sortedCompanies.length} companies)
            </p>
            <div className="flex items-center gap-2">
              <Button
                data-testid="pipeline-pagination-prev-button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setCurrentPage((p) => Math.max(1, p - 1))
                }
                disabled={currentPage === 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                data-testid="pipeline-pagination-next-button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setCurrentPage((p) => Math.min(totalPages, p + 1))
                }
                disabled={currentPage === totalPages}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </>
    );

  return (
    <>
      {/* The SQE Suite surface palette (MB-648 prototypes): the shared
          full-bleed header band over the flat page colour, cards below. */}
      <div className="suite-surface min-h-full bg-background animate-fade-in">
        <PageHeader
          title={isSourcing ? "Sourcing" : pipelineHeading.title}
          titleTestId="pipeline-heading-title"
          subtitle={
            isSourcing
              ? "Candidates not yet promoted into L0 sourcing"
              : pipelineHeading.subtitle
          }
          subtitleTestId="pipeline-heading-subtitle"
          titleAdornment={
            !isSourcing && (
              <Button
                data-testid="pipeline-heading-edit-button"
                variant="ghost"
                size="icon"
                aria-label="Edit pipeline heading"
                title="Edit title and subtitle"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => setHeadingDialogOpen(true)}
              >
                <PencilLine className="h-4 w-4" />
              </Button>
            )
          }
          actions={
            <Button
              data-testid={
                isSourcing ? "sourcing-track-button" : "pipeline-configure-button"
              }
              variant="outline"
              onClick={() => setPipelineSettingsOpen(true)}
              className="gap-2 bg-card text-muted-foreground"
            >
              <Settings className="h-4 w-4" />
              Pipeline Settings
            </Button>
          }
        />

        <div className="space-y-6 p-6">
        {isSourcing ? (
          <>
            <Tabs
              value={sourcingTab}
              onValueChange={(value) =>
                handleSourcingTabChange(value as SourcingTab)
              }
            >
              <TabsList
                data-testid="sourcing-tabs"
                className="h-auto w-full justify-start gap-1 rounded-none border-b bg-transparent p-0"
              >
                <TabsTrigger
                  data-testid="sourcing-tab-pending"
                  value="pending"
                  className={PAGE_TAB_CLASS}
                >
                  Pending Confirmation
                  {pendingCount > 0 && (
                    <span className="ml-1.5 rounded-full bg-orange-100 px-1.5 py-0.5 text-xs font-semibold leading-none text-orange-700 dark:bg-orange-950 dark:text-orange-300">
                      {pendingCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  data-testid="sourcing-tab-scanning"
                  value="scanning"
                  className={PAGE_TAB_CLASS}
                >
                  AI Market Scanning
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {sourcingTab === "pending" ? (
              <Card className="shadow-md">
                <CardHeader className="pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500" />
                        Pending Confirmation
                        <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-xs font-semibold leading-none text-orange-700 dark:bg-orange-950 dark:text-orange-300">
                          {pendingCount}
                        </span>
                      </CardTitle>
                      <CardDescription>
                        Companies awaiting initial screening decision
                      </CardDescription>
                    </div>
                    <PendingAutomationToggles
                      pendingCount={pendingCount}
                      onQueued={() => fetchCompanies({ silent: true })}
                    />
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="relative min-w-[220px] flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        data-testid="sourcing-search-input"
                        placeholder="Search companies or sectors..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                    <Select value={docTypeFilter} onValueChange={setDocTypeFilter}>
                      <SelectTrigger
                        data-testid="sourcing-origin-select"
                        className="w-40 h-9"
                      >
                        <SelectValue placeholder="Origin" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Origins</SelectItem>
                        {DOC_TYPE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Column-config gear portals in here (see tables). */}
                    <div
                      id="pipeline-columns-config"
                      className="shrink-0 flex items-center"
                    />
                  </div>

                  {/* MB-224: Triage Banner */}
                  <TriageBanner
                    companies={sortedCompanies}
                    onTriageClick={() => setShowTriageModal(true)}
                  />

                  {companiesTable}
                </CardContent>
              </Card>
            ) : (
              <>
                <MarketScreeningStatus
                  onScanComplete={() => {
                    setMarketScreeningRefresh((prev) => prev + 1);
                    fetchNewCandidatesCount();
                  }}
                  newCandidatesCount={newCandidatesCount}
                  refreshKey={tracksRefreshKey}
                />

                {/* AI-Discovered Companies Results */}
                <MarketScreeningResults
                  refreshTrigger={marketScreeningRefresh}
                  onAddedToPipeline={() => {
                    fetchCompanies();
                    fetchNewCandidatesCount();
                  }}
                />
              </>
            )}
          </>
        ) : (
          <>
            <Tabs
              value={pipelineTab}
              onValueChange={(value) =>
                handlePipelineTabChange(value as PipelineTab)
              }
            >
              <TabsList
                data-testid="pipeline-page-tabs"
                className="h-auto w-full justify-start gap-1 rounded-none border-b bg-transparent p-0"
              >
                <TabsTrigger
                  data-testid="pipeline-page-tab-pipeline"
                  value="pipeline"
                  className={PAGE_TAB_CLASS}
                >
                  Pipeline
                </TabsTrigger>
                <TabsTrigger
                  data-testid="pipeline-page-tab-screening"
                  value="screening"
                  className={PAGE_TAB_CLASS}
                >
                  AI Screening
                  {runningScreeningCompanyIds.size > 0 && (
                    <span className="ml-1.5 rounded-full bg-yellow-100 px-1.5 py-0.5 text-xs font-semibold leading-none text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300">
                      {runningScreeningCompanyIds.size}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {pipelineTab === "screening" ? (
              // The panel lists Pending Confirmation and L0 screenings; row
              // Run AI Screening is Pending Confirmation only (Scan now path).
              <ScreeningProgressPanel
                refreshTrigger={screeningProgressRefresh}
                tasks={screeningTasks}
                onScreeningComplete={() => {
                  fetchCompanies();
                }}
                onCompanyClick={(companyId) => {
                  // `companies` holds every non-market-screening deal, so a
                  // Pending Confirmation or L0 row is always here.
                  const company = companies.find((c) => c.id === companyId);
                  if (company) {
                    setOpenDetailInEdit(false);
                    setDetailInitialTab("filters");
                    setSelectedCompany(company);
                  }
                }}
              />
            ) : (
              <Card className="shadow-md">
                <CardHeader className="pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-lg">Pipeline Companies</CardTitle>
                      <CardDescription>Manage your deals in the pipeline</CardDescription>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 ml-auto">
                      <Button
                        data-testid="pipeline-present-button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={loading}
                        onClick={openPresentation}
                      >
                        <Presentation className="h-4 w-4" />
                        Present
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button data-testid="pipeline-add-company-button" size="sm">
                            <Plus className="mr-2 h-4 w-4" />
                            Add Company
                            <ChevronDown className="ml-2 h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            data-testid="pipeline-add-company-manual"
                            onSelect={() => setAddCompanyOpen(true)}
                          >
                            <PencilLine className="mr-2 h-4 w-4" />
                            Manual
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            data-testid="pipeline-add-company-ask-ai"
                            onSelect={handleAddCompanyWithAI}
                          >
                            <Sparkles className="mr-2 h-4 w-4" />
                            Ask AI
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            data-testid="pipeline-add-company-drop-file"
                            onSelect={() => router.push(smartFilesHref)}
                          >
                            <Upload className="mr-2 h-4 w-4" />
                            Drop File
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      data-testid="pipeline-search-input"
                      placeholder="Search companies or sectors..."
                      value={searchQuery}
                      onChange={(e) => handleSearchChange(e.target.value)}
                      className="pl-9"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <button
                        type="button"
                        data-testid="pipeline-pending-chip"
                        aria-pressed={pendingActive}
                        disabled={searchesAllStages}
                        onClick={() =>
                          handleStageViewChange(pendingActive ? "all" : "pending")
                        }
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          pendingActive
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Pending Confirmation
                        {pendingCount > 0 && (
                          <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-xs font-semibold leading-none text-red-700 dark:bg-red-950 dark:text-red-300">
                            {pendingCount}
                          </span>
                        )}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-testid="pipeline-stage-help-button"
                        className="h-6 w-6 shrink-0 text-muted-foreground"
                        title="What are pipeline stages?"
                        aria-label="What are pipeline stages?"
                        onClick={() => setStageHelpOpen(true)}
                      >
                        <HelpCircle className="h-4 w-4" />
                      </Button>
                      <span className="shrink-0 text-xs font-bold tracking-wider text-muted-foreground">
                        STAGE
                      </span>
                      <Tabs
                        value={stageView}
                        onValueChange={(value) =>
                          handleStageViewChange(parseStageView(value, stageKeys))
                        }
                        className="min-w-0"
                      >
                        <TabsList
                          data-testid="pipeline-stage-tabs"
                          className="h-auto max-w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0"
                        >
                          {stageTabs.map((tab) => (
                            <TabsTrigger
                              key={tab.value}
                              data-testid={`pipeline-tab-${tab.value.toLowerCase()}`}
                              value={tab.value}
                              disabled={searchesAllStages}
                              className="shrink-0 gap-1.5 rounded-none border-b-2 border-transparent px-3 py-2 text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none disabled:cursor-not-allowed"
                            >
                              {tab.label}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </Tabs>
                    </div>
                    {searchesAllStages && (
                      <p
                        data-testid="pipeline-search-scope-hint"
                        className="text-xs text-muted-foreground"
                      >
                        Searching every stage, including Pending Confirmation,
                        and both active and dropped deals. Clear the search to
                        filter by stage and status.
                      </p>
                    )}
                    {otherSourceMatchCount > 0 && (
                      <p
                        data-testid="pipeline-other-source-hint"
                        className="text-xs text-muted-foreground"
                      >
                        {otherSourceMatchCount}{" "}
                        {otherSourceMatchCount === 1 ? "match" : "matches"} in{" "}
                        {otherSource === "inbound" ? "Inbound" : "Outbound"}
                        {" — "}
                        <button
                          type="button"
                          className="font-semibold text-primary hover:underline"
                          onClick={() => setSourceFilter(otherSource)}
                        >
                          Show
                        </button>
                      </p>
                    )}
                    {stageDescription && !searchesAllStages && (
                      <p
                        data-testid="pipeline-stage-description"
                        className="text-xs text-muted-foreground"
                      >
                        <span className="font-semibold">Description: </span>
                        {stageDescriptionPreview}
                        {stageDescriptionTruncated && (
                          <button
                            type="button"
                            data-testid="pipeline-stage-description-more"
                            className="ml-1 font-semibold text-primary hover:underline"
                            onClick={() => setStageHelpOpen(true)}
                          >
                            Show more
                          </button>
                        )}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <Select
                      value={sourceFilter}
                      onValueChange={(value) =>
                        setSourceFilter(value as SourceFilter)
                      }
                    >
                      <SelectTrigger
                        data-testid="pipeline-source-select"
                        className="w-36 h-9"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Sources</SelectItem>
                        <SelectItem value="inbound">Inbound</SelectItem>
                        <SelectItem value="outbound">Outbound</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={effectiveViewMode}
                      onValueChange={(value) =>
                        setViewMode(value as PipelineViewMode)
                      }
                      disabled={isSearching}
                    >
                      <SelectTrigger
                        data-testid="pipeline-status-select"
                        className="w-44 h-9"
                        title={
                          isSearching
                            ? "A search looks through active and dropped deals"
                            : undefined
                        }
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Pipeline Status</SelectItem>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="dropped">Dropped</SelectItem>
                      </SelectContent>
                    </Select>
                    {tracks.length > 0 && (
                      <TrackMultiSelect
                        tracks={tracks}
                        value={trackFilter}
                        onChange={setTrackFilter}
                        variant="filter"
                        placeholder="All Tracks"
                        className="w-44 h-9"
                        includeUnassigned
                      />
                    )}
                    {stageView === screeningStage && !searchesAllStages && (
                      <Select
                        value={l1StatusFilter}
                        onValueChange={(v) => setL1StatusFilter(v as "all" | L1Status)}
                      >
                        <SelectTrigger className="w-40 h-9">
                          <SelectValue placeholder="Status" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Status</SelectItem>
                          <SelectItem value="Pass">Pass</SelectItem>
                          <SelectItem value="Fail">Fail</SelectItem>
                          <SelectItem value="Inconclusive">Inconclusive</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    <Select
                      value={sortPreset}
                      onValueChange={(value) => {
                        if (value === "newest") setSortField(null);
                        else setSortColumn(dateSortField, "asc");
                      }}
                    >
                      <SelectTrigger
                        data-testid="pipeline-sort-select"
                        className="w-44 h-9"
                      >
                        <SelectValue placeholder="Sort by: Column" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="newest">Sort by: Newest</SelectItem>
                        <SelectItem value="oldest">Sort by: Oldest</SelectItem>
                      </SelectContent>
                    </Select>
                    {/* Column-config gear portals in here (see tables). */}
                    <div
                      id="pipeline-columns-config"
                      className="shrink-0 flex items-center"
                    />
                  </div>

                  {/* The Pending Confirmation bucket carries the same
                      automation controls as Sourcing's Pending tab. */}
                  {reviewsPending && (
                    <div
                      data-testid="pipeline-pending-automation"
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted px-4 py-2"
                    >
                      <span className="text-sm text-muted-foreground">
                        Pending Confirmation automation
                      </span>
                      <PendingAutomationToggles
                        pendingCount={pendingCount}
                        onQueued={() => fetchCompanies({ silent: true })}
                        testIdPrefix="pipeline"
                      />
                    </div>
                  )}

                  {companiesTable}
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Opened only from the Pipeline view, never on Sourcing. */}
        {!isSourcing && (
          <Dialog open={stageHelpOpen} onOpenChange={setStageHelpOpen}>
            <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Pipeline Stages</DialogTitle>
                <DialogDescription>
                  What each stage means and what&apos;s needed to move forward.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {stageHelpItems.map((item) => (
                  <div key={item.key} className="rounded-lg border bg-card px-4 py-3">
                    <div className="font-semibold">{item.label}</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        )}

        {selectedCompany && (
          <CompanyDetailDialog
            key={selectedCompany.id}
            company={selectedCompany}
            open={!!selectedCompany}
            onOpenChange={(open) => {
              if (!open) {
                setSelectedCompany(null);
                setOpenDetailInEdit(false);
                setDetailInitialTab(null);
              }
            }}
            onUpdate={() => refetchAfterCompanyUpdate(selectedCompany.id)}
            initialTab={openDetailInEdit ? "details" : (detailInitialTab ?? "overview")}
            initialEditing={openDetailInEdit}
          />
        )}

        {/* Workspace-wide page heading. Mounted only while open so the inputs
            re-seed from the current heading on every open. */}
        {!isSourcing && headingDialogOpen && (
          <PipelineHeadingDialog
            open={headingDialogOpen}
            onOpenChange={setHeadingDialogOpen}
            heading={pipelineHeading}
            onSaved={setPipelineHeading}
          />
        )}

        <PipelineSettingsDialog
          open={pipelineSettingsOpen}
          onOpenChange={setPipelineSettingsOpen}
          onSaved={() => {
            fetchTracks();
            setTracksRefreshKey((k) => k + 1);
          }}
          // Deleting a stage moves its deals; reordering changes the tabs.
          onStagesChanged={() => fetchCompanies({ silent: true })}
        />
        {restoreStageDialog}

        {/* Opened only from the Pipeline view, never on Sourcing. */}
        {!isSourcing && presentDeck && (
          <PipelinePresentationDialog
            open={!!presentDeck}
            onOpenChange={(open) => {
              if (!open) setPresentDeck(null);
            }}
            deck={presentDeck}
          />
        )}

        {/* Opened only from the Pipeline view, never on Sourcing. */}
        {!isSourcing && (
          <Dialog open={addCompanyOpen} onOpenChange={setAddCompanyOpen}>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add Company to L0 Pipeline</DialogTitle>
                <DialogDescription>
                  New L0 companies are matched to tracks automatically.
                </DialogDescription>
              </DialogHeader>
              <AddCompanyForm
                onCancel={() => setAddCompanyOpen(false)}
                onSuccess={() => {
                  setAddCompanyOpen(false);
                  fetchCompanies();
                }}
              />
            </DialogContent>
          </Dialog>
        )}

        {/* MB-223: Bulk Triage Modal */}
        <BulkTriageModal
          open={showTriageModal}
          companies={allUnreviewedCompanies}
          onClose={() => setShowTriageModal(false)}
          onConfirm={handleTriageConfirm}
          onEdit={(id) => {
            const company = allUnreviewedCompanies.find((c) => c.id === id);
            if (company) {
              setShowTriageModal(false);
              setOpenDetailInEdit(true);
              setDetailInitialTab(null);
              setSelectedCompany(company);
            }
          }}
        />

        {promotingCompany && stageMoveTarget && (
          <PromoteDialog
            open={promoteDialogOpen}
            onOpenChange={setPromoteDialogOpen}
            dealId={promotingCompany.id}
            companyName={companyDisplayName(promotingCompany, "this company")}
            currentStage={promotingCompany.pipeline_stage}
            nextStage={stageMoveTarget}
            onSuccess={() => {
              setPromotingCompany(null);
              fetchCompanies();
            }}
            mode={dialogMode}
          />
        )}

        <AlertDialog
          open={!!dropDealCompany}
          onOpenChange={(open) => {
            if (!open) {
              setDropDealCompany(null);
              setDropReason("");
              setDropResurfaceOption("none");
              setDropResurfaceDate("");
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Drop deal?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to drop{" "}
                <span className="font-medium">
                  {companyDisplayName(dropDealCompany, "this company")}
                </span>
                ? This will remove the deal from the pipeline.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="mt-2">
              <Label htmlFor="drop-reason">Reason (optional)</Label>
              <Textarea
                id="drop-reason"
                placeholder="Why is this deal being dropped?"
                value={dropReason}
                onChange={(e) => setDropReason(e.target.value)}
                rows={3}
                className="mt-1.5"
                disabled={isDropping}
              />
            </div>
            <div className="mt-2">
              <Label htmlFor="drop-resurface">Resurface at (optional)</Label>
              <Select
                value={dropResurfaceOption}
                onValueChange={(value) => {
                  setDropResurfaceOption(value);
                  if (value !== "custom") setDropResurfaceDate("");
                }}
                disabled={isDropping}
              >
                <SelectTrigger
                  id="drop-resurface"
                  data-testid="drop-deal-resurface-select"
                  className="mt-1.5"
                >
                  <SelectValue placeholder="Don't resurface" />
                </SelectTrigger>
                <SelectContent>
                  {RESURFACE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {dropResurfaceOption === "custom" && (
                <Input
                  type="date"
                  data-testid="drop-deal-resurface-date"
                  value={dropResurfaceDate}
                  onChange={(e) => setDropResurfaceDate(e.target.value)}
                  min={new Date(Date.now() + 86400000)
                    .toISOString()
                    .slice(0, 10)}
                  className="mt-1.5"
                  disabled={isDropping}
                />
              )}
              {dropResurfaceOption !== "none" && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The deal will automatically return to the active pipeline on
                  this date, and the PIC and you will be notified by email.
                </p>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="drop-deal-cancel-button"
                disabled={isDropping}
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="drop-deal-confirm-button"
                disabled={
                  isDropping ||
                  (dropResurfaceOption === "custom" && !dropResurfaceDate)
                }
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={async (e) => {
                  e.preventDefault();
                  if (!dropDealCompany) return;
                  const resurfaceAt = computeResurfaceAt(
                    dropResurfaceOption,
                    dropResurfaceDate,
                  );
                  if (resurfaceAt && new Date(resurfaceAt) <= new Date()) {
                    toast.error("Resurface date must be in the future");
                    return;
                  }
                  setIsDropping(true);
                  try {
                    await dropDeal(dropDealCompany.id, {
                      currentStage: dropDealCompany.pipeline_stage,
                      reason: dropReason,
                      resurfaceAt,
                    });
                    posthog.capture("deal_dropped", {
                      deal_id: dropDealCompany.id,
                      company_name: companyDisplayName(dropDealCompany, ""),
                      from_stage: dropDealCompany.pipeline_stage,
                      has_reason: dropReason.trim() !== "",
                      has_resurface_at: !!resurfaceAt,
                    });
                    toast.success(
                      `Dropped ${companyDisplayName(dropDealCompany, "company")}`,
                    );
                    setDropDealCompany(null);
                    setDropReason("");
                    setDropResurfaceOption("none");
                    setDropResurfaceDate("");
                    fetchCompanies();
                  } catch (err: any) {
                    console.error("Error dropping deal:", err);
                    toast.error(
                      `Failed to drop deal: ${err.message || "Unknown error"}`,
                    );
                  } finally {
                    setIsDropping(false);
                  }
                }}
              >
                {isDropping ? "Dropping..." : "Drop deal"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </div>
      </div>
    </>
  );
}
