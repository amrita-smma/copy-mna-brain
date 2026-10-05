"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getTracks,
  saveTrack,
  deleteTrack,
  getUsers,
  getCriterias,
  getTrackVariables,
  type Track,
  type UserSummary,
  type Criteria,
  type TrackVariable,
} from "@/lib/api/pipeline";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import ScreeningCriteriaManager from "@/components/pipeline/ScreeningCriteriaManager";
import TrackVariablesManager from "@/components/pipeline/TrackVariablesManager";
import PipelineStageSettings from "@/components/pipeline/PipelineStageSettings";
import { trackDisplayName } from "@/lib/tracks/matchTracks";

interface WorkingTrack {
  id: string;
  title: string;
  pic: string;
  content: string;
  isNew?: boolean;
}

type ConfigurationTab = "track" | "pipeline";

interface TrackSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after tracks are persisted so the parent can refetch. */
  onSaved: () => void;
  /**
   * Called after a Pipeline Settings change that moves companies or reorders
   * stages (delete, move, new stage), so the parent can refetch its deals.
   */
  onStagesChanged?: () => void;
}

const CONFIG_TAB_CLASS =
  "rounded-none border-b-2 border-transparent px-1 pb-2.5 pt-0 -mb-px text-sm font-semibold text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none";

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

/**
 * The Pipeline page's Configuration dialog: the Investment Track editor (the
 * theses used to auto-match deals) and Pipeline Settings (the workspace's
 * deal stages, MB-651).
 */
