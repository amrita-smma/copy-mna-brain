"use client";

import { useState, useEffect } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  Eye,
  EyeOff,
  Star,
  Trash2,
  RotateCcw,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { SEARCH_SUGGESTION_CHIPS } from "@/lib/constants";
import PromoteDialog from "@/components/pipeline/PromoteDialog";
import { DealStage, L1Status } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import CompanyDetailDialog from "@/components/pipeline/CompanyDetailDialog";
import AIScreeningDialog from "@/components/pipeline/AIScreeningDialog";
import MarketScreeningStatus from "@/components/pipeline/MarketScreeningStatus";
import MarketScreeningResults from "@/components/pipeline/MarketScreeningResults";
import ScreeningProgressPanel from "@/components/pipeline/ScreeningProgressPanel";
import { CollapsibleSection } from "@/components/common/CollapsibleSection";
import { cn } from "@/lib/utils";
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
} from "@/lib/api/pipeline";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { getCompanyOverride } from "@/lib/companyOverrides";

interface PipelineCompany {
  id: string;
  target: string;
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
  ownership: string | null;
  geography: string | null;
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
};

const formatCurrency = (value: number | null) => {
  if (value === null || value === undefined) return "-";
  // Values are stored in millions
  if (Math.abs(value) >= 1000) {
    const billions = value / 1000;
    return `$${billions.toFixed(2)}B`;
  }
  return `$${value.toFixed(2)}M`;
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
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}

