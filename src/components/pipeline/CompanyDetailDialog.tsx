import { useState, useEffect, useRef } from "react";
import { trackPassRuleFromRows, trackScreeningVerdict } from "@/lib/screening/verdict";
import { useRouter } from "next/navigation";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";
import { CompanyContextCard } from "@/components/pipeline/CompanyContextCard";
import { CollapsibleSection } from "@/components/pipeline/CollapsibleSection";
import { CompanyTimeline } from "@/components/pipeline/CompanyTimeline";
import { useEventStream } from "@/hooks/useEventStream";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CompanyVotingTab from "@/components/pipeline/voting/CompanyVotingTab";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  TrendingUp,
  FileText,
  Link as LinkIcon,
  Upload,
  Plus,
  Loader2,
  Trash2,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertCircle,
  DollarSign,
  BarChart3,
  Expand,
  Sparkles,
  HelpCircle,
  Download,
  Eye,
  Presentation,
  BookOpen,
  X,
} from "lucide-react";
import { AICompanyCardLoading } from "@/components/pipeline/AICompanyCardLoading";
import DropDealDialog from "@/components/pipeline/DropDealDialog";
import CompanyOverviewSlide, {
  type AnalysisSectionKey,
  type EditSectionRequest,
} from "@/components/pipeline/CompanyOverviewSlide";
import FilePreview from "@/components/Files/FilePreview";
import { detectFileKind } from "@/lib/fileType";
import ExistingAttachmentPicker from "@/components/pipeline/ExistingAttachmentPicker";
import { cn } from "@/lib/utils";
import { useDealDocumentProcessingPoll } from "@/components/Files/DocumentInsightsPanel";
import {
  isAnalysisInProgress,
  type AnalysisJobStatus,
} from "@/lib/constants";
import { format } from "date-fns";
import {
  addCompanyLink,
  addCompanyNote,
  deleteDealLink,
  deleteDealNote,
  updateDealNote,
  getCompanies,
  getCompanyDetails,
  getTracks,
  updateCompany,
  type Track,
} from "@/lib/api/pipeline";
import { apiRequest } from "@/lib/api/client";
import { companyDisplayName, companyDisplayTitle, companyInitials } from "@/lib/companyDisplay";
import { isDealLive } from "@/lib/dealStatus";
import { usePipelineStages } from "@/hooks/usePipelineStages";

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
import CompanyDetailsTab from "@/components/pipeline/CompanyDetailsTab";
import { useCompanyInformationEditor } from "@/components/pipeline/useCompanyInformationEditor";
import { useDealStatusToggle } from "@/components/pipeline/useDealStatusToggle";
import type { Tables } from "@/lib/repositories";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { useChatActions } from "@/components/chat/ChatProvider";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { useLayoutControl } from "@/components/layout/LayoutControlContext";
import { useSetPageCompanyId } from "@/components/layout/PageContextProvider";

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
  /** Free-form markdown background shown on the Context tab. */
  context?: string | null;
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
  /** UUID of the user who sourced this company (references users.id). */
  entered_by?: string | null;
  /** Resolved display name for `entered_by`. */
  entered_by_name?: string | null;
  last_activity_at?: string | null;
  banker?: string | null;
  advisor?: string | null;
  /** NBO (Non-Binding Offer) due date (YYYY-MM-DD). */
  nbo_date?: string | null;
  /** Explicit "live process" override. Null ⇒ derive from advisor presence. */
  is_live?: boolean | null;
  doc_type?: string | null;
  stake?: string | null;
  deal_size?: string | null;
  workflow_status?: string | null;
  key_rationale?: string | null;
  company_focus?: string | null;
  comments?: string | null;
  matched_track_ids?: string[] | null;
  track_specific_variables?: Record<string, Record<string, string>> | null;
  slide_track_variable_ids?: string[] | null;
  // uuid FKs to users.id; `*_name` carries the resolved display name.
  deal_sponsor?: string | null;
  deal_sponsor_name?: string | null;
  deal_captain?: string | null;
  deal_captain_name?: string | null;
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
  structured_notes: string | null;
  tags: string[] | null;
  processing_status: string | null;
  is_featured: boolean;
}

/** File from the "files" table (Smart Files) where matched_companies contains this company */
interface MatchedFile {
  id: string;
  file_name: string;
  file_link: string;
  file_date: string | null;
  created_at: string;
  file_type: string | null;
  structured_notes: string | null;
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
    must_pass?: boolean;
  };
  track?: {
    id: string;
    title: string | null;
    min_optional_criteria_pass?: number | null;
  } | null;
}

