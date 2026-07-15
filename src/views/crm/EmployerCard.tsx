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
import { ChevronDown, Loader2, Mail, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  EmployerDetail,
  EmployerNote,
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
  tabTriggerCls,
} from "./utils";

export function EmployerCard({
  employer,
  expanded,
  detail,
  loadingDetail,
  onToggle,
  onAddContact,
  onRefreshDetail,
  onRefreshList,
}: {
  employer: EmployerSummary;
  expanded: boolean;
  detail?: EmployerDetail;
  loadingDetail: boolean;
  onToggle: () => void;
  onAddContact: () => void;
  onRefreshDetail: () => void;
  onRefreshList: () => void;
}) {
  const lastContact = employer.last_contact_at
    ? formatDistanceToNow(new Date(employer.last_contact_at), {
        addSuffix: true,
      })
    : "—";
  const isStale = employer.last_contact_at
    ? Date.now() - new Date(employer.last_contact_at).getTime() >
      30 * 24 * 60 * 60 * 1000
    : true;
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

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card transition-all",
        expanded
          ? "border-blue-500 shadow-md shadow-blue-500/10"
          : "hover:border-foreground/20",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[36px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_28px] items-center gap-3 px-3 py-2.5 text-left"
      >
        <div
          className={cn(
            "grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br text-xs font-bold text-white",
            avatarGradient,
          )}
        >
          {initials}
        </div>

        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{employer.name}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
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

        <div className="min-w-0 truncate text-xs font-semibold text-muted-foreground">
          {employer.industry ?? "—"}
        </div>

        <div className="min-w-0">
          {employer.primary_pic ? (
            <>
              <div className="truncate text-sm font-semibold">
                {employer.primary_pic.name}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {employer.primary_pic.title ?? "—"}
              </div>
              {employer.primary_pic.email && (
                <div className="truncate font-mono text-[9px] text-blue-600 dark:text-blue-400">
                  {employer.primary_pic.email}
                </div>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No PIC yet</span>
          )}
        </div>

        <div className="min-w-0">
          {employer.response_pair_count > 0 ? (
            <>
              <div className="truncate text-sm font-semibold">
                {formatResponseP50(employer.response_p50_seconds)}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {employer.response_pair_count} pair
                {employer.response_pair_count === 1 ? "" : "s"}
              </div>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>

        <div className="min-w-0">
          <div
            className={cn(
              "truncate text-sm font-semibold",
              isStale ? "text-orange-600" : "text-emerald-600",
            )}
          >
            {lastContact}
          </div>
          {employer.last_contact_at && (
            <div className="truncate text-[10px] text-muted-foreground">
              {format(new Date(employer.last_contact_at), "MMM d, yyyy")}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-0.5 truncate text-xs font-semibold">
            {employer.email_count} email{employer.email_count === 1 ? "" : "s"}
          </div>
          <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
            {summaryTopics.length === 0 ? (
              <span className="text-[10px] text-muted-foreground">No tags</span>
            ) : (
              summaryTopics.map((t) => (
                <div key={t.id} className="min-w-0 flex-shrink truncate">
                  <TopicChipBadge topic={t} />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0">
          {employer.team.length === 0 ? (
            <span className="text-[10px] text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
              {employer.team.slice(0, 3).map((t) => (
                <Badge
                  key={t.id}
                  variant="outline"
                  className="h-4 max-w-[80px] flex-shrink-0 truncate px-1.5 text-[10px] font-semibold"
                >
                  {t.name.split(" ")[0]}
                </Badge>
              ))}
              {employer.team.length > 3 && (
                <Badge
                  variant="outline"
                  className="h-4 flex-shrink-0 px-1.5 text-[10px]"
                >
                  +{employer.team.length - 3}
                </Badge>
              )}
            </div>
          )}
        </div>

        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

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
              onAddContact={onAddContact}
              onRefreshDetail={onRefreshDetail}
              onRefreshList={onRefreshList}
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
  onAddContact,
  onRefreshDetail,
  onRefreshList,
}: {
  employerId: string;
  detail: EmployerDetail;
  onAddContact: () => void;
  onRefreshDetail: () => void;
  onRefreshList: () => void;
}) {
  return (
    <Tabs defaultValue="contacts" className="w-full">
      <TabsList className="h-auto w-full justify-start rounded-none border-b bg-background px-5 py-0">
        <TabsTrigger value="contacts" className={tabTriggerCls}>
          Contacts{" "}
          <span className="ml-1 text-xs">({detail.correspondents.length})</span>
        </TabsTrigger>
        <TabsTrigger value="topics" className={tabTriggerCls}>
          Topics Tag{" "}
          <span className="ml-1 text-xs">({detail.topics.length})</span>
        </TabsTrigger>
        <TabsTrigger value="related-companies" className={tabTriggerCls}>
          Related Companies{" "}
          <span className="ml-1 text-xs">({detail.related_companies.length})</span>
        </TabsTrigger>
        <TabsTrigger value="notes" className={tabTriggerCls}>
          Notes
        </TabsTrigger>
      </TabsList>

      <TabsContent value="contacts" className="px-5 pb-5 pt-4">
        <div className="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <span>Contacts ({detail.correspondents.length})</span>
          <button
            className="text-xs font-bold normal-case text-blue-600 hover:underline"
            onClick={onAddContact}
          >
            + Add contact
          </button>
        </div>
        <div className="divide-y">
          {detail.correspondents.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              No contacts on file.
            </div>
          ) : (
            detail.correspondents.map((c) => (
              <div key={c.id} className="flex items-start gap-3 py-3">
                <div
                  className={cn(
                    "grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br text-[10px] font-bold text-white",
                    colorForId(c.id),
                  )}
                >
                  {initialsOf(c.name)}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-bold">
                    {c.name}
                    {c.is_primary && (
                      <Badge
                        variant="outline"
                        className="ml-2 h-4 bg-emerald-50 px-1.5 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                      >
                        Primary
                      </Badge>
                    )}
                  </div>
                  {c.title && (
                    <div className="text-xs text-muted-foreground">
                      {c.title}
                    </div>
                  )}
                  {c.email && (
                    <div className="mt-0.5 font-mono text-[11px] text-blue-600 dark:text-blue-400">
                      {c.email}
                    </div>
                  )}
                  {c.phone && (
                    <div className="text-[11px] text-muted-foreground">
                      {c.phone}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
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
        <NotesTab
          employerId={employerId}
          notes={detail.notes}
          team={detail.team}
          onChanged={onRefreshDetail}
        />
      </TabsContent>
    </Tabs>
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

function NotesTab({
  employerId,
  notes,
  team,
  onChanged,
}: {
  employerId: string;
  notes: EmployerNote[];
  team: TeamMemberSummary[];
  onChanged: () => void;
}) {
  const [content, setContent] = useState(notes[0]?.content ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setContent(notes[0]?.content ?? "");
  }, [notes]);

  const save = async () => {
    if (!content.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/crm/employers/${employerId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast.success("Note saved");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        Notes
      </div>
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        placeholder="Add a note about this firm…"
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={save} disabled={saving || !content.trim()}>
          {saving ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
          Save note
        </Button>
      </div>
      {team.length > 0 && (
        <div className="mt-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Team
          <div className="flex gap-1">
            {team.map((m) => (
              <span
                key={m.id}
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br text-[8px] font-bold text-white",
                  colorForId(m.id),
                )}
                title={m.name}
              >
                {initialsOf(m.name)}
              </span>
            ))}
          </div>
          <span className="text-xs font-medium normal-case text-muted-foreground">
            {team.map((m) => m.name.split(" ")[0]).join(", ")}
          </span>
        </div>
      )}
      {notes.length > 1 && (
        <div className="mt-4 text-xs text-muted-foreground">
          Past notes:
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {notes.slice(1).map((n) => (
              <li key={n.id}>
                <span className="text-[10px] text-muted-foreground">
                  {format(new Date(n.created_at), "MMM d, yyyy")}
                </span>{" "}
                — {n.content.slice(0, 80)}
                {n.content.length > 80 ? "…" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
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
                {c.source === "manual" && (
                  <button
                    type="button"
                    aria-label="Remove company"
                    disabled={removing === c.id}
                    className="text-muted-foreground hover:text-red-600 disabled:opacity-50"
                    onClick={() => handleRemove(c.id)}
                  >
                    {removing === c.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
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
