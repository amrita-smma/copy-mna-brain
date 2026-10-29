'use client';

import { useState, useEffect } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import { CompanyContextCard } from '@/components/pipeline/CompanyContextCard';
import { CollapsibleSection } from '@/components/pipeline/CollapsibleSection';
import { CompanyTimeline } from '@/components/pipeline/CompanyTimeline';
import { useSetPageCompanyId, useSetPageDetail } from '@/components/layout/PageContextProvider';
import posthog from 'posthog-js';
import { useChatActions } from '@/components/chat/ChatProvider';
import { useIsMobile } from '@/hooks/use-mobile';
import { useQuery } from '@tanstack/react-query';
import { getWorkspaceSlugFromUrl } from '@/lib/api/client';
import { getScreenings } from '@/lib/api/pipeline';
import { useLiveRefetchInterval } from '@/components/live/LiveEventsProvider';
import { LIVE_TOPICS } from '@/lib/live/topics';
import { companyDisplayName, companyDisplayTitle, companyInitials } from '@/lib/companyDisplay';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  ArrowLeft,
  FileText,
  Link as LinkIcon,
  Plus,
  Loader2,
  AlertCircle,
  BookOpen,
  Sparkles,
  Eye,
  Presentation,
  X,
  MoreVertical,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import CompanyVotingTab from '@/components/pipeline/voting/CompanyVotingTab';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CompanyCardNotGenerated } from '@/components/pipeline/CompanyCardNotGenerated';
import {
  hasCompanyCard,
  useCompanyCardGeneration,
} from '@/components/pipeline/useCompanyCardGeneration';
import { useCompanyCardSectionEdit } from '@/components/pipeline/useCompanyCardSectionEdit';
import CompanyOverviewSlide, {
  type EditSectionRequest,
} from '@/components/pipeline/CompanyOverviewSlide';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
import FeaturedSlideSection from '@/components/pipeline/featured/FeaturedSlideSection';
import { useFeaturedSlide } from '@/components/pipeline/featured/useFeaturedSlide';
import { useDealDocumentProcessingPoll } from '@/components/Files/DocumentInsightsPanel';
import { usePipelineStages } from '@/hooks/usePipelineStages';
import { format } from 'date-fns';
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
} from '@/lib/api/pipeline';
import CompanyDetailsTab from '@/components/pipeline/CompanyDetailsTab';
import { useCompanyInformationEditor } from '@/components/pipeline/useCompanyInformationEditor';
import { useDealStatusToggle } from '@/components/pipeline/useDealStatusToggle';
import DropDealDialog from '@/components/pipeline/DropDealDialog';
import { PrePipelineFilterResults, type PrePipelineScreening as Screening } from '@/components/pipeline/PrePipelineFilterResults';


interface CompanyData {
  id: string;
  target: string | null;
  project_name?: string | null;
  segment: string | null;
  pipeline_stage: string | null;
  website: string | null;
  geography: string | null;
  ownership: string | null;
  comments: string | null;
  company_focus: string | null;
  // Revenue fields (USD Mn)
  revenue_2021_usd_mn: number | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  // EBITDA fields (USD Mn)
  ebitda_2021_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  // EV/Valuation
  ev_2024: number | null;
  // L1 screening results
  l1_screening_result: string | null;
  l1_rationale: string | null;
  l1_vision_fit: string | null;
  l1_priority_geo_flag: string | null;
  l1_ev_below_threshold: string | null;
  l1_revenue_no_consecutive_drop_usd: string | null;
  // EBITDA margin
  ebitda_margin_2021: number | null;
  ebitda_margin_2022: number | null;
  ebitda_margin_2023: number | null;
  ebitda_margin_2024: number | null;
  // AI Market Screening Remarks
  remarks?: string | null;
  /** Free-form markdown background shown on the Context tab. */
  context?: string | null;
  created_at: string | null;
  updated_at: string | null;
  source: string | null;
  status?: string | null;
  dropped_reason?: string | null;
  dropped_at?: string | null;
  promoted_reasons?: string | null;
  deal_type?: string | null;
  entered_by?: string | null;
  /** Resolved display name for `entered_by` (joined server-side in the DTO). */
  entered_by_name?: string | null;
  last_activity_at?: string | null;
  banker?: string | null;
  advisor?: string | null;
  doc_type?: string | null;
  stake?: string | null;
  deal_size?: string | null;
  workflow_status?: string | null;
  key_rationale?: string | null;
  nbo_date?: string | null;
  is_live?: boolean | null;
  matched_track_ids?: string[] | null;
  track_specific_variables?: Record<string, Record<string, string>> | null;
  slide_track_variable_ids?: string[] | null;
  deal_sponsor?: string | null;
  deal_captain?: string | null;
  deal_sponsor_name?: string | null;
  // Why the sponsor was auto-assigned (MB-830), while it still is the auto pick.
  deal_sponsor_auto_reason?: string | null;
  deal_captain_name?: string | null;
  financials_raw?: import('@/lib/repositories').Tables<'company_financials'>[];
}

