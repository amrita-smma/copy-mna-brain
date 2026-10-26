"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  addContactDeal,
  removeContactDeal,
  type DealContactRole,
} from "@/lib/api/contactDeals";
import {
  getContactConversation,
  requestRelationshipOverview,
  type ContactConversation,
  type ConversationNote,
} from "@/lib/api/contactConversation";
import {
  getContactInsights,
  type ContactInsights,
  type InsightsPeriod,
} from "@/lib/api/contactInsights";
import { decodeHtmlEntities } from "@/lib/crm/displayText";
import { Info, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAskBrain } from "./AskBrainRow";
import { DealFunnelTab } from "./conversation/DealFunnelTab";
import { OverviewTab } from "./conversation/OverviewTab";
import { RelatedDealsTab } from "./conversation/RelatedDealsTab";
import { SectionLabel } from "./conversation/SectionLabel";
import { buildBrainShortcuts } from "./conversation/shortcuts";
import { UnderlineTabs } from "./UnderlineTabs";
import { initialsOf } from "./utils";

/** What the opener already knows about the contact; the panel fetches the rest. */
export interface ContactPanelSeed {
  id: string;
  name: string;
  title: string | null;
}

const POLL_MS = 4_000;
const POLL_TIMEOUT_MS = 2 * 60_000;
/**
 * The overview probes one note only, to know whether there is anything to
 * summarise or list; the folded notes list pages in NOTES_PAGE at a time.
 */
const NOTE_PROBE_LIMIT = 1;
const NOTES_PAGE = 20;

type DrawerTab = "overview" | "related" | "funnel";

