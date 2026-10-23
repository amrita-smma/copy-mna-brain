"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { History, Loader2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { EmployerNote, EmployerNoteRevision, TeamMemberSummary } from "./types";
import { colorForId, initialsOf } from "./utils";

const fmt = (iso: string) => format(new Date(iso), "MMM d, yyyy · HH:mm");

/**
 * The firm's Notes tab: a composer for a new note and every note listed with
 * who wrote it and who last changed it. Anyone in the workspace may edit or
 * delete any note; the server keeps every change in the note's history
 * (employer_note_revisions), which the History button shows.
 */
export function EmployerNotesTab({
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
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<EmployerNote | null>(null);
  const [historyFor, setHistoryFor] = useState<EmployerNote | null>(null);

  const add = async () => {
    if (!draft.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/crm/employers/${employerId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      if (!res.ok) throw new Error("Could not save the note");
      setDraft("");
      toast.success("Note added");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const saveEdit = async (note: EmployerNote) => {
    if (!editDraft.trim()) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/crm/employers/${employerId}/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editDraft }),
      });
      if (!res.ok) throw new Error("Could not save the note");
      setEditingId(null);
      toast.success("Note updated");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async (note: EmployerNote) => {
    try {
      const res = await fetch(`/api/crm/employers/${employerId}/notes/${note.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not delete the note");
      toast.success("Note deleted");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div data-testid="crm-notes-tab">
      <div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        Notes
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder="Add a note about this firm…"
        data-testid="crm-note-composer"
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={() => void add()} disabled={adding || !draft.trim()}>
          {adding && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
          Add note
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

      {notes.length === 0 ? (
        <div className="mt-4 text-sm text-muted-foreground">No notes yet.</div>
      ) : (
        <ul className="mt-4 space-y-2">
          {notes.map((n) => (
            <li
              key={n.id}
              className="rounded-lg border bg-card px-3 py-2"
              data-testid="crm-note-item"
            >
              {editingId === n.id ? (
                <>
                  <Textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={3}
                    disabled={savingEdit}
                    data-testid="crm-note-edit-input"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingId(null)}
                      disabled={savingEdit}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void saveEdit(n)}
                      disabled={savingEdit || !editDraft.trim()}
                      data-testid="crm-note-edit-save"
                    >
                      {savingEdit && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                      Save
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">
                    {n.content}
                  </p>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <NoteIconButton
                      label="Edit note"
                      onClick={() => {
                        setEditingId(n.id);
                        setEditDraft(n.content);
                      }}
                      testId="crm-note-edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </NoteIconButton>
                    <NoteIconButton
                      label="Note history"
                      onClick={() => setHistoryFor(n)}
                      testId="crm-note-history"
                    >
                      <History className="h-3.5 w-3.5" />
                    </NoteIconButton>
                    <NoteIconButton
                      label="Delete note"
                      onClick={() => setConfirmDelete(n)}
                      testId="crm-note-delete"
                      destructive
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </NoteIconButton>
                  </div>
                </div>
              )}
              <div className="mt-1 text-[11px] text-muted-foreground">
                {n.author_name ?? "Someone"} · {fmt(n.created_at)}
                {n.updated_by && (
                  <>
                    {" "}
                    · edited by {n.updated_by_name ?? "someone"} {fmt(n.updated_at)}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
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
              <DialogTitle>Delete note?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              It disappears from the Notes tab. Its history, including this
              deletion and who made it, is kept.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void remove(confirmDelete)}
                data-testid="crm-note-delete-confirm"
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {historyFor && (
        <NoteHistoryDialog
          key={historyFor.id}
          employerId={employerId}
          note={historyFor}
          open={!!historyFor}
          onOpenChange={(o) => {
            if (!o) setHistoryFor(null);
          }}
        />
      )}
    </div>
  );
}

function NoteIconButton({
  label,
  onClick,
  testId,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  testId: string;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cn(
        "grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted",
        destructive ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const ACTION_LABEL: Record<EmployerNoteRevision["action"], string> = {
  create: "Created",
  edit: "Edited",
  delete: "Deleted",
};

/**
 * One note's audit trail. Mounted per note (keyed by its id) and fetched on
 * open; the generation guard drops a response that lands after the dialog
 * was closed.
 */
function NoteHistoryDialog({
  employerId,
  note,
  open,
  onOpenChange,
}: {
  employerId: string;
  note: EmployerNote;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [revisions, setRevisions] = useState<EmployerNoteRevision[] | null>(null);
  const [failed, setFailed] = useState(false);
  const liveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/crm/employers/${employerId}/notes/${note.id}/revisions`,
        { credentials: "same-origin" },
      );
      if (!res.ok) throw new Error();
      const { data } = (await res.json()) as { data: EmployerNoteRevision[] };
      if (liveRef.current) setRevisions(data ?? []);
    } catch {
      if (liveRef.current) setFailed(true);
    }
  }, [employerId, note.id]);

  useEffect(() => {
    liveRef.current = true;
    void load();
    return () => {
      liveRef.current = false;
    };
  }, [load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Note history</DialogTitle>
        </DialogHeader>
        {failed ? (
          <p className="text-sm text-muted-foreground">Could not load the history.</p>
        ) : !revisions ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ol className="space-y-3" data-testid="crm-note-history-list">
            {revisions.map((r) => (
              <li key={r.id} className="rounded-lg border bg-muted px-3 py-2">
                <div className="text-xs font-semibold">
                  {ACTION_LABEL[r.action]} by {r.changed_by_name ?? "someone"}
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {fmt(r.changed_at)}
                  </span>
                </div>
                {r.action === "edit" && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground line-through">
                    {r.content_before}
                  </p>
                )}
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {r.action === "delete" ? r.content_before : r.content_after}
                </p>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