/** Minimal company_logs row used to build stage history */
interface CompanyLogRow {
  id: string;
  action: string;
  created_at: string | null;
  comments?: string | null;
}

interface StageHistory {
  id: string;
  stage: string;
  entered_at: string;
  exited_at: string | null;
  duration_seconds: number | null;
  reason: string | null;
}

/** Parse company_logs actions into stage + entered_at. Returns null if not a stage-related action. */
function stageFromLogAction(action: string, created_at: string): { stage: string; entered_at: string } | null {
  const at = created_at || new Date().toISOString();
  if (action === 'ADDED_TO_PIPELINE') return { stage: 'L0', entered_at: at };
  if (action === 'PROMOTED_FROM_MARKET_SCREENING_TO_L0') return { stage: 'L0', entered_at: at };
  const fromTo = /^PROMOTED_FROM_(.+)_TO_(.+)$/.exec(action);
  if (fromTo) return { stage: fromTo[2], entered_at: at };
  const to = /^PROMOTED_TO_(.+)$/.exec(action);
  if (to) return { stage: to[1], entered_at: at };
  return null;
}

/** Build StageHistory[] from company_logs rows (ordered by created_at asc). */
function companyLogsToStageHistory(logs: CompanyLogRow[]): StageHistory[] {
  const entries: { id: string; stage: string; entered_at: string; reason: string | null }[] = [];
  for (const log of logs) {
    const parsed = stageFromLogAction(log.action, log.created_at ?? '');
    if (parsed) {
      entries.push({
        id: log.id,
        stage: parsed.stage,
        entered_at: parsed.entered_at,
        reason: log.comments?.trim() || null,
      });
    }
  }
  const result: StageHistory[] = [];
  for (let i = 0; i < entries.length; i++) {
    const curr = entries[i];
    const next = entries[i + 1];
    const exited_at = next ? next.entered_at : null;
    const duration_seconds =
      exited_at && curr.entered_at
        ? (new Date(exited_at).getTime() - new Date(curr.entered_at).getTime()) / 1000
        : null;
    result.push({
      id: curr.id,
      stage: curr.stage,
      entered_at: curr.entered_at,
      exited_at,
      duration_seconds,
      reason: curr.reason,
    });
  }
  return result.reverse(); // newest first for display
}

interface DealNote {
  id: string;
  content: string;
  stage: string;
  created_at: string | null;
}

interface DealLink {
  id: string;
  url: string;
  title: string | null;
  stage: string;
  created_at: string | null;
  is_featured: boolean;
}