export function ContactInsightsPanel({
  contact,
  open,
  onOpenChange,
  onChanged,
}: {
  contact: ContactPanelSeed;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a deal link changes, so the list behind can refresh. */
  onChanged?: () => void;
}) {
  const [insights, setInsights] = useState<ContactInsights | null>(null);
  const [conversation, setConversation] = useState<ContactConversation | null>(null);
  const ask = useAskBrain();

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkRole, setLinkRole] = useState<DealContactRole>("involved");

  const [tab, setTab] = useState<DrawerTab>("overview");
  const [period, setPeriod] = useState<InsightsPeriod>("all");
  // Read by load so a period change doesn't recreate `load` and re-run the
  // open effect (a full reload racing the handler's own fetch).
  const periodRef = useRef<InsightsPeriod>("all");
  const [loadingScorecard, setLoadingScorecard] = useState(false);
  // Latest insights request: a period fetch, or a load (which fetches the
  // current period too). Only the latest may set `insights` or stop the
  // funnel spinner; `requestRef` guards the rest of a load.
  const periodRequestRef = useRef(0);

  // Folded notes list: fetched on first open, then paged with "Load more".
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState<ConversationNote[] | null>(null);
  const [notesCursor, setNotesCursor] = useState<string | null>(null);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Overview polling
  const [summarising, setSummarising] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGenRef = useRef(0);
  const requestedOverviewRef = useRef(false);

  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const askedRef = useRef(false);

  const stopPolling = useCallback(() => {
    pollGenRef.current += 1;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    setSummarising(false);
  }, []);

  const startOverviewPolling = useCallback(() => {
    stopPolling();
    setSummarising(true);
    const gen = pollGenRef.current;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    const poll = async (): Promise<void> => {
      try {
        const data = await getContactConversation(contact.id, { limit: NOTE_PROBE_LIMIT });
        if (!mountedRef.current || gen !== pollGenRef.current) return;
        setConversation((prev) => (prev ? { ...prev, overview: data.overview } : data));
        const status = data.overview.status;
        if (status === "ready" || (!data.overview.stale && status !== "pending")) {
          stopPolling();
          return;
        }
      } catch {
        if (!mountedRef.current || gen !== pollGenRef.current) return;
      }

      if (Date.now() > deadline) {
        stopPolling();
        return;
      }

      if (gen !== pollGenRef.current) return;
      pollTimerRef.current = setTimeout(() => void poll(), POLL_MS);
    };

    pollTimerRef.current = setTimeout(() => void poll(), POLL_MS);
  }, [contact.id, stopPolling]);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const periodRequestId = ++periodRequestRef.current;
    setLoading(true);
    try {
      const [insightsData, conversationData] = await Promise.all([
        getContactInsights(contact.id, { period: periodRef.current }),
        getContactConversation(contact.id, { limit: NOTE_PROBE_LIMIT }),
      ]);

      if (requestRef.current !== requestId) return;
      if (periodRequestRef.current === periodRequestId) setInsights(insightsData);
      setConversation(conversationData);
      setFailed(false);

      // The overview is built from the notes, so ask for one only when it is
      // stale (the server sets that from the real note count, so a missing
      // overview with notes is stale too) or failed. Not from `notes`: that
      // list is empty while CRM_EMAIL_NOTES_ENABLED is off, and the overview
      // is not gated by it. The server also refuses to generate from no notes.
      if (
        !requestedOverviewRef.current &&
        (conversationData.overview.stale || conversationData.overview.status === "failed")
      ) {
        requestedOverviewRef.current = true;
        void requestRelationshipOverview(contact.id)
          .then((ov) => {
            if (requestRef.current !== requestId) return;
            setConversation((prev) => (prev ? { ...prev, overview: ov } : prev));
            if (ov.status === "pending") startOverviewPolling();
          })
          .catch(() => {
            // Non-fatal: the last overview (if any) stays on screen.
          });
      }
    } catch {
      if (requestRef.current !== requestId) return;
      setFailed(true);
      toast.error("Could not load contact conversation");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
      if (periodRequestRef.current === periodRequestId) setLoadingScorecard(false);
    }
  }, [contact.id, startOverviewPolling]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  useEffect(() => {
    if (!open) return;
    askedRef.current = false;
    requestedOverviewRef.current = false;
    void load();
    return () => {
      requestRef.current += 1;
      stopPolling();
    };
  }, [open, load, stopPolling]);

  const handlePeriodChange = useCallback(
    async (newPeriod: InsightsPeriod) => {
      setPeriod(newPeriod);
      periodRef.current = newPeriod;
      const requestId = ++periodRequestRef.current;
      setLoadingScorecard(true);
      try {
        const updatedInsights = await getContactInsights(contact.id, { period: newPeriod });
        if (periodRequestRef.current !== requestId) return;
        setInsights(updatedInsights);
      } catch {
        toast.error("Could not load deal funnel for period");
      } finally {
        if (periodRequestRef.current === requestId) setLoadingScorecard(false);
      }
    },
    [contact.id],
  );

  const loadNotes = useCallback(
    async (cursor: string | null) => {
      setLoadingNotes(true);
      try {
        const page = await getContactConversation(contact.id, {
          limit: NOTES_PAGE,
          cursor: cursor ?? undefined,
        });
        if (!mountedRef.current) return;
        setNotes((prev) => (cursor && prev ? [...prev, ...page.notes] : page.notes));
        setNotesCursor(page.nextCursor);
      } catch {
        toast.error("Could not load conversation notes");
        if (!cursor) setNotesOpen(false);
      } finally {
        if (mountedRef.current) setLoadingNotes(false);
      }
    },
    [contact.id],
  );

  const toggleNotes = useCallback(() => {
    const next = !notesOpen;
    setNotesOpen(next);
    if (next && notes === null && !loadingNotes) void loadNotes(null);
  }, [notesOpen, notes, loadingNotes, loadNotes]);

  const mutate = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      setBusy(true);
      try {
        await action();
        toast.success(success);
        await load();
        onChanged?.();
      } catch (err) {
        toast.error((err as Error).message || "Something went wrong");
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  const name = insights?.contact.name || decodeHtmlEntities(contact.name);
  const title = insights ? insights.contact.title : decodeHtmlEntities(contact.title);
  const initials = initialsOf(name) || "—";
  const firstName = name.trim().split(/\s+/)[0] || name;

  const deals = insights?.deals;
  const shortcuts = useMemo(
    () => buildBrainShortcuts(firstName, deals ?? []),
    [firstName, deals],
  );
  const relatedCount =
    (insights?.deals.length ?? 0) + (insights?.relatedCompanies.length ?? 0);

  const tabs: Array<{ key: DrawerTab; label: string; count?: number }> = [
    { key: "overview", label: "Overview" },
    { key: "related", label: "Related deals & companies", count: relatedCount },
    { key: "funnel", label: "Deal funnel" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(760px,calc(100vh-48px))] w-[calc(100vw-2rem)] max-w-[640px] flex-col gap-0 overflow-hidden rounded-xl bg-card p-0"
        data-testid="contact-insights-panel"
        onCloseAutoFocus={(e) => {
          if (askedRef.current) e.preventDefault();
        }}
      >
        <div className="shrink-0 border-b">
          <header
            className="flex items-start gap-3 px-5 pb-3 pt-4"
            data-testid="contact-insights-header"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
              {initials}
            </div>
            <div className="min-w-0 flex-1 pr-8">
              <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Conversation notes
              </div>
              <DialogTitle className="mt-0.5 truncate text-lg font-semibold leading-tight text-foreground">
                {name}
              </DialogTitle>
              <DialogDescription className="truncate text-xs text-muted-foreground">
                {title || "—"}
              </DialogDescription>
            </div>
          </header>

          <section
            className="flex flex-col gap-2.5 px-5 pb-3.5"
            data-testid="contact-insights-ask-brain"
          >
            <SectionLabel>Ask Brain Bot</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {shortcuts.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  title={s.question || "Type your own question"}
                  onClick={() => {
                    askedRef.current = true;
                    ask(s.question);
                    onOpenChange(false);
                  }}
                  className="inline-flex h-7 max-w-full items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 text-xs font-semibold text-primary transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`contact-insights-ask-brain-${s.key}`}
                >
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        <UnderlineTabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          testIdPrefix="contact-conversation-tab"
          className="shrink-0 gap-6 px-5"
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && !insights && !conversation ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : failed && !insights && !conversation ? (
            <div className="py-6 text-sm text-muted-foreground">
              Could not load this contact.{" "}
              <button
                type="button"
                className="font-semibold text-primary hover:underline"
                onClick={() => void load()}
              >
                Retry
              </button>
            </div>
          ) : tab === "overview" ? (
            <OverviewTab
              conversation={conversation}
              insights={insights}
              summarising={summarising}
              notes={notes}
              notesOpen={notesOpen}
              onToggleNotes={toggleNotes}
              loadingNotes={loadingNotes}
              hasMoreNotes={notesCursor !== null}
              onLoadMoreNotes={() => void loadNotes(notesCursor)}
                    />
          ) : tab === "related" ? (
            <RelatedDealsTab
              deals={insights?.deals ?? []}
              dealNotes={conversation?.overview.dealNotes ?? []}
              relatedCompanies={insights?.relatedCompanies ?? []}
              firstName={firstName}
              synced={Boolean(insights?.interactions?.hasSyncedData)}
              busy={busy}
              linkRole={linkRole}
              onLinkRoleChange={setLinkRole}
              onLinkDeal={(companyId) =>
                void mutate(() => addContactDeal(contact.id, companyId, linkRole), "Deal linked")
              }
              onRemoveDeal={(companyId) =>
                void mutate(() => removeContactDeal(contact.id, companyId), "Link removed")
              }
            />
          ) : (
            <DealFunnelTab
              scorecard={insights?.scorecard ?? null}
              period={period}
              onPeriodChange={(p) => void handlePeriodChange(p)}
              loading={loadingScorecard}
              contactFirstName={firstName}
            />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 border-t px-5 py-2.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          Summarised by AI from team emails – it can make mistakes.
        </div>
      </DialogContent>
    </Dialog>
  );
}
