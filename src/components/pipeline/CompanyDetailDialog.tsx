import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Building2,
  TrendingUp,
  FileText,
  Link as LinkIcon,
  Upload,
  Plus,
  Loader2,
  Trash2,
  ExternalLink,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  DollarSign,
  BarChart3,
  Expand,
  Sparkles,
  Lightbulb,
  AlertTriangle,
  Search,
  Briefcase,
  Globe,
  HelpCircle,
  Download,
  Eye,
  Presentation,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { CompanyAnalysisSection } from "@/components/pipeline/CompanyAnalysisSection";
import { AICompanyCardLoading } from "@/components/pipeline/AICompanyCardLoading";
import CompanyOverviewSlide from "@/components/pipeline/CompanyOverviewSlide";
import FilePreview from "@/components/Files/FilePreview";
import { DealStage } from "@/lib/types";
import { STAGE_LABELS, isAnalysisInProgress } from "@/lib/constants";
import { formatDistanceToNow, format } from "date-fns";
import {
  addCompanyLink,
  addCompanyNote,
  deleteDealLink,
  deleteDealNote,
  getCompanies,
  getCompanyDetails,
  getScreenings,
  getBankerNames,
  getTracks,
  getUsers,
  updateCompany,
  type Track,
  type UserSummary,
} from "@/lib/api/pipeline";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import StatusCombobox, {
  DEFAULT_INBOUND_STATUS_OPTIONS,
  DEFAULT_OUTBOUND_STATUS_OPTIONS,
} from "@/components/pipeline/StatusCombobox";
import { normalizeStake } from "@/lib/stake";
import {
  matchedTrackPics,
  dealLeadField,
  dealLeadLabel,
  effectiveDealLead,
} from "@/lib/tracks/matchTracks";
import { companyDisplayName, companyDisplayTitle, companyInitials } from "@/lib/companyDisplay";

const OWNERSHIP_OPTIONS = [
  "Public",
  "Private",
  "Private Equity",
  "Venture Capital",
  "Family Owned",
  "Subsidiary",
] as const;

const getStageLabel = (stage: string | null): string => {
  const key = (stage || "L0") as DealStage;
  return STAGE_LABELS[key] ?? key;
};

const websiteHref = (url: string) =>
  /^https?:\/\//i.test(url) ? url : `https://${url}`;

/** timestamptz ISO string -> YYYY-MM-DD for <input type="date">. */
const isoToDateInput = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
};
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import { FinancialCharts } from "@/components/pipeline/FinancialCharts";
import type { Tables } from "@/lib/repositories";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { useChatContext } from "@/components/chat/ChatProvider";
import { AskAIButton } from "@/components/chat/AskAIButton";

export interface CompanyData {
  id: string;
  target: string | null;
  project_name?: string | null;
  segment: string | null;
  website?: string | null;
  watchlist_status: string | null;
  pipeline_stage: string | null;
  revenue_2021_usd_mn: number | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  ebitda_2021_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  ev_2024: number | null;
  l1_screening_result: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
  source: string | null;
  status: string | null;
  dropped_reason: string | null;
  dropped_at: string | null;
  promoted_reasons?: string | null;
  ownership: string | null;
  geography: string | null;
  deal_type?: string | null;
  entered_by?: string | null;
  last_activity_at?: string | null;
  banker?: string | null;
  doc_type?: string | null;
  stake?: string | null;
  deal_size?: string | null;
  workflow_status?: string | null;
  key_rationale?: string | null;
  matched_track_ids?: string[] | null;
  deal_sponsor?: string | null;
  deal_captain?: string | null;
  financials_raw?: Tables<'company_financials'>[];
}

/** Minimal company_logs row used to build stage history */
interface CompanyLogRow {
  id: string;
  action: string;
  created_at: string | null;
}

interface StageHistory {
  id: string;
  stage: string;
  entered_at: string;
  exited_at: string | null;
  duration_seconds: number | null;
}

/** Parse company_logs actions into stage + entered_at. Returns [] if not a stage-related action. */
function stageFromLogAction(
  action: string,
  created_at: string,
): { stage: string; entered_at: string } | null {
  const at = created_at || new Date().toISOString();
  if (action === "ADDED_TO_PIPELINE") return { stage: "L0", entered_at: at };
  if (action === "PROMOTED_FROM_MARKET_SCREENING_TO_L0")
    return { stage: "L0", entered_at: at };
  const fromTo = /^PROMOTED_FROM_(.+)_TO_(.+)$/.exec(action);
  if (fromTo) return { stage: fromTo[2], entered_at: at };
  const to = /^PROMOTED_TO_(.+)$/.exec(action);
  if (to) return { stage: to[1], entered_at: at };
  return null;
}

/** Build StageHistory[] from company_logs rows (ordered by created_at asc). */
function companyLogsToStageHistory(logs: CompanyLogRow[]): StageHistory[] {
  const entries: { id: string; stage: string; entered_at: string }[] = [];
  for (const log of logs) {
    const parsed = stageFromLogAction(log.action, log.created_at ?? "");
    if (parsed)
      entries.push({
        id: log.id,
        stage: parsed.stage,
        entered_at: parsed.entered_at,
      });
  }
  const result: StageHistory[] = [];
  for (let i = 0; i < entries.length; i++) {
    const curr = entries[i];
    const next = entries[i + 1];
    const exited_at = next ? next.entered_at : null;
    const duration_seconds =
      exited_at && curr.entered_at
        ? (new Date(exited_at).getTime() -
            new Date(curr.entered_at).getTime()) /
          1000
        : null;
    result.push({
      id: curr.id,
      stage: curr.stage,
      entered_at: curr.entered_at,
      exited_at,
      duration_seconds,
    });
  }
  return result.reverse(); // newest first for display
}

interface DealNote {
  id: string;
  content: string;
  stage: string;
  created_at: string;
}

interface DealLink {
  id: string;
  url: string;
  title: string | null;
  stage: string;
  created_at: string;
}

interface DealDocument {
  id: string;
  file_name: string;
  file_path: string;
  stage: string;
  created_at: string;
}

/** File from the "files" table (AI file dump) where matched_companies contains this company */
interface MatchedFile {
  id: string;
  file_name: string;
  file_link: string;
  file_date: string | null;
  created_at: string;
}

interface Screening {
  id: string;
  company_id: string;
  criteria_id: string;
  track_id: string | null;
  state: "pending" | "completed" | "failed";
  result: string | null;
  remarks: string | null;
  created_at: string;
  criterias: {
    id: string;
    name: string;
    prompt: string;
  };
  track?: {
    id: string;
    title: string | null;
  } | null;
}

type OverallScreeningStatus = "pending" | "pass" | "fail" | "inconclusive";

/** Aggregate verdict for a set of screenings (matches the L0 progress rules). */
function overallScreeningStatus(list: Screening[]): OverallScreeningStatus {
  if (list.some((s) => s.state === "pending")) return "pending";
  const pass = list.filter((s) => s.result?.toLowerCase() === "pass").length;
  const fail = list.filter((s) => s.result?.toLowerCase() === "fail").length;
  // Pass: minimum 3 pass AND maximum 1 fail.
  if (pass >= 3 && fail <= 1) return "pass";
  if (fail >= 1) return "fail";
  return "inconclusive";
}

interface ScreeningTrackGroup {
  key: string;
  trackName: string | null;
  screenings: Screening[];
}