type OverallScreeningStatus = "pending" | "pass" | "fail" | "inconclusive";

/**
 * Aggregate verdict for one track's screenings, under that track's rule
 * (must-pass criteria + minimum optional passes) — the same rule the AI
 * Screening panel and auto drop/promote use (src/lib/screening/verdict.ts).
 */
function overallScreeningStatus(list: Screening[]): OverallScreeningStatus {
  if (list.some((s) => s.state === "pending")) return "pending";
  return trackScreeningVerdict(list, trackPassRuleFromRows(list));
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
  status: AnalysisJobStatus;
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

/** Tabs this dialog can show. Mirrors the full-page view's tab set. */
export type CompanyDialogTab =
  | "overview"
  | "additional-context"
  | "timeline"
  | "details"
  | "filters"
  | "voting";

interface CompanyDetailDialogProps {
  company: CompanyData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: () => void;
  /** Tab to show when the dialog first opens. Defaults to "overview". */
  initialTab?: CompanyDialogTab;
  /** When true, the Company Information card opens in inline edit mode. */
  initialEditing?: boolean;
}

export default function CompanyDetailDialog({
  company: companyProp,
  open,
  onOpenChange,
  onUpdate,
  initialTab = "overview",
  initialEditing = false,
}: CompanyDetailDialogProps) {
  const pipelineStages = usePipelineStages();
  const getStageLabel = (stage: string | null): string =>
    pipelineStages.displayLabel(stage || "L0");
  const router = useRouter();
  const pipelineHref = useWorkspaceHref("/pipeline");
  const smartFilesHref = useWorkspaceHref("/smart-files");
  const { analyzeWithAI } = useChatActions();
  const { focusCopilot } = useLayoutControl();
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

  // Inline edit mode for the Company Information card (shared with the full
  // company page via CompanyDetailsTab).
  const [showDropDialog, setShowDropDialog] = useState(false);
  const editor = useCompanyInformationEditor<CompanyData>({
    company,
    stageLabel: getStageLabel,
    onStart: () => {
      if (tracks.length === 0) {
        getTracks()
          .then(setTracks)
          .catch((err) => console.error('Failed to load tracks:', err));
      }
    },
    onSaved: (refreshed) => {
      if (refreshed) setCompany((prev) => ({ ...prev, ...refreshed }));
      onUpdate();
    },
  });
  const { cancelEditing } = editor;
  const dealStatus = useDealStatusToggle({
    company,
    onDropRequested: () => setShowDropDialog(true),
    onRestored: (stage) => {
      setCompany((prev) => ({
        ...prev,
        status: 'active',
        dropped_at: null,
        dropped_reason: null,
        pipeline_stage: stage ?? prev.pipeline_stage,
      }));
      onUpdate();
    },
  });

  // The outbound deal's AI Market Scanning Remarks card. Rethrows so the card
  // keeps its editor open on a failed save.
  const saveRemarks = async (remarks: string | null) => {
    try {
      await updateCompany(company.id, { remarks });
      setCompany((prev) => ({ ...prev, remarks }));
      toast.success('Remarks updated');
      onUpdate();
    } catch (err: unknown) {
      console.error('Failed to save remarks:', err);
      toast.error(`Failed to save: ${(err as Error)?.message || 'Unknown error'}`);
      throw err;
    }
  };

  // Inline shareholding save from the Overview slide. Kept separate from the
  // Company Information card's edit mode so correcting ownership on the card
  // doesn't require entering (and saving) the whole form.
  const saveOwnership = async (ownership: string | null) => {
    try {
      await updateCompany(company.id, { ownership });
      setCompany((prev) => ({ ...prev, ownership }));
      toast.success('Shareholding updated');
      onUpdate();
    } catch (err: unknown) {
      console.error('Failed to save shareholding:', err);
      toast.error(`Failed to save: ${(err as Error)?.message || 'Unknown error'}`);
      // Rethrow so the slide keeps its editor open on the failed value rather
      // than closing over a write that never landed.
      throw err;
    }
  };

  // Analysis states
  const [analysis, setAnalysis] = useState<CompanyAnalysis | null>(null);
  const [analysisGenerating, setAnalysisGenerating] = useState(false);
  const [analysisCancelling, setAnalysisCancelling] = useState(false);
  const analysisPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The card section the copilot is currently rewriting (drives the slide's
  // busy overlay). Cleared when the new content lands or the wait times out.
  const [editingSectionKey, setEditingSectionKey] =
    useState<AnalysisSectionKey | null>(null);
  const sectionEditPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAnalysisPoll = () => {
    if (analysisPollRef.current) {
      clearInterval(analysisPollRef.current);
      analysisPollRef.current = null;
    }
  };

  const stopSectionEditPoll = () => {
    if (sectionEditPollRef.current) {
      clearInterval(sectionEditPollRef.current);
      sectionEditPollRef.current = null;
    }
  };

  // Right-click → "Edit with AI" on an Overview slide section. We hand the
  // copilot a tightly-scoped prompt (company_id + section key + current content
  // + the requested change) so it can rewrite ONLY that section via the
  // update_company_card_section tool, then poll the analysis row until the new
  // content lands and refresh the slide in place.
  const handleEditSection = (req: EditSectionRequest) => {
    const name = companyDisplayName(company, "this company");
    const previousContent = req.currentContent;
    const prompt = `Edit the "${req.sectionTitle}" section of the AI Company Card for ${name} (company_id: ${company.id}).

Current "${req.sectionTitle}" content:
"""
${previousContent || "(this section is currently empty)"}
"""

Requested change: ${req.instruction}

Rewrite ONLY this section to satisfy the request. Keep it factual and in the same concise markdown bullet style as the existing card. Then persist it by calling update_company_card_section with company_id "${company.id}", section "${req.sectionKey}", and the rewritten markdown as the content. Do not modify any other section.`;

    analyzeWithAI(prompt);
    focusCopilot();
    toast.info(`Sent to AI CoPilot — updating "${req.sectionTitle}"…`);

    setEditingSectionKey(req.sectionKey);
    stopSectionEditPoll();
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const data = await apiRequest<CompanyAnalysis>(
          `/api/company-analysis?companyId=${company.id}`,
        );
        const next = data?.[req.sectionKey];
        if (
          data &&
          typeof next === "string" &&
          next.trim() !== previousContent.trim()
        ) {
          setAnalysis(data);
          setEditingSectionKey(null);
          stopSectionEditPoll();
          toast.success(`Updated "${req.sectionTitle}"`);
          return;
        }
      } catch {
        // transient — keep polling until the cap
      }
      if (attempts >= 48) {
        // ~2 min cap; the copilot may still finish, but stop blocking the UI.
        stopSectionEditPoll();
        setEditingSectionKey(null);
      }
    }, 2500);
    sectionEditPollRef.current = interval;
  };

  // Form states
  const [newNote, setNewNote] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [newLinkTitle, setNewLinkTitle] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Featured Slide — a single highlighted PDF/PPTX (e.g. an external company
  // one-pager) shown full-width in its own tab. Backed by the same
  // deal_documents row as the Attachments tab's Documents section, just
  // flagged is_featured.
  const [isUploadingFeaturedSlide, setIsUploadingFeaturedSlide] = useState(false);
  const [isDraggingFeaturedSlide, setIsDraggingFeaturedSlide] = useState(false);
  const [featuredSlideUrl, setFeaturedSlideUrl] = useState<string | null>(null);
  const [loadingFeaturedSlide, setLoadingFeaturedSlide] = useState(false);
  const featuredDocument = documents.find((d) => d.is_featured) ?? null;
  // Existing attachments this company already has that could be featured
  // as-is, without re-uploading — offered via the search dropdown.
  const eligibleExistingAttachments = documents.filter((d) => {
    const kind = detectFileKind(d.file_name);
    return kind === "pdf" || kind === "pptx";
  });

  const [activeTab, setActiveTab] = useState<CompanyDialogTab>(initialTab);

  // Parent may change `initialTab` without remounting (same company, different open path).
  useEffect(() => {
    setActiveTab(initialTab);
  }, [company.id, initialTab]);

  // Re-fetch the authoritative company record whenever the dialog opens. The
  // `company` prop can be stale on reopen: some parents keep the dialog mounted
  // and hand back the same (pre-edit) object for an unchanged id, and some save
  // paths (e.g. track variables) update local state without refreshing the
  // parent. Pulling the DTO on open guarantees a reopen shows the saved values.
  const refreshCompany = async () => {
    try {
      const refreshed = await getCompanies({ id: company.id });
      if (refreshed) setCompany((prev) => ({ ...prev, ...refreshed }));
    } catch (error) {
      console.error("Error refreshing company:", error);
    }
  };

  useEffect(() => {
    if (open) {
      refreshCompany();
      fetchDetails();
      fetchAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company.id]);

  // While this dialog is open it — not the table behind it — is the record the
  // user means by "this company". Publish its id so the copilot passes it
  // verbatim to company_id tools instead of re-resolving a near-identical name.
  useSetPageCompanyId(open ? company.id : null);

  // When opened via the "Update" action, jump straight to the Details tab with
  // the Company Information card already in inline edit mode.
  useEffect(() => {
    if (open && initialEditing) {
      setActiveTab("details");
      editor.startEditing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company.id]);

  // Reset inline edit state on close. Some parents (e.g. MarketScreeningResults)
  // keep the dialog mounted between opens, so a lingering `isEditing` would make
  // it reopen stuck in edit mode.
  useEffect(() => {
    if (!open) cancelEditing();
  }, [open, cancelEditing]);

  // Load tracks once the dialog opens, to resolve the Deal Sponsor / Captain
  // (the matched Track's PIC).
  useEffect(() => {
    if (!open || tracks.length > 0) return;
    getTracks()
      .then(setTracks)
      .catch((err) => console.error("Failed to load tracks:", err));
  }, [open, tracks.length]);

  useEffect(() => {
    return () => {
      stopAnalysisPoll();
      stopSectionEditPoll();
    };
  }, []);

  const fetchDetails = async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
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
      if (!opts.silent) setLoading(false);
    }
  };

  useDealDocumentProcessingPoll(open ? documents : [], () => {
    void fetchDetails({ silent: true });
  });

  // Fetch a fresh signed preview URL whenever the featured document changes
  // (new upload, replace, or removal).
  useEffect(() => {
    if (!open || !featuredDocument) {
      setFeaturedSlideUrl(null);
      return;
    }
    let cancelled = false;
    setLoadingFeaturedSlide(true);
    apiRequest<{ url: string }>(
      `/api/deal-documents/download-url?id=${encodeURIComponent(featuredDocument.id)}&preview=true`,
    )
      .then((data) => {
        if (!cancelled) setFeaturedSlideUrl(data.url);
      })
      .catch((error) => {
        console.error("Error loading featured slide preview:", error);
        if (!cancelled) setFeaturedSlideUrl(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingFeaturedSlide(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, featuredDocument?.id]);

  // Live screening progress over SSE (replaces a 3s poll): connect only while
  // the dialog is open and a screening is pending; the stream pushes the full
  // list on every state change.
  const hasPendingScreening = screenings.some((s) => s.state === "pending");
  useEventStream<Screening[]>(
    open && company.id && hasPendingScreening
      ? `/api/screenings/stream?companyId=${encodeURIComponent(company.id)}`
      : null,
    (rows) => setScreenings(rows),
  );

  const fetchAnalysis = async () => {
    try {
      const data = await apiRequest<CompanyAnalysis | null>(
        `/api/company-analysis?companyId=${company.id}`,
      );
      if (data && data.status) {
        setAnalysis(data);
        if (isAnalysisInProgress(data.status)) {
          setAnalysisGenerating(true);
          pollAnalysis();
        }
        return;
      }
      // No analysis exists yet → leave it empty. Generation is triggered
      // manually via the "Generate AI Company Card" button.
    } catch (error) {
      // A 404 just means no analysis has been generated yet — not an error.
      if ((error as Error).message !== "No analysis found for this company") {
        console.error("Error fetching analysis:", error);
      }
    }
  };

  const pollAnalysis = () => {
    stopAnalysisPoll();
    const interval = setInterval(async () => {
      try {
        const data = await apiRequest<CompanyAnalysis>(
          `/api/company-analysis?companyId=${company.id}`,
        );
        setAnalysis(data);
        if (!isAnalysisInProgress(data.status)) {
          setAnalysisGenerating(false);
          stopAnalysisPoll();
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

  const generateAnalysis = async (force = false) => {
    setAnalysisGenerating(true);
    let dispatched = false;
    try {
      const data = await apiRequest<CompanyAnalysis & { runId?: string }>(
        "/api/company-analysis",
        {
          method: "POST",
          body: JSON.stringify({ companyId: company.id, force }),
        },
      );

      if (data.runId) {
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
    // Deliberately does NOT delete the existing card first: the run reads its
    // `created_at` and content to date-rank it against the company's
    // documents, so on a conflict the later-dated source wins.
    await generateAnalysis(true);
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
      await apiRequest("/api/company-analysis/cancel", {
        method: "POST",
        body: JSON.stringify({ companyId: company.id }),
      });
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

  const addNote = async (occurredAt?: string | null) => {
    if (!newNote.trim()) return;
    setIsSubmitting(true);
    try {
      await addCompanyNote(
        company.id,
        newNote,
        company.pipeline_stage || "L0",
        occurredAt,
      );
      setNewNote("");
      fetchDetails();
      toast.success("Note added");
    } catch (error: any) {
      toast.error("Failed to add note");
    } finally {
      setIsSubmitting(false);
    }
  };

  const addLink = async (occurredAt?: string | null) => {
    if (!newLinkUrl.trim()) return;
    setIsSubmitting(true);
    try {
      await addCompanyLink(
        company.id,
        newLinkUrl,
        newLinkTitle || undefined,
        company.pipeline_stage || "L0",
        occurredAt,
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

  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    occurredAt?: string | null,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsSubmitting(true);
    try {
      const contentType = file.type || "application/octet-stream";

      let uploadUrlData: { uploadUrl: string; key: string };
      try {
        uploadUrlData = await apiRequest(
          `/api/deal-documents/upload-url?dealId=${encodeURIComponent(company.id)}&fileName=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(contentType)}`,
        );
      } catch (apiErr: any) {
        throw new Error(
          apiErr?.message ||
            "Could not reach server. Check your connection and that the app is running.",
        );
      }
      const { uploadUrl, key } = uploadUrlData;

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

      try {
        await apiRequest("/api/deal-documents", {
          method: "POST",
          body: JSON.stringify({
            dealId: company.id,
            key,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || null,
            stage: company.pipeline_stage || "L0",
            createdAt: occurredAt ?? null,
          }),
        });
      } catch (apiErr: any) {
        throw new Error(
          apiErr?.message || "Could not register document. Check your connection.",
        );
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

  // Uploads (or replaces) this company's Featured Slide. Mirrors
  // handleFileUpload's presign → PUT → register flow, but flags the
  // registered document `featured: true` so the service supersedes any
  // previous featured slide instead of appending to it.
  const FEATURED_SLIDE_ACCEPT =
    ".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation";

  const uploadFeaturedSlideFile = async (file: File) => {
    const kind = detectFileKind(file.name);
    if (kind !== "pdf" && kind !== "pptx") {
      toast.error("Only PDF or PPTX files can be featured");
      return;
    }

    setIsUploadingFeaturedSlide(true);
    try {
      const contentType = file.type || "application/octet-stream";

      let uploadUrlData: { uploadUrl: string; key: string };
      try {
        uploadUrlData = await apiRequest(
          `/api/deal-documents/upload-url?dealId=${encodeURIComponent(company.id)}&fileName=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(contentType)}`,
        );
      } catch (apiErr: any) {
        throw new Error(
          apiErr?.message ||
            "Could not reach server. Check your connection and that the app is running.",
        );
      }
      const { uploadUrl, key } = uploadUrlData;

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

      try {
        await apiRequest("/api/deal-documents", {
          method: "POST",
          body: JSON.stringify({
            dealId: company.id,
            key,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || null,
            stage: company.pipeline_stage || "L0",
            featured: true,
          }),
        });
      } catch (apiErr: any) {
        throw new Error(
          apiErr?.message || "Could not register document. Check your connection.",
        );
      }

      fetchDetails();
      toast.success("Featured slide uploaded");
    } catch (error: unknown) {
      console.error("Featured slide upload error:", error);
      toast.error((error as Error)?.message || "Failed to upload featured slide");
    } finally {
      setIsUploadingFeaturedSlide(false);
    }
  };

  const handleFeaturedSlideUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void uploadFeaturedSlideFile(file);
  };

  const handleFeaturedSlideDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isUploadingFeaturedSlide) setIsDraggingFeaturedSlide(true);
  };

  const handleFeaturedSlideDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingFeaturedSlide(false);
  };

  const handleFeaturedSlideDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingFeaturedSlide(false);
    if (isUploadingFeaturedSlide) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFeaturedSlideFile(file);
  };

  const selectExistingAsFeaturedSlide = async (documentId: string) => {
    try {
      await apiRequest("/api/deal-documents/feature", {
        method: "POST",
        body: JSON.stringify({ dealId: company.id, documentId }),
      });
      fetchDetails();
      toast.success("Featured slide updated");
    } catch (error) {
      toast.error((error as Error)?.message || "Failed to set featured slide");
    }
  };

  const removeFeaturedSlide = async () => {
    if (!featuredDocument) return;
    try {
      await apiRequest(
        `/api/deal-documents/feature?dealId=${encodeURIComponent(company.id)}`,
        { method: "DELETE" },
      );
      fetchDetails();
      toast.success("Featured slide removed");
    } catch (error) {
      toast.error((error as Error)?.message || "Failed to remove featured slide");
    }
  };


  const editNote = async (noteId: string, content: string) => {
    try {
      await updateDealNote(noteId, content);
      // Awaited, unlike the other handlers here: the reading pane drops out of
      // edit mode as soon as this resolves, and would paint the pre-edit body
      // if the refetch were still in flight.
      await fetchDetails({ silent: true });
      toast.success("Note updated");
    } catch (error: unknown) {
      toast.error((error as Error)?.message || "Failed to update note");
      throw error;
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
      await apiRequest(`/api/deal-documents?id=${encodeURIComponent(doc.id)}`, {
        method: "DELETE",
      });
      fetchDetails();
      toast.success("Document deleted");
    } catch (error) {
      toast.error((error as Error)?.message || "Failed to delete document");
    }
  };

  const downloadDocument = async (doc: DealDocument) => {
    try {
      const data = await apiRequest<{ url: string }>(
        `/api/deal-documents/download-url?id=${encodeURIComponent(doc.id)}`,
      );
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

  // Signed preview URL for the timeline's inline preview. Errors propagate so
  // the preview can show its own "not available" state.
  const getDocumentPreviewUrl = async (doc: DealDocument) => {
    const data = await apiRequest<{ url: string }>(
      `/api/deal-documents/download-url?id=${encodeURIComponent(doc.id)}&preview=true`,
    );
    return data.url;
  };

  const downloadMatchedFile = async (file: MatchedFile) => {
    try {
      const data = await apiRequest<{ url: string }>(
        `/api/smart-files/${encodeURIComponent(file.id)}/download-url`,
      );
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

  const getMatchedFilePreviewUrl = async (file: MatchedFile) => {
    const data = await apiRequest<{ url: string }>(
      `/api/smart-files/${encodeURIComponent(file.id)}/download-url`,
    );
    return data.url;
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
              <div className="h-14 w-14 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center shrink-0 overflow-hidden border border-blue-200 dark:border-blue-700">
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
                  className="text-lg font-bold text-blue-600 dark:text-blue-300"
                  style={analysis?.logo_url ? { display: "none" } : undefined}
                >
                  {logoInitial}
                </span>
              </div>
              {/* Name + badges + description */}
              <div className="flex-1 min-w-0 pr-16">
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
                  {isDealLive(company) && (
                    <Badge
                      variant="outline"
                      className="text-xs border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                    >
                      Live process
                    </Badge>
                  )}
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
                        router.push(`${pipelineHref}/${company.id}/slides`);
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
                  {company.status !== "dropped" && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="company-detail-drop-button"
                      className="gap-1.5 h-7 text-xs text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setShowDropDialog(true)}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Drop Deal
                    </Button>
                  )}
                </div>
              </div>
            </div>
            {/* Control cluster, laid out right-to-left: new tab, full page,
                close (the close button is DialogContent's default). DOM order
                matches visual order so keyboard focus reads left-to-right. */}
            {/* Opens the full page in a new browser tab and leaves this dialog
                open — unlike the Expand button, which navigates this tab away.
                A plain anchor, so cmd/ctrl- and middle-click background the new
                tab natively. */}
            <a
              href={`${pipelineHref}/${company.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute right-16 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              title="Open in new tab"
            >
              <ExternalLink className="h-4 w-4" />
              <span className="sr-only">Open in new tab</span>
            </a>
            <button
              onClick={() => {
                onOpenChange(false);
                router.push(`${pipelineHref}/${company.id}`);
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
            onValueChange={(v) => setActiveTab(v as CompanyDialogTab)}
            className="flex flex-col flex-1 min-h-0"
          >
            {/* Tab bar pinned to top */}
            <div className="shrink-0 border-b bg-background">
              <TabsList className="w-full h-auto rounded-none bg-transparent p-0 grid grid-cols-6">
                <TabsTrigger
                  value="overview"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-accent data-[state=active]:text-accent data-[state=active]:bg-transparent py-3 text-sm font-medium"
                >
                  Overview
                </TabsTrigger>
                <TabsTrigger
                  value="additional-context"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-accent data-[state=active]:text-accent data-[state=active]:bg-transparent py-3 text-sm font-medium"
                >
                  Additional Context
                </TabsTrigger>
                <TabsTrigger
                  value="timeline"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-accent data-[state=active]:text-accent data-[state=active]:bg-transparent py-3 text-sm font-medium"
                >
                  Timeline
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
                  Pre-pipeline Filters
                </TabsTrigger>
                <TabsTrigger
                  value="voting"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-accent data-[state=active]:text-accent data-[state=active]:bg-transparent py-3 text-sm font-medium"
                >
                  Voting
                </TabsTrigger>
              </TabsList>
            </div>

            {/* A flex column so the Timeline tab can grow to the bottom of
                the modal; the other tabs size to their content as before. */}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 flex flex-col">
              <div className="h-2 shrink-0" />

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
                <CompanyOverviewSlide
                  company={company}
                  analysis={analysis}
                  tracks={tracks}
                  onEditSection={handleEditSection}
                  editingSectionKey={editingSectionKey}
                  onUpdateOwnership={saveOwnership}
                />
              )}
            </TabsContent>

            {/* Additional Context — the company's free-form markdown
                background and its Featured Slide, each in its own collapsible
                section so neither pushes the other off screen. The context
                feeds the AI Opinion, the company card / slide generation, and
                the agent read tools. */}
            <TabsContent value="additional-context" className="space-y-3 pb-4">
              <CollapsibleSection
                title="Context"
                description="Markdown background on this company. Read by the AI Opinion, the company card and slide generation, and the chat tools."
                icon={<BookOpen className="h-4 w-4" />}
              >
                <CompanyContextCard
                  companyId={company.id}
                  chrome="bare"
                  value={company.context}
                  variant="dialog"
                  onSaved={(context) =>
                    setCompany((prev) => ({ ...prev, context: context || null }))
                  }
                />
              </CollapsibleSection>

              {/* Featured Slide — a highlighted PDF/PPTX one-pager (e.g. an
                  external company card) shown full-width. Collapsed by
                  default: the viewer is 70vh tall, and the documents it reads
                  land after this first renders, so an `open` derived from them
                  would pop the section open mid-read. The current slide's name
                  goes in the header instead. */}
              <CollapsibleSection
                title="Featured Slide"
                description={
                  featuredDocument
                    ? `Currently featuring ${featuredDocument.file_name}.`
                    : "Highlight a company one-pager (PDF or PPTX) full-width on this card."
                }
                icon={<Presentation className="h-4 w-4" />}
                defaultOpen={false}
              >
                <div
                  className={cn(
                    "space-y-3 rounded-lg transition-shadow",
                    isDraggingFeaturedSlide && "ring-2 ring-primary ring-offset-2",
                  )}
                  onDragOver={handleFeaturedSlideDragOver}
                  onDragLeave={handleFeaturedSlideDragLeave}
                  onDrop={handleFeaturedSlideDrop}
                >
                  <div className="flex items-center justify-end gap-1 flex-wrap">
                    {eligibleExistingAttachments.length > 0 && (
                      <ExistingAttachmentPicker
                        documents={eligibleExistingAttachments}
                        onSelect={selectExistingAsFeaturedSlide}
                        selectedId={featuredDocument?.id ?? null}
                        disabled={isUploadingFeaturedSlide}
                      />
                    )}
                    <Label htmlFor="featured-slide-file-input" className="cursor-pointer">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={isUploadingFeaturedSlide}
                        asChild
                      >
                        <span>
                          {isUploadingFeaturedSlide ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Upload className="h-3.5 w-3.5" />
                          )}
                          {featuredDocument ? "Replace" : "Upload"}
                        </span>
                      </Button>
                    </Label>
                    {featuredDocument && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={removeFeaturedSlide}
                        title="Remove featured slide"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                  <Input
                    id="featured-slide-file-input"
                    type="file"
                    accept={FEATURED_SLIDE_ACCEPT}
                    className="hidden"
                    onChange={handleFeaturedSlideUpload}
                    disabled={isUploadingFeaturedSlide}
                  />
                  {featuredDocument ? (
                    <div className="h-[70vh] w-full">
                      {loadingFeaturedSlide ? (
                        <div className="flex h-full w-full items-center justify-center bg-muted rounded-md border">
                          <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        </div>
                      ) : featuredSlideUrl ? (
                        <FilePreview
                          url={featuredSlideUrl}
                          fileName={featuredDocument.file_name}
                          fileKey={featuredDocument.file_path}
                          onDownload={() => downloadDocument(featuredDocument)}
                        />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted rounded-md border text-sm text-muted-foreground">
                          <p>Preview not available</p>
                          <Button variant="outline" size="sm" onClick={() => void downloadDocument(featuredDocument)}>
                            <Download className="h-4 w-4 mr-2" />
                            Download
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <Label htmlFor="featured-slide-file-input" className="cursor-pointer">
                        <div
                          className={cn(
                            "border-2 border-dashed rounded-lg bg-muted p-10 text-center transition-colors",
                            isDraggingFeaturedSlide ? "border-primary bg-primary/5" : "hover:border-primary",
                          )}
                        >
                          <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                          <p className="text-sm text-muted-foreground">
                            Click to upload, or drag and drop a PDF or PPTX to feature it here
                          </p>
                        </div>
                      </Label>
                      {isUploadingFeaturedSlide && (
                        <div className="flex items-center justify-center gap-2 mt-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Uploading…
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </CollapsibleSection>
            </TabsContent>

            {/* Timeline — every dated thing that happened on the deal (stage
                changes, notes, uploads, links, Smart File references) on one
                horizontal rail, plus the manual-entry composer that replaced
                the Attachments tab. */}
            {/* `data-[state=active]:flex`, not `flex`: an inactive TabsContent
                stays mounted with the `hidden` attribute, which a plain `flex`
                display would override. */}
            <TabsContent
              value="timeline"
              className="pb-4 flex-1 flex-col data-[state=active]:flex lg:min-h-0"
            >
              <CompanyTimeline
                variant="dialog"
                notes={notes}
                documents={documents}
                links={links}
                matchedFiles={matchedFiles}
                stageHistory={stageHistory}
                getStageLabel={getStageLabel}
                newNote={newNote}
                onNewNoteChange={setNewNote}
                onAddNote={addNote}
                newLinkUrl={newLinkUrl}
                newLinkTitle={newLinkTitle}
                onNewLinkUrlChange={setNewLinkUrl}
                onNewLinkTitleChange={setNewLinkTitle}
                onAddLink={addLink}
                onUploadFile={handleFileUpload}
                isSubmitting={isSubmitting}
                onEditNote={editNote}
                onDeleteNote={deleteNote}
                onDeleteLink={deleteLink}
                onDownloadDocument={downloadDocument}
                getDocumentPreviewUrl={getDocumentPreviewUrl}
                onDeleteDocument={deleteDocument}
                onDownloadMatchedFile={downloadMatchedFile}
                getMatchedFilePreviewUrl={getMatchedFilePreviewUrl}
                onOpenMatchedFile={(file) =>
                  router.push(
                    `${smartFilesHref}?highlight=${encodeURIComponent(file.id)}`,
                  )
                }
              />
            </TabsContent>

            <TabsContent value="details" className="pb-4">
              <CompanyDetailsTab
                company={company}
                tracks={tracks}
                editor={editor}
                onDealStatusChange={(next) => void dealStatus.change(next)}
                dealStatusBusy={dealStatus.busy}
                onSaveRemarks={saveRemarks}
                onFinancialsUpdate={onUpdate}
                onTrackVariablesSaved={(next) =>
                  setCompany((prev) => ({ ...prev, track_specific_variables: next }))
                }
                onSlideVariablesSaved={(next) =>
                  setCompany((prev) => ({ ...prev, slide_track_variable_ids: next }))
                }
                stageHistory={stageHistory}
                analysis={analysis}
                analysisGenerating={analysisGenerating}
                analysisCancelling={analysisCancelling}
                onCancelAnalysis={cancelAnalysis}
                onRetryAnalysis={() => scrollToAICardAndRun(true)}
                active={open}
              />
            </TabsContent>

            <TabsContent value="filters" className="space-y-4 pb-4">
              {screenings.length > 0 ? (
                groupScreeningsByTrack(screenings).map((group) => (
                  <Card key={group.key}>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        Pre-pipeline Filter Results
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
                                {screening.criterias?.must_pass && (
                                  <Badge variant="secondary" className="text-xs">
                                    Must-pass
                                  </Badge>
                                )}
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
                      Pre-pipeline Filter Results
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground text-sm">
                      No screenings have been run yet. Use Scan now, or Run AI
                      Screening on the company in Pending Confirmation.
                    </p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* Voting — Investment-Committee round on this company. */}
            <TabsContent value="voting" className="pb-4">
              <CompanyVotingTab
                companyId={company.id}
                variant="dialog"
                featuredSlide={{
                  document: featuredDocument,
                  url: featuredSlideUrl,
                  loading: loadingFeaturedSlide,
                  onDownload: async () => {
                    if (featuredDocument) await downloadDocument(featuredDocument);
                  },
                }}
              />
            </TabsContent>

            </div>{/* end scrollable content */}
          </Tabs>
        </DialogContent>
      </Dialog>

      <DropDealDialog
        open={showDropDialog}
        onOpenChange={setShowDropDialog}
        dealId={company.id}
        companyName={companyDisplayName(company, "this company")}
        currentStage={company.pipeline_stage}
        onSuccess={(reason) => {
          setCompany((prev) => ({
            ...prev,
            status: "dropped",
            dropped_at: new Date().toISOString(),
            dropped_reason: reason,
          }));
          onUpdate();
        }}
      />
      {dealStatus.restoreStageDialog}
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
