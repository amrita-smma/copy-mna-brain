import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
} from "lucide-react";
import { CompanyAnalysisSection } from "@/components/pipeline/CompanyAnalysisSection";
import { AICompanyCardLoading } from "@/components/pipeline/AICompanyCardLoading";
import FilePreview from "@/components/Files/FilePreview";
import { DealStage, L1Status } from "@/lib/types";
import { STAGE_LABELS } from "@/lib/constants";
import { formatDistanceToNow, format } from "date-fns";
import {
  addCompanyLink,
  addCompanyNote,
  deleteDealLink,
  deleteDealNote,
  getCompanyAssignees,
  getCompanyDetails,
  getScreenings,
  type UserSummary,
} from "@/lib/api/pipeline";
import { mergeFinancialsWithOverrides, getCompanyOverride } from "@/lib/companyOverrides";

const getStageLabel = (stage: string | null): string => {
  const key = (stage || "L0") as DealStage;
  return STAGE_LABELS[key] ?? key;
};

const websiteHref = (url: string) =>
  /^https?:\/\//i.test(url) ? url : `https://${url}`;
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

export interface CompanyData {
  id: string;
  target: string | null;
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
  state: "pending" | "completed" | "failed";
  result: string | null;
  remarks: string | null;
  created_at: string;
  criterias: {
    id: string;
    name: string;
    prompt: string;
  };
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
  company,
  open,
  onOpenChange,
  onUpdate,
}: CompanyDetailDialogProps) {
  const router = useRouter();
  const [stageHistory, setStageHistory] = useState<StageHistory[]>([]);
  const [notes, setNotes] = useState<DealNote[]>([]);
  const [links, setLinks] = useState<DealLink[]>([]);
  const [documents, setDocuments] = useState<DealDocument[]>([]);
  const [matchedFiles, setMatchedFiles] = useState<MatchedFile[]>([]);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [assignees, setAssignees] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Analysis states
  const [analysis, setAnalysis] = useState<CompanyAnalysis | null>(null);
  const [analysisGenerating, setAnalysisGenerating] = useState(false);

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

  // Scroll target for AI Company Card section in Overview
  const aiCardSectionRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<
    "overview" | "filters" | "attachments"
  >("overview");

  useEffect(() => {
    if (open) {
      fetchDetails();
      fetchAnalysis();
    }
  }, [open, company.id]);

  const fetchDetails = async () => {
    setLoading(true);
    try {
      const [data, assigneeList] = await Promise.all([
        getCompanyDetails(company.id),
        getCompanyAssignees(company.id).catch(() => [] as UserSummary[]),
      ]);
      setStageHistory(
        companyLogsToStageHistory((data.logs || []) as CompanyLogRow[]),
      );
      setNotes((data.notes || []) as DealNote[]);
      setLinks((data.links || []) as DealLink[]);
      setDocuments((data.documents || []) as DealDocument[]);
      setScreenings((data.screenings || []) as Screening[]);
      setMatchedFiles((data.matchedFiles || []) as MatchedFile[]);
      setAssignees(assigneeList);
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
        setAnalysis(data);
        if (data.status === "generating") {
          setAnalysisGenerating(true);
          pollAnalysis();
        }
      }
    } catch (error) {
      console.error("Error fetching analysis:", error);
    }
  };

  const pollAnalysis = () => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/company-analysis?companyId=${company.id}`,
        );
        if (res.ok) {
          const data = await res.json();
          setAnalysis(data);
          if (data.status !== "generating") {
            setAnalysisGenerating(false);
            clearInterval(interval);
          }
        }
      } catch {
        clearInterval(interval);
        setAnalysisGenerating(false);
      }
    }, 5000);
    setTimeout(() => {
      clearInterval(interval);
      setAnalysisGenerating(false);
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
    setActiveTab("overview");
    setTimeout(() => {
      aiCardSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 100);
    if (forceRegenerate || analysis?.status === "completed") {
      regenerateAnalysis();
    } else {
      generateAnalysis();
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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
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
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-2xl">
              <Building2 className="h-6 w-6" />
              {company.target || "Unknown Company"}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex items-center gap-2">
                {company.segment && (
                  <Badge variant="outline">{company.segment}</Badge>
                )}
                {company.watchlist_status && (
                  <Badge
                    variant={
                      company.watchlist_status === "Active"
                        ? "default"
                        : "secondary"
                    }
                  >
                    {company.watchlist_status}
                  </Badge>
                )}
                <Badge variant="secondary">
                  {getStageLabel(company.pipeline_stage)}
                </Badge>
              </div>
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={activeTab}
            onValueChange={(v) =>
              setActiveTab(v as "overview" | "filters" | "attachments")
            }
            className="w-full"
          >
            <div className="flex items-center justify-between gap-2">
              <TabsList className="grid grid-cols-3 flex-1">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="filters">L1 Filters</TabsTrigger>
                <TabsTrigger value="attachments">Attachments</TabsTrigger>
              </TabsList>
              <div className="flex items-center gap-2 shrink-0">
                {analysis?.status === "completed" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => {
                      onOpenChange(false);
                      router.push(`/pipeline/${company.id}/slides`);
                    }}
                  >
                    <Presentation className="h-4 w-4" />
                    Generate Slides
                  </Button>
                )}
                <Button
                  size="sm"
                  className="bg-accent hover:bg-accent/90 text-accent-foreground gap-2"
                  onClick={() => scrollToAICardAndRun()}
                  disabled={analysisGenerating}
                >
                  {analysisGenerating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {analysisGenerating
                    ? "Generating..."
                    : analysis?.status === "completed"
                      ? "Regenerate"
                      : "AI Company Card"}
                </Button>
              </div>
            </div>

            <TabsContent value="overview" className="space-y-4 mt-4">
              {/* AI Market Scanning Remarks - only for outbound deals */}
              {company.remarks &&
                company.source?.toLowerCase() === "outbound" && (
                  <Card className="border-purple-200 dark:border-purple-800/50 bg-gradient-to-br from-purple-50/50 to-violet-50/30 dark:from-purple-950/20 dark:to-violet-950/10">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2 text-purple-700 dark:text-purple-400">
                          <Sparkles className="h-5 w-5 text-purple-500" />
                          AI Market Scanning Remarks
                        </CardTitle>
                        <Badge
                          variant="secondary"
                          className="bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-700"
                        >
                          <Sparkles className="h-3 w-3 mr-1" />
                          AI Discovered
                        </Badge>
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
                        <p className="text-sm leading-relaxed">
                          {company.remarks}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                )}

              {/* Company Information */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Company Information
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-3">
                      <div>
                        <p className="text-sm text-muted-foreground">
                          Company Name
                        </p>
                        <p className="font-semibold text-lg">
                          {company.target || "Unknown"}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Website</p>
                        {company.website ? (
                          <a
                            href={websiteHref(company.website)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline text-sm inline-flex items-center gap-1"
                          >
                            {company.website}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            Not available
                          </span>
                        )}
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Segment</p>
                        <p className="font-medium">{company.segment || "-"}</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Status</p>
                        {company.watchlist_status ? (
                          <Badge
                            variant={
                              company.watchlist_status === "Active"
                                ? "default"
                                : "secondary"
                            }
                          >
                            {company.watchlist_status}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </div>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <p className="text-sm text-muted-foreground">
                          Pipeline Stage
                        </p>
                        <Badge
                          variant="outline"
                          className="text-base px-3 py-1"
                        >
                          {getStageLabel(company.pipeline_stage)}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">
                          Enterprise Value (2024)
                        </p>
                        <p className="font-semibold text-2xl text-primary">
                          {formatCurrency(company.ev_2024)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">
                          L1 Screening Result
                        </p>
                        {company.l1_screening_result ? (
                          <Badge
                            variant={
                              company.l1_screening_result.toLowerCase() ===
                              "pass"
                                ? "default"
                                : "destructive"
                            }
                          >
                            {company.l1_screening_result}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            Not screened yet
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4">
                    <p className="text-sm text-muted-foreground">PIC</p>
                    {assignees.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1.5 p-2">
                        {assignees.map((u) => (
                          <span
                            key={u.id}
                            className="inline-flex items-center rounded-full bg-muted px-2.5 py-2 text-xs font-medium text-foreground"
                          >
                            {u.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        Not assigned
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>

              <FinancialCharts
                financials={mergeFinancialsWithOverrides(company.id, company.financials_raw ?? [])}
                rawFinancials={company.financials_raw ?? []}
                companyId={company.id}
                hasOverrides={Boolean(getCompanyOverride(company.id))}
                onUpdate={onUpdate}
              />

              {/* AI Company Card Summary in Overview */}
              <div ref={aiCardSectionRef}>
                {analysisGenerating && !analysis?.business_overview ? (
                  <AICompanyCardLoading />
                ) : analysis?.status === "failed" ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 flex flex-col items-center justify-center gap-3">
                    <AlertCircle className="h-6 w-6 text-destructive" />
                    <div className="text-center">
                      <h3 className="text-base font-semibold text-destructive">
                        Analysis Failed
                      </h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        {analysis.error_message ||
                          "An error occurred while generating the analysis."}
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
                ) : analysis?.status === "completed" ? (
                  <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-accent" />
                        <h3 className="text-lg font-semibold text-accent">
                          AI Company Card
                        </h3>
                        <span className="text-xs text-muted-foreground ml-2">
                          AI-generated analysis
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {analysis.updated_at && (
                          <span className="text-xs text-muted-foreground">
                            {format(
                              new Date(analysis.updated_at),
                              "MMM d, yyyy HH:mm",
                            )}
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-accent hover:text-accent/80 text-xs h-7 px-2"
                          onClick={() => scrollToAICardAndRun()}
                          disabled={analysisGenerating}
                        >
                          {analysisGenerating ? (
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          ) : (
                            <Sparkles className="h-3 w-3 mr-1" />
                          )}
                          Regenerate
                        </Button>
                      </div>
                    </div>

                    {analysis.sources &&
                      Array.isArray(analysis.sources) &&
                      analysis.sources.length > 0 && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground">
                            Sources:
                          </span>
                          {(analysis.sources as AnalysisSource[]).map(
                            (source, idx) =>
                              source.url ? (
                                <a
                                  key={idx}
                                  href={source.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent/10 text-accent text-xs hover:bg-accent/20 transition-colors"
                                >
                                  <Globe className="h-3 w-3" />
                                  {source.title || new URL(source.url).hostname}
                                  <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                              ) : (
                                <span
                                  key={idx}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent/10 text-accent text-xs"
                                >
                                  {source.type === "database" ? (
                                    <FileText className="h-3 w-3" />
                                  ) : source.type === "inven" ? (
                                    <Search className="h-3 w-3" />
                                  ) : source.type === "files" ? (
                                    <FileText className="h-3 w-3" />
                                  ) : (
                                    <Globe className="h-3 w-3" />
                                  )}
                                  {source.title || source.type}
                                </span>
                              ),
                          )}
                        </div>
                      )}

                    <CompanyAnalysisSection
                      title="Business Overview"
                      description="Products, end markets, customer types, and geographic footprint."
                      icon={Building2}
                      content={analysis.business_overview || ""}
                      colorVariant="default"
                    />

                    <CompanyAnalysisSection
                      title="Business Model & Value Chain Summary"
                      description="How the company operates economically and its position in the value chain."
                      icon={Briefcase}
                      content={analysis.business_model_summary || ""}
                      colorVariant="teal"
                    />

                    <CompanyAnalysisSection
                      title="Key Takeaways"
                      description="The most important implications from the analysis (3-5 synthesized insights)."
                      icon={Lightbulb}
                      content={analysis.key_takeaways || ""}
                      colorVariant="blue"
                    />

                    <CompanyAnalysisSection
                      title="Investment Highlights"
                      description="Upside drivers linked to the company's business model and positioning."
                      icon={TrendingUp}
                      content={analysis.investment_highlights || ""}
                      colorVariant="green"
                    />

                    <CompanyAnalysisSection
                      title="Investment Risks"
                      description="Risks inherent to the company's business model and value chain."
                      icon={AlertTriangle}
                      content={analysis.investment_risks || ""}
                      colorVariant="amber"
                    />

                    <CompanyAnalysisSection
                      title="Diligence Priorities"
                      description="Critical unknowns to resolve before advancing investment (3-7 items)."
                      icon={Search}
                      content={analysis.diligence_priorities || ""}
                      colorVariant="rose"
                    />
                  </div>
                ) : null}
              </div>

              {/* Stage History */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Stage History
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {stageHistory.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No history yet
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {stageHistory.map((history) => (
                        <div
                          key={history.id}
                          className="flex items-center justify-between py-2 border-b last:border-0"
                        >
                          <div className="flex items-center gap-3">
                            <Badge variant="outline">
                              {getStageLabel(history.stage)}
                            </Badge>
                            <span className="text-sm text-muted-foreground">
                              {format(
                                new Date(history.entered_at),
                                "MMM d, yyyy HH:mm",
                              )}
                            </span>
                          </div>
                          <span className="text-sm font-medium">
                            {history.exited_at
                              ? formatDuration(history.duration_seconds)
                              : "Current"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="filters" className="space-y-4 mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">
                    L1 Screening Results
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {screenings.length > 0 ? (
                    <div className="space-y-3">
                      {screenings.map((screening) => (
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
                          {(() => {
                            const isPending = screenings.some(
                              (s) => s.state === "pending",
                            );
                            if (isPending) {
                              return <Badge variant="secondary">Pending</Badge>;
                            }

                            const passCount = screenings.filter(
                              (s) => s.result?.toLowerCase() === "pass",
                            ).length;
                            const failCount = screenings.filter(
                              (s) => s.result?.toLowerCase() === "fail",
                            ).length;
                            const inconclusiveCount = screenings.filter(
                              (s) => s.result?.toLowerCase() === "inconclusive",
                            ).length;

                            // Pass: minimum 3 pass AND maximum 1 fail
                            if (passCount >= 3 && failCount <= 1) {
                              return <Badge variant="default">Pass</Badge>;
                            }
                            // Failed: at least 1 fail (but didn't qualify as pass)
                            if (failCount >= 1) {
                              return <Badge variant="destructive">Fail</Badge>;
                            }
                            // Inconclusive: everything else
                            return (
                              <Badge
                                variant="secondary"
                                className="bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400"
                              >
                                Inconclusive
                              </Badge>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      No screenings have been run yet. Click &quot;Screen&quot;
                      from the L0 stage to run filters.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="attachments" className="space-y-4 mt-4">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
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

                {/* Files mentioning this company (from AI file dump) */}
                <Card className="lg:col-span-3">
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
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Document preview dialog */}
      <Dialog
        open={!!(previewDoc || previewMatchedFile)}
        onOpenChange={(open) => !open && handleClosePreview()}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
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
              <div className="flex h-[400px] w-full items-center justify-center bg-muted/30 rounded-md border">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : previewUrl && (previewDoc || previewMatchedFile) ? (
              <FilePreview
                url={previewUrl}
                fileName={
                  previewDoc?.file_name ?? previewMatchedFile?.file_name ?? ""
                }
                onDownload={() =>
                  previewMatchedFile
                    ? downloadMatchedFile(previewMatchedFile)
                    : previewDoc && downloadDocument(previewDoc)
                }
              />
            ) : (
              <div className="flex h-[400px] w-full items-center justify-center bg-muted/30 rounded-md border text-muted-foreground">
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