interface DealDocument {
  id: string;
  file_name: string;
  file_path: string;
  stage: string;
  created_at: string | null;
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
  structured_notes: string | null;
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

/** Tab values, mirrored in the `?tab=` query param so back/forward restores one. */
const TAB_VALUES = [
  'overview',
  'additional-context',
  'timeline',
  'company-card',
  'filters',
  'voting',
] as const;
type CompanyTab = (typeof TAB_VALUES)[number];
const DEFAULT_TAB: CompanyTab = 'overview';

/**
 * Tabs that no longer exist, pointed at whatever absorbed them — so a link,
 * bookmark or history entry from before the merge still lands on the content
 * it was aimed at instead of silently falling back to Overview.
 */
const LEGACY_TABS: Record<string, CompanyTab> = {
  context: 'additional-context',
  'featured-slide': 'additional-context',
  attachments: 'timeline',
};

const isCompanyTab = (value: string | null): value is CompanyTab =>
  value !== null && (TAB_VALUES as readonly string[]).includes(value);

/** Resolve a `?tab=` value (current or legacy) to the tab to show. */
const resolveTab = (value: string | null): CompanyTab => {
  if (isCompanyTab(value)) return value;
  if (value && LEGACY_TABS[value]) return LEGACY_TABS[value];
  return DEFAULT_TAB;
};

export default function CompanyDetail() {
  const params = useParams();
  const router = useRouter();
  const { analyzeWithAI } = useChatActions();
  const { focusCopilot } = useLayoutControl();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const isMobile = useIsMobile();
  // This view serves two routes: `/companies/<id>` (a company on its own, where
  // chat and search send you) and `/pipeline/<dealId>` (the same company read as
  // a deal in the funnel). Both segments carry the company id — the pipeline
  // route's is named `dealId` for historical reasons.
  const companyId = (params.id ?? params.dealId) as string;
  const pipelineHref = useWorkspaceHref('/pipeline');
  const chatHref = useWorkspaceHref('/chat');
  const smartFilesHref = useWorkspaceHref('/smart-files');
  const returnTo = searchParams.get('from') || pipelineHref;

  // The active tab lives in the URL (`?tab=`) so each switch is a history entry
  // and Back returns to the tab you came from. Local state mirrors it so the
  // switch renders immediately instead of waiting on the navigation.
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<CompanyTab>(resolveTab(tabParam));

  // Back/forward (and any external link) changes the param, not the state.
  useEffect(() => {
    setActiveTab(resolveTab(tabParam));
  }, [tabParam]);

  // router.push — not the history.replaceState trick used for URL-bar-only sync
  // in SmartFiles/WorkforceTasks. That deliberately avoids a history entry;
  // here the entry is the whole point, and this matches Pipeline's `?stage=`.
  const handleTabChange = (value: string) => {
    if (!isCompanyTab(value)) return;
    setActiveTab(value);
    const next = new URLSearchParams(searchParams.toString());
    next.set('tab', value);
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const [company, setCompany] = useState<CompanyData | null>(null);
  const pipelineStages = usePipelineStages();
  const getStageLabel = (stage: string | null): string =>
    pipelineStages.displayLabel(stage || 'L0');

  // Name the deal on screen for the copilot, so "this company" resolves without
  // the user having to type the name — and so the agent can pass the id straight
  // to its lookup tools instead of fuzzy-matching a name.
  useSetPageDetail(
    company
      ? [
          `Deal open: ${companyDisplayName(company, 'unnamed company')}`,
          `(company id ${company.id}, stage ${company.pipeline_stage ?? 'unknown'},`,
          `status ${company.status ?? 'unknown'}).`,
          `Viewing the "${activeTab}" tab.`,
        ].join(' ')
      : null,
  );

  // Hand the copilot the deal's id as its own context field, so tools that take
  // a company_id get it verbatim instead of fuzzy-matching a name — which picks
  // the wrong record when two companies share a near-identical name.
  useSetPageCompanyId(company?.id ?? null);

  // "Analyze using AI" sends the prompt to the shared copilot, then surfaces it.
  // On mobile the copilot lives on the Chat tab (no side pane), so jump there to
  // watch the response stream; on desktop reveal the copilot pane instead.
  const handleAnalyzeWithAI = () => {
    analyzeWithAI(
      `Analyze ${companyDisplayName(company, 'this company')} and provide insights about it as a potential deal.`,
    );
    if (isMobile) {
      posthog.capture('mobile_ai_analysis_opened', { label: 'Analyze using AI' });
      router.push(chatHref);
    } else {
      focusCopilot();
    }
  };
  const [stageHistory, setStageHistory] = useState<StageHistory[]>([]);
  const [notes, setNotes] = useState<DealNote[]>([]);
  const [links, setLinks] = useState<DealLink[]>([]);
  const [documents, setDocuments] = useState<DealDocument[]>([]);
  const [matchedFiles, setMatchedFiles] = useState<MatchedFile[]>([]);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const card = useCompanyCardGeneration<CompanyAnalysis>(companyId);
  const {
    analysis,
    setAnalysis,
    generating: analysisGenerating,
    cancelling: analysisCancelling,
    regenerate: regenerateAnalysis,
    cancel: cancelAnalysis,
  } = card;
  const generateAnalysis = () => card.generate();
  // The card section the copilot is currently rewriting (drives the slide's
  // busy overlay). Cleared when the new content lands or the wait times out.
  const { editingSectionKey, watch: watchSectionEdit } =
    useCompanyCardSectionEdit<CompanyAnalysis>(companyId, setAnalysis);

  // Right-click → "Edit with AI" on an Overview slide section. Hands the copilot
  // a tightly-scoped prompt (company_id + section + current content + change) so
  // it rewrites ONLY that section via update_company_card_section, then watches
  // the analysis row until the new content lands and refreshes the slide in place.
  const handleEditSection = (req: EditSectionRequest) => {
    if (!companyId) return;
    const name = companyDisplayName(company, 'this company');
    const previousContent = req.currentContent;
    const prompt = `Edit the "${req.sectionTitle}" section of the AI Company Card for ${name} (company_id: ${companyId}).

Current "${req.sectionTitle}" content:
"""
${previousContent || '(this section is currently empty)'}
"""

Requested change: ${req.instruction}

Rewrite ONLY this section to satisfy the request. Keep it factual and in the same concise markdown bullet style as the existing card. Then persist it by calling update_company_card_section with company_id "${companyId}", section "${req.sectionKey}", and the rewritten markdown as the content. Do not modify any other section.`;

    analyzeWithAI(prompt);
    if (isMobile) {
      router.push(chatHref);
    } else {
      focusCopilot();
    }
    toast.info(`Sent to AI CoPilot — updating "${req.sectionTitle}"…`);

    watchSectionEdit(req);
  };

  const [newNote, setNewNote] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);



  // Inline edit mode for the Company Information card (shared with the
  // pipeline dialog via CompanyDetailsTab).
  const editor = useCompanyInformationEditor<CompanyData>({
    company,
    stageLabel: getStageLabel,
    onSaved: (refreshed) => {
      if (refreshed) setCompany((prev) => (prev ? { ...prev, ...refreshed } : refreshed));
    },
  });

  // Deal Status (Active/Dropped). Dropping and reactivating are immediate
  // side-effecting actions (their own log entry, optional note), not fields
  // saved with the Company Information form.
  const [showDropDialog, setShowDropDialog] = useState(false);
  const dealStatus = useDealStatusToggle({
    company,
    onDropRequested: () => setShowDropDialog(true),
    onRestored: (stage) =>
      setCompany((prev) =>
        prev
          ? {
              ...prev,
              status: 'active',
              dropped_at: null,
              dropped_reason: null,
              pipeline_stage: stage ?? prev.pipeline_stage,
            }
          : prev,
      ),
  });

  // The outbound deal's AI Market Scanning Remarks card. Rethrows so the card
  // keeps its editor open on a failed save.
  const saveRemarks = async (remarks: string | null) => {
    if (!company) return;
    try {
      await updateCompany(company.id, { remarks });
      setCompany((prev) => (prev ? { ...prev, remarks } : prev));
      toast.success('Remarks updated');
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
    if (!company) return;
    try {
      await updateCompany(company.id, { ownership });
      setCompany((prev) => (prev ? { ...prev, ownership } : prev));
      toast.success('Shareholding updated');
    } catch (err: unknown) {
      console.error('Failed to save shareholding:', err);
      toast.error(`Failed to save: ${(err as Error)?.message || 'Unknown error'}`);
      // Rethrow so the slide keeps its editor open on the failed value rather
      // than closing over a write that never landed.
      throw err;
    }
  };

  useEffect(() => {
    if (companyId) {
      fetchCompany();
    }
  }, [companyId]);

  // Load tracks to resolve the Deal Sponsor / Captain (the matched Track's PIC).
  useEffect(() => {
    getTracks()
      .then(setTracks)
      .catch((err) => console.error('Failed to load tracks:', err));
  }, []);

  const fetchCompany = async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const data = await getCompanies({ id: companyId });
      if (data) {
        setCompany(data as CompanyData);
        if (!opts.silent) {
          fetchDetails((data as CompanyData).target?.trim() || null);
        }
      }
    } catch (error) {
      console.error('Error fetching company:', error);
      toast.error('Failed to load company details');
    } finally {
      if (!opts.silent) setLoading(false);
    }
  };

