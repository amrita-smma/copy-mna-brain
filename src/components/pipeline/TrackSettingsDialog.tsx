"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getTracks,
  saveTrack,
  deleteTrack,
  getUsers,
  type Track,
  type UserSummary,
} from "@/lib/api/pipeline";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import { trackDisplayName } from "@/lib/tracks/matchTracks";

interface WorkingTrack {
  id: string;
  title: string;
  pic: string;
  content: string;
  isNew?: boolean;
}

interface TrackSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after tracks are persisted so the parent can refetch. */
  onSaved: () => void;
}

const toWorking = (t: Track): WorkingTrack => ({
  id: t.id,
  title: t.title ?? "",
  pic: t.pic ?? "",
  content: t.content ?? "",
});

const summary = (content: string) => {
  const c = content.trim();
  if (!c) return "No thesis yet";
  return c.length > 48 ? `${c.slice(0, 48)}…` : c;
};

export default function TrackSettingsDialog({
  open,
  onOpenChange,
  onSaved,
}: TrackSettingsDialogProps) {
  const [tracks, setTracks] = useState<WorkingTrack[]>([]);
  const [original, setOriginal] = useState<Record<string, WorkingTrack>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tempCounter, setTempCounter] = useState(0);
  const [users, setUsers] = useState<UserSummary[]>([]);

  // Load team members once, to suggest PIC values.
  useEffect(() => {
    if (!open || users.length > 0) return;
    getUsers()
      .then(setUsers)
      .catch((err) => console.error("Failed to load users:", err));
  }, [open, users.length]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getTracks()
      .then((rows) => {
        const working = rows.map(toWorking);
        setTracks(working);
        setOriginal(Object.fromEntries(working.map((w) => [w.id, { ...w }])));
        setActiveId(working[0]?.id ?? null);
      })
      .catch((err) => {
        console.error("Failed to load tracks:", err);
        toast.error("Failed to load tracks");
      })
      .finally(() => setLoading(false));
  }, [open]);

  const active = tracks.find((t) => t.id === activeId) ?? null;

  const patchActive = (patch: Partial<WorkingTrack>) =>
    setTracks((prev) =>
      prev.map((t) => (t.id === activeId ? { ...t, ...patch } : t)),
    );

  const addTrack = () => {
    const id = `new-${tempCounter}`;
    setTempCounter((c) => c + 1);
    setTracks((prev) => [
      { id, title: "New track", pic: "", content: "", isNew: true },
      ...prev,
    ]);
    setActiveId(id);
  };

  const removeActive = async () => {
    if (!active) return;
    if (
      !window.confirm(
        `Delete track "${trackDisplayName({ ...active })}"? This can't be undone.`,
      )
    )
      return;
    try {
      if (!active.isNew) await deleteTrack(active.id);
      const next = tracks.filter((t) => t.id !== active.id);
      setTracks(next);
      setActiveId(next[0]?.id ?? null);
      if (!active.isNew) toast.success("Track deleted");
    } catch (err: any) {
      console.error("Failed to delete track:", err);
      toast.error(`Failed to delete: ${err.message || "Unknown error"}`);
    }
  };

  const isDirty = (t: WorkingTrack) => {
    if (t.isNew) return true;
    const orig = original[t.id];
    return (
      !orig ||
      orig.title !== t.title ||
      orig.pic !== t.pic ||
      orig.content !== t.content
    );
  };

  const handleSave = async () => {
    const blank = tracks.find((t) => !t.title.trim());
    if (blank) {
      setActiveId(blank.id);
      toast.error("Every track needs a name");
      return;
    }
    const dirty = tracks.filter(isDirty);
    if (dirty.length === 0) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    try {
      for (const t of dirty) {
        await saveTrack({
          id: t.isNew ? undefined : t.id,
          title: t.title.trim(),
          pic: t.pic.trim() || null,
          content: t.content.trim(),
        });
      }
      toast.success(
        dirty.length === 1 ? "Track saved" : `${dirty.length} tracks saved`,
      );
      onSaved();
      onOpenChange(false);
    } catch (err: any) {
      console.error("Failed to save tracks:", err);
      toast.error(`Failed to save: ${err.message || "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b">
          <DialogTitle>Track Settings</DialogTitle>
          <DialogDescription>
            Manage the investment theses used to auto-match inbound and outbound
            deals.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[360px] max-h-[60vh]">
          {/* Track list */}
          <aside className="w-56 shrink-0 border-r bg-muted/30 flex flex-col">
            <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Tracks
            </div>
            <div className="flex-1 overflow-y-auto px-2 space-y-1">
              {loading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : tracks.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  No tracks yet.
                </p>
              ) : (
                tracks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveId(t.id)}
                    className={cn(
                      "w-full text-left rounded-md px-2.5 py-2 border transition-colors",
                      t.id === activeId
                        ? "bg-muted border-border"
                        : "border-transparent hover:bg-background",
                    )}
                  >
                    <div
                      className={cn(
                        "text-xs font-semibold truncate",
                        t.id === activeId && "text-foreground",
                      )}
                    >
                      {t.title.trim() || "Untitled track"}
                    </div>
                    <div className="text-[10.5px] text-muted-foreground truncate">
                      {summary(t.content)}
                    </div>
                  </button>
                ))
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addTrack}
              className="m-2 border-dashed"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New track
            </Button>
          </aside>

          {/* Editor */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {active ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="track-name">
                    Track name <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="track-name"
                    value={active.title}
                    onChange={(e) => patchActive({ title: e.target.value })}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>PIC</Label>
                  <StatusCombobox
                    value={active.pic || null}
                    options={users
                      .map((u) => u.name)
                      .filter((n): n is string => !!n)}
                    placeholder="Set PIC…"
                    searchPlaceholder="Search or type a name…"
                    emptyText="No team members found."
                    onChange={(v) => patchActive({ pic: v })}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="track-thesis">Investment Thesis</Label>
                  <Textarea
                    id="track-thesis"
                    value={active.content}
                    onChange={(e) => patchActive({ content: e.target.value })}
                    rows={10}
                    placeholder="Describe the investment thesis — target sectors, geographies, deal characteristics…"
                    className="resize-y"
                    disabled={saving}
                  />
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a track or create a new one.
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-3.5 border-t">
          <Button
            type="button"
            variant="outline"
            onClick={removeActive}
            disabled={!active || saving}
            className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            Delete track
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Save Settings
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
