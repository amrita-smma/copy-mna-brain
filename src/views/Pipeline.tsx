"use client";

import { useState, useEffect } from "react";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  Building2,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  FileText,
  Loader2,
  Plus,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Settings,
} from "lucide-react";
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
import CompanyDetailDialog from "@/components/pipeline/CompanyDetailDialog";
import UpdateCompanyDialog from "@/components/pipeline/UpdateCompanyDialog";
import InboundCompaniesTable from "@/components/pipeline/InboundCompaniesTable";
import OutboundCompaniesTable from "@/components/pipeline/OutboundCompaniesTable";
import TrackSettingsDialog from "@/components/pipeline/TrackSettingsDialog";
import TrackMultiSelect, {
  UNASSIGNED_TRACK_ID,
} from "@/components/pipeline/TrackMultiSelect";
import { resolveTrackIds } from "@/lib/tracks/matchTracks";
import { DOC_TYPE_OPTIONS } from "@/lib/constants";
import {
  DEFAULT_INBOUND_STATUS_OPTIONS,
  DEFAULT_OUTBOUND_STATUS_OPTIONS,
} from "@/components/pipeline/StatusCombobox";
import AIScreeningDialog from "@/components/pipeline/AIScreeningDialog";
import MarketScreeningStatus from "@/components/pipeline/MarketScreeningStatus";
import MarketScreeningResults from "@/components/pipeline/MarketScreeningResults";
import ScreeningProgressPanel from "@/components/pipeline/ScreeningProgressPanel";
import { CollapsibleSection } from "@/components/common/CollapsibleSection";
import { TriageBanner } from "@/components/pipeline/TriageBanner";
import { BulkTriageModal } from "@/components/pipeline/BulkTriageModal";
import { DuplicatePopup } from "@/components/pipeline/DuplicatePopup";
import { cn } from "@/lib/utils";
import { companyDisplayName } from "@/lib/companyDisplay";
import posthog from "posthog-js";
import { useAuth } from "@/hooks/useAuth";
import {
  getCompanies,
  getCompaniesCount,
  getFavoriteCompanies,
  toggleFavoriteCompany,
  promoteCompany,
  runCompanyL1Filters,
  dropDeal,
  restoreDeal,
  updateCompany,
  getTracks,
  getScreenings,
  type Track,
} from "@/lib/api/pipeline";
import {
  runAIScreeningForCompanies,
  toAIScreeningCompany,
} from "@/lib/aiScreeningClient";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

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
  originator: string | null;
  last_activity_at: string | null;
  banker: string | null;
  doc_type: string | null;
  stake: string | null;
  deal_size: string | null;
  workflow_status: string | null;
  key_rationale: string | null;
  review_state: string;
  banker_source: string | null;
  possible_duplicate_company_id: string | null;
  matched_track_ids: string[];
  financials_raw?: import('@/lib/repositories').Tables<'company_financials'>[];
}

const STAGES: DealStage[] = ["L0", "L1", "L2", "L3", "L4", "L5"];

const stageDescriptions: Record<DealStage, string> = {
  market_screening: "AI Market Scanning - AI-discovered companies",
  L0: "Company Sourcing - Inbound & Outbound companies",
  L1: "Automated Screening - Filter evaluation",
  L2: "Initial Review - Manual assessment",
  L3: "Deep Dive - Detailed analysis",
  L4: "Due Diligence - Final verification",
  L5: "Closing - Deal completion",
  discovered: "Discovered - Surfaced via the relationship graph",
};

const stageColors: Record<
  DealStage,
  { bg: string; text: string; bgLight: string; textLight: string }
> = {
  market_screening: {
    bg: "bg-purple-500",
    text: "text-white",
    bgLight: "bg-purple-500/15",
    textLight: "text-purple-600",
  },
  L0: {
    bg: "bg-stage-l0",
    text: "text-white",
    bgLight: "bg-stage-l0/15",
    textLight: "text-stage-l0",
  },
  L1: {
    bg: "bg-stage-l1",
    text: "text-white",
    bgLight: "bg-stage-l1/15",
    textLight: "text-stage-l1",
  },
  L2: {
    bg: "bg-stage-l2",
    text: "text-white",
    bgLight: "bg-stage-l2/15",
    textLight: "text-stage-l2",
  },
  L3: {
    bg: "bg-stage-l3",
    text: "text-white",
    bgLight: "bg-stage-l3/15",
    textLight: "text-stage-l3",
  },
  L4: {
    bg: "bg-stage-l4",
    text: "text-white",
    bgLight: "bg-stage-l4/15",
    textLight: "text-stage-l4",
  },
  L5: {
    bg: "bg-stage-l5",
    text: "text-white",
    bgLight: "bg-stage-l5/15",
    textLight: "text-stage-l5",
  },
  discovered: {
    bg: "bg-amber-500",
    text: "text-white",
    bgLight: "bg-amber-500/15",
    textLight: "text-amber-600",
  },
};


const getRevenueChange = (year2: number | null, year3: number | null) => {
  if (year2 === null || year3 === null || year2 === 0) return null;
  return ((year3 - year2) / year2) * 100;
};