  const fetchDetails = async (companyTarget?: string | null) => {
    if (!companyId) return;
    try {
      const data = await getCompanyDetails(companyId);
      setStageHistory(companyLogsToStageHistory((data.logs || []) as CompanyLogRow[]));
      setNotes((data.notes || []) as DealNote[]);
      setLinks((data.links || []) as DealLink[]);
      setDocuments((data.documents || []) as DealDocument[]);
      setMatchedFiles((data.matchedFiles || []) as MatchedFile[]);
      setScreenings((data.screenings || []) as Screening[]);
    } catch (error) {
      console.error('Error fetching details:', error);
    }
  };

  useDealDocumentProcessingPoll(documents, () => {
    void fetchDetails();
  });

  // Live screening progress: only while a screening is pending, re-read the
  // company's screenings whenever the `screenings` live topic fires (with a
  // slow fallback poll — 3s, the old cadence, only while the stream is down).
  const hasPendingScreening = screenings.some((s) => s.state === 'pending');
  const liveRefetchInterval = useLiveRefetchInterval(3_000);
  const { data: liveScreenings } = useQuery({
    queryKey: [LIVE_TOPICS.screenings, getWorkspaceSlugFromUrl(), companyId],
    queryFn: () => getScreenings({ companyId }) as Promise<Screening[]>,
    enabled: Boolean(companyId) && hasPendingScreening,
    refetchInterval: liveRefetchInterval,
  });
  useEffect(() => {
    if (liveScreenings) setScreenings(liveScreenings);
  }, [liveScreenings]);

