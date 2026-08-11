'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';
import { formatMoneyMn } from '@/lib/currency';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useChatContext } from '@/components/chat/ChatProvider';
import { AskAIButton } from '@/components/chat/AskAIButton';
import { useIsMobile } from '@/hooks/use-mobile';
import { useEventStream } from '@/hooks/useEventStream';
import { companyDisplayName, companyDisplayTitle, companyInitials } from '@/lib/companyDisplay';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  Building2,
  ArrowLeft,
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
  Lightbulb,
  TrendingUp,
  AlertTriangle,
  Search,
  Briefcase,
  Globe,
  Sparkles,
  Download,
  Eye,
  HelpCircle,
  Presentation,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import StatusCombobox, {
  DEFAULT_INBOUND_STATUS_OPTIONS,
  DEFAULT_OUTBOUND_STATUS_OPTIONS,
} from '@/components/pipeline/StatusCombobox';
import UserSelectCombobox from '@/components/pipeline/UserSelectCombobox';
import TrackVariablesSection from '@/components/pipeline/TrackVariablesSection';
import { normalizeStake } from '@/lib/stake';
import {
  matchedTrackPics,
  dealLeadField,
  dealLeadLabel,
  effectiveDealLead,
  persistedTrackIds,
} from '@/lib/tracks/matchTracks';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CompanyAnalysisSection } from '@/components/pipeline/CompanyAnalysisSection';
import CompanyRelationshipGraph from '@/components/pipeline/CompanyRelationshipGraph';
import { AICompanyCardLoading } from '@/components/pipeline/AICompanyCardLoading';
import CompanyOverviewSlide, {
  type AnalysisSectionKey,
  type EditSectionRequest,
} from '@/components/pipeline/CompanyOverviewSlide';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
import FilePreview from '@/components/Files/FilePreview';
import { FinancialCharts } from '@/components/pipeline/FinancialCharts';
import { DealStage } from '@/lib/types';
import { STAGE_LABELS, isAnalysisInProgress } from '@/lib/constants';
import { formatDistanceToNow, format } from 'date-fns';
import {
  addCompanyLink,
  addCompanyNote,
  deleteDealLink,
  deleteDealNote,
  getCompanies,
  getCompanyDetails,
  getBankerNames,
  getTracks,
  getUsers,
  updateCompany,
  type Track,
  type UserSummary,
} from '@/lib/api/pipeline';

const websiteHref = (url: string) =>
  /^https?:\/\//i.test(url) ? url : `https://${url}`;

/** timestamptz ISO string -> YYYY-MM-DD for <input type="date">. */
const isoToDateInput = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
};

const OWNERSHIP_OPTIONS = [
  'Public',
  'Private',
  'Private Equity',
  'Venture Capital',
  'Family Owned',
  'Subsidiary',
] as const;

const getStageLabel = (stage: string | null): string => {
  const key = (stage || 'L0') as DealStage;
  return STAGE_LABELS[key] ?? key;
};

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
  matched_track_ids?: string[] | null;
  track_specific_variables?: Record<string, Record<string, string>> | null;
  slide_track_variable_ids?: string[] | null;
  deal_sponsor?: string | null;
  deal_captain?: string | null;
  financials_raw?: import('@/lib/repositories').Tables<'company_financials'>[];
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
  const entries: { id: string; stage: string; entered_at: string }[] = [];
  for (const log of logs) {
    const parsed = stageFromLogAction(log.action, log.created_at ?? '');
    if (parsed) entries.push({ id: log.id, stage: parsed.stage, entered_at: parsed.entered_at });
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
    });
  }
  return result.reverse(); // newest first for display
}

const formatDuration = (seconds: number | null) => {
  if (seconds === null) return 'Ongoing';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
};

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
}

interface DealDocument {
  id: string;
  file_name: string;
  file_path: string;
  stage: string;
  created_at: string | null;
}

/** File from the "files" table (Smart Files) where matched_companies contains this company */
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
  state: 'pending' | 'completed' | 'failed';
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


interface CompanyDetailProps {
  showCompanyGraph?: boolean;
  showFundManagement?: boolean;
}