const L1StatusBadge = ({ status }: { status: L1Status | null }) => {
  if (!status) return <Badge variant="outline">Pending</Badge>;

  const getStatusStyles = (status: L1Status) => {
    switch (status) {
      case "Pass":
        return "bg-blue-500/20 text-blue-600 border-blue-500/30 hover:bg-blue-500/30";
      case "Inconclusive":
        return "bg-amber-500/20 text-amber-600 border-amber-500/30 hover:bg-amber-500/30";
      case "Fail":
        return "bg-red-500/20 text-red-600 border-red-500/30 hover:bg-red-500/30";
      default:
        return "";
    }
  };

  const icons: Record<L1Status, any> = {
    Pass: CheckCircle2,
    Fail: XCircle,
    Inconclusive: AlertCircle,
  };

  const Icon = icons[status];
  const customStyles = getStatusStyles(status);

  return (
    <Badge variant="outline" className={`gap-1 ${customStyles}`}>
      <Icon className="h-3 w-3" />
      {status}
    </Badge>
  );
};

interface PipelineProps {
  showCompanyGraph?: boolean;
}

export default function Pipeline({ showCompanyGraph = false }: PipelineProps) {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialTab = searchParams.get("stage") || "L0";
  const [activeTab, setActiveTab] = useState<DealStage>(
    initialTab as DealStage,
  );
  const [companies, setCompanies] = useState<PipelineCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingCompanyIds, setUpdatingCompanyIds] = useState<Set<string>>(
    new Set(),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [sectorFilterValue, setSectorFilterValue] = useState<string>("all");
  const [selectedCompany, setSelectedCompany] =
    useState<PipelineCompany | null>(null);
  const [showScreeningDialog, setShowScreeningDialog] = useState(false);
  const [screeningCompanyIds, setScreeningCompanyIds] = useState<string[]>([]);
  const [marketScreeningRefresh, setMarketScreeningRefresh] = useState(0);
  const [screeningProgressRefresh, setScreeningProgressRefresh] = useState(0);
  const [pendingScreeningCompanyIds, setPendingScreeningCompanyIds] = useState<
    Set<string>
  >(new Set());
  const [startingScreeningCompanyIds, setStartingScreeningCompanyIds] =
    useState<Set<string>>(new Set());
  const [newCandidatesCount, setNewCandidatesCount] = useState(0);

  // Section visibility
  const [showL0Pipeline, setShowL0Pipeline] = useState(true);
  const [showMarketScanning, setShowMarketScanning] = useState(true);
  const [showMarketResults, setShowMarketResults] = useLocalStorage('pipeline:show-market-results', true);
  const [showScreeningProgress, setShowScreeningProgress] = useLocalStorage('pipeline:show-screening-progress', true);

  // Sorting state
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  // L1 status filter
  const [l1StatusFilter, setL1StatusFilter] = useState<"all" | L1Status>("all");

  // Active vs Dropped view
  const [viewMode, setViewMode] = useState<"active" | "dropped">("active");

  // Sector filter
  const [sectorFilter, setSectorFilter] = useState<string>("all");

  // Source sub-tab (replaces filter dropdown — real tabs now)
  const [sourceFilter, setSourceFilter] = useState<"inbound" | "outbound">("inbound");
  const [showUnreviewedOnly, setShowUnreviewedOnly] = useState(false);
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");

  // Tracks (investment theses) + matched-track filter
  const [tracks, setTracks] = useState<Track[]>([]);
  const [trackSettingsOpen, setTrackSettingsOpen] = useState(false);
  const [trackFilter, setTrackFilter] = useState<string[]>([]);
  // Bumped after Track Settings saves so the AI Market Scanning banner refetches.
  const [tracksRefreshKey, setTracksRefreshKey] = useState(0);

  // Favorites state
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [togglingFavorite, setTogglingFavorite] = useState<string | null>(null);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Promote/Demote dialog state
  const [promoteDialogOpen, setPromoteDialogOpen] = useState(false);
  const [promotingCompany, setPromotingCompany] =
    useState<PipelineCompany | null>(null);
  const [dialogMode, setDialogMode] = useState<"promote" | "demote">("promote");

  // Update company dialog state
  const [editingCompany, setEditingCompany] =
    useState<PipelineCompany | null>(null);

  // Drop deal dialog state
  const [dropDealCompany, setDropDealCompany] =
    useState<PipelineCompany | null>(null);
  const [dropReason, setDropReason] = useState("");
  const [isDropping, setIsDropping] = useState(false);
  const [showTriageModal, setShowTriageModal] = useState(false);

  const fetchCompanies = async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const data = await getCompanies({
        stageNotNull: true,
        excludeStage: "market_screening",
        orderBy: "updated_at",
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
          originator: company.originator ?? null,
          last_activity_at: company.last_activity_at ?? null,
          banker: company.banker ?? null,
          doc_type: company.doc_type ?? null,
          stake: company.stake ?? null,
          deal_size: company.deal_size ?? null,
          workflow_status: company.workflow_status ?? null,
          key_rationale: company.key_rationale ?? null,
          review_state: company.review_state ?? "reviewed",
          banker_source: company.banker_source ?? null,
          possible_duplicate_company_id:
            company.possible_duplicate_company_id ?? null,
          matched_track_ids: company.matched_track_ids ?? [],
          financials_raw: company.financials_raw,
        })) || [];

      setCompanies(formatted);
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

  const fetchFavorites = async () => {
    if (!user?.id) return;
    try {
      const favs = await getFavoriteCompanies(user.id);
      setFavoriteIds(new Set(favs || []));
    } catch (error: any) {
      console.error("Error fetching favorites:", error);
    }
  };

  const handleToggleFavorite = async (companyId: string) => {
    if (!user?.id) return;
    setTogglingFavorite(companyId);
    try {
      const updated = await toggleFavoriteCompany(user.id, companyId);
      setFavoriteIds(new Set(updated || []));
    } catch (error: any) {
      console.error("Error toggling favorite:", error);
      toast.error("Failed to update favorite");
    } finally {
      setTogglingFavorite(null);
    }
  };

  useEffect(() => {
    fetchCompanies();
    fetchNewCandidatesCount();
  }, []);

  useEffect(() => {
    fetchFavorites();
  }, [user?.id]);

  const handleTabChange = (value: string) => {
    // Capture pipeline stage change event
    posthog.capture("pipeline_stage_changed", {
      from_stage: activeTab,
      to_stage: value,
    });

    setActiveTab(value as DealStage);
    setCurrentPage(1);
    router.push(`/pipeline?stage=${value}`);
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
  }, [searchQuery, sectorFilter, l1StatusFilter, activeTab, viewMode, sourceFilter, trackFilter]);

  const isDropped = (c: PipelineCompany) => c.status === "dropped";
  const isActive = (c: PipelineCompany) => !isDropped(c);

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
  const handleStatusChange = async (
    company: PipelineCompany,
    next: string,
  ) => {
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

  const filteredCompanies = companies.filter((company) => {
    const matchesStage = company.pipeline_stage === activeTab;
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      companyDisplayName(company, "").toLowerCase().includes(q) ||
      (company.project_name || "").toLowerCase().includes(q) ||
      (company.segment || "").toLowerCase().includes(q);
    const matchesL1Status =
      l1StatusFilter === "all" ||
      company.l1_screening_result === l1StatusFilter;
    const matchesSector =
      sectorFilter === "all" || company.segment === sectorFilter;
    const matchesSource = company.source === sourceFilter;
    const matchesDocType =
      docTypeFilter === "all" || company.doc_type === docTypeFilter;
    // L0 inbound is split across two sub-tabs: the Unreviewed tab shows only
    // unreviewed companies, the Inbound tab shows only reviewed ones. Outbound
    // and the L1-L5 stages are unaffected by review state.
    const matchesReviewState =
      activeTab !== "L0" || sourceFilter !== "inbound"
        ? true
        : showUnreviewedOnly
          ? company.review_state === "unreviewed"
          : company.review_state !== "unreviewed";
    const matchesView =
      viewMode === "dropped" ? isDropped(company) : isActive(company);
    const companyTrackIds = resolveTrackIds(company, tracks);
    const matchesTrack =
      trackFilter.length === 0 ||
      (trackFilter.includes(UNASSIGNED_TRACK_ID) &&
        companyTrackIds.length === 0) ||
      companyTrackIds.some((id) => trackFilter.includes(id));
    return (
      matchesStage &&
      matchesSearch &&
      matchesL1Status &&
      matchesSector &&
      matchesSource &&
      matchesDocType &&
      matchesReviewState &&
      matchesView &&
      matchesTrack
    );
  });

  // Apply sorting (favorites always first)
  const sortedCompanies = [...filteredCompanies].sort((a, b) => {
    const aFav = favoriteIds.has(a.id) ? 1 : 0;
    const bFav = favoriteIds.has(b.id) ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;

    if (!sortField) return 0;

    let aVal: any;
    let bVal: any;

    switch (sortField) {
      case "name":
        aVal = `${a.target} ${a.project_name ?? ''}`.trim().toLowerCase();
        bVal = `${b.target} ${b.project_name ?? ''}`.trim().toLowerCase();
        break;
      case "sector":
        aVal = (a.segment || "").toLowerCase();
        bVal = (b.segment || "").toLowerCase();
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

  const totalPages = Math.max(
    1,
    Math.ceil(sortedCompanies.length / itemsPerPage),
  );
  const paginatedCompanies = sortedCompanies.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage,
  );
  const splitInboundReviewSections =
    activeTab === "L0" && sourceFilter === "inbound" && viewMode !== "dropped";
  const visibleCompanies = splitInboundReviewSections
    ? sortedCompanies
    : paginatedCompanies;

  // MB-225: unreviewed inbound companies for the current stage/view — independent
  // of the active sub-tab so the Unreviewed tab badge and triage modal stay correct
  // even while the Inbound (reviewed-only) tab is selected.
  const allUnreviewedCompanies = companies.filter(
    (c) =>
      c.pipeline_stage === activeTab &&
      c.source === "inbound" &&
      c.review_state === "unreviewed" &&
      (viewMode === "dropped" ? isDropped(c) : isActive(c)),
  );

  // Handler for bulk triage confirm
  async function handleTriageConfirm(
    decisions: Array<{ id: string; action: "keep" | "drop"; reason?: string }>,
  ) {
    const res = await fetch("/api/companies/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    });
    if (!res.ok) throw new Error("Triage failed");
    await fetchCompanies({ silent: true });
    toast.success("Triage applied");
  }

  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchQuery, sectorFilter, l1StatusFilter]);

  useEffect(() => {
    let cancelled = false;

    const fetchPendingScreenings = async () => {
      try {
        const data = await getScreenings({ onlyL0: true });
        if (cancelled) return;

        const pendingIds = new Set(
          data
            .filter((screening: { state: string }) => screening.state === "pending")
            .map((screening: { company_id: string }) => screening.company_id),
        );
        setPendingScreeningCompanyIds(pendingIds);
        setStartingScreeningCompanyIds((prev) => {
          const next = new Set(prev);
          pendingIds.forEach((id) => next.delete(id));
          return next.size === prev.size ? prev : next;
        });
      } catch (error) {
        console.error("Error fetching pending screenings:", error);
      }
    };

    fetchPendingScreenings();
    const interval = setInterval(fetchPendingScreenings, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [screeningProgressRefresh]);

  const runningScreeningCompanyIds = new Set([
    ...pendingScreeningCompanyIds,
    ...startingScreeningCompanyIds,
  ]);

  const runL1Filters = async (dealId: string) => {
    try {
      const data = await runCompanyL1Filters(dealId);
      const result = data as { status: string } | null;
      toast.success(`Filter completed: ${result?.status || "Unknown"}`);
      fetchCompanies();
    } catch (error: any) {
      console.error("Error running filters:", error);
      toast.error("Failed to run filters");
    }
  };

  const openScreeningCriteria = () => {
    setScreeningCompanyIds([]);
    setShowScreeningDialog(true);
  };

  const runScreeningForCompany = async (company: PipelineCompany) => {
    if (runningScreeningCompanyIds.has(company.id)) return;

    setStartingScreeningCompanyIds((prev) => new Set(prev).add(company.id));

    try {
      await runAIScreeningForCompanies([toAIScreeningCompany(company)]);
      setStartingScreeningCompanyIds((prev) => {
        const next = new Set(prev);
        next.delete(company.id);
        return next;
      });
      setPendingScreeningCompanyIds((prev) => new Set(prev).add(company.id));
      toast.success(
        `Started AI screening for ${companyDisplayName(company, "this company")}`,
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

  const getCompaniesForScreening = () => {
    return companies
      .filter((c) => screeningCompanyIds.includes(c.id))
      .map(toAIScreeningCompany);
  };

  const promoteToNextStage = async (
    companyId: string,
    currentStage: DealStage,
  ) => {
    const stageIndex = STAGES.indexOf(currentStage);
    if (stageIndex >= STAGES.length - 1) {
      toast.error("Already at final stage");
      return;
    }

    const nextStage = STAGES[stageIndex + 1];

    try {
      await promoteCompany(companyId, {
        currentStage,
        nextStage,
      });

      toast.success(`Promoted to ${nextStage}`);
      fetchCompanies();
    } catch (error: any) {
      console.error("Error promoting company:", error);
      toast.error("Failed to promote company");
    }
  };

  const stageCount = (stage: DealStage) =>
    companies.filter((c) => c.pipeline_stage === stage && isActive(c)).length;
  const sourceCount = (stage: DealStage, src: "inbound" | "outbound") =>
    companies.filter(
      (c) =>
        c.pipeline_stage === stage &&
        c.source === src &&
        (viewMode === "dropped" ? isDropped(c) : isActive(c)),
    ).length;

  // "New" = recently added (created within the last NEW_WINDOW_DAYS days).
  const NEW_WINDOW_DAYS = 7;
  const isRecentlyAdded = (c: PipelineCompany) => {
    if (!c.created_at) return false;
    const created = new Date(c.created_at).getTime();
    if (Number.isNaN(created)) return false;
    return Date.now() - created <= NEW_WINDOW_DAYS * 86_400_000;
  };
  const sourceNewCount = (stage: DealStage, src: "inbound" | "outbound") =>
    companies.filter(
      (c) =>
        c.pipeline_stage === stage &&
        c.source === src &&
        (viewMode === "dropped" ? isDropped(c) : isActive(c)) &&
        isRecentlyAdded(c),
    ).length;

  const handleRestoreDeal = async (company: PipelineCompany) => {
    try {
      await restoreDeal(company.id, { currentStage: company.pipeline_stage });
      posthog.capture("deal_restored", {
        deal_id: company.id,
        company_name: companyDisplayName(company, ""),
        to_stage: company.pipeline_stage,
      });
      toast.success(`Restored ${companyDisplayName(company, "company")}`);
      fetchCompanies();
    } catch (err: any) {
      console.error("Error restoring deal:", err);
      toast.error(`Failed to restore deal: ${err.message || "Unknown error"}`);
    }
  };

  const renderViewToggle = () => {
    const isDroppedView = viewMode === "dropped";
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="pipeline-view-toggle-button"
        onClick={() => setViewMode(isDroppedView ? "active" : "dropped")}
        className="ml-auto shrink-0 h-9 gap-2"
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            isDroppedView ? "bg-red-500" : "bg-emerald-500",
          )}
        />
        {isDroppedView ? "Dropped" : "Active"}
      </Button>
    );
  };

  const SOURCE_TABS: {
    value: "inbound" | "outbound";
    label: string;
    dot: string;
    activeText: string;
    activeBorder: string;
    badge: string;
  }[] = [
    {
      value: "inbound",
      label: "Inbound",
      dot: "bg-blue-600",
      activeText: "text-blue-700",
      activeBorder: "border-blue-700",
      badge: "bg-blue-100 text-blue-700",
    },
    {
      value: "outbound",
      label: "Outbound",
      dot: "bg-amber-600",
      activeText: "text-amber-700",
      activeBorder: "border-amber-700",
      badge: "bg-amber-100 text-amber-700",
    },
  ];

  const renderSourceTabs = (stage: DealStage) => (
    <div className="flex items-stretch gap-1 border-b mb-4">
      {SOURCE_TABS.map((t) => {
        const active = sourceFilter === t.value;
        const newCount = sourceNewCount(stage, t.value);
        return (
          <button
            key={t.value}
            type="button"
            data-testid={`pipeline-source-${t.value}-tab`}
            onClick={() => {
              setSourceFilter(t.value);
              setCurrentPage(1);
            }}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-all",
              active
                ? cn(t.activeText, t.activeBorder)
                : "text-muted-foreground border-transparent hover:text-foreground",
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", t.dot)} />
            {t.label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-xs font-semibold",
                active ? t.badge : "bg-muted text-muted-foreground",
              )}
            >
              {sourceCount(stage, t.value)}
            </span>
            {newCount > 0 && (
              <span
                className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"
                title={`${newCount} added in the last ${NEW_WINDOW_DAYS} days`}
              >
                {newCount} new
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
      <div className="p-6 space-y-6 animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Deal Pipeline</h1>
            <p className="text-muted-foreground">
              Track companies through all stages
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setTrackSettingsOpen(true)}
            className="gap-2"
          >
            <Settings className="h-4 w-4" />
            Track Settings
          </Button>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <TabsList data-testid="pipeline-stage-tabs" className="grid w-full grid-cols-6">
            {STAGES.map((stage) => (
              <TabsTrigger
                key={stage}
                data-testid={`pipeline-tab-${stage.toLowerCase()}`}
                value={stage}
                className={`relative transition-all ${
                  activeTab === stage
                    ? `${stageColors[stage].bg} ${stageColors[stage].text} data-[state=active]:${stageColors[stage].bg} data-[state=active]:${stageColors[stage].text}`
                    : `${stageColors[stage].bgLight} ${stageColors[stage].textLight} hover:opacity-80`
                }`}
              >
                {stage}
                <Badge
                  variant="secondary"
                  className={`ml-2 h-5 min-w-5 px-1.5 text-xs ${
                    activeTab === stage
                      ? "bg-white/20 text-white"
                      : `${stageColors[stage].bg} text-white`
                  }`}
                >
                  {stageCount(stage)}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>

          {STAGES.map((stage) => (
            <TabsContent key={stage} value={stage} className="mt-6 space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-xl">
                        {stage} - {stageDescriptions[stage].split(" - ")[0]}
                      </CardTitle>
                      <CardDescription>
                        {stageDescriptions[stage].split(" - ")[1]}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {/* L0 Specific Layout */}
                  {stage === "L0" ? (
                    <div className="space-y-6">
                      {/* Market Screening Status Banner */}
                      {/* Market Screening Status Banner */}
                      <MarketScreeningStatus
                        onScanComplete={() => {
                          setMarketScreeningRefresh((prev) => prev + 1);
                          fetchNewCandidatesCount();
                        }}
                        newCandidatesCount={newCandidatesCount}
                        isVisible={showMarketScanning}
                        onToggle={() =>
                          setShowMarketScanning(!showMarketScanning)
                        }
                        refreshKey={tracksRefreshKey}
                      />

                      {/* AI-Discovered Companies Results */}
                      <MarketScreeningResults
                        refreshTrigger={marketScreeningRefresh}
                        onAddedToPipeline={() => {
                          fetchCompanies();
                          fetchNewCandidatesCount();
                        }}
                        collapsed={!showMarketResults}
                        onToggleCollapse={() =>
                          setShowMarketResults(!showMarketResults)
                        }
                      />

                      {/* L0 Pipeline Companies */}
                      <Card className="border-dashed">
                        <CardHeader className="pb-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="min-w-0">
                                <CardTitle className="text-lg">
                                  L0 Pipeline Companies
                                </CardTitle>
                                <CardDescription>
                                  Companies sourced and ready for screening
                                </CardDescription>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 ml-auto">
                              {/* MB-223: Triage Unreviewed — persistent header button */}
                              {allUnreviewedCompanies.length > 0 && (
                                <Button
                                  data-testid="pipeline-triage-unreviewed-button"
                                  variant="outline"
                                  size="sm"
                                  className="gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50"
                                  onClick={() => setShowTriageModal(true)}
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  Triage Unreviewed
                                  <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-white">
                                    {allUnreviewedCompanies.length}
                                  </span>
                                </Button>
                              )}
                              {showL0Pipeline && (
                                <Button
                                  data-testid="pipeline-ai-screening-button"
                                  onClick={openScreeningCriteria}
                                  className="bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600 shadow-md transition-all hover:scale-[1.02]"
                                >
                                  <Sparkles className="mr-2 h-4 w-4" />
                                  AI Screening Criteria
                                </Button>
                              )}
                              <Link href="/ai-file-dump">
                                <Button data-testid="pipeline-add-company-button">
                                  <Plus className="mr-2 h-4 w-4" />
                                  Add Company
                                </Button>
                              </Link>
                              {/* Visibility toggle — always rightmost */}
                              <Button
                                data-testid="pipeline-l0-toggle-visibility-button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setShowL0Pipeline(!showL0Pipeline)
                                }
                                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                              >
                                {showL0Pipeline ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                                {showL0Pipeline ? "Hide" : "Show"}
                                {showL0Pipeline ? (
                                  <ChevronUp className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                          </div>
                        </CardHeader>
                        {showL0Pipeline && (
                          <CardContent className="px-0 pb-0">
                            {/* MB-225: Unreviewed / Inbound / Outbound sub-tabs */}
                            <div className="flex border-b px-6">
                              <button
                                type="button"
                                data-testid="pipeline-l0-unreviewed-tab"
                                onClick={() => {
                                  setSourceFilter("inbound");
                                  setShowUnreviewedOnly(true);
                                  setDocTypeFilter("all");
                                  setCurrentPage(1);
                                }}
                                className={cn(
                                  "flex items-center gap-2 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                                  sourceFilter === "inbound" && showUnreviewedOnly
                                    ? "border-amber-600 text-amber-700"
                                    : "border-transparent text-muted-foreground hover:text-foreground",
                                )}
                              >
                                <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
                                Inbound Pending Review
                                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-700">
                                  {allUnreviewedCompanies.length}
                                </span>
                              </button>
                              <div className="my-2 w-px bg-border mx-1" />
                              <button
                                type="button"
                                data-testid="pipeline-l0-inbound-tab"
                                onClick={() => {
                                  setSourceFilter("inbound");
                                  setShowUnreviewedOnly(false);
                                  setDocTypeFilter("all");
                                  setCurrentPage(1);
                                }}
                                className={cn(
                                  "flex items-center gap-2 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                                  sourceFilter === "inbound" && !showUnreviewedOnly
                                    ? "border-blue-600 text-blue-700"
                                    : "border-transparent text-muted-foreground hover:text-foreground",
                                )}
                              >
                                <span className="h-2 w-2 rounded-full bg-blue-600 shrink-0" />
                                Inbound
                                <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-blue-700">
                                  {sourceCount("L0", "inbound")}
                                </span>
                              </button>
                              <div className="my-2 w-px bg-border mx-1" />
                              <button
                                type="button"
                                data-testid="pipeline-l0-outbound-tab"
                                onClick={() => {
                                  setSourceFilter("outbound");
                                  setShowUnreviewedOnly(false);
                                  setDocTypeFilter("all");
                                  setCurrentPage(1);
                                }}
                                className={cn(
                                  "flex items-center gap-2 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                                  sourceFilter === "outbound"
                                    ? "border-amber-600 text-amber-700"
                                    : "border-transparent text-muted-foreground hover:text-foreground",
                                )}
                              >
                                <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
                                Outbound
                                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-700">
                                  {sourceCount("L0", "outbound")}
                                </span>
                              </button>
                            </div>

                            <div className="px-6 pt-4">
                            {/* Filters */}
                            <div className="flex items-center gap-4 mb-1.5 flex-wrap">
                              <div className="relative flex-1 max-w-sm">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                  placeholder="Search companies or sectors..."
                                  value={searchQuery}
                                  onChange={(e) =>
                                    setSearchQuery(e.target.value)
                                  }
                                  className="pl-9"
                                />
                              </div>
                              {/* Filter by matched Track */}
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
                              {/* Origin (document type) filter — only on inbound */}
                              {sourceFilter === "inbound" && (
                                <Select
                                  value={docTypeFilter}
                                  onValueChange={setDocTypeFilter}
                                >
                                  <SelectTrigger className="w-40 h-9">
                                    <SelectValue placeholder="Origin" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="all">
                                      All Origins
                                    </SelectItem>
                                    {DOC_TYPE_OPTIONS.map((opt) => (
                                      <SelectItem
                                        key={opt.value}
                                        value={opt.value}
                                      >
                                        {opt.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                              {renderViewToggle()}
                            </div>

                            {/* MB-224: Triage Banner */}
                            {sourceFilter === "inbound" && (
                              <TriageBanner
                                companies={sortedCompanies}
                                onTriageClick={() => setShowTriageModal(true)}
                              />
                            )}

                            {loading ? (
                              <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                              </div>
                            ) : sortedCompanies.length === 0 ? (
                              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                                <Building2 className="h-12 w-12 mb-4 opacity-50" />
                                <p>No companies in this stage</p>
                              </div>
                            ) : sourceFilter === "inbound" ? (
                              <>
                                <div className="overflow-x-auto">
                                  <InboundCompaniesTable
                                    companies={visibleCompanies}
                                    tracks={tracks}
                                    stage="L0"
                                    viewMode={viewMode}
                                    groupByReviewState={false}
                                    favoriteIds={favoriteIds}
                                    togglingFavorite={togglingFavorite}
                                    onToggleFavorite={handleToggleFavorite}
                                    updatingCompanyIds={updatingCompanyIds}
                                    statusOptions={inboundStatusOptions}
                                    onRunScreening={runScreeningForCompany}
                                    runningScreeningCompanyIds={runningScreeningCompanyIds}
                                    sortField={sortField}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    onOpenDetail={(company) => {
                                      posthog.capture("company_detail_viewed", {
                                        company_id: company.id,
                                        company_name: companyDisplayName(company, ""),
                                        pipeline_stage: company.pipeline_stage,
                                      });
                                      setSelectedCompany(company);
                                    }}
                                    onStatusChange={handleStatusChange}
                                    onTriageAll={() =>
                                      setShowTriageModal(true)
                                    }
                                    onKeep={(company) =>
                                      handleTriageConfirm([
                                        { id: company.id, action: "keep" },
                                      ])
                                    }
                                    onUpdate={(company) =>
                                      setEditingCompany(company)
                                    }
                                    onPromote={(company) => {
                                      setDialogMode("promote");
                                      setPromotingCompany(company);
                                      setPromoteDialogOpen(true);
                                    }}
                                    onDemote={(company) => {
                                      setDialogMode("demote");
                                      setPromotingCompany(company);
                                      setPromoteDialogOpen(true);
                                    }}
                                    onDrop={(company) =>
                                      setDropDealCompany(company)
                                    }
                                    onRestore={handleRestoreDeal}
                                  />
                                </div>
                                {!splitInboundReviewSections && totalPages > 1 && (
                                  <div className="flex items-center justify-between mt-4 pt-4 border-t">
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
                                          setCurrentPage((p) =>
                                            Math.max(1, p - 1),
                                          )
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
                                          setCurrentPage((p) =>
                                            Math.min(totalPages, p + 1),
                                          )
                                        }
                                        disabled={currentPage === totalPages}
                                      >
                                        <ChevronRight className="h-4 w-4" />
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </>
                            ) : (
                              <>
                                <div className="overflow-x-auto">
                                  <OutboundCompaniesTable
                                    companies={paginatedCompanies}
                                    tracks={tracks}
                                    stage="L0"
                                    viewMode={viewMode}
                                    favoriteIds={favoriteIds}
                                    togglingFavorite={togglingFavorite}
                                    onToggleFavorite={handleToggleFavorite}
                                    updatingCompanyIds={updatingCompanyIds}
                                    statusOptions={outboundStatusOptions}
                                    onRunScreening={runScreeningForCompany}
                                    runningScreeningCompanyIds={runningScreeningCompanyIds}
                                    sortField={sortField}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    onOpenDetail={(company) => {
                                      posthog.capture("company_detail_viewed", {
                                        company_id: company.id,
                                        company_name: companyDisplayName(company, ""),
                                        pipeline_stage: company.pipeline_stage,
                                      });
                                      setSelectedCompany(company);
                                    }}
                                    onStatusChange={handleStatusChange}
                                    onUpdate={(company) =>
                                      setEditingCompany(company)
                                    }
                                    onPromote={(company) => {
                                      setDialogMode("promote");
                                      setPromotingCompany(company);
                                      setPromoteDialogOpen(true);
                                    }}
                                    onDemote={(company) => {
                                      setDialogMode("demote");
                                      setPromotingCompany(company);
                                      setPromoteDialogOpen(true);
                                    }}
                                    onDrop={(company) =>
                                      setDropDealCompany(company)
                                    }
                                    onRestore={handleRestoreDeal}
                                  />
                                </div>
                                {totalPages > 1 && (
                                  <div className="flex items-center justify-between mt-4 pt-4 border-t">
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
                                          setCurrentPage((p) =>
                                            Math.max(1, p - 1),
                                          )
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
                                          setCurrentPage((p) =>
                                            Math.min(totalPages, p + 1),
                                          )
                                        }
                                        disabled={currentPage === totalPages}
                                      >
                                        <ChevronRight className="h-4 w-4" />
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </>
                            )}
                            </div> {/* px-6 pt-4 */}
                          </CardContent>
                        )}
                      </Card>

                      <ScreeningProgressPanel
                        refreshTrigger={screeningProgressRefresh}
                        onScreeningComplete={() => {
                          fetchCompanies();
                        }}
                        onCompanyClick={(companyId) => {
                          const company = companies.find(
                            (c) => c.id === companyId,
                          );
                          if (company) {
                            setSelectedCompany(company);
                          }
                        }}
                        collapsed={!showScreeningProgress}
                        onToggleCollapse={() =>
                          setShowScreeningProgress(!showScreeningProgress)
                        }
                      />
                    </div>
                  ) : (
                    <>
                      {/* Filters for L1-L5 stages */}
                      <div className="flex items-center gap-4 mb-4 flex-wrap">
                        <div className="relative flex-1 max-w-sm">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            placeholder="Search companies or sectors..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-9"
                          />
                        </div>
                        {stage === "L1" && (
                          <Select
                            value={l1StatusFilter}
                            onValueChange={(v) => setL1StatusFilter(v as any)}
                          >
                            <SelectTrigger className="w-40">
                              <SelectValue placeholder="Status" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">All Status</SelectItem>
                              <SelectItem value="Pass">Pass</SelectItem>
                              <SelectItem value="Fail">Fail</SelectItem>
                              <SelectItem value="Inconclusive">
                                Inconclusive
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                        {renderViewToggle()}
                      </div>

                      {renderSourceTabs(stage)}

                      {/* Table for L1-L5 stages */}
                      {loading ? (
                        <div className="flex items-center justify-center py-12">
                          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                      ) : sortedCompanies.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                          <Building2 className="h-12 w-12 mb-4 opacity-50" />
                          <p>No companies in this stage</p>
                        </div>
                      ) : sourceFilter === "inbound" ? (
                        <>
                          <div className="overflow-x-auto">
                            <InboundCompaniesTable
                              companies={paginatedCompanies}
                              tracks={tracks}
                              stage={stage}
                              viewMode={viewMode}
                              favoriteIds={favoriteIds}
                              togglingFavorite={togglingFavorite}
                              onToggleFavorite={handleToggleFavorite}
                              updatingCompanyIds={updatingCompanyIds}
                              statusOptions={inboundStatusOptions}
                              onRunScreening={runScreeningForCompany}
                              runningScreeningCompanyIds={runningScreeningCompanyIds}
                              sortField={sortField}
                              sortDirection={sortDirection}
                              onSort={toggleSort}
                              onOpenDetail={(company) => {
                                posthog.capture("company_detail_viewed", {
                                  company_id: company.id,
                                  company_name: companyDisplayName(company, ""),
                                  pipeline_stage: company.pipeline_stage,
                                });
                                setSelectedCompany(company);
                              }}
                              onStatusChange={handleStatusChange}
                              onUpdate={(company) => setEditingCompany(company)}
                              onPromote={(company) => {
                                setDialogMode("promote");
                                setPromotingCompany(company);
                                setPromoteDialogOpen(true);
                              }}
                              onDemote={(company) => {
                                setDialogMode("demote");
                                setPromotingCompany(company);
                                setPromoteDialogOpen(true);
                              }}
                              onDrop={(company) => setDropDealCompany(company)}
                              onRestore={handleRestoreDeal}
                            />
                          </div>
                          {totalPages > 1 && (
                            <div className="flex items-center justify-between mt-4 pt-4 border-t">
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
                                    setCurrentPage((p) =>
                                      Math.min(totalPages, p + 1),
                                    )
                                  }
                                  disabled={currentPage === totalPages}
                                >
                                  <ChevronRight className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="overflow-x-auto">
                            <OutboundCompaniesTable
                              companies={paginatedCompanies}
                              tracks={tracks}
                              stage={stage}
                              viewMode={viewMode}
                              favoriteIds={favoriteIds}
                              togglingFavorite={togglingFavorite}
                              onToggleFavorite={handleToggleFavorite}
                              updatingCompanyIds={updatingCompanyIds}
                              statusOptions={outboundStatusOptions}
                              onRunScreening={runScreeningForCompany}
                              runningScreeningCompanyIds={runningScreeningCompanyIds}
                              sortField={sortField}
                              sortDirection={sortDirection}
                              onSort={toggleSort}
                              onOpenDetail={(company) => {
                                posthog.capture("company_detail_viewed", {
                                  company_id: company.id,
                                  company_name: companyDisplayName(company, ""),
                                  pipeline_stage: company.pipeline_stage,
                                });
                                setSelectedCompany(company);
                              }}
                              onStatusChange={handleStatusChange}
                              onUpdate={(company) => setEditingCompany(company)}
                              onPromote={(company) => {
                                setDialogMode("promote");
                                setPromotingCompany(company);
                                setPromoteDialogOpen(true);
                              }}
                              onDemote={(company) => {
                                setDialogMode("demote");
                                setPromotingCompany(company);
                                setPromoteDialogOpen(true);
                              }}
                              onDrop={(company) => setDropDealCompany(company)}
                              onRestore={handleRestoreDeal}
                            />
                          </div>
                          {totalPages > 1 && (
                            <div className="flex items-center justify-between mt-4 pt-4 border-t">
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
                                    setCurrentPage((p) =>
                                      Math.min(totalPages, p + 1),
                                    )
                                  }
                                  disabled={currentPage === totalPages}
                                >
                                  <ChevronRight className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>

        {selectedCompany && (
          <CompanyDetailDialog
            company={selectedCompany}
            open={!!selectedCompany}
            onOpenChange={(open) => !open && setSelectedCompany(null)}
            onUpdate={() => refetchAfterCompanyUpdate(selectedCompany.id)}
          />
        )}

        {editingCompany && (
          <UpdateCompanyDialog
            company={editingCompany}
            tracks={tracks}
            open={!!editingCompany}
            onOpenChange={(open) => !open && setEditingCompany(null)}
            onUpdate={() => refetchAfterCompanyUpdate(editingCompany.id)}
            statusOptions={
              editingCompany.source === "outbound"
                ? outboundStatusOptions
                : inboundStatusOptions
            }
          />
        )}

        <TrackSettingsDialog
          open={trackSettingsOpen}
          onOpenChange={setTrackSettingsOpen}
          onSaved={() => {
            fetchTracks();
            setTracksRefreshKey((k) => k + 1);
          }}
        />

        <AIScreeningDialog
          open={showScreeningDialog}
          onOpenChange={setShowScreeningDialog}
          companies={getCompaniesForScreening()}
          onComplete={() => {
            setScreeningCompanyIds([]);
            setScreeningProgressRefresh((prev) => prev + 1);
            fetchCompanies();
          }}
        />

        {/* MB-223: Bulk Triage Modal */}
        <BulkTriageModal
          open={showTriageModal}
          companies={allUnreviewedCompanies}
          onClose={() => setShowTriageModal(false)}
          onConfirm={handleTriageConfirm}
        />

        {promotingCompany && (
          <PromoteDialog
            open={promoteDialogOpen}
            onOpenChange={setPromoteDialogOpen}
            dealId={promotingCompany.id}
            companyName={companyDisplayName(promotingCompany, "this company")}
            currentStage={promotingCompany.pipeline_stage}
            nextStage={
              dialogMode === "demote"
                ? (STAGES[
                    STAGES.indexOf(promotingCompany.pipeline_stage) - 1
                  ] as DealStage)
                : (STAGES[
                    STAGES.indexOf(promotingCompany.pipeline_stage) + 1
                  ] as DealStage)
            }
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
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Drop deal?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to drop{" "}
                <span className="font-medium">{companyDisplayName(dropDealCompany, "this company")}</span>?
                This will remove the deal from the pipeline.
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
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="drop-deal-cancel-button" disabled={isDropping}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="drop-deal-confirm-button"
                disabled={isDropping}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={async (e) => {
                  e.preventDefault();
                  if (!dropDealCompany) return;
                  setIsDropping(true);
                  try {
                    await dropDeal(dropDealCompany.id, {
                      currentStage: dropDealCompany.pipeline_stage,
                      reason: dropReason,
                    });
                    posthog.capture("deal_dropped", {
                      deal_id: dropDealCompany.id,
                      company_name: companyDisplayName(dropDealCompany, ""),
                      from_stage: dropDealCompany.pipeline_stage,
                      has_reason: dropReason.trim() !== "",
                    });
                    toast.success(`Dropped ${companyDisplayName(dropDealCompany, "company")}`);
                    setDropDealCompany(null);
                    setDropReason("");
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
    </DashboardLayout>
  );
}