  const addNote = async (occurredAt?: string | null) => {
    if (!newNote.trim() || !company) return;
    setIsSubmitting(true);
    try {
      await addCompanyNote(company.id, newNote, company.pipeline_stage || 'L0', occurredAt);
      setNewNote('');
      await fetchDetails();
      toast.success('Note added');
    } catch (error: unknown) {
      console.error('Add note error:', error);
      toast.error((error as Error)?.message || 'Failed to add note');
    } finally {
      setIsSubmitting(false);
    }
  };

  const addLink = async (occurredAt?: string | null) => {
    if (!newLinkUrl.trim() || !company) return;
    setIsSubmitting(true);
    try {
      await addCompanyLink(
        company.id,
        newLinkUrl,
        newLinkTitle || undefined,
        company.pipeline_stage || 'L0',
        occurredAt,
      );
      setNewLinkUrl('');
      setNewLinkTitle('');
      await fetchDetails();
      toast.success('Link added');
    } catch (error: unknown) {
      console.error('Add link error:', error);
      toast.error((error as Error)?.message || 'Failed to add link');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    occurredAt?: string | null,
  ) => {
    const file = e.target.files?.[0];
    if (!file || !company) return;

    setIsSubmitting(true);
    try {
      const contentType = file.type || 'application/octet-stream';

      let uploadUrlRes: Response;
      try {
        uploadUrlRes = await fetch(
          `/api/deal-documents/upload-url?dealId=${encodeURIComponent(company.id)}&fileName=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(contentType)}`
        );
      } catch (netErr) {
        throw new Error('Could not reach server. Check your connection and that the app is running.');
      }
      const uploadUrlText = await uploadUrlRes.text();
      let uploadUrlData: { success?: boolean; error?: string; data?: { uploadUrl: string; key: string } };
      try {
        uploadUrlData = JSON.parse(uploadUrlText);
      } catch {
        throw new Error(uploadUrlRes.ok ? 'Invalid server response' : `Get upload URL failed: ${uploadUrlRes.status}`);
      }
      if (!uploadUrlData.success || !uploadUrlData.data) {
        throw new Error(uploadUrlData.error || 'Failed to get upload URL');
      }
      const { uploadUrl, key } = uploadUrlData.data;

      let s3Res: Response;
      try {
        s3Res = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': contentType },
        });
      } catch (netErr) {
        throw new Error(
          'Upload to storage failed (network error). Ensure AWS_S3_BUCKET matches your bucket and the bucket has CORS enabled for this origin.'
        );
      }
      if (!s3Res.ok) throw new Error('Failed to upload file to storage');

      let registerRes: Response;
      try {
        registerRes = await fetch('/api/deal-documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dealId: company.id,
            key,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || null,
            stage: company.pipeline_stage || 'L0',
            createdAt: occurredAt ?? null,
          }),
        });
      } catch (netErr) {
        throw new Error('Could not register document. Check your connection.');
      }
      const registerText = await registerRes.text();
      let registerData: { success?: boolean; error?: string };
      try {
        registerData = registerText ? JSON.parse(registerText) : {};
      } catch {
        throw new Error(registerRes.ok ? 'Invalid server response' : `Register failed: ${registerRes.status}`);
      }
      if (!registerData.success) {
        throw new Error(registerData.error || 'Failed to register document');
      }

      await fetchDetails();
      toast.success('Document uploaded');
      e.target.value = '';
    } catch (error: unknown) {
      console.error('Upload error:', error);
      toast.error((error as Error)?.message || 'Failed to upload document');
    } finally {
      setIsSubmitting(false);
    }
  };



  const editNote = async (noteId: string, content: string) => {
    try {
      await updateDealNote(noteId, content);
      await fetchDetails();
      toast.success('Note updated');
    } catch (error: unknown) {
      toast.error((error as Error)?.message || 'Failed to update note');
      throw error;
    }
  };

  const deleteNote = async (noteId: string) => {
    try {
      await deleteDealNote(noteId);
      fetchDetails();
      toast.success('Note deleted');
    } catch (error) {
      toast.error('Failed to delete note');
    }
  };

  const deleteLink = async (linkId: string) => {
    try {
      await deleteDealLink(linkId);
      fetchDetails();
      toast.success('Link deleted');
    } catch (error) {
      toast.error('Failed to delete link');
    }
  };

  const deleteDocument = async (doc: DealDocument) => {
    try {
      const res = await fetch(`/api/deal-documents?id=${encodeURIComponent(doc.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to delete document');
      }
      fetchDetails();
      toast.success('Document deleted');
    } catch (error) {
      toast.error((error as Error)?.message || 'Failed to delete document');
    }
  };

  const downloadDocument = async (doc: DealDocument) => {
    try {
      const res = await fetch(`/api/deal-documents/download-url?id=${encodeURIComponent(doc.id)}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to get download URL');
      }
      const url = data.url;
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.file_name;
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      a.click();
    } catch (error) {
      toast.error((error as Error)?.message || 'Failed to download document');
    }
  };

  // Featured Slide — one highlighted deck, recording or YouTube video, shared
  // with CompanyDetailDialog through useFeaturedSlide/FeaturedSlideSection.
  const featured = useFeaturedSlide({
    companyId: company?.id ?? '',
    stage: company?.pipeline_stage || 'L0',
    documents,
    links,
    enabled: !!company,
    refresh: () => fetchDetails(),
    downloadDocument,
  });

  const downloadMatchedFile = async (file: MatchedFile) => {
    try {
      const res = await fetch(`/api/smart-files/${encodeURIComponent(file.id)}/download-url`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to get download URL');
      }
      const a = document.createElement('a');
      a.href = data.url;
      a.download = file.file_name;
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      a.click();
    } catch (error) {
      toast.error((error as Error)?.message || 'Failed to download file');
    }
  };

  // Signed preview URLs for the timeline's inline preview. Errors propagate so
  // the preview can show its own "not available" state.
  const getMatchedFilePreviewUrl = async (file: MatchedFile) => {
    const res = await fetch(`/api/smart-files/${encodeURIComponent(file.id)}/download-url`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to get preview URL');
    }
    return data.url as string;
  };

  const getDocumentPreviewUrl = async (doc: DealDocument) => {
    const res = await fetch(
      `/api/deal-documents/download-url?id=${encodeURIComponent(doc.id)}&preview=true`
    );
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to get preview URL');
    }
    return data.url as string;
  };

  if (loading) {
    return (
      <>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </>
    );
  }

  if (!company) {
    return (
      <>
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <p className="text-muted-foreground">Company not found</p>
          <Button onClick={() => router.push(returnTo)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Go Back
          </Button>
        </div>
      </>
    );
  }

  const displayName = companyDisplayName(company, 'Unnamed Company');
  const displayTitle = companyDisplayTitle(company, 'Unnamed Company');
  const logoInitial = companyInitials(company);

  const overviewFirstLine = analysis?.business_overview
    ? analysis.business_overview.replace(/^-\s+\*\*[^*]+\*\*:\s*/m, '').replace(/\n[\s\S]*/m, '').trim()
    : null;

  return (
    <>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
          <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:gap-4">
            <Button variant="ghost" size="icon" onClick={() => router.push(returnTo)} className="shrink-0">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-4 min-w-0">
            {/* Logo / Acronym */}
            <div className="h-16 w-16 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center shrink-0 overflow-hidden border border-blue-200 dark:border-blue-700">
              {analysis?.logo_url ? (
                <img
                  src={analysis.logo_url}
                  alt={displayName}
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                    (e.currentTarget.nextSibling as HTMLElement | null)?.removeAttribute('style');
                  }}
                />
              ) : null}
              <span
                className="text-xl font-bold text-blue-600 dark:text-blue-300"
                style={analysis?.logo_url ? { display: 'none' } : undefined}
              >
                {logoInitial}
              </span>
            </div>
            {/* Name + badges + description */}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold leading-tight">
                  {displayTitle}
                </h1>
                {company.segment && <Badge variant="outline">{company.segment}</Badge>}
                <Badge variant="outline">{getStageLabel(company.pipeline_stage)}</Badge>
                {company.l1_screening_result && (
                  <Badge variant={company.l1_screening_result === 'Pass' ? 'default' : 'destructive'}>
                    L1: {company.l1_screening_result}
                  </Badge>
                )}
                {company.status === 'dropped' && <Badge variant="destructive">Dropped</Badge>}
              </div>
            </div>
            </div>
          </div>
          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:self-center">
            {/* While a card is generating, the progress + cancel pair stays
                inline — a spinner buried in a closed menu is invisible. Once
                idle, all secondary actions collapse into the overflow menu. */}
            {analysisGenerating ? (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="bg-accent hover:bg-accent/90 text-accent-foreground gap-2"
                  disabled
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating...
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={cancelAnalysis}
                  disabled={analysisCancelling}
                >
                  {analysisCancelling ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  Cancel
                </Button>
              </div>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="More actions"
                    title="More actions"
                    className="h-7 w-7"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() =>
                      analysis?.status === 'completed'
                        ? regenerateAnalysis()
                        : generateAnalysis()
                    }
                  >
                    <Sparkles className="mr-2 h-4 w-4" />
                    {analysis?.status === 'completed'
                      ? 'Regenerate AI Card'
                      : 'Generate AI Company Card'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleAnalyzeWithAI}>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Analyze using AI
                  </DropdownMenuItem>
                  {analysis?.status === 'completed' && (
                    <DropdownMenuItem
                      onClick={() => router.push(`${pipelineHref}/${companyId}/slides`)}
                    >
                      <Presentation className="mr-2 h-4 w-4" />
                      Generate Slides
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {overviewFirstLine && (
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm text-muted-foreground leading-relaxed">{overviewFirstLine}</p>
            </CardContent>
          </Card>
        )}

        {company.status === 'dropped' && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>
              Deal dropped
              {company.dropped_at && ` on ${format(new Date(company.dropped_at), 'MMM d, yyyy')}`}
            </AlertTitle>
            <AlertDescription>
              {company.dropped_reason ?? 'No reason was recorded.'}
            </AlertDescription>
          </Alert>
        )}

        {/* Content */}
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="grid grid-cols-6 max-w-5xl">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="additional-context">Additional Context</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="company-card">Details</TabsTrigger>
            <TabsTrigger value="filters">Pre-pipeline Filters</TabsTrigger>
            <TabsTrigger value="voting">Voting</TabsTrigger>
          </TabsList>

          {/* Overview — read-only L0→L1 submission slide, powered by the AI
              Company Card. Without a card it is a blank screen with one
              "generate" button, which turns into "Generating…" + a link to the
              AI Workforce task for as long as the run is in flight. */}
          <TabsContent value="overview" className="space-y-6 mt-6">
            {!card.loaded ? null : !hasCompanyCard(analysis) &&
              (analysisGenerating || analysis?.status !== 'failed') ? (
              <CompanyCardNotGenerated
                generating={analysisGenerating}
                taskHref={card.taskHref}
                onGenerate={generateAnalysis}
                onCancel={cancelAnalysis}
                cancelling={analysisCancelling}
              />
            ) : analysis?.status === 'failed' ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 flex flex-col items-center justify-center gap-3">
                <AlertCircle className="h-6 w-6 text-destructive" />
                <div className="text-center">
                  <h3 className="text-base font-semibold text-destructive">Generation Failed</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {analysis.error_message || 'An error occurred while generating the overview.'}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={regenerateAnalysis} disabled={analysisGenerating}>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Retry
                </Button>
              </div>
            ) : (
              <CompanyOverviewSlide
                company={company}
                analysis={analysis}
                onEditSection={handleEditSection}
                editingSectionKey={editingSectionKey}
                onUpdateOwnership={saveOwnership}
              />
            )}
          </TabsContent>

          {/* Additional Context — the company's free-form markdown background
              and its Featured Slide, each in its own collapsible section so
              neither pushes the other off screen. The context feeds the AI
              Opinion, the company card / slide generation, and the agent read
              tools. */}
          <TabsContent value="additional-context" className="space-y-4 mt-6">
            <CollapsibleSection
              title="Context"
              description="Markdown background on this company. Read by the AI Opinion, the company card and slide generation, and the chat tools."
              icon={<BookOpen className="h-4 w-4" />}
            >
              <CompanyContextCard
                companyId={company.id}
                chrome="bare"
                value={company.context}
                onSaved={(context) =>
                  setCompany((prev) => (prev ? { ...prev, context: context || null } : prev))
                }
              />
            </CollapsibleSection>

            <FeaturedSlideSection featured={featured} />
          </TabsContent>

          {/* Timeline — every dated thing that happened on the deal (stage
              changes, notes, uploads, links, Smart File references) on one
              horizontal rail, plus the manual-entry composer that replaced the
              Attachments tab. */}
          <TabsContent value="timeline" className="mt-6">
            <CompanyTimeline
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
                router.push(`${smartFilesHref}?highlight=${encodeURIComponent(file.id)}`)
              }
            />
          </TabsContent>

          <TabsContent value="company-card" className="mt-6">
            <CompanyDetailsTab
              company={company}
              tracks={tracks}
              editor={editor}
              onDealStatusChange={(next) => void dealStatus.change(next)}
              dealStatusBusy={dealStatus.busy}
              onSaveRemarks={saveRemarks}
              onFinancialsUpdate={() => fetchCompany({ silent: true })}
              onTrackVariablesSaved={(next) => {
                setCompany((prev) => (prev ? { ...prev, track_specific_variables: next } : prev));
                void fetchCompany({ silent: true });
              }}
              onSlideVariablesSaved={(next) => {
                setCompany((prev) => (prev ? { ...prev, slide_track_variable_ids: next } : prev));
                void fetchCompany({ silent: true });
              }}
              stageHistory={stageHistory}
              analysis={analysis}
              analysisGenerating={analysisGenerating}
              analysisCancelling={analysisCancelling}
              onCancelAnalysis={cancelAnalysis}
              onRetryAnalysis={regenerateAnalysis}
            />
          </TabsContent>

          <TabsContent value="filters" className="mt-6 space-y-4">
            <PrePipelineFilterResults screenings={screenings} />
          </TabsContent>

          {/* Voting — Investment-Committee round on this company. */}
          <TabsContent value="voting" className="mt-6">
            <CompanyVotingTab
              companyId={companyId}
              featuredSlide={featured.slide}
            />
          </TabsContent>
        </Tabs>
      </div>


      {dealStatus.restoreStageDialog}

      {company && (
        <DropDealDialog
          open={showDropDialog}
          onOpenChange={setShowDropDialog}
          dealId={company.id}
          companyName={companyDisplayName(company, 'this company')}
          currentStage={company.pipeline_stage}
          onSuccess={(reason) => {
            setCompany((prev) =>
              prev
                ? { ...prev, status: 'dropped', dropped_at: new Date().toISOString(), dropped_reason: reason }
                : prev,
            );
          }}
        />
      )}
    </>
  );
}
