"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";
import {
  ChevronDown,
  Copy,
  Info,
  Linkedin,
  Loader2,
  Mail,
  MessagesSquare,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EditContactDialog } from "./EditContactDialog";
import { EditEmployerDialog } from "./EditEmployerDialog";
import { EmployerNotesTab } from "./EmployerNotesTab";
import type { ContactPanelSeed } from "./ContactInsightsPanel";
import { FillContactButton, type EnrichmentRun } from "./FillContactButton";
import type {
  Correspondent,
  EmployerDetail,
  EmployerRelatedCompany,
  EmployerSummary,
  EmployerTopicAssignment,
  TeamMemberSummary,
  TopicChip,
} from "./types";
import {
  colorForId,
  formatResponseP50,
  initialsOf,
  isStaleContact,
  safeProfileUrl,
  tabTriggerCls,
} from "./utils";

/** Firm list columns: Source · Industry · PIC · Activity · Topics · Team · actions. Shared with the header row in CRM.tsx. */
export const FIRM_GRID =
  "grid grid-cols-[minmax(0,20fr)_minmax(0,12fr)_minmax(0,18fr)_minmax(0,14fr)_minmax(0,14fr)_minmax(0,12fr)_104px] gap-3 px-3";

export function EmployerCard({
  employer,
  expanded,
  detail,
  loadingDetail,
  onToggle,
  onAddContact,
  onRefreshDetail,
  onRefreshList,
  onOpenContact,
  searchTerm,
}: {
  employer: EmployerSummary;
  /** The search the list was fetched with; drives the contact filter. */
  searchTerm?: string;
  expanded: boolean;
  detail?: EmployerDetail;
  loadingDetail: boolean;
  onToggle: () => void;
  onAddContact: () => void;
  onRefreshDetail: () => void;
  onRefreshList: () => void;
  /** Opens the contact insights panel for a contact clicked in the Contacts tab. */
  onOpenContact?: (contact: ContactPanelSeed) => void;
}) {
  const lastContact = employer.last_contact_at
    ? formatDistanceToNow(new Date(employer.last_contact_at), {
        addSuffix: true,
      })
    : "—";
  const isStale = isStaleContact(employer.last_contact_at);
  const initials = initialsOf(employer.name);
  const avatarGradient = colorForId(employer.id);
  const metaLabel = employer.status === "inbound" ? "Inbound" : "Outbound";
  const summaryTopics = [...employer.topics]
    .sort(
      (a, b) =>
        Number(b.is_highlight) - Number(a.is_highlight) ||
        (a.source === "auto" ? -1 : 1),
    )
    .slice(0, 2);
  const matched = employer.matched_contacts ?? [];
  const [editingPrimary, setEditingPrimary] = useState(false);
  // The card IS the record here, so a plain boolean is safe: the dialog is
  // keyed by this firm's id and unmounts on close.
  const [editingFirm, setEditingFirm] = useState(false);

  const pic = employer.primary_pic;
  // The primary PIC's full record (for the edit dialog) comes from the firm
  // detail; the pencil loads it when the row was never expanded.
  const primaryContact = pic
    ? (detail?.correspondents.find((c) => c.id === pic.id) ?? null)
    : null;
  const primaryMissing = editingPrimary && !!detail && !primaryContact;
  useEffect(() => {
    if (!primaryMissing) return;
    setEditingPrimary(false);
    toast.error("Could not load this contact");
  }, [primaryMissing]);

  return (
    <div
      className={cn(
        "bg-card transition-colors",
        expanded ? "bg-muted" : "hover:bg-muted",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          FIRM_GRID,
          "cursor-pointer items-center py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        data-testid="crm-firm-row"
      >
        <div className="flex min-w-0 flex-col items-start gap-1">
          <div
            className={cn(
              "grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br text-[11px] font-bold text-white",
              avatarGradient,
            )}
          >
            {initials}
          </div>
          <div className="min-w-0 max-w-full">
            <div className="break-words text-sm font-bold">{employer.name}</div>
            {matched.length > 0 && (
              <div
                className="truncate text-[11px] font-semibold text-blue-600 dark:text-blue-400"
                title={matched.map((m) => m.name).join(", ")}
                data-testid="crm-row-matched-contacts"
              >
                {matched
                  .slice(0, 2)
                  .map((m) => m.name)
                  .join(", ")}
                {matched.length > 2 && ` +${matched.length - 2}`}
              </div>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span>{metaLabel}</span>
              <Badge
                variant="outline"
                className={cn(
                  "inline-flex h-4 items-center gap-0.5 px-1.5 text-[9px] font-semibold uppercase",
                  employer.source === "auto"
                    ? "border-orange-200 bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
                    : "text-muted-foreground",
                )}
              >
                {employer.source === "auto" && <Mail className="h-2.5 w-2.5" />}
                {employer.source}
              </Badge>
            </div>
          </div>
        </div>

        <div className="min-w-0 truncate text-xs">{employer.industry ?? "—"}</div>

        <div className="min-w-0 break-words">
          {pic ? (
            <>
              <div className="truncate text-sm font-bold">{pic.name}</div>
              <div className="truncate text-xs text-muted-foreground">{pic.title ?? "—"}</div>
              {pic.email && (
                <a
                  href={`mailto:${pic.email}`}
                  onClick={(e) => e.stopPropagation()}
                  className="block truncate text-xs text-primary hover:underline"
                >
                  {pic.email}
                </a>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No PIC yet</span>
          )}
        </div>

        <div className="min-w-0">
          <div
            className={cn(
              "truncate text-sm font-semibold",
              isStale && "text-destructive",
            )}
            title={
              employer.last_contact_at
                ? format(new Date(employer.last_contact_at), "MMM d, yyyy")
                : undefined
            }
          >
            {lastContact}
          </div>
          <div
            className="truncate text-xs text-muted-foreground"
            title={
              employer.response_pair_count > 0
                ? `Median reply time over ${employer.response_pair_count} pair${employer.response_pair_count === 1 ? "" : "s"}`
                : undefined
            }
          >
            P50 ·{" "}
            {employer.response_pair_count > 0
              ? formatResponseP50(employer.response_p50_seconds)
              : "—"}
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-1 truncate text-xs text-muted-foreground">
            {employer.email_count} email{employer.email_count === 1 ? "" : "s"}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {summaryTopics.length === 0 ? (
              <span className="text-xs text-muted-foreground">No tags</span>
            ) : (
              summaryTopics.map((t) => (
                <div key={t.id} className="min-w-0 max-w-full truncate">
                  <TopicChipBadge topic={t} />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0">
          {employer.team.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              {employer.team.slice(0, 2).map((t) => (
                <Badge
                  key={t.id}
                  variant="outline"
                  className="h-auto max-w-full whitespace-normal bg-card px-2 py-0.5 text-[10px] font-semibold leading-tight text-muted-foreground"
                >
                  {t.name}
                </Badge>
              ))}
              {employer.team.length > 2 && (
                <Badge
                  variant="outline"
                  className="h-auto bg-card px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
                  title={employer.team
                    .slice(2)
                    .map((t) => t.name)
                    .join(", ")}
                >
                  +{employer.team.length - 2}
                </Badge>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-0.5">
          {pic && onOpenContact && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenContact(pic);
              }}
              className="grid h-[26px] w-[26px] place-items-center rounded-md bg-primary/10 text-primary transition-colors hover:bg-primary/20"
              aria-label={`Conversation with ${pic.name}`}
              title="Conversation — AI-summarised notes from your team"
              data-testid="crm-firm-conversation"
            >
              <MessagesSquare className="h-3.5 w-3.5" />
            </button>
          )}
          {pic && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditingPrimary(true);
                if (!detail && !loadingDetail) onRefreshDetail();
              }}
              className="grid h-[26px] w-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              aria-label={`Edit ${pic.name}`}
              title="Edit contact"
              data-testid="crm-firm-edit-primary"
            >
              {editingPrimary && !primaryContact ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Pencil className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <span className="grid h-[26px] w-[26px] place-items-center text-muted-foreground">
            <ChevronDown
              className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")}
            />
          </span>
        </div>
      </div>

      {editingPrimary && primaryContact && (
        <EditContactDialog
          key={primaryContact.id}
          contact={primaryContact}
          open={!!primaryContact}
          onOpenChange={(open) => {
            if (!open) setEditingPrimary(false);
          }}
          onSaved={() => {
            setEditingPrimary(false);
            onRefreshDetail();
            onRefreshList();
          }}
        />
      )}

      {editingFirm && detail && (
        <EditEmployerDialog
          key={employer.id}
          employerId={employer.id}
          name={employer.name}
          industry={employer.industry}
          team={detail.team}
          open={editingFirm}
          onOpenChange={(open) => {
            if (!open) setEditingFirm(false);
          }}
          onSaved={() => {
            setEditingFirm(false);
            onRefreshDetail();
            onRefreshList();
          }}
        />
      )}

      {expanded && (
        <div className="border-t bg-background">
          {/* Only show the spinner on the INITIAL load (no detail yet). During a
              background refetch (e.g. after reclassifying a topic) `detail` is
              still populated, so we keep rendering it in place — swapping to a
              spinner on every refresh caused the card to blink. */}
          {!detail ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ExpandedTabs
              employerId={employer.id}
              detail={detail}
              onEditFirm={() => setEditingFirm(true)}
              matchedContactIds={matched.map((m) => m.id)}
              searchTerm={searchTerm}
              onAddContact={onAddContact}
              onRefreshDetail={onRefreshDetail}
              onRefreshList={onRefreshList}
              onOpenContact={onOpenContact}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TopicChipBadge({
  topic,
}: {
  topic: TopicChip | EmployerTopicAssignment;
}) {
  const cls =
    topic.source === "auto"
      ? "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300"
      : "bg-muted text-foreground";
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4 px-1.5 text-[10px] font-semibold",
        cls,
        topic.is_highlight && "ring-1 ring-blue-300",
      )}
    >
      {topic.name}
    </Badge>
  );
}

function TopicChipWithActions({
  topic,
  onReclassify,
  onRemove,
  onDragStart,
  onDragEnd,
}: {
  topic: EmployerTopicAssignment;
  onReclassify: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className="group relative cursor-grab active:cursor-grabbing"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", topic.topic_id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <TopicChipBadge topic={topic} />
      <div className="absolute -right-1 -top-1 hidden gap-0.5 group-hover:flex">
        <button
          className="flex h-4 w-4 items-center justify-center rounded-full border bg-background text-[10px] hover:bg-blue-50"
          onClick={onReclassify}
          aria-label={topic.is_deal_related ? "Move to non-deal" : "Move to deal"}
          title={topic.is_deal_related ? "Move to Non-Deal Related" : "Move to Deal Related"}
        >
          ⇄
        </button>
        <button
          className="flex h-4 w-4 items-center justify-center rounded-full border bg-background text-[10px] hover:bg-red-50"
          onClick={onRemove}
          aria-label="Remove tag"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function TopicDropZone({
  label,
  labelClassName,
  topics,
  isDealZone,
  dragActive,
  dragOver,
  onDragEnterZone,
  onDragLeaveZone,
  onDrop,
  onDragStartChip,
  onDragEndChip,
  onReclassify,
  onRemove,
}: {
  label: string;
  labelClassName: string;
  topics: EmployerTopicAssignment[];
  isDealZone: boolean;
  dragActive: boolean;
  dragOver: boolean;
  onDragEnterZone: () => void;
  onDragLeaveZone: () => void;
  onDrop: () => void;
  onDragStartChip: (t: EmployerTopicAssignment) => void;
  onDragEndChip: () => void;
  onReclassify: (t: EmployerTopicAssignment) => void;
  onRemove: (t: EmployerTopicAssignment) => void;
}) {
  return (
    <div
      className={cn(
        "mb-3 rounded-md border border-transparent p-1 transition-colors",
        dragActive && "border-dashed border-muted-foreground/30",
        dragOver && "border-blue-400 bg-blue-50/50 dark:bg-blue-950/20",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={onDragEnterZone}
      onDragLeave={(e) => {
        // Ignore leave events bubbling from child chips.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) onDragLeaveZone();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <p
        className={cn(
          "mb-1.5 text-[10px] font-bold uppercase tracking-wider",
          labelClassName,
        )}
      >
        {label}
      </p>
      <div className="flex min-h-[1.25rem] flex-wrap gap-2">
        {topics.length === 0 ? (
          <span className="text-[10px] italic text-muted-foreground">
            {dragActive
              ? `Drop here to mark ${isDealZone ? "deal" : "non-deal"} related`
              : "—"}
          </span>
        ) : (
          topics.map((t) => (
            <TopicChipWithActions
              key={t.id}
              topic={t}
              onReclassify={() => onReclassify(t)}
              onRemove={() => onRemove(t)}
              onDragStart={() => onDragStartChip(t)}
              onDragEnd={onDragEndChip}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ExpandedTabs({
  employerId,
  detail,
  onEditFirm,
  matchedContactIds,
  searchTerm,
  onAddContact,
  onRefreshDetail,
  onRefreshList,
  onOpenContact,
}: {
  employerId: string;
  detail: EmployerDetail;
  onEditFirm: () => void;
  matchedContactIds: string[];
  searchTerm?: string;
  onAddContact: () => void;
  onRefreshDetail: () => void;
  onRefreshList: () => void;
  onOpenContact?: (contact: ContactPanelSeed) => void;
}) {
  return (
    <Tabs defaultValue="contacts" className="w-full">
      <div className="flex items-end justify-between gap-3 border-b bg-background px-5 pt-5">
      <TabsList className="h-auto justify-start gap-6 rounded-none bg-background p-0">
        <TabsTrigger value="contacts" className={tabTriggerCls}>
          Contacts
          <span className="ml-1">
            ({matchedContactIds.length > 0
              ? `${detail.correspondents.filter((c) => matchedContactIds.includes(c.id)).length} of ${detail.correspondents.length}`
              : detail.correspondents.length})
          </span>
        </TabsTrigger>
        <TabsTrigger value="topics" className={tabTriggerCls}>
          Topics Tag
          <span className="ml-1">({detail.topics.length})</span>
        </TabsTrigger>
        <TabsTrigger value="related-companies" className={tabTriggerCls}>
          Related Companies
          <span className="ml-1">({detail.related_companies.length})</span>
        </TabsTrigger>
        <TabsTrigger value="notes" className={tabTriggerCls}>
          Notes
        </TabsTrigger>
      </TabsList>
        <Button
          variant="ghost"
          size="sm"
          className="mb-1 h-7 gap-1.5 px-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
          onClick={onEditFirm}
          title="Edit this firm's name, industry and team"
          data-testid="crm-firm-edit"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit firm
        </Button>
      </div>

      <TabsContent value="contacts" className="px-5 pb-5 pt-4">
        <ContactsTab
          employerId={employerId}
          correspondents={detail.correspondents}
          matchedContactIds={matchedContactIds}
          searchTerm={searchTerm}
          onAddContact={onAddContact}
          onOpenContact={onOpenContact}
          onChanged={() => {
            onRefreshDetail();
            onRefreshList();
          }}
        />
      </TabsContent>

      <TabsContent value="topics" className="px-5 pb-5 pt-4">
        <TopicsTab
          employerId={employerId}
          topics={detail.topics}
          onChanged={() => {
            onRefreshDetail();
            onRefreshList();
          }}
        />
      </TabsContent>

      <TabsContent value="related-companies" className="px-5 pb-5 pt-4">
        <RelatedCompaniesTab
          employerId={employerId}
          companies={detail.related_companies}
          onChanged={onRefreshDetail}
        />
      </TabsContent>

      <TabsContent value="notes" className="px-5 pb-5 pt-4">
        <EmployerNotesTab
          employerId={employerId}
          notes={detail.notes}
          team={detail.team}
          onChanged={onRefreshDetail}
        />
      </TabsContent>
    </Tabs>
  );
}

function ContactsTab({
  employerId,
  correspondents,
  matchedContactIds,
  searchTerm,
  onAddContact,
  onChanged,
  onOpenContact,
}: {
  employerId: string;
  correspondents: Correspondent[];
  /** Server-matched contact ids; non-empty narrows the list to them. */
  matchedContactIds: string[];
  searchTerm?: string;
  onAddContact: () => void;
  onChanged: () => void;
  onOpenContact?: (contact: ContactPanelSeed) => void;
}) {
  // Record-scoped dialog: `open` is derived from the selection rather than
  // tracked as a second boolean, per .claude/rules/dialog-open-state.md. The
  // row is already in hand, so there is no fetch to race on open.
  const [editing, setEditing] = useState<Correspondent | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Correspondent | null>(null);
  const [busyContactId, setBusyContactId] = useState<string | null>(null);

  // PIC and delete are per workspace: picking a PIC records this workspace's
  // choice, and Delete unlinks the contact from this workspace only.
  const makePrimary = async (c: Correspondent) => {
    setBusyContactId(c.id);
    try {
      const res = await fetch(`/api/crm/employers/${employerId}/primary-contact`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correspondent_id: c.id }),
      });
      if (!res.ok) throw new Error("Could not set the primary contact");
      toast.success(`${c.name} is now the primary contact`);
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyContactId(null);
    }
  };

  const removeContact = async (c: Correspondent) => {
    setBusyContactId(c.id);
    try {
      const res = await fetch(`/api/crm/correspondents/${c.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not delete the contact");
      toast.success(`${c.name} removed from this workspace`);
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyContactId(null);
      setConfirmDelete(null);
    }
  };
  // Every row's latest @crm_contact run in one request, so the fill buttons
  // can render their state without a GET per rendered contact.
  const [enrichRuns, setEnrichRuns] = useState<Record<string, EnrichmentRun>>(
    {},
  );
  const enrichRunsLive = useRef(true);
  // A person search narrows the table to the people who matched; "Show all"
  // reveals the rest of the firm without refetching. A new search resets it.
  const matchKey = matchedContactIds.join(",");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [matchKey]);
  const filtering = matchedContactIds.length > 0;
  const visible =
    filtering && !showAll
      ? correspondents.filter((c) => matchedContactIds.includes(c.id))
      : correspondents;

  const loadEnrichRuns = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/crm/employers/${employerId}/contact-enrichment`,
        { credentials: "same-origin" },
      );
      if (!res.ok) return;
      const { data } = (await res.json()) as {
        data: Record<string, EnrichmentRun>;
      };
      if (enrichRunsLive.current) setEnrichRuns(data ?? {});
    } catch {
      // No run state is the same as no runs — the buttons stay idle and a
      // click still works.
    }
  }, [employerId]);

  useEffect(() => {
    enrichRunsLive.current = true;
    void loadEnrichRuns();
    return () => {
      enrichRunsLive.current = false;
    };
  }, [loadEnrichRuns]);

  return (
    <>
      <div className="mb-2 flex items-center justify-end gap-3">
        {filtering && (
          <div
            className="mr-auto text-xs text-muted-foreground"
            data-testid="crm-contact-search-filter"
          >
            {showAll ? (
              <>Showing all {correspondents.length} contacts · </>
            ) : (
              <>
                Showing {visible.length} of {correspondents.length} contacts
                matching <b className="text-foreground">“{searchTerm}”</b> ·{" "}
              </>
            )}
            <button
              type="button"
              className="font-semibold text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Only matches" : "Show all"}
            </button>
          </div>
        )}
        <button
          className="text-sm font-bold text-blue-600 hover:underline dark:text-blue-400"
          onClick={onAddContact}
        >
          + Add contact
        </button>
      </div>
      {visible.length === 0 ? (
        <div className="py-6 text-sm text-muted-foreground">
          {filtering && correspondents.length > 0 && !showAll
            ? "No contacts match this search."
            : "No contacts on file."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <div className="min-w-[1000px] text-xs">
            <div
              className={cn(
                CONTACT_GRID,
                "border-b bg-muted text-xs font-bold uppercase tracking-wider text-foreground",
              )}
            >
              <div className="px-2.5 py-1.5">Name</div>
              <div className="px-2.5 py-1.5">Email / Phone</div>
              <div className="px-2.5 py-1.5">Area Focus</div>
              <div className="px-2.5 py-1.5">Industry Focus</div>
              <div className="px-2.5 py-1.5">Profile</div>
              <div className="px-2.5 py-1.5 text-center">Action</div>
            </div>
            {visible.map((c) => {
              // Profile fields are free text, so the stored URL is only safe to
              // put in an href once its scheme has been checked.
              const linkedinHref = safeProfileUrl(c.linkedin_url);
              const subtitle = c.title || c.department || c.seniority;
              return (
                <div
                  key={c.id}
                  className={cn(
                    CONTACT_GRID,
                    "min-h-12 items-center border-b last:border-b-0",
                  )}
                  data-testid="crm-contact-row"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-1.5">
                    <span className="whitespace-nowrap">{c.name}</span>
                    {linkedinHref && (
                      <a
                        href={linkedinHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={`${c.name} on LinkedIn`}
                        title="LinkedIn"
                      >
                        <Linkedin className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {c.is_primary && (
                      <Badge
                        variant="outline"
                        className="h-auto border-transparent bg-emerald-50 px-1.5 py-0.5 text-xs font-normal text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                      >
                        Primary
                      </Badge>
                    )}
                    {subtitle && (
                      <span
                        className="w-full truncate text-xs text-muted-foreground"
                        title={subtitle}
                      >
                        {subtitle}
                      </span>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5 px-2.5 py-1.5">
                    {c.email && (
                      <CopyLine value={c.email} label="email">
                        <a
                          href={`mailto:${c.email}`}
                          className="truncate font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {c.email}
                        </a>
                      </CopyLine>
                    )}
                    {c.phone && (
                      <CopyLine value={c.phone} label="phone">
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      </CopyLine>
                    )}
                    {!c.email && !c.phone && (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="min-w-0 px-2.5 py-1.5">
                    <FocusTag value={c.coverage_region} />
                  </div>
                  <div className="min-w-0 px-2.5 py-1.5">
                    <FocusTag value={c.specialization} />
                  </div>
                  <div className="min-w-0 px-2.5 py-1.5">
                    <ContactProfileCell
                      contact={c}
                      initialRun={enrichRuns[c.id]}
                      onFilled={() => {
                        onChanged();
                        void loadEnrichRuns();
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-end gap-1 px-2.5 py-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => setEditing(c)}
                      aria-label={`Edit ${c.name}`}
                      title="Edit contact"
                      data-testid="crm-contact-edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {!c.is_primary && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => void makePrimary(c)}
                        disabled={busyContactId === c.id}
                        aria-label={`Make ${c.name} the primary contact`}
                        title="Make primary contact"
                        data-testid="crm-contact-make-primary"
                      >
                        <Star className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setConfirmDelete(c)}
                      disabled={busyContactId === c.id}
                      aria-label={`Delete ${c.name}`}
                      title="Delete contact"
                      data-testid="crm-contact-delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    {onOpenContact && (
                      <button
                        type="button"
                        className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                        onClick={() => onOpenContact(c)}
                        aria-label={`Conversation with ${c.name}`}
                        title="AI-summarised conversation notes from your team"
                        data-testid="contact-conversation-open"
                      >
                        <MessagesSquare className="h-3.5 w-3.5" />
                        Conversation
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {confirmDelete && (
        <Dialog
          key={confirmDelete.id}
          open={!!confirmDelete}
          onOpenChange={(o) => {
            if (!o) setConfirmDelete(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete {confirmDelete.name}?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              They are removed from this workspace&apos;s CRM. Other workspaces
              keep them. If a synced mailbox here emails them again, they come
              back.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void removeContact(confirmDelete)}
                disabled={busyContactId === confirmDelete.id}
                data-testid="crm-contact-delete-confirm"
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {editing && (
        <EditContactDialog
          key={editing.id}
          contact={editing}
          open={!!editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

const CONTACT_GRID =
  "grid grid-cols-[2.2fr_2.2fr_1.4fr_1.4fr_3fr_2.2fr]";

/** Area / industry focus as one outlined tag, or "—". */
function FocusTag({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className="inline-flex h-5 max-w-full items-center rounded border bg-muted px-1.5 text-xs text-muted-foreground"
      title={value}
    >
      <span className="truncate">{value}</span>
    </span>
  );
}

/** A line with a copy-to-clipboard button revealed on hover. */
function CopyLine({
  value,
  label,
  children,
}: {
  value: string;
  label: string;
  children: React.ReactNode;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${label}`);
    } catch {
      toast.error(`Could not copy ${label}`);
    }
  };
  return (
    <div className="group/copy flex min-w-0 items-center gap-1" title={value}>
      {children}
      <button
        type="button"
        onClick={() => void copy()}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-blue-600 focus-visible:opacity-100 group-hover/copy:opacity-100"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        <Copy className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * The contact's Profile cell, laid out like prototype v2.4: "Get Full Profile"
 * until there is a bio, then an "AI research" label with a Refresh control
 * over the bio (three lines, "Show more" only when it is cut off) and the AI
 * disclaimer. Area and industry focus have their own columns, so they are not
 * repeated here.
 */
function ContactProfileCell({
  contact,
  initialRun,
  onFilled,
}: {
  contact: Correspondent;
  initialRun?: EnrichmentRun | null;
  onFilled: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const bioRef = useRef<HTMLParagraphElement>(null);
  const bio = contact.bio?.trim();

  useLayoutEffect(() => {
    const el = bioRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [bio, expanded]);

  if (!bio) {
    // A finished run that found no bio still filled what it could prove;
    // say so instead of offering the button as if nothing had happened.
    const searched = initialRun?.status === "succeeded" && !initialRun.active;
    return (
      <div className="flex flex-col gap-0.5 py-0.5" data-testid="contact-profile-cell">
        {searched && (
          <span className="text-xs text-muted-foreground" data-testid="contact-profile-no-bio">
            No public bio found.
          </span>
        )}
        <FillContactButton
          correspondentId={contact.id}
          contactName={contact.name}
          initialRun={initialRun}
          onFilled={onFilled}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 py-0.5" data-testid="contact-profile-cell">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-primary">
          <Sparkles className="h-3 w-3" />
          AI research
        </span>
        {/* A refresh run rewrites the bio and updates stale fields; a plain
            fill would change nothing here, since it only fills gaps. Handed
            only a refresh run, so one in flight resumes after a reload while
            a fill that just finished (and brought this bio) is not picked up
            a second time — the contacts and the runs refetch separately. The
            wrapper keeps the button's self-start off the label's centre line. */}
        <div className="shrink-0">
          <FillContactButton
            correspondentId={contact.id}
            contactName={contact.name}
            initialRun={initialRun?.mode === "refresh" ? initialRun : null}
            onFilled={onFilled}
            refresh
          />
        </div>
      </div>
      <p
        ref={bioRef}
        className={cn("whitespace-normal text-xs text-foreground", !expanded && "line-clamp-3")}
      >
        {bio}
      </p>
      {(clamped || expanded) && (
        <button
          type="button"
          className="self-start text-xs font-semibold text-primary hover:underline"
          onClick={() => setExpanded((v) => !v)}
          data-testid="contact-profile-expand"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      <p
        className="flex items-center gap-1 text-xs text-muted-foreground"
        data-testid="crm-contact-bio-disclaimer"
      >
        <Info className="h-3 w-3 shrink-0" />
        <span>AI-generated – it can make mistakes.</span>
      </p>
    </div>
  );
}

function TopicsTab({
  employerId,
  topics,
  onChanged,
}: {
  employerId: string;
  topics: EmployerTopicAssignment[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [isDealRelated, setIsDealRelated] = useState(true);
  const [confirmRemove, setConfirmRemove] =
    useState<EmployerTopicAssignment | null>(null);
  const [dragging, setDragging] = useState<EmployerTopicAssignment | null>(null);
  const [dragOverDeal, setDragOverDeal] = useState<boolean | null>(null);

  const dealTopics = topics.filter((t) => t.is_deal_related);
  const nonDealTopics = topics.filter((t) => !t.is_deal_related);

  const handleAdd = async () => {
    const v = name.trim();
    if (!v) {
      toast.error("Enter a tag name");
      return;
    }
    const res = await fetch(`/api/crm/employers/${employerId}/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: v, is_deal_related: isDealRelated }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error || "Failed to add tag");
      return;
    }
    toast.success("Tag added");
    setName("");
    setAdding(false);
    onChanged();
  };

  const setDealRelated = async (
    topic: EmployerTopicAssignment,
    value: boolean,
  ) => {
    if (topic.is_deal_related === value) return;
    const res = await fetch(
      `/api/crm/employers/${employerId}/topics/${topic.topic_id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_deal_related: value }),
      },
    );
    if (!res.ok) {
      toast.error("Failed to reclassify tag");
      return;
    }
    onChanged();
  };

  const handleDropTo = (value: boolean) => {
    const t = dragging;
    setDragging(null);
    setDragOverDeal(null);
    if (t) void setDealRelated(t, value);
  };

  const handleRemove = async (topic: EmployerTopicAssignment) => {
    const res = await fetch(
      `/api/crm/employers/${employerId}/topics/${topic.topic_id}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      toast.error("Failed to remove tag");
      return;
    }
    toast.success(
      topic.source === "auto" ? "Auto tag dismissed" : "Tag removed",
    );
    setConfirmRemove(null);
    onChanged();
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        <span>Topics Tag ({topics.length})</span>
        <button
          className="text-xs font-bold normal-case text-blue-600 hover:underline"
          onClick={() => setAdding(true)}
        >
          + Add tag
        </button>
      </div>

      {topics.length === 0 && !adding && (
        <span className="text-xs text-muted-foreground">No topic tags yet.</span>
      )}

      {topics.length > 0 && (
        <>
          <TopicDropZone
            label="Deal Related"
            labelClassName="text-blue-600"
            topics={dealTopics}
            isDealZone={true}
            dragActive={dragging !== null && !dragging.is_deal_related}
            dragOver={dragOverDeal === true}
            onDragEnterZone={() => setDragOverDeal(true)}
            onDragLeaveZone={() => setDragOverDeal((v) => (v === true ? null : v))}
            onDrop={() => handleDropTo(true)}
            onDragStartChip={setDragging}
            onDragEndChip={() => {
              setDragging(null);
              setDragOverDeal(null);
            }}
            onReclassify={(t) => setDealRelated(t, false)}
            onRemove={setConfirmRemove}
          />

          <TopicDropZone
            label="Non-Deal Related"
            labelClassName="text-muted-foreground"
            topics={nonDealTopics}
            isDealZone={false}
            dragActive={dragging !== null && dragging.is_deal_related}
            dragOver={dragOverDeal === false}
            onDragEnterZone={() => setDragOverDeal(false)}
            onDragLeaveZone={() => setDragOverDeal((v) => (v === false ? null : v))}
            onDrop={() => handleDropTo(false)}
            onDragStartChip={setDragging}
            onDragEndChip={() => {
              setDragging(null);
              setDragOverDeal(null);
            }}
            onReclassify={(t) => setDealRelated(t, true)}
            onRemove={setConfirmRemove}
          />
        </>
      )}

      {adding && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border text-xs font-semibold overflow-hidden">
            <button
              className={`px-3 py-1 ${isDealRelated ? "bg-blue-600 text-white" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => setIsDealRelated(true)}
            >
              Deal Related
            </button>
            <button
              className={`px-3 py-1 ${!isDealRelated ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => setIsDealRelated(false)}
            >
              Non-deal related
            </button>
          </div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tag name…"
            list="topic-suggestions"
            className="max-w-[200px]"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
              if (e.key === "Escape") {
                setAdding(false);
                setName("");
              }
            }}
          />
          <Button size="sm" onClick={handleAdd}>
            Add
          </Button>
          <button
            className="text-xs font-semibold text-muted-foreground hover:text-foreground"
            onClick={() => {
              setAdding(false);
              setName("");
            }}
          >
            Cancel
          </button>
        </div>
      )}

      <div className="mt-3 text-[10px] text-muted-foreground">
        <Badge
          variant="outline"
          className="mr-1 h-4 border-orange-200 bg-orange-50 px-1.5 text-[10px] font-semibold text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
        >
          Auto
        </Badge>{" "}
        from emails &nbsp;·&nbsp;{" "}
        <Badge variant="outline" className="mr-1 h-4 px-1.5 text-[10px] font-semibold">
          Manual
        </Badge>{" "}
        added by you
      </div>

      <Dialog
        open={!!confirmRemove}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete topic?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmRemove?.source === "auto" ? "Dismiss" : "Delete"} topic "
            {confirmRemove?.name}"? This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmRemove && handleRemove(confirmRemove)}
            >
              Yes, delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const CONFIDENCE_BADGE: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300",
  medium: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300",
  low: "text-muted-foreground",
};

function RelatedCompaniesTab({
  employerId,
  companies,
  onChanged,
}: {
  employerId: string;
  companies: EmployerRelatedCompany[];
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const handleAdd = async (companyId: string) => {
    const res = await fetch(
      `/api/crm/employers/${employerId}/related-companies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error || "Failed to add company");
      return;
    }
    toast.success("Company linked");
    onChanged();
  };

  const handleRemove = async (id: string) => {
    setRemoving(id);
    const res = await fetch(
      `/api/crm/employers/${employerId}/related-companies/${id}`,
      { method: "DELETE" },
    );
    setRemoving(null);
    if (!res.ok) {
      toast.error("Failed to remove company");
      return;
    }
    toast.success("Company removed");
    onChanged();
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Related Companies ({companies.length})
        </div>
        <RelatedCompanyPicker onSelect={handleAdd} />
      </div>
      {companies.length === 0 ? (
        <div className="py-6 text-sm text-muted-foreground">
          No related companies yet. Use "Add company" to link one.
        </div>
      ) : (
      <div className="divide-y">
        {companies.map((c) => (
          <div key={c.id} className="py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-bold truncate">{c.company_name}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-4 px-1.5 text-[9px] font-semibold uppercase",
                      c.source === "auto"
                        ? "border-orange-200 bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
                        : "text-muted-foreground",
                    )}
                  >
                    {c.source}
                  </Badge>
                  {c.source !== "manual" && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-4 px-1.5 text-[9px] font-semibold",
                        CONFIDENCE_BADGE[c.confidence] ?? "text-muted-foreground",
                      )}
                    >
                      {c.confidence}
                    </Badge>
                  )}
                </div>
                {c.reason_summary && (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {c.reason_summary}
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                  {c.evidence_count > 0 && (
                    <span>{c.evidence_count} evidence</span>
                  )}
                  {c.last_seen_at && (
                    <span>
                      Last: {format(new Date(c.last_seen_at), "MMM d, yyyy")}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {c.evidence.length > 0 && (
                  <button
                    type="button"
                    className="text-[10px] font-semibold text-blue-600 hover:underline"
                    onClick={() =>
                      setExpanded(expanded === c.id ? null : c.id)
                    }
                  >
                    {expanded === c.id ? "Hide" : "Show"} evidence
                  </button>
                )}
                {/* A manual link is deleted; an auto suggestion is dismissed
                    for this workspace so the next ingest does not bring it
                    back. The server picks which by the row's source. */}
                <button
                  type="button"
                  aria-label={c.source === "manual" ? "Remove company" : "Dismiss suggestion"}
                  title={c.source === "manual" ? "Remove company" : "Dismiss suggestion"}
                  disabled={removing === c.id}
                  className="text-muted-foreground hover:text-red-600 disabled:opacity-50"
                  onClick={() => handleRemove(c.id)}
                  data-testid="crm-related-company-remove"
                >
                  {removing === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
            {expanded === c.id && (
              <div className="mt-2 space-y-1.5">
                {c.evidence.map((e) => (
                  <div
                    key={e.id}
                    className="rounded border bg-muted/40 px-3 py-2 text-xs"
                  >
                    {e.matched_text && (
                      <blockquote className="mb-1 border-l-2 border-blue-300 pl-2 italic text-muted-foreground">
                        "{e.matched_text}"
                      </blockquote>
                    )}
                    <div className="text-[10px] text-muted-foreground">
                      {e.reason_summary ?? e.reason}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      )}
      <div className="mt-3 text-[10px] text-muted-foreground">
        <Badge
          variant="outline"
          className="mr-1 h-4 border-orange-200 bg-orange-50 px-1.5 text-[10px] font-semibold text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
        >
          auto
        </Badge>{" "}
        detected from email evidence — suggestions only, not guaranteed truth
      </div>
    </div>
  );
}

/**
 * Company combobox backed by `GET /api/companies?lite=true&q=` (Master Data /
 * public.companies). Returns the picked company's id to the parent.
 */
function RelatedCompanyPicker({
  onSelect,
}: {
  onSelect: (companyId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<Array<{ id: string; target: string | null }>>(
    [],
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(h);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ lite: "true", limit: "50" });
    if (debounced) params.set("q", debounced);
    fetch(`/api/companies?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const rows = (j.data ?? []) as Array<{ id: string; target: string | null }>;
        setItems(rows.filter((c) => c.target));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced]);

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3 w-3" /> Add company
      </Button>
    );
  }

  return (
    <div className="relative w-56">
      <Input
        autoFocus
        placeholder="Search Master Data…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="h-7 text-xs"
      />
      <div className="absolute right-0 z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
        {loading ? (
          <div className="py-3 text-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="py-3 text-center text-xs text-muted-foreground">
            {debounced ? "No matching company" : "Type to search"}
          </div>
        ) : (
          items.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-center rounded p-1.5 text-left text-sm hover:bg-muted"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(c.id);
                setOpen(false);
                setQuery("");
              }}
            >
              {c.target}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
