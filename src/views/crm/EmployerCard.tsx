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
import { ChevronDown, Loader2, Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  EmployerDetail,
  EmployerNote,
  EmployerSummary,
  EmployerTopicAssignment,
  TeamMemberSummary,
  TopicChip,
} from "./types";
import { colorForId, initialsOf, tabTriggerCls } from "./utils";

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
          ? "border-indigo-500 shadow-md shadow-indigo-500/10"
          : "hover:border-foreground/20",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[36px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_28px] items-center gap-3 px-3 py-2.5 text-left"
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
                <div className="truncate font-mono text-[9px] text-indigo-600 dark:text-indigo-400">
                  {employer.primary_pic.email}
                </div>
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
          {loadingDetail || !detail ? (
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
        topic.is_highlight && "ring-1 ring-indigo-300",
      )}
    >
      {topic.name}
    </Badge>
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
        <TabsTrigger value="notes" className={tabTriggerCls}>
          Notes
        </TabsTrigger>
      </TabsList>

      <TabsContent value="contacts" className="px-5 pb-5 pt-4">
        <div className="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <span>Contacts ({detail.correspondents.length})</span>
          <button
            className="text-xs font-bold normal-case text-indigo-600 hover:underline"
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
                    <div className="mt-0.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">
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
  const [confirmRemove, setConfirmRemove] =
    useState<EmployerTopicAssignment | null>(null);

  const handleAdd = async () => {
    const v = name.trim();
    if (!v) {
      toast.error("Enter a tag name");
      return;
    }
    const res = await fetch(`/api/crm/employers/${employerId}/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: v }),
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
        <span>Topics ({topics.length})</span>
        <button
          className="text-xs font-bold normal-case text-indigo-600 hover:underline"
          onClick={() => setAdding(true)}
        >
          + Add tag
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {topics.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No topic tags yet.
          </span>
        )}
        {topics.map((t) => (
          <div key={t.id} className="group relative">
            <TopicChipBadge topic={t} />
            <button
              className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border bg-background text-[10px] group-hover:flex"
              onClick={() => setConfirmRemove(t)}
              aria-label="Remove tag"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {adding && (
        <div className="mt-3 flex items-center gap-2">
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
        <span
          className="mr-1 inline-flex h-4 items-center rounded-full px-1.5 text-[9px] font-semibold text-orange-600"
          style={{ border: "1px solid #f97316" }}
        >
          Auto
        </span>{" "}
        from emails &nbsp;·&nbsp;{" "}
        <Badge variant="outline" className="mr-1 h-4 px-1.5 text-[9px]">
          manual
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
            {confirmRemove?.source === "auto" ? "Dismiss" : "Delete"} topic “
            {confirmRemove?.name}”? This cannot be undone.
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
