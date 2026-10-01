'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  duplicateInsight,
  featureInsight,
  getInsight,
  getInsightRefreshRoutine,
  type InsightRefreshRoutineStatus,
} from '@/lib/api/insights';
import { describeRoutinePause } from '@/lib/routines/pauseReason';
import type { InsightDetail } from '@/lib/insights/types';
import { formatInsightDate } from '@/lib/insights/format';
import type { InsightSectionRef } from '@/lib/chat/pageContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InsightErrorBoundary } from './InsightErrorBoundary';
import { InsightFrame } from './InsightFrame';
import { InsightElementPopover } from './InsightElementPopover';
import { InsightHistoryDialog } from './InsightHistoryDialog';
import { InsightManageDialog } from './InsightManageDialog';
import { InsightSaveAsTemplateDialog } from './InsightSaveAsTemplateDialog';
import { InsightRefreshScheduleDialog } from './InsightRefreshScheduleDialog';
import { InsightAgentDialog } from './InsightAgentDialog';
import {
  InsightTemplatePreviewDialog,
  type TemplatePreviewTarget,
} from './InsightTemplatePreviewDialog';
import { getInsightTemplateHtml } from '@/lib/api/insightTemplates';
import { describeInsightAgent } from '@/lib/insights/agentLabel';
import {
  Loader2,
  MoreVertical,
  History,
  RotateCcw,
  AlertCircle,
  Pencil,
  Copy,
  CalendarClock,
  LayoutTemplate,
  Star,
  StarOff,
  Archive,
  ArrowLeft,
  Trash2,
  SquareDashedMousePointer,
  FileDown,
  Maximize,
  Minimize,
  Bot,
  FileCode2,
  Link2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  clearOpenInsightAgent,
  getPageContext,
  setInsightSections,
  setOpenInsightAgent,
  setPageContext,
  usePageContext,
} from '@/lib/chat/pageContextStore';
import { useChatContext } from '@/components/chat/ChatProvider';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { useWorkspaceHref, useWorkspacePush } from '@/hooks/useWorkspaceHref';
import {
  INSIGHT_PRIME_TIMEOUT_MS,
  INSIGHT_SANDBOX,
  buildInsightPrimerSrcDoc,
  isInsightFrameReadyMessage,
} from '@/lib/insights/srcdoc';
import { buildInsightPrintDoc, isInsightPrintDoneMessage } from '@/lib/insights/printDoc';
import { cn } from '@/lib/utils';
import { insightHtmlFileName } from '@/lib/insights/downloadName';
import { INSIGHT_FEATURED_HELP } from './featuredHelp';

export interface InsightViewProps {
  insightId: string;
  /** Whether click-to-select is armed in the document. Owned by the toolbar. */
  selectMode?: boolean;
  onToggleSelectMode?: () => void;
  onInsightChange?: () => void;
  onArchive?: () => void;
}