export default function CompanyDetail({
  showCompanyGraph = false,
  showFundManagement = false,
}: CompanyDetailProps) {
  const params = useParams();
  const router = useRouter();
  const { analyzeWithAI } = useChatContext();
  const currency = useWorkspaceCurrency();
  const formatCurrency = (value: number | null) => formatMoneyMn(value, currency);
  const { focusCopilot } = useLayoutControl();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const companyId = params.dealId as string;
  const pipelineHref = useWorkspaceHref('/pipeline');
  const chatHref = useWorkspaceHref('/chat');
  const smartFilesHref = useWorkspaceHref('/smart-files');
  const returnTo = searchParams.get('from') || pipelineHref;

  const [company, setCompany] = useState<CompanyData | null>(null);

  // "Analyze using AI" sends the prompt to the shared copilot. On mobile the
  // copilot lives on the Chat tab, so jump there to watch the response stream.
  const handleAnalyzeWithAI = () => {
    analyzeWithAI(
      `Analyze ${companyDisplayName(company, 'this company')} and provide insights about it as a potential deal.`,
    );
    if (isMobile) router.push(chatHref);
  };
  const [stageHistory, setStageHistory] = useState<StageHistory[]>([]);
  const [notes, setNotes] = useState<DealNote[]>([]);
  const [links, setLinks] = useState<DealLink[]>([]);
  const [documents, setDocuments] = useState<DealDocument[]>([]);
  const [matchedFiles, setMatchedFiles] = useState<MatchedFile[]>([]);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [analysis, setAnalysis] = useState<CompanyAnalysis | null>(null);
  const [analysisGenerating, setAnalysisGenerating] = useState(false);
  const [analysisCancelling, setAnalysisCancelling] = useState(false);
  const analysisPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // Right-click → "Edit with AI" on an Overview slide section. Hands the copilot
  // a tightly-scoped prompt (company_id + section + current content + change) so
  // it rewrites ONLY that section via update_company_card_section, then polls the
  // analysis row until the new content lands and refreshes the slide in place.
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

    setEditingSectionKey(req.sectionKey);
    stopSectionEditPoll();
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`/api/company-analysis?companyId=${companyId}`);
        if (res.ok) {
          const data = (await res.json()) as CompanyAnalysis;
          const next = data?.[req.sectionKey];
          if (
            data &&
            typeof next === 'string' &&
            next.trim() !== previousContent.trim()
          ) {
            setAnalysis(data);
            setEditingSectionKey(null);
            stopSectionEditPoll();
            toast.success(`Updated "${req.sectionTitle}"`);
            return;
          }
        }
      } catch {
        // transient — keep polling until the cap
      }
      if (attempts >= 48) {
        stopSectionEditPoll();
        setEditingSectionKey(null);
      }
    }, 2500);
    sectionEditPollRef.current = interval;
  };

  const [newNote, setNewNote] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [previewDoc, setPreviewDoc] = useState<DealDocument | null>(null);
  const [previewMatchedFile, setPreviewMatchedFile] = useState<MatchedFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

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
    advisor: string;
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
  // Full users list (id + name) for the `entered_by` picker — it's a uuid FK,
  // so it can't reuse the name-only `userOptions` (those back the free-text
  // Deal Sponsor / Deal Captain comboboxes).
  const [users, setUsers] = useState<UserSummary[]>([]);

  const startEditing = async () => {
    if (!company) return;
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
      advisor: company.advisor ?? '',
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
        .then((rows: UserSummary[]) => {
          setUsers(rows);
          setUserOptions(rows.map((u) => u.name).filter((n): n is string => !!n));
        })
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
    if (!company) return;
    setRemarksDraft(company.remarks ?? '');
    setIsEditingRemarks(true);
  };

  const cancelEditingRemarks = () => {
    setIsEditingRemarks(false);
    setRemarksDraft('');
  };

  const saveRemarks = async () => {
    if (!company) return;
    setIsSavingRemarks(true);
    try {
      const trimmed = remarksDraft.trim();
      await updateCompany(company.id, { remarks: trimmed || null });
      setCompany((prev) => (prev ? { ...prev, remarks: trimmed || null } : prev));
      toast.success('Remarks updated');
      setIsEditingRemarks(false);
      setRemarksDraft('');
    } catch (err: unknown) {
      console.error('Failed to save remarks:', err);
      toast.error(`Failed to save: ${(err as Error)?.message || 'Unknown error'}`);
    } finally {
      setIsSavingRemarks(false);
    }
  };

  const saveEditing = async () => {
    if (!editForm || !company) return;
    setIsSaving(true);
    try {
      const evNum = editForm.ev_2024.trim() === '' ? null : Number(editForm.ev_2024);
      if (evNum !== null && Number.isNaN(evNum)) {
        toast.error('Valuation must be a number');
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
        advisor: editForm.advisor.trim() || null,
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
        setCompany((prev) =>
          prev ? { ...prev, ...(refreshedCompany as CompanyData) } : (refreshedCompany as CompanyData),
        );
      }
      toast.success('Company updated');
      setIsEditing(false);
      setEditForm(null);
    } catch (err: unknown) {
      console.error('Failed to save company:', err);
      toast.error(`Failed to save: ${(err as Error)?.message || 'Unknown error'}`);
    } finally {
      setIsSaving(false);
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

  useEffect(() => {
    return () => {
      stopAnalysisPoll();
      stopSectionEditPoll();
    };
  }, []);

  const fetchCompany = async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const data = await getCompanies({ id: companyId });
      if (data) {
        setCompany(data as CompanyData);
        if (!opts.silent) {
          fetchDetails((data as CompanyData).target?.trim() || null);
          fetchAnalysis();
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

  // Live screening progress over SSE (replaces a 3s poll): connect only while a
  // screening is pending; the stream pushes the full list on every state change.
  const hasPendingScreening = screenings.some((s) => s.state === 'pending');
  useEventStream<Screening[]>(
    companyId && hasPendingScreening
      ? `/api/screenings/stream?companyId=${encodeURIComponent(companyId)}`
      : null,
    (rows) => setScreenings(rows),
  );

  const fetchAnalysis = async () => {
    if (!companyId) return;
    try {
      const res = await fetch(`/api/company-analysis?companyId=${companyId}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.status) {
          setAnalysis(data);
          // If still processing, poll until complete
          if (isAnalysisInProgress(data.status)) {
            setAnalysisGenerating(true);
            pollAnalysis();
          }
          return;
        }
      }
      // No analysis exists yet → leave it empty. Generation is triggered manually
      // via the "Generate AI Company Card" button.
    } catch (error) {
      console.error('Error fetching analysis:', error);
    }
  };

  const pollAnalysis = () => {
    stopAnalysisPoll();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/company-analysis?companyId=${companyId}`);
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
    }, 5000);
    analysisPollRef.current = interval;
    // Clean up after 5 minutes max
    setTimeout(() => {
      if (analysisPollRef.current === interval) {
        stopAnalysisPoll();
        setAnalysisGenerating(false);
      }
    }, 300000);
  };

  const generateAnalysis = async () => {
    if (!companyId) return;
    setAnalysisGenerating(true);

    let dispatched = false;
    try {
      const res = await fetch('/api/company-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to generate analysis');
      }

      const data = await res.json();
      // 202 → job dispatched; pollAnalysis watches the company_analyses row.
      if (res.status === 202 || data.jobId) {
        dispatched = true;
        pollAnalysis();
        return;
      }
      setAnalysis(data);
      toast.success('AI Company Card generated successfully');
    } catch (error) {
      console.error('Error generating analysis:', error);
      toast.error((error as Error).message || 'Failed to generate AI Company Card');
      // Re-fetch to get the latest status (might be 'failed')
      fetchAnalysis();
    } finally {
      if (!dispatched) setAnalysisGenerating(false);
    }
  };

  const regenerateAnalysis = async () => {
    if (!companyId) return;

    try {
      // Delete existing analysis first
      await fetch(`/api/company-analysis?companyId=${companyId}`, {
        method: 'DELETE',
      });
      setAnalysis(null);
    } catch {
      // Continue even if delete fails
    }

    // Generate fresh
    await generateAnalysis();
  };

  const cancelAnalysis = async () => {
    if (!companyId) return;
    setAnalysisCancelling(true);
    try {
      const res = await fetch('/api/company-analysis/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to cancel generation');
      }
      stopAnalysisPoll();
      setAnalysis(null);
      setAnalysisGenerating(false);
      toast.success('Company Card generation cancelled');
    } catch (error) {
      console.error('Error cancelling analysis:', error);
      toast.error(
        (error as Error).message || 'Failed to cancel Company Card generation',
      );
    } finally {
      setAnalysisCancelling(false);
    }
  };

  const addNote = async () => {
    if (!newNote.trim() || !company) return;
    setIsSubmitting(true);
    try {
      await addCompanyNote(company.id, newNote, company.pipeline_stage || 'L0');
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

  const addLink = async () => {
    if (!newLinkUrl.trim() || !company) return;
    setIsSubmitting(true);
    try {
      await addCompanyLink(company.id, newLinkUrl, newLinkTitle || undefined, company.pipeline_stage || 'L0');
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

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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

  const handleClosePreview = () => {
    setPreviewDoc(null);
    setPreviewMatchedFile(null);
    setPreviewUrl(null);
  };

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

  const handleOpenMatchedFilePreview = async (file: MatchedFile) => {
    setPreviewDoc(null);
    setPreviewMatchedFile(file);
    setLoadingPreview(true);
    setPreviewUrl(null);
    try {
      const res = await fetch(`/api/smart-files/${encodeURIComponent(file.id)}/download-url`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to get preview URL');
      }
      setPreviewUrl(data.url);
    } catch (error) {
      toast.error((error as Error)?.message || 'Failed to load preview');
      setPreviewMatchedFile(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleOpenPreview = async (doc: DealDocument) => {
    setPreviewDoc(doc);
    setPreviewMatchedFile(null);
    setLoadingPreview(true);
    setPreviewUrl(null);
    try {
      const res = await fetch(
        `/api/deal-documents/download-url?id=${encodeURIComponent(doc.id)}&preview=true`
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to get preview URL');
      }
      setPreviewUrl(data.url);
    } catch (error) {
      toast.error((error as Error)?.message || 'Failed to load preview');
      setPreviewDoc(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    >
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  if (!company) {
    return (
      <DashboardLayout
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    >
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <p className="text-muted-foreground">Company not found</p>
          <Button onClick={() => router.push(returnTo)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Go Back
          </Button>
        </div>
      </DashboardLayout>
    );
  }

  const displayName = companyDisplayName(company, 'Unnamed Company');
  const displayTitle = companyDisplayTitle(company, 'Unnamed Company');
  const logoInitial = companyInitials(company);

  const overviewFirstLine = analysis?.business_overview
    ? analysis.business_overview.replace(/^-\s+\*\*[^*]+\*\*:\s*/m, '').replace(/\n[\s\S]*/m, '').trim()
    : null;

  return (
    <DashboardLayout
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    >
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
            {analysis?.status === 'completed' && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => router.push(`${pipelineHref}/${companyId}/slides`)}
              >
                <Presentation className="h-4 w-4" />
                Generate Slides
              </Button>
            )}
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
              <Button
                size="sm"
                className="bg-accent hover:bg-accent/90 text-accent-foreground gap-2"
                onClick={analysis?.status === 'completed' ? regenerateAnalysis : generateAnalysis}
              >
                <Sparkles className="h-4 w-4" />
                {analysis?.status === 'completed'
                  ? 'Regenerate AI Card'
                  : 'Generate AI Company Card'}
              </Button>
            )}
            <AskAIButton
              variant="button"
              label="Analyze using AI"
              onClick={handleAnalyzeWithAI}
            />
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

        {company.promoted_reasons && company.promoted_reasons.trim() && (
          <Alert>
            <TrendingUp className="h-4 w-4" />
            <AlertTitle>Promotion reasons</AlertTitle>
            <AlertDescription>
              <MarkdownRenderer content={company.promoted_reasons} variant="card" />
            </AlertDescription>
          </Alert>
        )}

        {/* Content */}
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid grid-cols-4 max-w-2xl">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="company-card">Details</TabsTrigger>
            <TabsTrigger value="filters">L1 Screening</TabsTrigger>
            <TabsTrigger value="attachments">Attachments</TabsTrigger>
          </TabsList>

          {/* Overview — read-only L0→L1 submission slide, powered by the AI
              Company Card. Generated manually via the "Generate AI Company Card"
              button; shows the generating state until ready. */}
          <TabsContent value="overview" className="space-y-6 mt-6">
            {analysisGenerating && !analysis?.business_overview ? (
              <AICompanyCardLoading
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
              />
            )}
          </TabsContent>

          <TabsContent value="company-card" className="space-y-6 mt-6">
            {/* AI Market Scanning Remarks */}
            {company.source?.toLowerCase() === 'outbound' && (
              <Card className="border-blue-200 dark:border-blue-800/50 bg-gradient-to-br from-blue-50/50 to-blue-50/30 dark:from-blue-950/20 dark:to-blue-950/10">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg flex items-center gap-2 text-blue-700 dark:text-blue-400">
                      <Sparkles className="h-5 w-5 text-blue-500" />
                      AI Market Scanning Remarks
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700">
                        <Sparkles className="h-3 w-3 mr-1" />
                        AI Discovered
                      </Badge>
                      {!isEditingRemarks && (
                        <Button variant="ghost" size="sm" onClick={startEditingRemarks} aria-label="Edit remarks" className="h-6 w-6 p-0 text-blue-700 dark:text-blue-300">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {company.segment && (
                    <p className="text-sm text-muted-foreground">Matched against: {company.segment}</p>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-800/50 bg-blue-50/80 dark:bg-blue-950/30">
                    <p className="text-sm font-medium text-blue-700 dark:text-blue-300 flex items-center gap-2 mb-2">
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

            {/* Financial Charts - first */}
            <FinancialCharts
              financials={company.financials_raw ?? []}
              rawFinancials={company.financials_raw ?? []}
              companyId={company.id}
              onUpdate={() => fetchCompany({ silent: true })}
            />

            {/* Company Information - flat, 2-column */}
            <div className="rounded-lg border bg-card px-4 py-3">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Company Information
                </p>
                {!isEditing && (
                  <Button variant="ghost" size="sm" onClick={startEditing} aria-label="Edit" className="h-6 w-6 p-0">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                <div>
                  <p className="text-xs text-muted-foreground">Company Name</p>
                  {isEditing && editForm ? (
                    <Input value={editForm.target} onChange={(e) => setEditForm({ ...editForm, target: e.target.value })} disabled={isSaving} className="mt-1 h-7 text-sm" />
                  ) : (
                    <p className="text-sm font-medium break-words">{company.target || '—'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Project Name</p>
                  {isEditing && editForm ? (
                    <Input value={editForm.project_name} onChange={(e) => setEditForm({ ...editForm, project_name: e.target.value })} placeholder="e.g. Project Phoenix" disabled={isSaving} className="mt-1 h-7 text-sm" />
                  ) : (
                    <p className="text-sm font-medium break-words">{company.project_name || '—'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Website</p>
                  {isEditing && editForm ? (
                    <Input value={editForm.website} onChange={(e) => setEditForm({ ...editForm, website: e.target.value })} placeholder="https://..." disabled={isSaving} className="mt-1 h-7 text-sm" />
                  ) : company.website ? (
                    <a href={websiteHref(company.website)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-xs inline-flex items-start gap-1 break-all">
                      <span className="break-all">{company.website}</span>
                      <ExternalLink className="h-3 w-3 shrink-0 mt-0.5" />
                    </a>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Sector</p>
                  {isEditing && editForm ? (
                    <Input value={editForm.segment} onChange={(e) => setEditForm({ ...editForm, segment: e.target.value })} disabled={isSaving} className="mt-1 h-7 text-sm" />
                  ) : (
                    <p className="text-sm font-medium break-words">{company.segment || '—'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Headquarter</p>
                  {isEditing && editForm ? (
                    <Input value={editForm.geography} onChange={(e) => setEditForm({ ...editForm, geography: e.target.value })} disabled={isSaving} className="mt-1 h-7 text-sm" />
                  ) : (
                    <p className="text-sm font-medium break-words">{company.geography || '—'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Ownership</p>
                  {isEditing && editForm ? (
                    <Select value={editForm.ownership || '__none__'} onValueChange={(v) => setEditForm({ ...editForm, ownership: v === '__none__' ? '' : v })} disabled={isSaving}>
                      <SelectTrigger className="mt-1 h-7 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">-</SelectItem>
                        {OWNERSHIP_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm font-medium break-words">{company.ownership || '—'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Source</p>
                  {isEditing && editForm ? (
                    <Select value={editForm.source || '__none__'} onValueChange={(v) => setEditForm({ ...editForm, source: v === '__none__' ? '' : v })} disabled={isSaving}>
                      <SelectTrigger className="mt-1 h-7 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">-</SelectItem>
                        <SelectItem value="inbound">Inbound</SelectItem>
                        <SelectItem value="outbound">Outbound</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm font-medium capitalize break-words">{company.source || '—'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Current Stage</p>
                  {isEditing && editForm ? (
                    <Select value={editForm.pipeline_stage} onValueChange={(v) => setEditForm({ ...editForm, pipeline_stage: v })} disabled={isSaving}>
                      <SelectTrigger className="mt-1 h-7 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as DealStage[]).map((s) => (
                          <SelectItem key={s} value={s}>{s} — {STAGE_LABELS[s] ?? s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline" className="text-xs px-2 py-0.5 mt-0.5">{getStageLabel(company.pipeline_stage)}</Badge>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Valuation</p>
                  {isEditing && editForm ? (
                    <Input type="number" step="0.01" value={editForm.ev_2024} onChange={(e) => setEditForm({ ...editForm, ev_2024: e.target.value })} placeholder="USD millions" disabled={isSaving} className="mt-1 h-7 text-sm" />
                  ) : (
                    <p className="text-sm font-medium break-words">{formatCurrency(company.ev_2024)}</p>
                  )}
                </div>
                <div>
                  {(() => {
                    const stage =
                      isEditing && editForm ? editForm.pipeline_stage : company.pipeline_stage;
                    const field = dealLeadField(stage);
                    const pics = matchedTrackPics(company, tracks);
                    const fallback = pics.length > 0 ? pics.join(', ') : null;
                    return (
                      <>
                        <p className="text-xs text-muted-foreground">{dealLeadLabel(stage)}</p>
                        {isEditing && editForm ? (
                          <div className="mt-1">
                            <StatusCombobox
                              value={editForm[field] || null}
                              options={userOptions}
                              allowCreate={false}
                              placeholder={
                                fallback ? `${fallback} (from track)` : `Set ${dealLeadLabel(stage)}…`
                              }
                              searchPlaceholder="Search a team member…"
                              emptyText="No team members found."
                              onChange={(v) => setEditForm({ ...editForm, [field]: v })}
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
                    <Select value={editForm.deal_type || '__none__'} onValueChange={(v) => setEditForm({ ...editForm, deal_type: v === '__none__' ? '' : v })} disabled={isSaving}>
                      <SelectTrigger className="mt-1 h-7 text-sm"><SelectValue /></SelectTrigger>
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
                      <UserSelectCombobox value={editForm.entered_by || null} onChange={(v) => setEditForm({ ...editForm, entered_by: v })} users={users} disabled={isSaving} className="h-7 text-sm" />
                    </div>
                  ) : (
                    <p className="text-sm font-medium break-words">{company.entered_by_name || '—'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  {isEditing && editForm ? (
                    <div className="mt-1">
                      <StatusCombobox value={editForm.workflow_status || null} options={company.source === 'outbound' ? DEFAULT_OUTBOUND_STATUS_OPTIONS : DEFAULT_INBOUND_STATUS_OPTIONS} placeholder={company.source === 'outbound' ? 'Set status…' : 'Unreviewed'} onChange={(v) => setEditForm({ ...editForm, workflow_status: v })} disabled={isSaving} />
                    </div>
                  ) : (
                    <p className="text-sm font-medium break-words">{company.workflow_status || '—'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Last Activity</p>
                  {isEditing && editForm ? (
                    <Input type="date" value={editForm.last_activity_at} onChange={(e) => setEditForm({ ...editForm, last_activity_at: e.target.value })} disabled={isSaving} className="mt-1 h-7 text-sm" />
                  ) : (
                    <p className="text-sm font-medium break-words">{company.last_activity_at ? format(new Date(company.last_activity_at), 'MMM d, yyyy') : '—'}</p>
                  )}
                </div>
                {company.source !== 'outbound' && (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground">Banker / Source</p>
                      {isEditing && editForm ? (
                        <StatusCombobox value={editForm.banker || null} options={bankerOptions} placeholder="Set banker…" searchPlaceholder="Search or add a banker…" emptyText="No bankers yet." onChange={(v) => setEditForm({ ...editForm, banker: v })} disabled={isSaving} className="mt-1" />
                      ) : (
                        <p className="text-sm font-medium break-words">{company.banker || '—'}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Advisor</p>
                      {isEditing && editForm ? (
                        <StatusCombobox value={editForm.advisor || null} options={bankerOptions} placeholder="Set advisor…" searchPlaceholder="Search or add a banker…" emptyText="No bankers yet." onChange={(v) => setEditForm({ ...editForm, advisor: v })} disabled={isSaving} className="mt-1" />
                      ) : (
                        <p className="text-sm font-medium break-words">{company.advisor || '—'}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Doc Type</p>
                      {isEditing && editForm ? (
                        <Select value={editForm.doc_type || '__none__'} onValueChange={(v) => setEditForm({ ...editForm, doc_type: v === '__none__' ? '' : v })} disabled={isSaving}>
                          <SelectTrigger className="mt-1 h-7 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">-</SelectItem>
                            <SelectItem value="teaser">Teaser</SelectItem>
                            <SelectItem value="shopping_list">Shopping List</SelectItem>
                            <SelectItem value="market_study">Market Study</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-sm font-medium capitalize break-words">{company.doc_type ? company.doc_type.replace(/_/g, ' ') : '—'}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">% Stake</p>
                      {isEditing && editForm ? (
                        <Input value={editForm.stake} onChange={(e) => setEditForm({ ...editForm, stake: e.target.value })} placeholder="e.g. 51%" title="Target ownership percentage being pursued" disabled={isSaving} className="mt-1 h-7 text-sm" />
                      ) : (
                        <p className="text-sm font-medium break-words">{company.stake || '—'}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Deal Size</p>
                      {isEditing && editForm ? (
                        <Input value={editForm.deal_size} onChange={(e) => setEditForm({ ...editForm, deal_size: e.target.value })} disabled={isSaving} className="mt-1 h-7 text-sm" />
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
                      <Textarea value={editForm.key_rationale} onChange={(e) => setEditForm({ ...editForm, key_rationale: e.target.value })} rows={3} disabled={isSaving} className="mt-1 text-sm resize-y" />
                    ) : (
                      <p className="text-sm font-medium break-words whitespace-pre-wrap">{company.key_rationale || '—'}</p>
                    )}
                  </div>
                )}
              </div>
              {company.company_focus && !isEditing && (
                <div className="mt-3 pt-3 border-t">
                  <p className="text-xs text-muted-foreground mb-0.5">Company Focus</p>
                  <p className="text-sm break-words">{company.company_focus}</p>
                </div>
              )}
              {company.comments && !isEditing && (
                <div className="mt-3 pt-3 border-t">
                  <p className="text-xs text-muted-foreground mb-0.5">Comments</p>
                  <p className="text-sm break-words">{company.comments}</p>
                </div>
              )}
              {isEditing && editForm && (
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={cancelEditing} disabled={isSaving}>Cancel</Button>
                  <Button size="sm" onClick={saveEditing} disabled={isSaving} className="gap-1">
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Save
                  </Button>
                </div>
              )}
            </div>

            {/* Relationship graph snippet — this company and the companies
                directly connected to it. Filtering lives on the graph page. */}
            <CompanyRelationshipGraph
              companyId={company.id}
              companyName={companyDisplayName(company, 'This company')}
            />

            {/* AI Company Card Section */}
            {analysisGenerating ? (
              <AICompanyCardLoading
                onCancel={cancelAnalysis}
                cancelling={analysisCancelling}
              />
            ) : analysis?.status === 'failed' ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-12 flex flex-col items-center justify-center gap-4">
                <AlertCircle className="h-8 w-8 text-destructive" />
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-destructive">Analysis Failed</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {analysis.error_message || 'An error occurred while generating the analysis.'}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={regenerateAnalysis} disabled={analysisGenerating}>
                  <Sparkles className="h-4 w-4 mr-2" />Retry
                </Button>
              </div>
            ) : analysis?.status === 'completed' ? (
              <div className="space-y-6">
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
                          {source.type === 'database' || source.type === 'files' ? <FileText className="h-3 w-3" /> : source.type === 'inven' ? <Search className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
                          {source.title || source.type}
                        </span>
                      ),
                    )}
                  </div>
                )}
                <CompanyAnalysisSection title="Business Overview" description="Establish a factual baseline: products, end markets, customer types, and geographic footprint." icon={Building2} content={analysis.business_overview || ''} colorVariant="default" />
                <CompanyAnalysisSection title="Business Model & Value Chain Summary" description="Explain how the company operates economically and where it sits in the industry value chain." icon={Briefcase} content={analysis.business_model_summary || ''} colorVariant="teal" />
                <CompanyAnalysisSection title="Key Takeaways" description="Surface the most important implications from the analysis above (3-5 synthesized insights)." icon={Lightbulb} content={analysis.key_takeaways || ''} colorVariant="blue" />
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <CompanyAnalysisSection title="Investment Highlights" description="Identify upside drivers linked to the company's business model and positioning." icon={TrendingUp} content={analysis.investment_highlights || ''} colorVariant="green" />
                  <CompanyAnalysisSection title="Investment Risks" description="Identify risks inherent to the company's business model and value chain." icon={AlertTriangle} content={analysis.investment_risks || ''} colorVariant="amber" />
                </div>
                <CompanyAnalysisSection title="Diligence Priorities" description="Define the most critical unknowns to resolve before advancing investment (3-7 items)." icon={Search} content={analysis.diligence_priorities || ''} colorVariant="rose" />
              </div>
            ) : null}

            {/* Track-specific custom variables */}
            {company && (
              <TrackVariablesSection
                companyId={company.id}
                matchedTrackIds={persistedTrackIds(company, tracks)}
                tracks={tracks}
                values={company.track_specific_variables}
                onSaved={() => fetchCompany({ silent: true })}
                slideVariableIds={company.slide_track_variable_ids}
                onSlideVariablesSaved={() => fetchCompany({ silent: true })}
              />
            )}

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
                    <div key={history.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="text-xs px-2 py-0.5">{getStageLabel(history.stage)}</Badge>
                        <span className="text-xs text-muted-foreground">{format(new Date(history.entered_at), 'MMM d, yyyy HH:mm')}</span>
                      </div>
                      <span className="text-xs font-medium">{history.exited_at ? formatDuration(history.duration_seconds) : 'Current'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="filters" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">L1 Screening Results</CardTitle>
              </CardHeader>
              <CardContent>
                {screenings.length > 0 ? (
                  <div className="space-y-3">
                    {screenings.map((screening) => (
                      <div key={screening.id} className="flex items-center justify-between py-2 border-b last:border-0">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{screening.criterias?.name || 'Unknown Criteria'}</span>
                            <Badge
                              variant={screening.state === 'completed' ? 'outline' : screening.state === 'pending' ? 'secondary' : 'destructive'}
                              className="text-xs"
                            >
                              {screening.state}
                            </Badge>
                          </div>
                          {screening.result && (
                            <p className="text-sm text-muted-foreground mt-1">{screening.result}</p>
                          )}
                          {screening.remarks && (
                            <p className="text-xs text-muted-foreground mt-1 italic">{screening.remarks}</p>
                          )}
                        </div>
                        <ScreeningStateIcon state={screening.state} result={screening.result} />
                      </div>
                    ))}
                    <div className="pt-3 border-t">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">Overall Status</span>
                        {(() => {
                          const isPending = screenings.some(s => s.state === 'pending');
                          const hasFail = screenings.some(s => s.result?.toLowerCase() === 'fail');

                          if (isPending) {
                            return <Badge variant="secondary">Pending</Badge>;
                          }
                          if (hasFail) {
                            return <Badge variant="destructive">Fail</Badge>;
                          }

                          return <Badge variant="default">Pass</Badge>;
                        })()}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    No screenings have been run yet. Click &quot;Screen&quot; from the L0 stage to run filters.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="attachments" className="mt-6">
            <div className="grid grid-cols-1 gap-6">
              {/* Files mentioning this company (from Smart Files) */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Files mentioning this company
                  </CardTitle>
                  <CardDescription>From Smart Files</CardDescription>
                </CardHeader>
                <CardContent>
                  {matchedFiles.length === 0 ? (
                    <p className="text-muted-foreground text-xs">No Smart Files mention this company yet.</p>
                  ) : (
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {matchedFiles.map((file) => (
                        <div key={file.id} className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="text-sm truncate" title={file.file_name}>
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
                              onClick={() => handleOpenMatchedFilePreview(file)}
                              title="Preview"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => router.push(`${smartFilesHref}?highlight=${encodeURIComponent(file.id)}`)}
                              title="Open in Smart Files"
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
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Upload className="h-4 w-4" />
                    Documents
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label htmlFor="file-upload" className="cursor-pointer">
                      <div className="border-2 border-dashed rounded-lg p-6 text-center hover:border-primary transition-colors">
                        <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">Click to upload a document</p>
                      </div>
                    </Label>
                    <input
                      id="file-upload"
                      type="file"
                      className="hidden"
                      onChange={handleFileUpload}
                      disabled={isSubmitting}
                    />
                  </div>
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {documents.map((doc) => (
                      <div key={doc.id} className="flex items-center justify-between p-2 bg-muted rounded-lg">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="text-sm truncate" title={doc.file_name}>
                            {doc.file_name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => downloadDocument(doc)}
                            title="Download"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleOpenPreview(doc)}
                            title="Preview"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => deleteDocument(doc)} title="Delete">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    {documents.length === 0 && <p className="text-muted-foreground text-sm">No documents yet</p>}
                  </div>
                </CardContent>
              </Card>

              {/* Links Section */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <LinkIcon className="h-4 w-4" />
                    Links
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Input
                      placeholder="https://..."
                      value={newLinkUrl}
                      onChange={(e) => setNewLinkUrl(e.target.value)}
                    />
                    <Input
                      placeholder="Title (optional)"
                      value={newLinkTitle}
                      onChange={(e) => setNewLinkTitle(e.target.value)}
                    />
                    <Button onClick={addLink} disabled={isSubmitting || !newLinkUrl.trim()} size="sm">
                      {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                      Add Link
                    </Button>
                  </div>
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {links.map((link) => (
                      <div key={link.id} className="flex items-center justify-between p-2 bg-muted rounded-lg">
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-primary hover:underline text-sm truncate flex-1"
                        >
                          <ExternalLink className="h-4 w-4 shrink-0" />
                          {link.title || link.url}
                        </a>
                        <Button variant="ghost" size="icon" onClick={() => deleteLink(link.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                    {links.length === 0 && <p className="text-muted-foreground text-sm">No links yet</p>}
                  </div>
                </CardContent>
              </Card>

              {/* Notes Section */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Notes
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Add a note..."
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      rows={3}
                    />
                    <Button onClick={addNote} disabled={isSubmitting || !newNote.trim()} size="sm">
                      {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                      Add Note
                    </Button>
                  </div>
                  <div className="space-y-3 max-h-[300px] overflow-y-auto">
                    {notes.map((note) => (
                      <div key={note.id} className="p-3 bg-muted rounded-lg">
                        <div className="flex justify-between items-start gap-2">
                          <p className="text-sm whitespace-pre-wrap flex-1">{note.content}</p>
                          <Button variant="ghost" size="icon" onClick={() => deleteNote(note.id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          {note.created_at && formatDistanceToNow(new Date(note.created_at), { addSuffix: true })} · {note.stage}
                        </p>
                      </div>
                    ))}
                    {notes.length === 0 && <p className="text-muted-foreground text-sm">No notes yet</p>}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Document preview dialog */}
      <Dialog open={!!(previewDoc || previewMatchedFile)} onOpenChange={(open) => !open && handleClosePreview()}>
        <DialogContent className="flex flex-col w-screen h-screen max-w-none sm:rounded-none border-0 overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              <span className="truncate">{previewDoc?.file_name ?? previewMatchedFile?.file_name ?? 'Preview'}</span>
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
                fileName={previewDoc?.file_name ?? previewMatchedFile?.file_name ?? ''}
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
    </DashboardLayout>
  );
}

function ScreeningStateIcon({ state, result }: { state: 'pending' | 'completed' | 'failed'; result: string | null }) {
  if (state === 'pending') {
    return (
      <div className="flex items-center gap-1 text-yellow-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm font-medium">Pending</span>
      </div>
    );
  }
  if (state === 'failed') {
    return (
      <div className="flex items-center gap-1 text-red-600">
        <XCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Failed</span>
      </div>
    );
  }

  const resultLower = result?.toLowerCase();
  if (resultLower === 'inconclusive') {
    return (
      <div className="flex items-center gap-1 text-amber-500">
        <HelpCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Inconclusive</span>
      </div>
    );
  }

  const isPassed = resultLower === 'pass' || resultLower === 'yes';
  return (
    <div className={`flex items-center gap-1 ${isPassed ? 'text-green-600' : 'text-red-600'}`}>
      {isPassed ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      <span className="text-sm font-medium">{isPassed ? 'Pass' : 'Fail'}</span>
    </div>
  );
}