export default function TrackSettingsDialog({
  open,
  onOpenChange,
  onSaved,
  onStagesChanged,
}: TrackSettingsDialogProps) {
  // Every open starts on the Investment Track tab.
  const [tab, setTab] = useState<ConfigurationTab>("track");
  useEffect(() => {
    if (open) setTab("track");
  }, [open]);
  const [tracks, setTracks] = useState<WorkingTrack[]>([]);
  const [original, setOriginal] = useState<Record<string, WorkingTrack>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tempCounter, setTempCounter] = useState(0);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [criterias, setCriterias] = useState<Criteria[]>([]);
  const [trackVariables, setTrackVariables] = useState<TrackVariable[]>([]);

  // Load team members once, to suggest PIC values.
  useEffect(() => {
    if (!open || users.length > 0) return;
    getUsers()
      .then(setUsers)
      .catch((err) => console.error("Failed to load users:", err));
  }, [open, users.length]);

  // `tracks.pic` stores the member's *name* (free text), so the picker is
  // keyed by name — with the email stacked underneath, like every other user
  // dropdown. A duplicated name simply shares a hint.
  const userNames = useMemo(
    () => users.map((u) => u.name).filter((n): n is string => !!n),
    [users],
  );
  const userEmailsByName = useMemo(
    () =>
      Object.fromEntries(
        users.filter((u) => !!u.name).map((u) => [u.name, u.email]),
      ),
    [users],
  );

  // Load all screening criteria once; the manager filters to the active track.
  useEffect(() => {
    if (!open || criterias.length > 0) return;
    getCriterias()
      .then(setCriterias)
      .catch((err) => console.error("Failed to load criterias:", err));
  }, [open, criterias.length]);

  // Load all track variables once; the manager filters to the active track.
  useEffect(() => {
    if (!open || trackVariables.length > 0) return;
    getTrackVariables()
      .then(setTrackVariables)
      .catch((err) => console.error("Failed to load track variables:", err));
  }, [open, trackVariables.length]);

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

  const removeTrack = async (track: WorkingTrack) => {
    if (
      !window.confirm(
        `Delete track "${trackDisplayName({ ...track })}"? This can't be undone.`,
      )
    )
      return;
    try {
      if (!track.isNew) await deleteTrack(track.id);
      const next = tracks.filter((t) => t.id !== track.id);
      setTracks(next);
      if (activeId === track.id) setActiveId(next[0]?.id ?? null);
      if (!track.isNew) toast.success("Track deleted");
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
      <DialogContent className="max-w-[80vw] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b">
          <DialogTitle>Configuration</DialogTitle>
          <DialogDescription>
            Manage the investment theses used to auto-match inbound and outbound
            deals, and the stages of your deal pipeline.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as ConfigurationTab)}
          className="w-full"
        >
          <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent px-6 pt-3">
            <TabsTrigger value="track" className={CONFIG_TAB_CLASS}>
              Investment Track
            </TabsTrigger>
            <TabsTrigger value="pipeline" className={CONFIG_TAB_CLASS}>
              Pipeline Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pipeline" className="mt-0">
            <PipelineStageSettings
              onStagesChanged={onStagesChanged}
              onCancel={() => onOpenChange(false)}
            />
          </TabsContent>

          <TabsContent value="track" className="mt-0">
            <div className="flex h-[60vh]">
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
                      <div
                        key={t.id}
                        className={cn(
                          "group flex items-center gap-1 rounded-md border transition-colors",
                          t.id === activeId
                            ? "bg-blue-300 border-blue-300 shadow-sm"
                            : "border-transparent hover:bg-blue-100",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveId(t.id)}
                          className="min-w-0 flex-1 text-left px-2.5 py-2"
                        >
                          <div
                            className={cn(
                              "text-xs font-semibold truncate",
                              t.id === activeId && "text-blue-950",
                            )}
                          >
                            {t.title.trim() || "Untitled track"}
                          </div>
                          <div
                            className={cn(
                              "text-[10.5px] truncate",
                              t.id === activeId
                                ? "text-blue-800"
                                : "text-muted-foreground",
                            )}
                          >
                            {summary(t.content)}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => removeTrack(t)}
                          disabled={saving}
                          aria-label={`Delete ${t.title.trim() || "track"}`}
                          className="shrink-0 mr-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
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
                        options={userNames}
                        optionHints={userEmailsByName}
                        placeholder="Set PIC…"
                        searchPlaceholder="Search or type a name…"
                        emptyText="No team members found."
                        onChange={(v) => patchActive({ pic: v })}
                        disabled={saving}
                      />
                    </div>
                    <Tabs defaultValue="thesis" className="w-full">
                      <TabsList className="h-auto gap-1 rounded-full bg-blue-100 p-1">
                        <TabsTrigger
                          value="thesis"
                          className="rounded-full text-blue-700 hover:text-blue-900 data-[state=active]:bg-blue-300 data-[state=active]:text-blue-950 data-[state=active]:shadow-sm"
                        >
                          Investment Thesis
                        </TabsTrigger>
                        <TabsTrigger
                          value="criteria"
                          className="rounded-full text-blue-700 hover:text-blue-900 data-[state=active]:bg-blue-300 data-[state=active]:text-blue-950 data-[state=active]:shadow-sm"
                        >
                          AI Screening Criteria
                        </TabsTrigger>
                        <TabsTrigger
                          value="variables"
                          className="rounded-full text-blue-700 hover:text-blue-900 data-[state=active]:bg-blue-300 data-[state=active]:text-blue-950 data-[state=active]:shadow-sm"
                        >
                          Variables
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="thesis" className="mt-4">
                        <Textarea
                          id="track-thesis"
                          value={active.content}
                          onChange={(e) => patchActive({ content: e.target.value })}
                          rows={12}
                          placeholder="Describe the investment thesis — target sectors, geographies, deal characteristics…"
                          className="resize-none overflow-y-auto"
                          disabled={saving}
                        />
                      </TabsContent>

                      <TabsContent value="criteria" className="mt-4">
                        {active.isNew ? (
                          <p className="text-sm text-muted-foreground">
                            Save this track first to add screening criteria to it.
                          </p>
                        ) : (
                          <ScreeningCriteriaManager
                            thesisId={active.id}
                            criterias={criterias}
                            onChange={setCriterias}
                            disabled={saving}
                          />
                        )}
                      </TabsContent>

                      <TabsContent value="variables" className="mt-4">
                        {active.isNew ? (
                          <p className="text-sm text-muted-foreground">
                            Save this track first to add variables to it.
                          </p>
                        ) : (
                          <TrackVariablesManager
                            trackId={active.id}
                            variables={trackVariables}
                            onChange={setTrackVariables}
                            disabled={saving}
                          />
                        )}
                      </TabsContent>
                    </Tabs>
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Select a track or create a new one.
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-6 py-3.5 border-t">
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
                Save Tracks
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