/** Group a company's screenings by the track they were run for, order preserved. */
function groupScreeningsByTrack(screenings: Screening[]): ScreeningTrackGroup[] {
  const groups = new Map<string, ScreeningTrackGroup>();
  for (const s of screenings) {
    const key = s.track_id ?? "none";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        trackName: s.track?.title?.trim() || null,
        screenings: [],
      });
    }
    groups.get(key)!.screenings.push(s);
  }
  return Array.from(groups.values());
}

function OverallStatusBadge({ status }: { status: OverallScreeningStatus }) {
  if (status === "pending") return <Badge variant="secondary">Pending</Badge>;
  if (status === "pass") return <Badge variant="default">Pass</Badge>;
  if (status === "fail") return <Badge variant="destructive">Fail</Badge>;
  return (
    <Badge
      variant="secondary"
      className="bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400"
    >
      Inconclusive
    </Badge>
  );
}

interface CompanyAnalysis {
  id?: string;
  company_id: string;
  status: string;
  business_overview: string | null;
  business_model_summary: string | null;
  key_takeaways: string | null;
  investment_highlights: string | null;
  investment_risks: string | null;
  diligence_priorities: string | null;
  sources: AnalysisSource[] | null;
  logo_url: string | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface AnalysisSource {
  type: string;
  url?: string;
  title?: string;
}

interface CompanyDetailDialogProps {
  company: CompanyData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: () => void;
  /** Tab to show when the dialog first opens. Defaults to "overview". */
  initialTab?: "overview" | "details" | "filters" | "attachments";
  /** When true, the Company Information card opens in inline edit mode. */
  initialEditing?: boolean;
}

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";
  // Values are stored in millions
  if (Math.abs(value) >= 1000) {
    const billions = value / 1000;
    return `$${billions.toFixed(2)}B`;
  }
  return `$${value.toFixed(2)}M`;
};

const formatDuration = (seconds: number | null) => {
  if (seconds === null) return "Ongoing";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
};