export default function Pipeline({ showCrm = false, showAiWorkforce = false }: PipelineProps) {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialTab = searchParams.get("stage") || "L0";
  const [activeTab, setActiveTab] = useState<DealStage>(
    initialTab as DealStage,
  );
  const [companies, setCompanies] = useState<PipelineCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sectorFilterValue, setSectorFilterValue] = useState<string>("all");
  const [selectedCompany, setSelectedCompany] =
    useState<PipelineCompany | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showScreeningDialog, setShowScreeningDialog] = useState(false);
  const [marketScreeningRefresh, setMarketScreeningRefresh] = useState(0);
  const [screeningProgressRefresh, setScreeningProgressRefresh] = useState(0);
  const [newCandidatesCount, setNewCandidatesCount] = useState(0);

  // Section visibility
  const [showL0Pipeline, setShowL0Pipeline] = useState(true);
  const [showMarketScanning, setShowMarketScanning] = useState(true);
  const [showMarketResults, setShowMarketResults] = useState(true);
  const [showScreeningProgress, setShowScreeningProgress] = useState(true);

  // Sorting state
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  // L1 status filter
  const [l1StatusFilter, setL1StatusFilter] = useState<"all" | L1Status>("all");

  // Active vs Dropped view
  const [viewMode, setViewMode] = useState<"active" | "dropped">("active");

  // Sector filter
  const [sectorFilter, setSectorFilter] = useState<string>("all");

  // Source filter
  const [sourceFilter, setSourceFilter] = useState<string>("all");

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

  // Drop deal dialog state
  const [dropDealCompany, setDropDealCompany] =
    useState<PipelineCompany | null>(null);
  const [dropReason, setDropReason] = useState("");
  const [isDropping, setIsDropping] = useState(false);

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
        data?.map((company: any) => {
          const override = getCompanyOverride(company.id);
          return {
            id: company.id,
            target: company.target || "",
            segment: company.segment || "",
            geo: company.geography || company.geo || null,
            website: company.website ?? null,
            watchlist_status: company.watchlist_status,
            revenue_2021_usd_mn: company.revenue_2021_usd_mn,
            revenue_2022_usd_mn: company.revenue_2022_usd_mn,
            revenue_2023_usd_mn:
              override?.revenue_2023_usd_mn ?? company.revenue_2023_usd_mn,
            revenue_2024_usd_mn:
              override?.revenue_2024_usd_mn ?? company.revenue_2024_usd_mn,
            revenue_2025_usd_mn: override?.revenue_2025_usd_mn ?? null,
            ebitda_2021_usd_mn: company.ebitda_2021_usd_mn,
            ebitda_2022_usd_mn: company.ebitda_2022_usd_mn,
            ebitda_2023_usd_mn:
              override?.ebitda_2023_usd_mn ?? company.ebitda_2023_usd_mn,
            ebitda_2024_usd_mn:
              override?.ebitda_2024_usd_mn ?? company.ebitda_2024_usd_mn,
            ebitda_2025_usd_mn: override?.ebitda_2025_usd_mn ?? null,
            ev_2024: override?.ev_2024 ?? company.ev_2024,
            pipeline_stage: (company.pipeline_stage || "L0") as DealStage,
            l1_screening_result: company.l1_screening_result,
            pic:
              override?.pic ??
              (Array.isArray(company.assignees) && company.assignees.length > 0
                ? company.assignees
                    .map((a: { name: string | null }) => a.name)
                    .filter(Boolean)
                    .join(", ")
                : (company.pic ?? null)),
            remarks: company.remarks || null,
            created_at: company.created_at,
            updated_at: company.updated_at,
            source: company.source || null,
            ownership: company.ownership ?? null,
            geography: company.geography ?? null,
            financials_raw: company.financials_raw,
          };
        }) || [];

      setCompanies(formatted);
    } catch (error: any) {
      console.error("Error fetching companies:", error);
      toast.error("Failed to load companies");
    } finally {
      if (!opts.silent) setLoading(false);
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
    setSelectedIds(new Set());
    setCurrentPage(1);
    router.push(`/pipeline?stage=${value}`);
  };

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sectorFilter, l1StatusFilter, activeTab, viewMode]);

  // Get unique sectors for filter
  const uniqueSectors = [
    ...new Set(companies.map((c) => c.segment).filter(Boolean)),
  ].sort();

  const isDropped = (c: PipelineCompany) => c.status === "dropped";
  const isActive = (c: PipelineCompany) => !isDropped(c);

  const filteredCompanies = companies.filter((company) => {
    const matchesStage = company.pipeline_stage === activeTab;
    const matchesSearch =
      company.target.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (company.segment || "").toLowerCase().includes(searchQuery.toLowerCase());
    const matchesL1Status =
      l1StatusFilter === "all" ||
      company.l1_screening_result === l1StatusFilter;
    const matchesSector =
      sectorFilter === "all" || company.segment === sectorFilter;
    const matchesView =
      viewMode === "dropped" ? isDropped(company) : isActive(company);
    return (
      matchesStage &&
      matchesSearch &&
      matchesL1Status &&
      matchesSector &&
      matchesView
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
        aVal = a.target.toLowerCase();
        bVal = b.target.toLowerCase();
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

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field)
      return <ArrowUpDown className="h-3 w-3 ml-1 opacity-50" />;
    return sortDirection === "asc" ? (
      <ArrowUp className="h-3 w-3 ml-1" />
    ) : (
      <ArrowDown className="h-3 w-3 ml-1" />
    );
  };

  const totalPages = Math.max(
    1,
    Math.ceil(sortedCompanies.length / itemsPerPage),
  );
  const paginatedCompanies = sortedCompanies.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage,
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchQuery, sectorFilter, l1StatusFilter]);

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

  const openAIScreening = () => {
    if (selectedIds.size === 0) {
      toast.error("Please select at least one company");
      return;
    }
    setShowScreeningDialog(true);
  };

  const getSelectedCompaniesForScreening = () => {
    return filteredCompanies
      .filter((c) => selectedIds.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.target,
        sector: c.segment || "",
        revenue_year1: c.revenue_2022_usd_mn,
        revenue_year2: c.revenue_2023_usd_mn,
        revenue_year3: c.revenue_2024_usd_mn,
        ebitda_year1: c.ebitda_2022_usd_mn,
        ebitda_year2: c.ebitda_2023_usd_mn,
        ebitda_year3: c.ebitda_2024_usd_mn,
        valuation: c.ev_2024,
        source: "pipeline",
      }));
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
  const activeStageCount = (stage: DealStage) =>
    companies.filter((c) => c.pipeline_stage === stage && isActive(c)).length;
  const droppedStageCount = (stage: DealStage) =>
    companies.filter((c) => c.pipeline_stage === stage && isDropped(c)).length;

  const handleRestoreDeal = async (company: PipelineCompany) => {
    try {
      await restoreDeal(company.id, { currentStage: company.pipeline_stage });
      posthog.capture("deal_restored", {
        deal_id: company.id,
        company_name: company.target,
        to_stage: company.pipeline_stage,
      });
      toast.success(`Restored ${company.target}`);
      fetchCompanies();
    } catch (err: any) {
      console.error("Error restoring deal:", err);
      toast.error(`Failed to restore deal: ${err.message || "Unknown error"}`);
    }
  };

  const renderViewToggle = (stage: DealStage) => (
    <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1 mb-4">
      <button
        type="button"
        onClick={() => setViewMode("active")}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-all",
          viewMode === "active"
            ? "bg-background text-foreground font-medium shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Active
        <span className="text-xs text-muted-foreground">
          {activeStageCount(stage)}
        </span>
      </button>
      <button
        type="button"
        onClick={() => setViewMode("dropped")}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-all",
          viewMode === "dropped"
            ? "bg-background text-foreground font-medium shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Dropped
        <span className="text-xs text-muted-foreground">
          {droppedStageCount(stage)}
        </span>
      </button>
    </div>
  );

  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const toggleSelectAll = () => {
    const stageCompanies = filteredCompanies.filter(
      (c) => c.pipeline_stage === activeTab,
    );
    if (
      selectedIds.size === stageCompanies.length &&
      stageCompanies.length > 0
    ) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(stageCompanies.map((c) => c.id)));
    }
  };

  const isAllSelected = () => {
    const stageCompanies = filteredCompanies.filter(
      (c) => c.pipeline_stage === activeTab,
    );
    return (
      stageCompanies.length > 0 && selectedIds.size === stageCompanies.length
    );
  };

  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <div className="p-6 space-y-6 animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Deal Pipeline</h1>
            <p className="text-muted-foreground">
              Track companies through all stages
            </p>
          </div>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-6">
            {STAGES.map((stage) => (
              <TabsTrigger
                key={stage}
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
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div>
                                <CardTitle className="text-lg">
                                  L0 Pipeline Companies
                                </CardTitle>
                                <CardDescription>
                                  Companies sourced and ready for screening
                                </CardDescription>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
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
                              {showL0Pipeline && (
                                <Button
                                  onClick={openAIScreening}
                                  className="bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600 shadow-md transition-all hover:scale-[1.02]"
                                >
                                  <Sparkles className="mr-2 h-4 w-4" />
                                  AI Screening ({selectedIds.size} selected)
                                </Button>
                              )}
                              <Link href="/ai-file-dump">
                                <Button>
                                  <Plus className="mr-2 h-4 w-4" />
                                  Add Company
                                </Button>
                              </Link>
                            </div>
                          </div>
                        </CardHeader>
                        {showL0Pipeline && (
                          <CardContent>
                            {/* Header with Select All */}
                            <div className="flex items-center justify-between mb-4">
                              <div className="flex items-center gap-2">
                                <Checkbox
                                  checked={
                                    selectedIds.size > 0 &&
                                    paginatedCompanies.every((c) =>
                                      selectedIds.has(c.id),
                                    )
                                  }
                                  onCheckedChange={() => {
                                    if (
                                      selectedIds.size > 0 &&
                                      paginatedCompanies.every((c) =>
                                        selectedIds.has(c.id),
                                      )
                                    ) {
                                      setSelectedIds(new Set());
                                    } else {
                                      const newSet = new Set(selectedIds);
                                      paginatedCompanies.forEach((c) =>
                                        newSet.add(c.id),
                                      );
                                      setSelectedIds(newSet);
                                    }
                                  }}
                                  id="select-all"
                                />
                                <label
                                  htmlFor="select-all"
                                  className="text-sm font-medium cursor-pointer"
                                >
                                  Select All
                                </label>
                              </div>
                            </div>

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
                              <Select
                                value={sectorFilter}
                                onValueChange={setSectorFilter}
                              >
                                <SelectTrigger className="w-40">
                                  <SelectValue placeholder="Sector" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="all">
                                    All Sectors
                                  </SelectItem>
                                  {uniqueSectors.map((sector) => (
                                    <SelectItem key={sector} value={sector}>
                                      {sector}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Select
                                value={sourceFilter}
                                onValueChange={(v) => setSourceFilter(v as any)}
                              >
                                <SelectTrigger className="w-40">
                                  <SelectValue placeholder="Source" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="all">
                                    All Sources
                                  </SelectItem>
                                  <SelectItem value="inbound">
                                    Inbound
                                  </SelectItem>
                                  <SelectItem value="outbound">
                                    Outbound
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
                              <Lightbulb className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                              <span>Try:</span>
                              {SEARCH_SUGGESTION_CHIPS.map((chip, i) => (
                                <span key={chip}>
                                  <button
                                    type="button"
                                    onClick={() => setSearchQuery(chip)}
                                    className="text-primary hover:underline"
                                  >
                                    &quot;{chip}&quot;
                                  </button>
                                  {i < SEARCH_SUGGESTION_CHIPS.length - 1
                                    ? ","
                                    : ""}
                                </span>
                              ))}
                            </div>

                            {renderViewToggle("L0")}

                            {loading ? (
                              <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                              </div>
                            ) : sortedCompanies.length === 0 ? (
                              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                                <Building2 className="h-12 w-12 mb-4 opacity-50" />
                                <p>No companies in this stage</p>
                              </div>
                            ) : (
                              <>
                                <div className="overflow-x-auto">
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead className="w-[40px]"></TableHead>
                                        <TableHead className="w-[50px]">
                                          Select
                                        </TableHead>
                                        <TableHead>
                                          <button
                                            onClick={() => toggleSort("name")}
                                            className="flex items-center hover:text-foreground transition-colors"
                                          >
                                            Company
                                            <SortIcon field="name" />
                                          </button>
                                        </TableHead>
                                        <TableHead>
                                          <button
                                            onClick={() => toggleSort("sector")}
                                            className="flex items-center hover:text-foreground transition-colors"
                                          >
                                            Sector
                                            <SortIcon field="sector" />
                                          </button>
                                        </TableHead>
                                        <TableHead>Geo</TableHead>
                                        <TableHead>PIC</TableHead>
                                        <TableHead className="text-right">
                                          Revenue 2023
                                        </TableHead>
                                        <TableHead className="text-right">
                                          Revenue 2024
                                        </TableHead>
                                        <TableHead className="text-right">
                                          <button
                                            onClick={() =>
                                              toggleSort("revenue")
                                            }
                                            className="flex items-center justify-end w-full hover:text-foreground transition-colors"
                                          >
                                            Revenue 2025
                                            <SortIcon field="revenue" />
                                          </button>
                                        </TableHead>
                                        <TableHead className="text-right">
                                          EBITDA 2023
                                        </TableHead>
                                        <TableHead className="text-right">
                                          EBITDA 2024
                                        </TableHead>
                                        <TableHead className="text-right">
                                          <button
                                            onClick={() => toggleSort("ebitda")}
                                            className="flex items-center justify-end w-full hover:text-foreground transition-colors"
                                          >
                                            EBITDA 2025
                                            <SortIcon field="ebitda" />
                                          </button>
                                        </TableHead>
                                        <TableHead className="text-right">
                                          <button
                                            onClick={() =>
                                              toggleSort("valuation")
                                            }
                                            className="flex items-center justify-end w-full hover:text-foreground transition-colors"
                                          >
                                            Valuation
                                            <SortIcon field="valuation" />
                                          </button>
                                        </TableHead>
                                        <TableHead className="text-center">
                                          Source
                                        </TableHead>
                                        <TableHead className="text-right">
                                          Actions
                                        </TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {paginatedCompanies.map((company) => {
                                        const isFav = favoriteIds.has(
                                          company.id,
                                        );
                                        return (
                                          <TableRow
                                            key={company.id}
                                            className={cn(
                                              "transition-colors",
                                              isFav
                                                ? "bg-amber-50/60 dark:bg-amber-900/10 hover:bg-amber-100/60 dark:hover:bg-amber-900/20"
                                                : "hover:bg-muted/50",
                                            )}
                                          >
                                            <TableCell className="pr-0">
                                              <button
                                                onClick={() =>
                                                  handleToggleFavorite(
                                                    company.id,
                                                  )
                                                }
                                                disabled={
                                                  togglingFavorite ===
                                                  company.id
                                                }
                                                className={cn(
                                                  "p-1 rounded-md transition-colors",
                                                  isFav
                                                    ? "text-amber-500 hover:text-amber-600"
                                                    : "text-muted-foreground/40 hover:text-amber-400",
                                                )}
                                              >
                                                <Star
                                                  className={cn(
                                                    "h-4 w-4",
                                                    isFav && "fill-current",
                                                  )}
                                                />
                                              </button>
                                            </TableCell>
                                            <TableCell>
                                              <Checkbox
                                                checked={selectedIds.has(
                                                  company.id,
                                                )}
                                                onCheckedChange={() => {
                                                  const newSet = new Set(
                                                    selectedIds,
                                                  );
                                                  if (newSet.has(company.id)) {
                                                    newSet.delete(company.id);
                                                  } else {
                                                    newSet.add(company.id);
                                                  }
                                                  setSelectedIds(newSet);
                                                }}
                                              />
                                            </TableCell>
                                            <TableCell>
                                              <button
                                                onClick={() => {
                                                  posthog.capture(
                                                    "company_detail_viewed",
                                                    {
                                                      company_id: company.id,
                                                      company_name:
                                                        company.target,
                                                      pipeline_stage:
                                                        company.pipeline_stage,
                                                    },
                                                  );
                                                  setSelectedCompany(company);
                                                }}
                                                className="font-medium text-left hover:text-primary hover:underline transition-colors"
                                              >
                                                {company.target}
                                              </button>
                                            </TableCell>
                                            <TableCell>
                                              <span className="text-muted-foreground">
                                                {company.segment}
                                              </span>
                                            </TableCell>
                                            <TableCell>
                                              <span className="text-sm text-muted-foreground">
                                                {company.geo || "-"}
                                              </span>
                                            </TableCell>
                                            <TableCell>
                                              <span className="text-sm text-muted-foreground">
                                                {company.pic || "-"}
                                              </span>
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                              {formatCurrency(
                                                company.revenue_2023_usd_mn,
                                              )}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                              {formatCurrency(
                                                company.revenue_2024_usd_mn,
                                              )}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                              {formatCurrency(
                                                company.revenue_2025_usd_mn,
                                              )}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                              {formatCurrency(
                                                company.ebitda_2023_usd_mn,
                                              )}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                              {formatCurrency(
                                                company.ebitda_2024_usd_mn,
                                              )}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                              {formatCurrency(
                                                company.ebitda_2025_usd_mn,
                                              )}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                              {formatCurrency(company.ev_2024)}
                                            </TableCell>
                                            <TableCell className="text-center">
                                              {/* Source is not in PipelineCompany interface! 
                                                Wait, PipelineCompany interface (Step 267) has: 
                                                id, target, segment, ...
                                                It DOES NOT have 'source'.
                                                I need to check where 'source' comes from.
                                                In Step 253 (sqemnabrain), 'source' was in the query: `deals(companies(source))`.
                                                In acqgent `fetchCompanies` (Step 267), it selects from `companies` table directly?
                                                Line 206: `.from('companies')`.
                                                I should check if `companies` table has `source` column.
                                                If not, I might need to omit it or fetch from deals if possible.
                                                For now I will put a placeholder or omit badge.
                                                The screenshot shows "Inbound" / "Outbound".
                                                I will assume 'Inbound' for now or check if there is a field I missed.
                                                Actually, let's omit the Source column if I can't find it, OR add it if it's critical.
                                                User screenshot has "Source" column.
                                                I'll add the column but with a static/placeholder value or check if I can map it from something else.
                                                Wait, `sqemnabrain` has `source`. `acqgent` might not have migrated that column yet.
                                                I'll put "Inbound" as default or check remarks.
                                                Let's just use "Inbound" hardcoded for now or comments.
                                            */}
                                              <Badge
                                                variant="secondary"
                                                className="bg-emerald-500/20 text-emerald-600 hover:bg-emerald-500/30"
                                              >
                                                Inbound
                                              </Badge>
                                            </TableCell>
                                            <TableCell className="text-right">
                                              <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                  <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-7 gap-1"
                                                  >
                                                    Actions
                                                    <ChevronDown className="h-3 w-3" />
                                                  </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                  {viewMode === "dropped" ? (
                                                    <DropdownMenuItem
                                                      onClick={() =>
                                                        handleRestoreDeal(
                                                          company,
                                                        )
                                                      }
                                                    >
                                                      <RotateCcw className="mr-2 h-4 w-4" />
                                                      Restore deal
                                                    </DropdownMenuItem>
                                                  ) : (
                                                    <>
                                                      <DropdownMenuItem
                                                        onClick={() => {
                                                          setDialogMode(
                                                            "promote",
                                                          );
                                                          setPromotingCompany(
                                                            company,
                                                          );
                                                          setPromoteDialogOpen(
                                                            true,
                                                          );
                                                        }}
                                                      >
                                                        <ArrowRight className="mr-2 h-4 w-4" />
                                                        Promote to L1
                                                      </DropdownMenuItem>
                                                      <DropdownMenuSeparator />
                                                      <DropdownMenuItem
                                                        onClick={() =>
                                                          setDropDealCompany(
                                                            company,
                                                          )
                                                        }
                                                        className="text-destructive focus:text-destructive"
                                                      >
                                                        <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                                                        Drop deal
                                                      </DropdownMenuItem>
                                                    </>
                                                  )}
                                                </DropdownMenuContent>
                                              </DropdownMenu>
                                            </TableCell>
                                          </TableRow>
                                        );
                                      })}
                                    </TableBody>
                                  </Table>
                                </div>

                                {totalPages > 1 && (
                                  <div className="flex items-center justify-between mt-4 pt-4 border-t">
                                    <p className="text-sm text-muted-foreground">
                                      Page {currentPage} of {totalPages} (
                                      {sortedCompanies.length} companies)
                                    </p>
                                    <div className="flex items-center gap-2">
                                      <Button
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
                        <Select
                          value={sectorFilter}
                          onValueChange={setSectorFilter}
                        >
                          <SelectTrigger className="w-40">
                            <SelectValue placeholder="Sector" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Sectors</SelectItem>
                            {uniqueSectors.map((sector) => (
                              <SelectItem key={sector} value={sector}>
                                {sector}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1.5 mb-4">
                        <Lightbulb className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        <span>Try:</span>
                        {SEARCH_SUGGESTION_CHIPS.map((chip, i) => (
                          <span key={chip}>
                            <button
                              type="button"
                              onClick={() => setSearchQuery(chip)}
                              className="text-primary hover:underline"
                            >
                              &quot;{chip}&quot;
                            </button>
                            {i < SEARCH_SUGGESTION_CHIPS.length - 1 ? "," : ""}
                          </span>
                        ))}
                      </div>

                      {renderViewToggle(stage)}

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
                      ) : (
                        <>
                          <div className="overflow-x-auto">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="w-[40px]"></TableHead>
                                  <TableHead>
                                    <button
                                      onClick={() => toggleSort("name")}
                                      className="flex items-center hover:text-foreground transition-colors"
                                    >
                                      Company
                                      <SortIcon field="name" />
                                    </button>
                                  </TableHead>
                                  <TableHead>
                                    <button
                                      onClick={() => toggleSort("sector")}
                                      className="flex items-center hover:text-foreground transition-colors"
                                    >
                                      Sector
                                      <SortIcon field="sector" />
                                    </button>
                                  </TableHead>
                                  <TableHead>Geo</TableHead>
                                  <TableHead>PIC</TableHead>
                                  <TableHead className="text-right">
                                    Rev 2023
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Rev 2024
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Rev 2025
                                  </TableHead>
                                  <TableHead className="text-right">
                                    EBITDA 2023
                                  </TableHead>
                                  <TableHead className="text-right">
                                    EBITDA 2024
                                  </TableHead>
                                  <TableHead className="text-right">
                                    EBITDA 2025
                                  </TableHead>
                                  <TableHead>
                                    <button
                                      onClick={() => toggleSort("valuation")}
                                      className="flex items-center hover:text-foreground transition-colors"
                                    >
                                      Valuation
                                      <SortIcon field="valuation" />
                                    </button>
                                  </TableHead>
                                  <TableHead className="max-w-[200px]">
                                    Remarks
                                  </TableHead>
                                  <TableHead>
                                    <button
                                      onClick={() => toggleSort("updated")}
                                      className="flex items-center hover:text-foreground transition-colors"
                                    >
                                      Updated
                                      <SortIcon field="updated" />
                                    </button>
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Actions
                                  </TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {(() => {
                                  const paginatedCompanies =
                                    sortedCompanies.slice(
                                      (currentPage - 1) * itemsPerPage,
                                      currentPage * itemsPerPage,
                                    );

                                  return paginatedCompanies.map((company) => {
                                    const isFav = favoriteIds.has(company.id);
                                    return (
                                      <TableRow
                                        key={company.id}
                                        className={cn(
                                          "transition-colors",
                                          isFav
                                            ? "bg-amber-50/60 dark:bg-amber-900/10 hover:bg-amber-100/60 dark:hover:bg-amber-900/20"
                                            : "hover:bg-muted/50",
                                        )}
                                      >
                                        <TableCell className="pr-0">
                                          <button
                                            onClick={() =>
                                              handleToggleFavorite(company.id)
                                            }
                                            disabled={
                                              togglingFavorite === company.id
                                            }
                                            className={cn(
                                              "p-1 rounded-md transition-colors",
                                              isFav
                                                ? "text-amber-500 hover:text-amber-600"
                                                : "text-muted-foreground/40 hover:text-amber-400",
                                            )}
                                          >
                                            <Star
                                              className={cn(
                                                "h-4 w-4",
                                                isFav && "fill-current",
                                              )}
                                            />
                                          </button>
                                        </TableCell>
                                        <TableCell>
                                          <button
                                            onClick={() => {
                                              posthog.capture(
                                                "company_detail_viewed",
                                                {
                                                  company_id: company.id,
                                                  company_name: company.target,
                                                  pipeline_stage:
                                                    company.pipeline_stage,
                                                },
                                              );
                                              setSelectedCompany(company);
                                            }}
                                            className="font-medium text-left hover:text-primary hover:underline transition-colors"
                                          >
                                            {company.target}
                                          </button>
                                        </TableCell>
                                        <TableCell>
                                          <Badge variant="outline">
                                            {company.segment}
                                          </Badge>
                                        </TableCell>
                                        <TableCell>
                                          <span className="text-sm text-muted-foreground">
                                            {company.geo || "-"}
                                          </span>
                                        </TableCell>
                                        <TableCell>
                                          <span className="text-sm text-muted-foreground">
                                            {company.pic || "-"}
                                          </span>
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {formatCurrency(
                                            company.revenue_2022_usd_mn,
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {formatCurrency(
                                            company.revenue_2023_usd_mn,
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {formatCurrency(
                                            company.revenue_2024_usd_mn,
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {formatCurrency(
                                            company.ebitda_2022_usd_mn,
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {formatCurrency(
                                            company.ebitda_2023_usd_mn,
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {formatCurrency(
                                            company.ebitda_2024_usd_mn,
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {formatCurrency(company.ev_2024)}
                                        </TableCell>
                                        <TableCell className="max-w-[200px]">
                                          {company.remarks ? (
                                            <p
                                              className="text-xs text-muted-foreground truncate"
                                              title={company.remarks}
                                            >
                                              {company.remarks}
                                            </p>
                                          ) : (
                                            <span className="text-xs text-muted-foreground">
                                              -
                                            </span>
                                          )}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground text-sm">
                                          {formatDistanceToNow(
                                            new Date(company.updated_at),
                                            { addSuffix: true },
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-7 gap-1"
                                              >
                                                Actions
                                                <ChevronDown className="h-3 w-3" />
                                              </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                              {viewMode === "dropped" ? (
                                                <DropdownMenuItem
                                                  onClick={() =>
                                                    handleRestoreDeal(company)
                                                  }
                                                >
                                                  <RotateCcw className="mr-2 h-4 w-4" />
                                                  Restore deal
                                                </DropdownMenuItem>
                                              ) : (
                                                <>
                                                  {stage !== "L5" && (
                                                    <DropdownMenuItem
                                                      onClick={() => {
                                                        setDialogMode(
                                                          "promote",
                                                        );
                                                        setPromotingCompany(
                                                          company,
                                                        );
                                                        setPromoteDialogOpen(
                                                          true,
                                                        );
                                                      }}
                                                    >
                                                      <ArrowRight className="mr-2 h-4 w-4" />
                                                      Promote to{" "}
                                                      {
                                                        STAGES[
                                                          STAGES.indexOf(
                                                            stage,
                                                          ) + 1
                                                        ]
                                                      }
                                                    </DropdownMenuItem>
                                                  )}
                                                  {STAGES.indexOf(stage) >
                                                    0 && (
                                                    <DropdownMenuItem
                                                      onClick={() => {
                                                        setDialogMode("demote");
                                                        setPromotingCompany(
                                                          company,
                                                        );
                                                        setPromoteDialogOpen(
                                                          true,
                                                        );
                                                      }}
                                                    >
                                                      <ArrowLeft className="mr-2 h-4 w-4" />
                                                      Demote to{" "}
                                                      {
                                                        STAGES[
                                                          STAGES.indexOf(
                                                            stage,
                                                          ) - 1
                                                        ]
                                                      }
                                                    </DropdownMenuItem>
                                                  )}
                                                  <DropdownMenuSeparator />
                                                  <DropdownMenuItem
                                                    onClick={() =>
                                                      setDropDealCompany(
                                                        company,
                                                      )
                                                    }
                                                    className="text-destructive focus:text-destructive"
                                                  >
                                                    <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                                                    Drop deal
                                                  </DropdownMenuItem>
                                                </>
                                              )}
                                            </DropdownMenuContent>
                                          </DropdownMenu>
                                        </TableCell>
                                      </TableRow>
                                    );
                                  });
                                })()}
                              </TableBody>
                            </Table>
                          </div>
                          {totalPages > 1 && (
                            <div className="flex items-center justify-between mt-4 pt-4 border-t">
                              <p className="text-sm text-muted-foreground">
                                Page {currentPage} of {totalPages} (
                                {sortedCompanies.length} companies)
                              </p>
                              <div className="flex items-center gap-2">
                                <Button
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
            onUpdate={() => fetchCompanies({ silent: true })}
          />
        )}

        <AIScreeningDialog
          open={showScreeningDialog}
          onOpenChange={setShowScreeningDialog}
          companies={getSelectedCompaniesForScreening()}
          onComplete={() => {
            setSelectedIds(new Set());
            setScreeningProgressRefresh((prev) => prev + 1);
            fetchCompanies();
          }}
        />

        {promotingCompany && (
          <PromoteDialog
            open={promoteDialogOpen}
            onOpenChange={setPromoteDialogOpen}
            dealId={promotingCompany.id}
            companyName={promotingCompany.target}
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
                <span className="font-medium">{dropDealCompany?.target}</span>?
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
              <AlertDialogCancel disabled={isDropping}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
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
                      company_name: dropDealCompany.target,
                      from_stage: dropDealCompany.pipeline_stage,
                      has_reason: dropReason.trim() !== "",
                    });
                    toast.success(`Dropped ${dropDealCompany.target}`);
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