export function InsightView({
  insightId,
  selectMode = false,
  onToggleSelectMode,
  onInsightChange,
  onArchive,
}: InsightViewProps) {
  const [detail, setDetail] = useState<InsightDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog states
  const [historyOpen, setHistoryOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [manageMode, setManageMode] = useState<'rename' | 'archive' | 'delete'>('rename');
  const [featuring, setFeaturing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [scheduleRefreshOpen, setScheduleRefreshOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [templatePreview, setTemplatePreview] = useState<TemplatePreviewTarget | null>(null);

  // The selection itself lives in the page context store, which is what the next
  // chat turn carries and what the composer chips render and clear. Only the
  // pick is local — it is a screen position, meaningful to nothing else.
  const [currentPick, setCurrentPick] = useState<{
    ref: InsightSectionRef;
    rect: { top: number; left: number; width: number; height: number };
    label: string;
    count: number;
    session: number;
  } | null>(null);

  // PDF export state and cleanup ref
  const [printing, setPrinting] = useState(false);
  const printCleanupRef = useRef<(() => void) | null>(null);

  // Fullscreen state and ref
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const { analyzeWithAI } = useChatContext();
  const { focusCopilot } = useLayoutControl();
  const isMobile = useIsMobile();
  const router = useRouter();
  const chatHref = useWorkspaceHref('/chat');
  const insightHref = useWorkspaceHref(`/insight/${insightId}`);
  const push = useWorkspacePush();

  // Left undefined when nothing is selected, so InsightFrame falls back to its
  // own stable empty list rather than a fresh array on every render.
  const selectedSections = usePageContext()?.insightSections;

  // Load insight details. Only the first load (no detail yet) swaps the view
  // for the spinner/error screen: a reload after a feature toggle, rename,
  // rebind or CoPilot publish keeps the document mounted, so scroll position,
  // in-frame state, fullscreen and any open dialog survive it.
  const hasDetailRef = useRef(false);
  const loadDetail = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getInsight(insightId);
      setDetail(data);
      hasDetailRef.current = true;
      setError(null);
    } catch (err: unknown) {
      console.error('Failed to load insight', err);
      const message = err instanceof Error ? err.message : 'Failed to load insight';
      if (hasDetailRef.current) {
        toast.error(message);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [insightId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // The refresh routine, only for the face's paused marker (MB-560). One
  // request per insight open, re-read after the binding or the schedule
  // changes. A failure just hides the marker.
  const [refreshRoutine, setRefreshRoutine] = useState<InsightRefreshRoutineStatus | null>(null);
  const loadRefreshRoutine = useCallback(async () => {
    try {
      setRefreshRoutine(await getInsightRefreshRoutine(insightId));
    } catch (err: unknown) {
      console.warn('Failed to load the refresh schedule', err);
      setRefreshRoutine(null);
    }
  }, [insightId]);

  useEffect(() => {
    void loadRefreshRoutine();
  }, [loadRefreshRoutine]);

  // Sync insightId with pageContextStore for CoPilot; clear selection on insight change
  useEffect(() => {
    const current = getPageContext();
    if (current) {
      if (current.insightId !== insightId) {
        // Section refs belong to the insight they were clicked in — carrying
        // them onto the next one would point the copilot at a block that
        // document does not have.
        const { insightSections: _stale, ...rest } = current;
        setPageContext({
          ...rest,
          tabSlug: 'insight',
          insightId,
        });
      }
    } else {
      setPageContext({
        tabSlug: 'insight',
        path: typeof window !== 'undefined' ? window.location.pathname : '',
        insightId,
      });
    }
    // A new document may not have the block that was selected in the old one.
    setInsightSections([]);
    setCurrentPick(null);
  }, [insightId]);

  // Leaving the page must not leave a stale selection on the next chat turn.
  useEffect(() => () => setInsightSections([]), []);

  // Tell the CoPilot which sector agent this insight is bound to (MB-549): the
  // header previews it, and a thread pinned to a different agent gives way to
  // a new one. Published once the detail loads, and again after a rebind
  // reloads it. Display-only — the server resolves the agent itself.
  const boundAgentKey = detail?.id === insightId ? (detail.agent_key ?? null) : undefined;
  useEffect(() => {
    if (boundAgentKey === undefined) return;
    setOpenInsightAgent({ insightId, agentKey: boundAgentKey });
  }, [insightId, boundAgentKey]);
  useEffect(() => () => clearOpenInsightAgent(insightId), [insightId]);

  // Disarming drops the frame's own pick but reports nothing back, so the prompt
  // box would otherwise stay open over a document that is live again. The
  // SELECTION itself survives on purpose — the outlines show what the next
  // question still carries, and the composer chips are how it is cleared.
  useEffect(() => {
    if (!selectMode) setCurrentPick(null);
  }, [selectMode]);

  // The selection can be emptied from OUTSIDE the frame — the chips in the chat
  // composer clear it, and a theme flip rebuilds the srcdoc underneath the pick.
  // Either way the prompt box would otherwise sit over nothing, still holding a
  // ref and a screen rect that no longer describe anything on screen.
  useEffect(() => {
    if (!selectedSections?.length) setCurrentPick(null);
  }, [selectedSections]);

  // Listen for copilot insight edit publishing so the view updates automatically
  useEffect(() => {
    const handleVersionPublished = (e: Event) => {
      const customEvent = e as CustomEvent<{ insightId: string }>;
      if (customEvent.detail?.insightId === insightId) {
        void loadDetail();
        onInsightChange?.();
      }
    };
    window.addEventListener('insight:version-published', handleVersionPublished);
    return () => {
      window.removeEventListener('insight:version-published', handleVersionPublished);
    };
  }, [insightId, loadDetail, onInsightChange]);

  const handleToggleFeatured = async () => {
    if (!detail || featuring) return;
    const nextFeatured = !detail.is_featured;
    setFeaturing(true);
    try {
      await featureInsight(insightId, nextFeatured);
      await loadDetail();
      onInsightChange?.();
      toast.success(nextFeatured ? 'Set as featured' : 'Removed as featured');
    } catch (err: unknown) {
      console.error('Failed to update featured status', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to update featured status',
      );
    } finally {
      setFeaturing(false);
    }
  };

  const handleDuplicate = async () => {
    if (!detail || duplicating) return;
    setDuplicating(true);
    try {
      const copy = await duplicateInsight(insightId);
      toast.success('Insight duplicated');
      onInsightChange?.();
      push(`/insight/${copy.id}`);
    } catch (err: unknown) {
      console.error('Failed to duplicate insight', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to duplicate insight',
      );
    } finally {
      setDuplicating(false);
    }
  };

  const handleVersionChange = (newDetail: InsightDetail) => {
    setDetail(newDetail);
    onInsightChange?.();
  };

  const handleAgentSaved = async () => {
    // A rebind may resume a schedule the system paused (MB-560).
    await Promise.all([loadDetail(), loadRefreshRoutine()]);
    onInsightChange?.();
  };

  const handleManageDone = async () => {
    if (manageMode === 'archive' || manageMode === 'delete') {
      onArchive?.();
    } else {
      await loadDetail();
      onInsightChange?.();
    }
  };

  // Fullscreen tracking via browser event
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === fullscreenRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err) => {
        console.error('Failed to exit fullscreen', err);
      });
    } else {
      fullscreenRef.current?.requestFullscreen().catch((err) => {
        console.error('Failed to request fullscreen', err);
      });
    }
  }, []);

  // Clean up PDF printing iframe on unmount
  useEffect(() => {
    return () => {
      if (printCleanupRef.current) {
        printCleanupRef.current();
      }
    };
  }, []);

  const handleExportPdf = () => {
    if (printing || !detail) return;
    setPrinting(true);

    if (printCleanupRef.current) {
      printCleanupRef.current();
    }

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', INSIGHT_SANDBOX);
    frame.referrerPolicy = 'no-referrer';
    frame.title = `Print ${detail.name}`;
    // Primer first, same as InsightFrame: the first document an opaque-origin
    // frame parses sees a 0×0 viewport, which breaks decks that paginate while
    // parsing. The print document loads once the primer reports a real width.
    frame.srcdoc = buildInsightPrimerSrcDoc('light');
    const printDoc = buildInsightPrintDoc(detail.html);
    frame.style.position = 'fixed';
    frame.style.left = '-10000px';
    frame.style.top = '0';
    frame.style.width = '900px';
    frame.style.height = '1200px';
    frame.style.border = '0';

    let timer: NodeJS.Timeout | null = null;
    let primeTimer: NodeJS.Timeout | null = null;
    let primed = false;

    const loadPrintDoc = () => {
      if (primed) return;
      primed = true;
      if (primeTimer) {
        clearTimeout(primeTimer);
        primeTimer = null;
      }
      frame.srcdoc = printDoc;
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (primeTimer) {
        clearTimeout(primeTimer);
        primeTimer = null;
      }
      window.removeEventListener('message', handleMessage);
      if (frame.parentNode) {
        frame.parentNode.removeChild(frame);
      }
      printCleanupRef.current = null;
      setPrinting(false);
    };

    const handleMessage = (event: MessageEvent) => {
      if (isInsightFrameReadyMessage(event, frame)) {
        loadPrintDoc();
        return;
      }
      if (isInsightPrintDoneMessage(event, frame)) {
        cleanup();
      }
    };

    timer = setTimeout(() => {
      cleanup();
    }, 60000);

    printCleanupRef.current = cleanup;
    window.addEventListener('message', handleMessage);
    document.body.appendChild(frame);
    primeTimer = setTimeout(loadPrintDoc, INSIGHT_PRIME_TIMEOUT_MS);
  };

  // The current version's HTML as a file, named after the insight.
  const handleDownloadHtml = () => {
    if (!detail) return;
    const url = URL.createObjectURL(new Blob([detail.html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = insightHtmlFileName(detail.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked on the next task: the click has started the download by then.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  // The absolute, workspace-scoped address of this insight.
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${insightHref}`);
      toast.success('Link copied');
    } catch (err: unknown) {
      console.error('Failed to copy the insight link', err);
      toast.error('Could not copy the link');
    }
  };

  const handlePopoverSubmit = (instruction: string) => {
    if (!detail || !currentPick) return;

    // The selection names every element the frame currently has selected, not
    // just the one the box is anchored to: a Ctrl/Cmd-click builds a
    // multi-element selection, and the turn carries it on BOTH channels — as an
    // attached selection the server spells out for the model, and as refs via
    // read_page_context. They have to agree, or the agent is told to edit three
    // blocks while the prompt asks about one. The bubble shows only the
    // instruction, with the selection as a chip beside it.
    const sections = selectedSections?.length ? selectedSections : [currentPick.ref];
    analyzeWithAI(instruction, {
      insightSelection: { insightId, insightName: detail.name, sections },
    });
    setCurrentPick(null);

    if (isMobile) {
      router.push(chatHref);
    } else {
      focusCopilot();
    }
  };

  if (loading && !detail) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3 text-sm text-muted-foreground">Loading insight...</span>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-8 m-6 rounded-lg border border-destructive bg-card text-destructive flex items-center gap-3">
        <AlertCircle className="h-6 w-6 shrink-0" />
        <div>
          <h3 className="font-semibold text-base">Unable to load insight</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {error ?? 'Insight not found.'}
          </p>
        </div>
      </div>
    );
  }

  const boundAgent = describeInsightAgent(detail.agent_key);
  // Only while the source template is live: the server leaves the name null
  // once the template is deleted.
  const sourceTemplate =
    detail.source_template_id && detail.source_template_name
      ? { id: detail.source_template_id, name: detail.source_template_name }
      : null;
  const schedulePausedNotice = describeRoutinePause(
    refreshRoutine?.paused_reason,
    detail.agent_key,
  );

  return (
    <div className="flex flex-col min-h-full bg-background text-foreground">
      {/* ── Insight Header ── */}
      <div className="border-b border-border bg-card px-6 py-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col sm:flex-row sm:items-start gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => push('/insight/list')}
              className="h-8 gap-1.5 bg-card hover:bg-muted text-foreground border-border shrink-0"
              data-testid="insight-back"
            >
              <ArrowLeft className="h-4 w-4" />
              All insights
            </Button>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">
                  {detail.name}
                </h1>

                {detail.is_featured && (
                  <Badge
                    variant="outline"
                    title={INSIGHT_FEATURED_HELP}
                    data-testid="insight-featured-badge"
                    className="bg-card text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-800 text-xs flex items-center gap-1"
                  >
                    <Star className="h-3 w-3 fill-current" />
                    Featured
                  </Badge>
                )}

                <Badge
                  variant="outline"
                  className="bg-card text-muted-foreground border-border text-xs font-mono"
                >
                  v{detail.version_no}
                </Badge>

                {boundAgent && (
                  <button
                    type="button"
                    onClick={() => setAgentOpen(true)}
                    title={[
                      boundAgent.name,
                      boundAgent.sector,
                      boundAgent.deprecated ? 'deprecated' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    data-testid="insight-agent-badge"
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2.5 py-0.5 text-xs font-mono bg-card hover:bg-muted transition-colors',
                      boundAgent.deprecated
                        ? 'text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-800'
                        : 'text-foreground border-border',
                    )}
                  >
                    <Bot className="h-3 w-3" />
                    {boundAgent.handle}
                    {boundAgent.deprecated && (
                      <span className="font-sans" data-testid="insight-agent-badge-deprecated">
                        · deprecated
                      </span>
                    )}
                  </button>
                )}

                {schedulePausedNotice && (
                  // The refresh schedule is paused for a broken binding
                  // (MB-560); rebinding is what resumes it, so this opens the
                  // Agent dialog.
                  <button
                    type="button"
                    onClick={() => setAgentOpen(true)}
                    title={schedulePausedNotice}
                    data-testid="insight-schedule-paused-badge"
                    className="inline-flex items-center gap-1 rounded-md border px-2.5 py-0.5 text-xs bg-card hover:bg-muted transition-colors text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-800"
                  >
                    <CalendarClock className="h-3 w-3" />
                    Refresh paused
                  </button>
                )}
              </div>

              {detail.description && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {detail.description}
                </p>
              )}

              <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                <span>Updated {formatInsightDate(detail.updated_at)}</span>
                {sourceTemplate && (
                  <button
                    type="button"
                    onClick={() =>
                      setTemplatePreview({
                        key: sourceTemplate.id,
                        title: sourceTemplate.name,
                        fetchHtml: () => getInsightTemplateHtml(sourceTemplate.id),
                      })
                    }
                    data-testid="insight-source-template"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-foreground hover:bg-muted transition-colors"
                  >
                    <LayoutTemplate className="h-3 w-3" />
                    From template: {sourceTemplate.name}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Insight Toolbar */}
          <div className="flex items-center gap-2 flex-wrap self-start sm:self-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onToggleSelectMode}
              aria-pressed={selectMode}
              className={cn(
                'h-8 gap-1.5 border-border',
                selectMode
                  ? 'text-primary bg-muted'
                  : 'bg-card hover:bg-muted text-foreground',
              )}
              data-testid="insight-update"
              title={
                selectMode
                  ? 'Click, Ctrl/⌘-click or drag to select. Click again to read and highlight text.'
                  : 'Select parts of the insight to ask about or edit. Or just highlight text to ask about it.'
              }
            >
              <SquareDashedMousePointer className="h-4 w-4" />
              {selectMode ? 'Selection mode on' : 'Selection mode'}
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportPdf}
              disabled={printing}
              className="h-8 gap-1.5 bg-card hover:bg-muted text-foreground border-border"
              data-testid="insight-export-pdf"
            >
              {printing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4" />
              )}
              Export PDF
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setHistoryOpen(true)}
              className="h-8 w-8 p-0 bg-card hover:bg-muted text-foreground border-border"
              title="Version history"
              data-testid="insight-history"
            >
              <span className="sr-only">Version history</span>
              <History className="h-4 w-4" />
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={toggleFullscreen}
              className="h-8 w-8 p-0 bg-card hover:bg-muted text-foreground border-border"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              data-testid="insight-fullscreen"
            >
              <span className="sr-only">{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span>
              {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0 bg-card hover:bg-muted text-foreground border-border"
                >
                  <span className="sr-only">Insight options</span>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-card text-foreground border border-border shadow-md">
                <DropdownMenuItem
                  onClick={() => {
                    setManageMode('rename');
                    setManageOpen(true);
                  }}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                >
                  <Pencil className="h-4 w-4 mr-2 text-muted-foreground" />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleDuplicate}
                  disabled={duplicating}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                >
                  <Copy className="h-4 w-4 mr-2 text-muted-foreground" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setScheduleRefreshOpen(true)}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                  data-testid="insight-schedule-refresh-menu-item"
                >
                  <CalendarClock className="h-4 w-4 mr-2 text-muted-foreground" />
                  Schedule refresh…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setAgentOpen(true)}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                  data-testid="insight-agent-menu-item"
                >
                  <Bot className="h-4 w-4 mr-2 text-muted-foreground" />
                  Agent…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSaveTemplateOpen(true)}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                >
                  <LayoutTemplate className="h-4 w-4 mr-2 text-muted-foreground" />
                  Save as template…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleToggleFeatured}
                  disabled={featuring}
                  title={INSIGHT_FEATURED_HELP}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                >
                  {detail.is_featured ? (
                    <>
                      <StarOff className="h-4 w-4 mr-2 text-muted-foreground" />
                      Remove as featured
                    </>
                  ) : (
                    <>
                      <Star className="h-4 w-4 mr-2 text-muted-foreground" />
                      Set as featured
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setHistoryOpen(true)}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                >
                  <RotateCcw className="h-4 w-4 mr-2 text-muted-foreground" />
                  Rollback…
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-border" />
                <DropdownMenuItem
                  onClick={handleDownloadHtml}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                  data-testid="insight-download-html-menu-item"
                >
                  <FileCode2 className="h-4 w-4 mr-2 text-muted-foreground" />
                  Download HTML
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void handleCopyLink()}
                  className="cursor-pointer hover:bg-muted focus:bg-muted"
                  data-testid="insight-copy-link-menu-item"
                >
                  <Link2 className="h-4 w-4 mr-2 text-muted-foreground" />
                  Copy link
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-border" />
                <DropdownMenuItem
                  onClick={() => {
                    setManageMode('archive');
                    setManageOpen(true);
                  }}
                  className="cursor-pointer text-destructive focus:text-destructive hover:bg-muted focus:bg-muted"
                >
                  <Archive className="h-4 w-4 mr-2 text-destructive" />
                  Archive…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setManageMode('delete');
                    setManageOpen(true);
                  }}
                  className="cursor-pointer text-destructive focus:text-destructive hover:bg-muted focus:bg-muted"
                >
                  <Trash2 className="h-4 w-4 mr-2 text-destructive" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* ── Document Container with InsightFrame ── */}
      <div className="p-6 lg:p-8 flex-1">
        <InsightErrorBoundary>
          <div
            ref={fullscreenRef}
            className={cn(
              'relative',
              isFullscreen
                ? 'bg-background overflow-auto'
                : 'rounded-xl border border-border bg-card shadow-sm',
            )}
          >
            {isFullscreen && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={toggleFullscreen}
                className="fixed top-3 right-3 z-10 h-8 w-8 p-0 bg-card hover:bg-muted text-foreground border-border"
                title="Exit fullscreen"
                data-testid="insight-exit-fullscreen"
              >
                <span className="sr-only">Exit fullscreen</span>
                <Minimize className="h-4 w-4" />
              </Button>
            )}
            <div className={cn(!isFullscreen && 'rounded-xl overflow-hidden')}>
              <InsightFrame
                html={detail.html}
                title={detail.name}
                // Armed from the page toolbar; with it off, highlighted text
                // can still be asked about. The approval cards and the history
                // dialog pass neither, so their previews stay inert.
                selectMode={selectMode}
                askText
                selectedSections={selectedSections}
                onSectionsChange={setInsightSections}
                onPick={setCurrentPick}
              />
            </div>
            {currentPick && (
              <InsightElementPopover
                // Keyed by the pick SESSION, not the element: aiming somewhere
                // new gets an empty box, because a half-typed "make this
                // shorter" must not silently carry over to a section the user
                // never aimed at — but Ctrl/Cmd-clicking a second element only
                // extends the same selection, and keeps what they have typed.
                key={currentPick.session}
                label={currentPick.label}
                count={currentPick.count}
                textPick={currentPick.ref.kind === 'text'}
                anchor={currentPick.rect}
                onSubmit={handlePopoverSubmit}
                onClose={() => setCurrentPick(null)}
              />
            )}
          </div>
        </InsightErrorBoundary>
      </div>

      {/* ── Version History Dialog ── */}
      <InsightHistoryDialog
        insightId={insightId}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        currentVersionNo={detail.version_no}
        onVersionChanged={handleVersionChange}
      />

      {/* ── Management (Rename & Archive) Dialog ── */}
      <InsightManageDialog
        insightId={insightId}
        insightName={detail.name}
        mode={manageMode}
        open={manageOpen}
        onOpenChange={setManageOpen}
        onDone={handleManageDone}
      />

      {/* ── Save as Template Dialog ── */}
      <InsightSaveAsTemplateDialog
        insightId={insightId}
        defaultName={detail.name}
        open={saveTemplateOpen}
        onOpenChange={setSaveTemplateOpen}
      />

      {/* ── Schedule Refresh Dialog ── */}
      <InsightRefreshScheduleDialog
        insightId={insightId}
        insightName={detail.name}
        agentKey={detail.agent_key ?? null}
        open={scheduleRefreshOpen}
        onOpenChange={setScheduleRefreshOpen}
        onChanged={loadRefreshRoutine}
        onOpenAgent={() => {
          setScheduleRefreshOpen(false);
          setAgentOpen(true);
        }}
      />

      {/* ── Source Template Preview ── */}
      <InsightTemplatePreviewDialog
        target={templatePreview}
        onClose={() => setTemplatePreview(null)}
      />

      {/* ── Sector Agent Binding Dialog ── */}
      <InsightAgentDialog
        insightId={insightId}
        insightName={detail.name}
        currentAgentKey={detail.agent_key ?? null}
        open={agentOpen}
        onOpenChange={setAgentOpen}
        onSaved={handleAgentSaved}
      />
    </div>
  );
}