export default function CompanyDetailDialog({
  company: companyProp,
  open,
  onOpenChange,
  onUpdate,
  initialTab = "overview",
  initialEditing = false,
}: CompanyDetailDialogProps) {
  const router = useRouter();
  const { analyzeWithAI } = useChatContext();
  const [company, setCompany] = useState<CompanyData>(companyProp);
  // Only re-sync from the prop when a *different* company is opened. Some
  // parents (e.g. MarketScreeningResults) rebuild the `company` prop as a new
  // object literal on every render; syncing on every reference change would
  // clobber in-dialog edits (remarks, company info) with stale prop values.
  useEffect(() => {
    setCompany(companyProp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyProp.id]);
  const [stageHistory, setStageHistory] = useState<StageHistory[]>([]);
  const [notes, setNotes] = useState<DealNote[]>([]);
  const [links, setLinks] = useState<DealLink[]>([]);
  const [documents, setDocuments] = useState<DealDocument[]>([]);
  const [matchedFiles, setMatchedFiles] = useState<MatchedFile[]>([]);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  // Inline edit mode for the Company Information card
  type EditForm = {
    target: string;
    project_name: string;
    website: string;
    geography: string;
    source: string;
    ownership: string;
    segment: string;
    pipeline_stage: string;
    ev_2024: string;
    // Pipeline (HTML-parity) fields
    deal_type: string;
    last_activity_at: string; // YYYY-MM-DD
    workflow_status: string;
    banker: string;
    doc_type: string;
    stake: string;
    deal_size: string;
    key_rationale: string;
    deal_sponsor: string;
    deal_captain: string;
    entered_by: string;
  };
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [bankerOptions, setBankerOptions] = useState<string[]>([]);
  const [userOptions, setUserOptions] = useState<string[]>([]);

  const startEditing = async () => {
    setEditForm({
      target: company.target ?? '',
      project_name: company.project_name ?? '',
      website: company.website ?? '',
      geography: company.geography ?? '',
      source: company.source ?? '',
      ownership: company.ownership ?? '',
      segment: company.segment ?? '',
      pipeline_stage: company.pipeline_stage ?? 'L0',
      ev_2024: company.ev_2024 != null ? String(company.ev_2024) : '',
      deal_type: company.deal_type ?? '',
      last_activity_at: isoToDateInput(company.last_activity_at),
      workflow_status: company.workflow_status ?? '',
      banker: company.banker ?? '',
      doc_type: company.doc_type ?? '',
      stake: company.stake ?? '',
      deal_size: company.deal_size ?? '',
      key_rationale: company.key_rationale ?? '',
      deal_sponsor: company.deal_sponsor ?? '',
      deal_captain: company.deal_captain ?? '',
      entered_by: company.entered_by ?? '',
    });
    setIsEditing(true);
    if (bankerOptions.length === 0) {
      getBankerNames()
        .then(setBankerOptions)
        .catch((err) => console.error('Failed to load bankers:', err));
    }
    if (userOptions.length === 0) {
      getUsers()
        .then((users: UserSummary[]) =>
          setUserOptions(users.map((u) => u.name).filter((n): n is string => !!n)),
        )
        .catch((err) => console.error('Failed to load users:', err));
    }
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditForm(null);
  };

  // Inline edit mode for the AI Market Scanning Remarks card
  const [isEditingRemarks, setIsEditingRemarks] = useState(false);
  const [isSavingRemarks, setIsSavingRemarks] = useState(false);
  const [remarksDraft, setRemarksDraft] = useState('');

  const startEditingRemarks = () => {
    setRemarksDraft(company.remarks ?? '');
    setIsEditingRemarks(true);
  };

  const cancelEditingRemarks = () => {
    setIsEditingRemarks(false);
    setRemarksDraft('');
  };

  const saveRemarks = async () => {
    setIsSavingRemarks(true);
    try {
      const trimmed = remarksDraft.trim();
      await updateCompany(company.id, { remarks: trimmed || null });
      setCompany((prev) => ({ ...prev, remarks: trimmed || null }));
      toast.success('Remarks updated');
      setIsEditingRemarks(false);
      setRemarksDraft('');
      onUpdate();
    } catch (err: any) {
      console.error('Failed to save remarks:', err);
      toast.error(`Failed to save: ${err.message || 'Unknown error'}`);
    } finally {
      setIsSavingRemarks(false);
    }
  };

  const saveEditing = async () => {
    if (!editForm) return;
    setIsSaving(true);
    try {
      const evNum = editForm.ev_2024.trim() === '' ? null : Number(editForm.ev_2024);
      if (evNum !== null && Number.isNaN(evNum)) {
        toast.error('Enterprise Value must be a number');
        setIsSaving(false);
        return;
      }
      const stakeResult = normalizeStake(editForm.stake);
      if ('error' in stakeResult) {
        toast.error(stakeResult.error);
        setIsSaving(false);
        return;
      }
      await updateCompany(company.id, {
          target: editForm.target.trim() || null,
          project_name: editForm.project_name.trim() || null,
          website: editForm.website.trim() || null,
          geography: editForm.geography.trim() || null,
          source: editForm.source || null,
          ownership: editForm.ownership || null,
          segment: editForm.segment.trim() || null,
          pipeline_stage: editForm.pipeline_stage,
          ev_2024: evNum,
          deal_type: editForm.deal_type || null,
          last_activity_at: editForm.last_activity_at
            ? new Date(editForm.last_activity_at).toISOString()
            : null,
          workflow_status: editForm.workflow_status.trim() || null,
          banker: editForm.banker.trim() || null,
          doc_type: editForm.doc_type || null,
          stake: stakeResult.value,
          deal_size: editForm.deal_size.trim() || null,
          key_rationale: editForm.key_rationale.trim() || null,
          deal_sponsor: editForm.deal_sponsor.trim() || null,
          deal_captain: editForm.deal_captain.trim() || null,
          entered_by: editForm.entered_by.trim() || null,
        });
      const refreshedCompany = await getCompanies({ id: company.id });
      if (refreshedCompany) {
        setCompany((prev) => ({ ...prev, ...refreshedCompany }));
      }
      toast.success('Company updated');
      setIsEditing(false);
      setEditForm(null);
      onUpdate();
    } catch (err: any) {
      console.error('Failed to save company:', err);
      toast.error(`Failed to save: ${err.message || 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  };

  // Analysis states
  const [analysis, setAnalysis] = useState<CompanyAnalysis | null>(null);
  const [analysisGenerating, setAnalysisGenerating] = useState(false);
  const [analysisCancelling, setAnalysisCancelling] = useState(false);
  const analysisPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAnalysisPoll = () => {
    if (analysisPollRef.current) {
      clearInterval(analysisPollRef.current);
      analysisPollRef.current = null;
    }
  };

  // Form states
  const [newNote, setNewNote] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [newLinkTitle, setNewLinkTitle] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Document preview (deal doc or matched file from files table)
  const [previewDoc, setPreviewDoc] = useState<DealDocument | null>(null);
  const [previewMatchedFile, setPreviewMatchedFile] =
    useState<MatchedFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const [activeTab, setActiveTab] = useState<
    "overview" | "details" | "filters" | "attachments"
  >(initialTab);

  useEffect(() => {
    if (open) {
      fetchDetails();
      fetchAnalysis();
    }
  }, [open, company.id]);

  // When opened via the "Update" action, jump straight to the Details tab with
  // the Company Information card already in inline edit mode.
  useEffect(() => {
    if (open && initialEditing) {
      setActiveTab("details");
      startEditing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company.id]);

  // Load tracks once the dialog opens, to resolve the Deal Sponsor / Captain
  // (the matched Track's PIC).
  useEffect(() => {
    if (!open || tracks.length > 0) return;
    getTracks()
      .then(setTracks)
      .catch((err) => console.error("Failed to load tracks:", err));
  }, [open, tracks.length]);

  useEffect(() => stopAnalysisPoll, []);

  const fetchDetails = async () => {
    setLoading(true);
    try {
      const data = await getCompanyDetails(company.id);
      setStageHistory(
        companyLogsToStageHistory((data.logs || []) as CompanyLogRow[]),
      );
      setNotes((data.notes || []) as DealNote[]);
      setLinks((data.links || []) as DealLink[]);
      setDocuments((data.documents || []) as DealDocument[]);
      setScreenings((data.screenings || []) as Screening[]);
      setMatchedFiles((data.matchedFiles || []) as MatchedFile[]);
    } catch (error) {
      console.error("Error fetching details:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchScreenings = async () => {
    if (!company.id) return;
    try {
      const data = await getScreenings({ companyId: company.id });
      if (data) setScreenings(data as Screening[]);
    } catch (error) {
      console.error("Error fetching screenings:", error);
    }
  };

  useEffect(() => {
    if (!open || !company.id || !screenings.some((s) => s.state === "pending"))
      return;
    const interval = setInterval(fetchScreenings, 3000);
    return () => clearInterval(interval);
  }, [open, company.id, screenings]);

  const fetchAnalysis = async () => {
    try {
      const res = await fetch(`/api/company-analysis?companyId=${company.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.status) {
          setAnalysis(data);
          if (isAnalysisInProgress(data.status)) {
            setAnalysisGenerating(true);
            pollAnalysis();
          }
          return;
        }
      }
      // No analysis exists yet → generate it the first time the deal is opened
      // (this content powers the Overview slide). Skip for dropped deals.
      if (company.status !== "dropped") {
        generateAnalysis();
      }
    } catch (error) {
      console.error("Error fetching analysis:", error);
    }
  };

  const pollAnalysis = () => {
    stopAnalysisPoll();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/company-analysis?companyId=${company.id}`,
        );
        if (res.ok) {
          const data = await res.json();
          setAnalysis(data);
          if (!isAnalysisInProgress(data.status)) {
            setAnalysisGenerating(false);
            stopAnalysisPoll();
          }
        }
      } catch {
        stopAnalysisPoll();
        setAnalysisGenerating(false);
      }
    }, 2500);
    analysisPollRef.current = interval;
    setTimeout(() => {
      if (analysisPollRef.current === interval) {
        stopAnalysisPoll();
        setAnalysisGenerating(false);
      }
    }, 300000);
  };

  const generateAnalysis = async () => {
    setAnalysisGenerating(true);
    let dispatched = false;
    try {
      const res = await fetch("/api/company-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate analysis");
      }

      const data = await res.json();
      if (res.status === 202 || data.jobId) {
        dispatched = true;
        pollAnalysis();
        return;
      }
      setAnalysis(data);
      toast.success("AI Company Card generated successfully");
    } catch (error) {
      console.error("Error generating analysis:", error);
      toast.error(
        (error as Error).message || "Failed to generate AI Company Card",
      );
      fetchAnalysis();
    } finally {
      if (!dispatched) setAnalysisGenerating(false);
    }
  };

  const regenerateAnalysis = async () => {
    try {
      await fetch(`/api/company-analysis?companyId=${company.id}`, {
        method: "DELETE",
      });
      setAnalysis(null);
    } catch {
      // Continue even if delete fails
    }
    await generateAnalysis();
  };

  const scrollToAICardAndRun = (forceRegenerate = false) => {
    setActiveTab("details");
    if (forceRegenerate || analysis?.status === "completed") {
      regenerateAnalysis();
    } else {
      generateAnalysis();
    }
  };

  const cancelAnalysis = async () => {
    setAnalysisCancelling(true);
    try {
      const res = await fetch("/api/company-analysis/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to cancel generation");
      }
      stopAnalysisPoll();
      setAnalysis(null);
      setAnalysisGenerating(false);
      toast.success("Company Card generation cancelled");
    } catch (error) {
      console.error("Error cancelling analysis:", error);
      toast.error(
        (error as Error).message || "Failed to cancel Company Card generation",
      );
    } finally {
      setAnalysisCancelling(false);
    }
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    setIsSubmitting(true);
    try {
      await addCompanyNote(company.id, newNote, company.pipeline_stage || "L0");
      setNewNote("");
      fetchDetails();
      toast.success("Note added");
    } catch (error: any) {
      toast.error("Failed to add note");
    } finally {
      setIsSubmitting(false);
    }
  };

  const addLink = async () => {
    if (!newLinkUrl.trim()) return;
    setIsSubmitting(true);
    try {
      await addCompanyLink(
        company.id,
        newLinkUrl,
        newLinkTitle || undefined,
        company.pipeline_stage || "L0",
      );
      setNewLinkUrl("");
      setNewLinkTitle("");
      fetchDetails();
      toast.success("Link added");
    } catch (error: any) {
      toast.error("Failed to add link");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsSubmitting(true);
    try {
      const contentType = file.type || "application/octet-stream";

      let uploadUrlRes: Response;
      try {
        uploadUrlRes = await fetch(
          `/api/deal-documents/upload-url?dealId=${encodeURIComponent(company.id)}&fileName=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(contentType)}`,
        );
      } catch (netErr) {
        throw new Error(
          "Could not reach server. Check your connection and that the app is running.",
        );
      }
      const uploadUrlText = await uploadUrlRes.text();
      let uploadUrlData: {
        success?: boolean;
        error?: string;
        data?: { uploadUrl: string; key: string };
      };
      try {
        uploadUrlData = JSON.parse(uploadUrlText);
      } catch {
        throw new Error(
          uploadUrlRes.ok
            ? "Invalid server response"
            : `Get upload URL failed: ${uploadUrlRes.status}`,
        );
      }
      if (!uploadUrlData.success || !uploadUrlData.data) {
        throw new Error(uploadUrlData.error || "Failed to get upload URL");
      }
      const { uploadUrl, key } = uploadUrlData.data;

      let s3Res: Response;
      try {
        s3Res = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": contentType },
        });
      } catch (netErr) {
        throw new Error(
          "Upload to storage failed (network error). Ensure AWS_S3_BUCKET matches your bucket and the bucket has CORS enabled for this origin.",
        );
      }
      if (!s3Res.ok) throw new Error("Failed to upload file to storage");

      let registerRes: Response;
      try {
        registerRes = await fetch("/api/deal-documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dealId: company.id,
            key,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || null,
            stage: company.pipeline_stage || "L0",
          }),
        });
      } catch (netErr) {
        throw new Error("Could not register document. Check your connection.");
      }
      const registerText = await registerRes.text();
      let registerData: { success?: boolean; error?: string };
      try {
        registerData = registerText ? JSON.parse(registerText) : {};
      } catch {
        throw new Error(
          registerRes.ok
            ? "Invalid server response"
            : `Register failed: ${registerRes.status}`,
        );
      }
      if (!registerData.success) {
        throw new Error(registerData.error || "Failed to register document");
      }

      fetchDetails();
      toast.success("Document uploaded");
      e.target.value = "";
    } catch (error: unknown) {
      console.error("Upload error:", error);
      toast.error((error as Error)?.message || "Failed to upload document");
    } finally {
      setIsSubmitting(false);
    }
  };

  const deleteNote = async (noteId: string) => {
    try {
      await deleteDealNote(noteId);
      fetchDetails();
      toast.success("Note deleted");
    } catch (error) {
      toast.error("Failed to delete note");
    }
  };

  const deleteLink = async (linkId: string) => {
    try {
      await deleteDealLink(linkId);
      fetchDetails();
      toast.success("Link deleted");
    } catch (error) {
      toast.error("Failed to delete link");
    }
  };

  const deleteDocument = async (doc: DealDocument) => {
    try {
      const res = await fetch(
        `/api/deal-documents?id=${encodeURIComponent(doc.id)}`,
        {
          method: "DELETE",
        },
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to delete document");
      }
      fetchDetails();
      toast.success("Document deleted");
    } catch (error) {
      toast.error((error as Error)?.message || "Failed to delete document");
    }
  };

  const downloadDocument = async (doc: DealDocument) => {
    try {
      const res = await fetch(
        `/api/deal-documents/download-url?id=${encodeURIComponent(doc.id)}`,
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to get download URL");
      }
      const url = data.url;
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.file_name;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      a.click();
    } catch (error) {
      toast.error((error as Error)?.message || "Failed to download document");
    }
  };

  const handleOpenPreview = async (doc: DealDocument) => {
    setPreviewDoc(doc);
    setLoadingPreview(true);
    setPreviewUrl(null);
    try {
      const res = await fetch(
        `/api/deal-documents/download-url?id=${encodeURIComponent(doc.id)}&preview=true`,
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to get preview URL");
      }
      setPreviewUrl(data.url);
    } catch (error) {
      toast.error((error as Error)?.message || "Failed to load preview");
      setPreviewDoc(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleClosePreview = () => {
    setPreviewDoc(null);
    setPreviewMatchedFile(null);
    setPreviewUrl(null);
  };

  const downloadMatchedFile = async (file: MatchedFile) => {
    try {
      const res = await fetch(
        `/api/ai-file-dump/${encodeURIComponent(file.id)}/download-url`,
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to get download URL");
      }
      const a = document.createElement("a");
      a.href = data.url;
      a.download = file.file_name;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      a.click();
    } catch (error) {
      toast.error((error as Error)?.message || "Failed to download file");
    }
  };

  const handleOpenMatchedFilePreview = async (file: MatchedFile) => {
    setPreviewDoc(null);
    setPreviewMatchedFile(file);
    setLoadingPreview(true);
    setPreviewUrl(null);
    try {
      const res = await fetch(
        `/api/ai-file-dump/${encodeURIComponent(file.id)}/download-url`,
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to get preview URL");
      }
      setPreviewUrl(data.url);
    } catch (error) {
      toast.error((error as Error)?.message || "Failed to load preview");
      setPreviewMatchedFile(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const displayName = companyDisplayName(company, "Unknown Company");
  const displayTitle = companyDisplayTitle(company, "Unknown Company");
  const logoInitial = companyInitials(company);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[80vw] max-w-[80vw] h-[85vh] overflow-hidden flex flex-col p-0 gap-0">
          {/* Header */}
          <div className="px-6 pt-5 pb-4 shrink-0">
            <div className="flex items-center gap-4">
              {/* Logo / Acronym circle */}
              <div className="h-14 w-14 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center shrink-0 overflow-hidden border border-violet-200 dark:border-violet-700">
                {analysis?.logo_url ? (
                  <img
                    src={analysis.logo_url}
                    alt={displayName}
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                      (e.currentTarget.nextSibling as HTMLElement | null)?.removeAttribute("style");
                    }}
                  />
                ) : null}
                <span
                  className="text-lg font-bold text-violet-600 dark:text-violet-300"
                  style={analysis?.logo_url ? { display: "none" } : undefined}
                >
                  {logoInitial}
                </span>
              </div>
              {/* Name + badges + description */}
              <div className="flex-1 min-w-0 pr-8">
                <div className="flex items-center gap-2 flex-wrap">
                  <DialogTitle className="text-xl font-bold leading-tight">
                    {displayTitle}
                  </DialogTitle>
                  {company.segment && (
                    <Badge variant="outline" className="text-xs">{company.segment}</Badge>
                  )}
                  <Badge variant="outline" className="text-xs">
                    {getStageLabel(company.pipeline_stage)}
                  </Badge>
                  {company.status === "dropped" && (
                    <Badge variant="destructive" className="text-xs">Dropped</Badge>
                  )}
                </div>
                {analysis?.business_overview && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-3 leading-snug">
                    {analysis.business_overview.replace(/^-\s+\*\*[^*]+\*\*:\s*/m, "").replace(/\n[\s\S]*/m, "").trim()}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  {analysis?.status === "completed" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 h-7 text-xs"
                      onClick={() => {
                        onOpenChange(false);
                        router.push(`/pipeline/${company.id}/slides`);
                      }}
                    >
                      <Presentation className="h-3.5 w-3.5" />
                      Generate Slides
                    </Button>
                  )}
                  {analysisGenerating ? (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        className="bg-accent hover:bg-accent/90 text-accent-foreground gap-1.5 h-7 text-xs"
                        disabled
                      >
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Generating...
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 h-7 text-xs"
                        onClick={cancelAnalysis}
                        disabled={analysisCancelling}
                      >
                        {analysisCancelling ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <X className="h-3.5 w-3.5" />
                        )}
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      className="bg-accent hover:bg-accent/90 text-accent-foreground gap-1.5 h-7 text-xs"
                      onClick={() => scrollToAICardAndRun()}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {analysis?.status === "completed"
                        ? "Regenerate AI Card"
                        : "Generate AI Company Card"}
                    </Button>
                  )}
                  <AskAIButton
                    variant="button"
                    label="Analyze using AI"
                    onClick={() => {
                      analyzeWithAI(
                        `Analyze ${companyDisplayName(company, "this company")} and provide insights about it as a potential deal.`,
                      );
                      onOpenChange(false);
                    }}
                  />
                </div>
              </div>
            </div>
            {/* Expand + close buttons are handled by DialogContent default close */}
            <button
              onClick={() => {
                onOpenChange(false);
                router.push(`/pipeline/${company.id}`);
              }}
              className="absolute right-10 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              title="Open full page"
            >
              <Expand className="h-4 w-4" />
              <span className="sr-only">Open full page</span>
            </button>
          </div>

          {company.status === "dropped" && (
            <div className="px-6 shrink-0">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>
                  Deal dropped
                  {company.dropped_at &&
                    ` on ${format(new Date(company.dropped_at), "MMM d, yyyy")}`}
                </AlertTitle>
                <AlertDescription>
                  {company.dropped_reason ?? "No reason was recorded."}
                </AlertDescription>
              </Alert>
            </div>
          )}

          {company.promoted_reasons && company.promoted_reasons.trim() && (
            <Alert>
              <TrendingUp className="h-4 w-4" />
              <AlertTitle>Promotion reasons</AlertTitle>
              <AlertDescription>
                <MarkdownRenderer content={company.promoted_reasons} variant="card" />
              </AlertDescription>
            </Alert>
          )}

          {/* Scrollable tab content */}
          <Tabs
            value={activeTab}
            onValueChange={(v) =>
              setActiveTab(
                v as "overview" | "details" | "filters" | "attachments",
              )
            }
            className="flex flex-col flex-1 min-h-0"
          >
            {/* Tab bar pinned to top */}
            <div className="shrink-0 border-b bg-background">
              <TabsList className="w-full h-auto rounded-none bg-transparent p-0 grid grid-cols-4">
                <TabsTrigger
                  value="overview"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-accent data-[state=active]:text-accent data-[state=active]:bg-transparent py-3 text-sm font-medium"
                >
                  Overview
                </TabsTrigger>
                <TabsTrigger
                  value="details"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-accent data-[state=active]:text-accent data-[state=active]:bg-transparent py-3 text-sm font-medium"
                >
                  Details
                </TabsTrigger>
                <TabsTrigger
                  value="filters"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-accent data-[state=active]:text-accent data-[state=active]:bg-transparent py-3 text-sm font-medium"
                >
                  L1 Filters
                </TabsTrigger>
                <TabsTrigger
                  value="attachments"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-accent data-[state=active]:text-accent data-[state=active]:bg-transparent py-3 text-sm font-medium"
                >
                  Attachments
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6">
              <div className="h-2" />

            {/* Overview — read-only L0→L1 submission slide, powered by the AI
                Company Card. Auto-generates on first open; shows the generating
                state until ready. */}
            <TabsContent value="overview" className="space-y-4 pb-4">
              {analysisGenerating && !analysis?.business_overview ? (
                <AICompanyCardLoading
                  onCancel={cancelAnalysis}
                  cancelling={analysisCancelling}
                />
              ) : analysis?.status === "failed" ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 flex flex-col items-center justify-center gap-3">
                  <AlertCircle className="h-6 w-6 text-destructive" />
                  <div className="text-center">
                    <h3 className="text-base font-semibold text-destructive">
                      Generation Failed
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      {analysis.error_message ??
                        "An error occurred while generating the overview."}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => scrollToAICardAndRun(true)}
                    disabled={analysisGenerating}
                  >
                    <Sparkles className="h-4 w-4 mr-2" />
                    Retry
                  </Button>
                </div>
              ) : (
                <CompanyOverviewSlide company={company} analysis={analysis} />
              )}
            </TabsContent>

            <TabsContent value="details" className="space-y-4 pb-4">
              {/* AI Market Scanning Remarks - only for outbound deals */}
              {company.source?.toLowerCase() === "outbound" && (
                  <Card className="border-purple-200 dark:border-purple-800/50 bg-gradient-to-br from-purple-50/50 to-violet-50/30 dark:from-purple-950/20 dark:to-violet-950/10">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2 text-purple-700 dark:text-purple-400">
                          <Sparkles className="h-5 w-5 text-purple-500" />
                          AI Market Scanning Remarks
                        </CardTitle>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-700"
                          >
                            <Sparkles className="h-3 w-3 mr-1" />
                            AI Discovered
                          </Badge>
                          {!isEditingRemarks && (
                            <Button variant="ghost" size="sm" onClick={startEditingRemarks} aria-label="Edit remarks" className="h-6 w-6 p-0 text-purple-700 dark:text-purple-300">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                      {company.segment && (
                        <p className="text-sm text-muted-foreground">
                          Matched against: {company.segment}
                        </p>
                      )}
                    </CardHeader>
                    <CardContent>
                      <div className="p-4 rounded-lg border border-purple-200 dark:border-purple-800/50 bg-purple-50/80 dark:bg-purple-950/30">
                        <p className="text-sm font-medium text-purple-700 dark:text-purple-300 flex items-center gap-2 mb-2">
                          <Sparkles className="h-4 w-4" />
                          Why This Company Matches Your Investment Thesis
                        </p>
                        {isEditingRemarks ? (
                          <div className="space-y-3">
                            <Textarea
                              value={remarksDraft}
                              onChange={(e) => setRemarksDraft(e.target.value)}
                              disabled={isSavingRemarks}
                              rows={6}
                              placeholder="Describe how this company aligns with the investment thesis…"
                              className="text-sm"
                            />
                            <div className="flex justify-end gap-2">
                              <Button variant="outline" size="sm" onClick={cancelEditingRemarks} disabled={isSavingRemarks}>Cancel</Button>
                              <Button size="sm" onClick={saveRemarks} disabled={isSavingRemarks} className="gap-1">
                                {isSavingRemarks ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                Save
                              </Button>
                            </div>
                          </div>
                        ) : company.remarks ? (
                          <MarkdownRenderer content={company.remarks} variant="card" />
                        ) : (
                          <p className="text-sm text-muted-foreground italic">No remarks yet. Click the edit icon to add some.</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

              {/* Financial Charts - shown first */}
              <FinancialCharts
                financials={company.financials_raw ?? []}
                rawFinancials={company.financials_raw ?? []}
                companyId={company.id}
                onUpdate={onUpdate}
              />

              {/* Company Information - flat, no card */}
              <div className="rounded-lg border bg-card px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Company Information
                  </p>
                  {!isEditing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={startEditing}
                      aria-label="Edit Company Information"
                      className="h-6 w-6 p-0"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Company Name</p>
                    {isEditing && editForm ? (
                      <Input
                        value={editForm.target}
                        onChange={(e) =>
                          setEditForm({ ...editForm, target: e.target.value })
                        }
                        disabled={isSaving}
                        className="mt-1 h-7 text-sm"
                      />
                    ) : (
                      <p className="text-sm font-medium break-words">{company.target || "—"}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Project Name</p>
                    {isEditing && editForm ? (
                      <Input
                        value={editForm.project_name}
                        onChange={(e) =>
                          setEditForm({ ...editForm, project_name: e.target.value })
                        }
                        placeholder="e.g. Project Phoenix"
                        disabled={isSaving}
                        className="mt-1 h-7 text-sm"
                      />
                    ) : (
                      <p className="text-sm font-medium break-words">{company.project_name || "—"}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Website</p>
                    {isEditing && editForm ? (
                      <Input
                        value={editForm.website}
                        onChange={(e) =>
                          setEditForm({ ...editForm, website: e.target.value })
                        }
                        placeholder="https://..."
                        disabled={isSaving}
                        className="mt-1 h-7 text-sm"
                      />
                    ) : company.website ? (
                      <a
                        href={websiteHref(company.website)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline text-xs inline-flex items-start gap-1 break-all"
                      >
                        <span className="break-all">{company.website}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 mt-0.5" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Sector</p>
                    {isEditing && editForm ? (
                      <Input
                        value={editForm.segment}
                        onChange={(e) =>
                          setEditForm({ ...editForm, segment: e.target.value })
                        }
                        disabled={isSaving}
                        className="mt-1 h-7 text-sm"
                      />
                    ) : (
                      <p className="text-sm font-medium break-words">{company.segment || "—"}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Headquarter</p>
                    {isEditing && editForm ? (
                      <Input
                        value={editForm.geography}
                        onChange={(e) =>
                          setEditForm({ ...editForm, geography: e.target.value })
                        }
                        disabled={isSaving}
                        className="mt-1 h-7 text-sm"
                      />
                    ) : (
                      <p className="text-sm font-medium break-words">{company.geography || "—"}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Ownership</p>
                    {isEditing && editForm ? (
                      <Select
                        value={editForm.ownership || '__none__'}
                        onValueChange={(v) =>
                          setEditForm({
                            ...editForm,
                            ownership: v === '__none__' ? '' : v,
                          })
                        }
                        disabled={isSaving}
                      >
                        <SelectTrigger className="mt-1 h-7 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">-</SelectItem>
                          {OWNERSHIP_OPTIONS.map((o) => (
                            <SelectItem key={o} value={o}>
                              {o}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm font-medium break-words">{company.ownership || "—"}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Source</p>
                    {isEditing && editForm ? (
                      <Select
                        value={editForm.source || '__none__'}
                        onValueChange={(v) =>
                          setEditForm({
                            ...editForm,
                            source: v === '__none__' ? '' : v,
                          })
                        }
                        disabled={isSaving}
                      >
                        <SelectTrigger className="mt-1 h-7 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">-</SelectItem>
                          <SelectItem value="inbound">Inbound</SelectItem>
                          <SelectItem value="outbound">Outbound</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm font-medium capitalize break-words">{company.source || "—"}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Current Stage</p>
                    {isEditing && editForm ? (
                      <Select
                        value={editForm.pipeline_stage}
                        onValueChange={(v) =>
                          setEditForm({ ...editForm, pipeline_stage: v })
                        }
                        disabled={isSaving}
                      >
                        <SelectTrigger className="mt-1 h-7 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as DealStage[]).map((s) => (
                            <SelectItem key={s} value={s}>
                              {s} — {STAGE_LABELS[s] ?? s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="outline" className="text-xs px-2 py-0.5 mt-0.5">
                        {getStageLabel(company.pipeline_stage)}
                      </Badge>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Valuation</p>
                    {isEditing && editForm ? (
                      <Input
                        type="number"
                        step="0.01"
                        value={editForm.ev_2024}
                        onChange={(e) =>
                          setEditForm({ ...editForm, ev_2024: e.target.value })
                        }
                        placeholder="USD millions"
                        disabled={isSaving}
                        className="mt-1 h-7 text-sm"
                      />
                    ) : (
                      <p className="text-sm font-medium break-words">{formatCurrency(company.ev_2024)}</p>
                    )}
                  </div>
                  <div>
                    {(() => {
                      const stage =
                        isEditing && editForm
                          ? editForm.pipeline_stage
                          : company.pipeline_stage;
                      const field = dealLeadField(stage);
                      const pics = matchedTrackPics(company, tracks);
                      const fallback = pics.length > 0 ? pics.join(', ') : null;
                      return (
                        <>
                          <p className="text-xs text-muted-foreground">
                            {dealLeadLabel(stage)}
                          </p>
                          {isEditing && editForm ? (
                            <div className="mt-1">
                              <StatusCombobox
                                value={editForm[field] || null}
                                options={userOptions}
                                placeholder={
                                  fallback
                                    ? `${fallback} (from track)`
                                    : `Set ${dealLeadLabel(stage)}…`
                                }
                                searchPlaceholder="Search or type a name…"
                                emptyText="No team members found."
                                onChange={(v) =>
                                  setEditForm({ ...editForm, [field]: v })
                                }
                                disabled={isSaving}
                              />
                            </div>
                          ) : (
                            <p className="text-sm font-medium break-words">
                              {effectiveDealLead(company, stage, tracks) ?? '—'}
                            </p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Deal Type</p>
                    {isEditing && editForm ? (
                      <Select
                        value={editForm.deal_type || '__none__'}
                        onValueChange={(v) =>
                          setEditForm({ ...editForm, deal_type: v === '__none__' ? '' : v })
                        }
                        disabled={isSaving}
                      >
                        <SelectTrigger className="mt-1 h-7 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">-</SelectItem>
                          <SelectItem value="majority">Majority</SelectItem>
                          <SelectItem value="minority">Minority</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm font-medium capitalize break-words">{company.deal_type || '—'}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Entered by</p>
                    {isEditing && editForm ? (
                      <div className="mt-1">
                        <StatusCombobox
                          value={editForm.entered_by || null}
                          options={userOptions}
                          placeholder="Set entered by…"
                          searchPlaceholder="Search or type a name…"
                          emptyText="No team members found."
                          onChange={(v) =>
                            setEditForm({ ...editForm, entered_by: v })
                          }
                          disabled={isSaving}
                        />
                      </div>
                    ) : (
                      <p className="text-sm font-medium break-words">{company.entered_by || '—'}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    {isEditing && editForm ? (
                      <div className="mt-1">
                        <StatusCombobox
                          value={editForm.workflow_status || null}
                          options={
                            company.source === 'outbound'
                              ? DEFAULT_OUTBOUND_STATUS_OPTIONS
                              : DEFAULT_INBOUND_STATUS_OPTIONS
                          }
                          placeholder={company.source === 'outbound' ? 'Set status…' : 'Unreviewed'}
                          onChange={(v) => setEditForm({ ...editForm, workflow_status: v })}
                          disabled={isSaving}
                        />
                      </div>
                    ) : (
                      <p className="text-sm font-medium break-words">{company.workflow_status || '—'}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Last Activity</p>
                    {isEditing && editForm ? (
                      <Input
                        type="date"
                        value={editForm.last_activity_at}
                        onChange={(e) =>
                          setEditForm({ ...editForm, last_activity_at: e.target.value })
                        }
                        disabled={isSaving}
                        className="mt-1 h-7 text-sm"
                      />
                    ) : (
                      <p className="text-sm font-medium break-words">
                        {company.last_activity_at
                          ? format(new Date(company.last_activity_at), 'MMM d, yyyy')
                          : '—'}
                      </p>
                    )}
                  </div>

                  {company.source !== 'outbound' && (
                    <>
                      <div>
                        <p className="text-xs text-muted-foreground">Banker / Source</p>
                        {isEditing && editForm ? (
                          <StatusCombobox
                            value={editForm.banker || null}
                            options={bankerOptions}
                            placeholder="Set banker…"
                            searchPlaceholder="Search or add a banker…"
                            emptyText="No bankers yet."
                            onChange={(v) =>
                              setEditForm({ ...editForm, banker: v })
                            }
                            disabled={isSaving}
                            className="mt-1"
                          />
                        ) : (
                          <p className="text-sm font-medium break-words">{company.banker || '—'}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Doc Type</p>
                        {isEditing && editForm ? (
                          <Select
                            value={editForm.doc_type || '__none__'}
                            onValueChange={(v) =>
                              setEditForm({ ...editForm, doc_type: v === '__none__' ? '' : v })
                            }
                            disabled={isSaving}
                          >
                            <SelectTrigger className="mt-1 h-7 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">-</SelectItem>
                              <SelectItem value="teaser">Teaser</SelectItem>
                              <SelectItem value="shopping_list">Shopping List</SelectItem>
                              <SelectItem value="market_study">Market Study</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="text-sm font-medium capitalize break-words">
                            {company.doc_type ? company.doc_type.replace(/_/g, ' ') : '—'}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">% Stake</p>
                        {isEditing && editForm ? (
                          <Input
                            value={editForm.stake}
                            onChange={(e) =>
                              setEditForm({ ...editForm, stake: e.target.value })
                            }
                            placeholder="e.g. 51%"
                            title="Target ownership percentage being pursued"
                            disabled={isSaving}
                            className="mt-1 h-7 text-sm"
                          />
                        ) : (
                          <p className="text-sm font-medium break-words">{company.stake || '—'}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Deal Size</p>
                        {isEditing && editForm ? (
                          <Input
                            value={editForm.deal_size}
                            onChange={(e) =>
                              setEditForm({ ...editForm, deal_size: e.target.value })
                            }
                            disabled={isSaving}
                            className="mt-1 h-7 text-sm"
                          />
                        ) : (
                          <p className="text-sm font-medium break-words">{company.deal_size || '—'}</p>
                        )}
                      </div>
                    </>
                  )}

                  {company.source === 'outbound' && (
                    <div className="col-span-2">
                      <p className="text-xs text-muted-foreground">Key Rationale</p>
                      {isEditing && editForm ? (
                        <Textarea
                          value={editForm.key_rationale}
                          onChange={(e) =>
                            setEditForm({ ...editForm, key_rationale: e.target.value })
                          }
                          rows={3}
                          disabled={isSaving}
                          className="mt-1 text-sm resize-y"
                        />
                      ) : (
                        <p className="text-sm font-medium break-words whitespace-pre-wrap">
                          {company.key_rationale || '—'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {isEditing && editForm && (
                  <div className="mt-4 flex justify-end gap-2">
                    <Button variant="outline" onClick={cancelEditing} disabled={isSaving} size="sm">
                      Cancel
                    </Button>
                    <Button onClick={saveEditing} disabled={isSaving} size="sm" className="gap-1">
                      {isSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      Save
                    </Button>
                  </div>
                )}
              </div>

              {/* Stage History */}
              <div className="rounded-lg border bg-card px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  Stage History
                </p>
                {stageHistory.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No history yet</p>
                ) : (
                  <div className="space-y-1">
                    {stageHistory.map((history) => (
                      <div
                        key={history.id}
                        className="flex items-center justify-between py-1.5 border-b last:border-0"
                      >
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="text-xs px-2 py-0.5">
                            {getStageLabel(history.stage)}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(history.entered_at), "MMM d, yyyy HH:mm")}
                          </span>
                        </div>
                        <span className="text-xs font-medium">
                          {history.exited_at ? formatDuration(history.duration_seconds) : "Current"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* AI Company Card - inline in Overview */}
              {(analysisGenerating || analysis) && (
                <div>
                  {analysisGenerating && !analysis?.business_overview ? (
                    <AICompanyCardLoading
                      onCancel={cancelAnalysis}
                      cancelling={analysisCancelling}
                    />
                  ) : analysis?.status === "failed" ? (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 flex flex-col items-center justify-center gap-3">
                      <AlertCircle className="h-6 w-6 text-destructive" />
                      <div className="text-center">
                        <h3 className="text-base font-semibold text-destructive">Analysis Failed</h3>
                        <p className="text-sm text-muted-foreground mt-1">
                          {analysis.error_message ?? "An error occurred while generating the analysis."}
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => scrollToAICardAndRun(true)} disabled={analysisGenerating}>
                        <Sparkles className="h-4 w-4 mr-2" />
                        Retry
                      </Button>
                    </div>
                  ) : analysis?.status === "completed" ? (
                    <div className="space-y-4">
                      {analysis.sources && Array.isArray(analysis.sources) && analysis.sources.length > 0 && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground">Sources:</span>
                          {(analysis.sources as AnalysisSource[]).map((source, idx) =>
                            source.url ? (
                              <a key={idx} href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent/10 text-accent text-xs hover:bg-accent/20 transition-colors">
                                <Globe className="h-3 w-3" />
                                {source.title || new URL(source.url).hostname}
                                <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            ) : (
                              <span key={idx} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent/10 text-accent text-xs">
                                {source.type === "database" || source.type === "files" ? <FileText className="h-3 w-3" /> : source.type === "inven" ? <Search className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
                                {source.title || source.type}
                              </span>
                            ),
                          )}
                        </div>
                      )}
                      <CompanyAnalysisSection title="Business Overview" description="Products, end markets, customer types, and geographic footprint." icon={Building2} content={analysis.business_overview || ""} colorVariant="default" />
                      <CompanyAnalysisSection title="Business Model & Value Chain Summary" description="How the company operates economically and its position in the value chain." icon={Briefcase} content={analysis.business_model_summary || ""} colorVariant="teal" />
                      <CompanyAnalysisSection title="Key Takeaways" description="The most important implications from the analysis (3-5 synthesized insights)." icon={Lightbulb} content={analysis.key_takeaways || ""} colorVariant="blue" />
                      <CompanyAnalysisSection title="Investment Highlights" description="Upside drivers linked to the company's business model and positioning." icon={TrendingUp} content={analysis.investment_highlights || ""} colorVariant="green" />
                      <CompanyAnalysisSection title="Investment Risks" description="Risks inherent to the company's business model and value chain." icon={AlertTriangle} content={analysis.investment_risks || ""} colorVariant="amber" />
                      <CompanyAnalysisSection title="Diligence Priorities" description="Critical unknowns to resolve before advancing investment (3-7 items)." icon={Search} content={analysis.diligence_priorities || ""} colorVariant="rose" />
                    </div>
                  ) : null}
                </div>
              )}
            </TabsContent>

            <TabsContent value="filters" className="space-y-4 pb-4">
              {screenings.length > 0 ? (
                groupScreeningsByTrack(screenings).map((group) => (
                  <Card key={group.key}>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        L1 Screening Results
                        <Badge
                          variant="secondary"
                          className="font-normal align-middle"
                        >
                          {group.trackName || "Unassigned"}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {group.screenings.map((screening) => (
                          <div
                            key={screening.id}
                            className="flex items-center justify-between py-2 border-b last:border-0"
                          >
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">
                                  {screening.criterias?.name ||
                                    "Unknown Criteria"}
                                </span>
                                <Badge
                                  variant={
                                    screening.state === "completed"
                                      ? "outline"
                                      : screening.state === "pending"
                                        ? "secondary"
                                        : "destructive"
                                  }
                                  className="text-xs"
                                >
                                  {screening.state}
                                </Badge>
                              </div>
                              {screening.result && (
                                <p className="text-sm text-muted-foreground mt-1">
                                  {screening.result}
                                </p>
                              )}
                              {screening.remarks && (
                                <p className="text-xs text-muted-foreground mt-1 italic">
                                  {screening.remarks}
                                </p>
                              )}
                            </div>
                            <ScreeningStateIcon
                              state={screening.state}
                              result={screening.result}
                            />
                          </div>
                        ))}
                        <div className="pt-3 border-t">
                          <div className="flex items-center justify-between">
                            <span className="font-medium">Overall Status</span>
                            <OverallStatusBadge
                              status={overallScreeningStatus(group.screenings)}
                            />
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">
                      L1 Screening Results
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground text-sm">
                      No screenings have been run yet. Click &quot;Screen&quot;
                      from the L0 stage to run filters.
                    </p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="attachments" className="space-y-4 pb-4">
              <div className="grid grid-cols-1 gap-4">
                {/* Files mentioning this company (from AI file dump) */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Files mentioning this company
                    </CardTitle>
                    <CardDescription>From AI file dump</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {matchedFiles.length === 0 ? (
                      <p className="text-muted-foreground text-xs">
                        No files from the AI file dump mention this company yet.
                      </p>
                    ) : (
                      <div className="space-y-2 max-h-[200px] overflow-y-auto">
                        {matchedFiles.map((file) => (
                          <div
                            key={file.id}
                            className="flex items-center justify-between p-3 border rounded-lg bg-muted/30"
                          >
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span
                                className="text-sm truncate"
                                title={file.file_name}
                              >
                                {file.file_name}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => downloadMatchedFile(file)}
                                title="Download"
                              >
                                <Download className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() =>
                                  handleOpenMatchedFilePreview(file)
                                }
                                title="Preview"
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() =>
                                  router.push(
                                    `/ai-file-dump?highlight=${encodeURIComponent(file.id)}`,
                                  )
                                }
                                title="Open in AI File Dump"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Documents Section */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Upload className="h-4 w-4" />
                      Documents
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label htmlFor="file-upload" className="cursor-pointer">
                        <div className="border-2 border-dashed rounded-lg p-3 text-center hover:border-primary transition-colors">
                          <Upload className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">
                            Click to upload
                          </p>
                        </div>
                      </Label>
                      <Input
                        id="file-upload"
                        type="file"
                        className="hidden"
                        onChange={handleFileUpload}
                        disabled={isSubmitting}
                      />
                    </div>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {documents.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          No documents yet
                        </p>
                      ) : (
                        documents.map((doc) => (
                          <div
                            key={doc.id}
                            className="flex items-center justify-between p-2 border rounded-lg"
                          >
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                              <button
                                type="button"
                                onClick={() => downloadDocument(doc)}
                                className="text-xs text-primary hover:underline truncate text-left"
                              >
                                {doc.file_name}
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </CardContent>
                </Card>

                {/* Links Section */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <LinkIcon className="h-4 w-4" />
                      Links
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-2">
                      <Input
                        placeholder="URL"
                        value={newLinkUrl}
                        onChange={(e) => setNewLinkUrl(e.target.value)}
                        className="h-8 text-sm"
                      />
                      <div className="flex gap-2">
                        <Input
                          placeholder="Title (optional)"
                          value={newLinkTitle}
                          onChange={(e) => setNewLinkTitle(e.target.value)}
                          className="h-8 text-sm flex-1"
                        />
                        <Button
                          onClick={addLink}
                          disabled={isSubmitting || !newLinkUrl.trim()}
                          size="icon"
                          className="h-8 w-8 shrink-0"
                        >
                          {isSubmitting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Plus className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {links.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          No links yet
                        </p>
                      ) : (
                        links.map((link) => (
                          <div
                            key={link.id}
                            className="flex items-center justify-between p-2 border rounded-lg"
                          >
                            <a
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline truncate flex-1 flex items-center gap-1"
                            >
                              <ExternalLink className="h-3 w-3 shrink-0" />
                              {link.title || link.url}
                            </a>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={() => deleteLink(link.id)}
                            >
                              <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                  </CardContent>
                </Card>

                {/* Notes Section */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Notes
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Textarea
                        placeholder="Add a note..."
                        value={newNote}
                        onChange={(e) => setNewNote(e.target.value)}
                        className="flex-1 min-h-[60px]"
                        rows={2}
                      />
                      <Button
                        onClick={addNote}
                        disabled={isSubmitting || !newNote.trim()}
                        size="icon"
                        className="shrink-0"
                      >
                        {isSubmitting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {notes.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          No notes yet
                        </p>
                      ) : (
                        notes.map((note) => (
                          <div
                            key={note.id}
                            className="p-2 border rounded-lg text-sm"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-xs whitespace-pre-wrap flex-1">
                                {note.content}
                              </p>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0"
                                onClick={() => deleteNote(note.id)}
                              >
                                <Trash2 className="h-3 w-3 text-destructive" />
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              {format(new Date(note.created_at), "MMM d, yyyy")}{" "}
                              • {note.stage}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </CardContent>
                </Card>

              </div>
            </TabsContent>

            </div>{/* end scrollable content */}
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Document preview dialog */}
      <Dialog
        open={!!(previewDoc || previewMatchedFile)}
        onOpenChange={(open) => !open && handleClosePreview()}
      >
        <DialogContent className="flex flex-col w-screen h-screen max-w-none sm:rounded-none border-0 overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              <span className="truncate">
                {previewDoc?.file_name ??
                  previewMatchedFile?.file_name ??
                  "Preview"}
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            {loadingPreview ? (
              <div className="flex h-full w-full items-center justify-center bg-muted/30 rounded-md border">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : previewUrl && (previewDoc || previewMatchedFile) ? (
              <FilePreview
                url={previewUrl}
                fileName={
                  previewDoc?.file_name ?? previewMatchedFile?.file_name ?? ""
                }
                fileKey={previewDoc?.file_path ?? previewMatchedFile?.file_link}
                onDownload={() =>
                  previewMatchedFile
                    ? downloadMatchedFile(previewMatchedFile)
                    : previewDoc && downloadDocument(previewDoc)
                }
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-muted/30 rounded-md border text-muted-foreground">
                Preview not available
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FilterResult({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm">{label}</span>
      {passed ? (
        <div className="flex items-center gap-1 text-green-600">
          <CheckCircle2 className="h-4 w-4" />
          <span className="text-sm font-medium">Pass</span>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-red-600">
          <XCircle className="h-4 w-4" />
          <span className="text-sm font-medium">Fail</span>
        </div>
      )}
    </div>
  );
}

function ScreeningStateIcon({
  state,
  result,
}: {
  state: "pending" | "completed" | "failed";
  result: string | null;
}) {
  if (state === "pending") {
    return (
      <div className="flex items-center gap-1 text-yellow-600">
        <Loader2 className="h-4 w-4 animate-spin" />{" "}
        {/* Changed to Loader2 to make it look active */}
        <span className="text-sm font-medium">Pending</span>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="flex items-center gap-1 text-red-600">
        <XCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Failed</span>
      </div>
    );
  }

  // For completed state, check the result
  const resultLower = result?.toLowerCase();

  if (resultLower === "inconclusive") {
    return (
      <div className="flex items-center gap-1 text-amber-500">
        <HelpCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Inconclusive</span>
      </div>
    );
  }

  const isPassed = resultLower === "pass" || resultLower === "yes";
  return (
    <div
      className={`flex items-center gap-1 ${isPassed ? "text-green-600" : "text-red-600"}`}
    >
      {isPassed ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <XCircle className="h-4 w-4" />
      )}
      <span className="text-sm font-medium">{isPassed ? "Pass" : "Fail"}</span>
    </div>
  );
}
