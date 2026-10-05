"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, List, ListOrdered, Loader2, Plus, Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePipelineStages } from "@/hooks/usePipelineStages";
import {
  createPipelineStage,
  deletePipelineStage,
  movePipelineStage,
  updatePipelineStages,
} from "@/lib/api/pipelineStages";
import { getCompanyStageCounts } from "@/lib/api/pipeline";
import { cn } from "@/lib/utils";
import {
  FIRST_STAGE_KEY,
  STAGE_CODE_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
  type PipelineStageDef,
} from "@/lib/pipeline/stages";

interface PipelineStageSettingsProps {
  /** Called after a change that moves companies or reorders stages, so the page can refetch. */
  onStagesChanged?: () => void;
  /** The footer's Cancel: closes the Configuration dialog, dropping unsaved edits. */
  onCancel?: () => void;
}

interface StageDraft {
  code: string;
  name: string;
  description: string;
}

type ConfirmAction =
  | { type: "up" | "down"; stage: PipelineStageDef }
  | { type: "delete"; stage: PipelineStageDef };

const DESCRIPTION_PLACEHOLDER =
  "What happens at this stage, and what must be produced to exit it…";

/**
 * Insert a list marker at the start of a new line at the caret, so the
 * bullet / numbered-list buttons build plain-text lists in the description.
 */
function insertListMarker(
  textarea: HTMLTextAreaElement | null,
  value: string,
  marker: (value: string) => string,
): { value: string; caret: number } {
  const at = textarea?.selectionStart ?? value.length;
  const before = value.slice(0, at);
  const after = value.slice(at);
  const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const inserted = `${prefix}${marker(value)}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

const bullet = () => "• ";
const nextNumber = (value: string) => {
  const numbered = value.split("\n").filter((line) => /^\d+\.\s/.test(line)).length;
  return `${numbered + 1}. `;
};

/**
 * The Pipeline Settings tab of the Configuration dialog (MB-651): rename and
 * renumber each stage, describe it, add stages, and reorder or delete them.
 * Text edits collect across the cards and save together from the footer, in
 * one request, so two stages can swap codes. Add, move and delete apply at
 * once (each confirms first) and keep any unsaved edits. L0 is the entry
 * stage, so it can be edited but not moved or deleted.
 */
export default function PipelineStageSettings({
  onStagesChanged,
  onCancel,
}: PipelineStageSettingsProps) {
  const { live, loading, refresh, label } = usePipelineStages();
  const [drafts, setDrafts] = useState<Record<string, StageDraft>>({});
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [newStageOpen, setNewStageOpen] = useState(false);
  const [activeCounts, setActiveCounts] = useState<Record<string, number>>({});

  const loadCounts = useCallback(async () => {
    try {
      const rows = await getCompanyStageCounts({ excludeDropped: true });
      setActiveCounts(Object.fromEntries(rows.map((r) => [r.stage, r.count])));
    } catch (err) {
      console.error("Failed to load stage counts:", err);
    }
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  const draftFor = (stage: PipelineStageDef): StageDraft =>
    drafts[stage.key] ?? { code: stage.code, name: stage.name, description: stage.description };

  const isDirty = (stage: PipelineStageDef) => {
    const draft = drafts[stage.key];
    return (
      !!draft &&
      (draft.code !== stage.code ||
        draft.name !== stage.name ||
        draft.description !== stage.description)
    );
  };

  const patchDraft = (stage: PipelineStageDef, patch: Partial<StageDraft>) =>
    setDrafts((prev) => ({ ...prev, [stage.key]: { ...draftFor(stage), ...patch } }));

  // A deleted stage's leftover draft drops out here: only live stages save.
  const dirtyStages = live.filter(isDirty);
  const hasBlankField = dirtyStages.some((stage) => {
    const draft = draftFor(stage);
    return !draft.code.trim() || !draft.name.trim();
  });

  const saveAll = async () => {
    if (dirtyStages.length === 0) return;
    setSaving(true);
    try {
      await updatePipelineStages(
        dirtyStages.map((stage) => ({ key: stage.key, ...draftFor(stage) })),
      );
      await refresh();
      setDrafts({});
      toast.success(
        dirtyStages.length === 1 ? "Stage saved" : `${dirtyStages.length} stages saved`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save stages");
    } finally {
      setSaving(false);
    }
  };

  const afterStructureChange = async () => {
    await Promise.all([refresh(), loadCounts()]);
    onStagesChanged?.();
  };

  return (
    <div className="flex h-[60vh] flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">Pipeline Settings</h3>
            <p className="text-sm text-muted-foreground">Rename pipeline stages shown across the app.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setNewStageOpen(true)}
            disabled={loading}
            className="shrink-0 border-primary text-primary hover:text-primary"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            New Pipeline Stage
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          live.map((stage, index) => (
            <StageCard
              key={stage.key}
              stage={stage}
              draft={draftFor(stage)}
              dirty={isDirty(stage)}
              saving={saving}
              locked={stage.key === FIRST_STAGE_KEY}
              canMoveUp={stage.key !== FIRST_STAGE_KEY && index > 1}
              canMoveDown={stage.key !== FIRST_STAGE_KEY && index < live.length - 1}
              onPatch={(patch) => patchDraft(stage, patch)}
              onMoveUp={() => setConfirm({ type: "up", stage })}
              onMoveDown={() => setConfirm({ type: "down", stage })}
              onDelete={() => setConfirm({ type: "delete", stage })}
            />
          ))
        )}

        {confirm && (
          <ConfirmStageAction
            key={`${confirm.type}:${confirm.stage.key}`}
            action={confirm}
            stageLabel={label(confirm.stage.key)}
            activeCount={activeCounts[confirm.stage.key] ?? 0}
            targets={live.filter((s) => s.key !== confirm.stage.key)}
            targetLabel={label}
            onClose={() => setConfirm(null)}
            onDone={afterStructureChange}
          />
        )}

        {newStageOpen && (
          <NewStageDialog
            stages={live}
            stageLabel={label}
            onClose={() => setNewStageOpen(false)}
            onCreated={afterStructureChange}
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-6 py-3.5 border-t">
        <p className="text-sm text-muted-foreground" data-testid="pipeline-stage-unsaved">
          {dirtyStages.length === 0
            ? null
            : dirtyStages.length === 1
              ? "1 stage has unsaved changes"
              : `${dirtyStages.length} stages have unsaved changes`}
        </p>
        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button
            type="button"
            data-testid="pipeline-stage-save"
            onClick={() => void saveAll()}
            disabled={saving || dirtyStages.length === 0 || hasBlankField}
          >
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </div>
    </div>
  );
}

interface StageCardProps {
  stage: PipelineStageDef;
  draft: StageDraft;
  dirty: boolean;
  saving: boolean;
  locked: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPatch: (patch: Partial<StageDraft>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

function StageCard({
  stage,
  draft,
  dirty,
  saving,
  locked,
  canMoveUp,
  canMoveDown,
  onPatch,
  onMoveUp,
  onMoveDown,
  onDelete,
}: StageCardProps) {
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const idBase = `stage-${stage.key}`;

  const addMarker = (marker: (value: string) => string) => {
    const next = insertListMarker(descriptionRef.current, draft.description, marker);
    onPatch({ description: next.value });
    requestAnimationFrame(() => {
      const el = descriptionRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div
      className={cn("rounded-lg border bg-card p-4 space-y-3", dirty && "border-primary/60")}
      data-testid={`pipeline-stage-card-${stage.key}`}
    >
      <div className="flex items-center justify-end gap-2">
        {dirty && <span className="text-xs font-medium text-primary">Unsaved</span>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label={`Stage options for ${stage.code}`}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!canMoveUp} onSelect={onMoveUp}>
              <ArrowUp className="h-3.5 w-3.5 mr-2" />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canMoveDown} onSelect={onMoveDown}>
              <ArrowDown className="h-3.5 w-3.5 mr-2" />
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={locked}
              onSelect={onDelete}
              className="text-red-600 focus:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete
            </DropdownMenuItem>
            {locked && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground max-w-[14rem]">
                The first stage is where confirmed deals enter, so it stays first and can&apos;t be
                deleted.
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex gap-3">
        <div className="w-28 shrink-0 space-y-1.5">
          <Label htmlFor={`${idBase}-code`}>Code</Label>
          <Input
            id={`${idBase}-code`}
            value={draft.code}
            maxLength={STAGE_CODE_MAX_LENGTH}
            onChange={(e) => onPatch({ code: e.target.value })}
            disabled={saving}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor={`${idBase}-name`}>Display name</Label>
          <Input
            id={`${idBase}-name`}
            value={draft.name}
            maxLength={STAGE_NAME_MAX_LENGTH}
            onChange={(e) => onPatch({ name: e.target.value.slice(0, STAGE_NAME_MAX_LENGTH) })}
            disabled={saving}
          />
          <p className="text-right text-xs text-muted-foreground">
            {draft.name.length}/{STAGE_NAME_MAX_LENGTH}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${idBase}-description`}>Description</Label>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              title="Bullet list"
              aria-label="Bullet list"
              onClick={() => addMarker(bullet)}
              disabled={saving}
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              title="Numbered list"
              aria-label="Numbered list"
              onClick={() => addMarker(nextNumber)}
              disabled={saving}
            >
              <ListOrdered className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Textarea
          id={`${idBase}-description`}
          ref={descriptionRef}
          value={draft.description}
          onChange={(e) => onPatch({ description: e.target.value })}
          placeholder={DESCRIPTION_PLACEHOLDER}
          rows={5}
          disabled={saving}
        />
      </div>
    </div>
  );
}

interface ConfirmStageActionProps {
  action: ConfirmAction;
  stageLabel: string;
  activeCount: number;
  targets: PipelineStageDef[];
  targetLabel: (key: string) => string;
  onClose: () => void;
  onDone: () => Promise<void>;
}

function ConfirmStageAction({
  action,
  stageLabel,
  activeCount,
  targets,
  targetLabel,
  onClose,
  onDone,
}: ConfirmStageActionProps) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const isDelete = action.type === "delete";
  const needsTarget = isDelete && activeCount > 0;

  const run = async () => {
    setBusy(true);
    try {
      if (isDelete) {
        const { moved } = await deletePipelineStage(action.stage.key, needsTarget ? target : undefined);
        toast.success(
          moved > 0
            ? `Stage deleted. ${moved} ${moved === 1 ? "company" : "companies"} moved to ${targetLabel(target)}.`
            : "Stage deleted",
        );
      } else {
        await movePipelineStage(action.stage.key, action.type);
        toast.success("Stage moved");
      }
      await onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Please confirm</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                <span className="font-semibold text-foreground">
                  {isDelete ? "Delete" : action.type === "up" ? "Move up" : "Move down"}
                </span>{" "}
                &ldquo;{stageLabel}&rdquo;
                {isDelete ? " stage? This can't be undone." : " one position?"}
              </p>
              {!isDelete && (
                <p className="text-xs">All companies currently in this stage will move together with it.</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {needsTarget && (
          <div className="space-y-2 rounded-md border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950">
            <p className="text-sm text-foreground">
              There are companies in this pipeline. Choose a pipeline stage to move them to.
            </p>
            <Select value={target} onValueChange={setTarget} disabled={busy}>
              <SelectTrigger className="bg-background" aria-label="Stage to move companies to">
                <SelectValue placeholder="Select a stage…" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {targetLabel(s.key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="button" onClick={() => void run()} disabled={busy || (needsTarget && !target)}>
            {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Confirm
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface NewStageDialogProps {
  stages: PipelineStageDef[];
  stageLabel: (key: string) => string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

function NewStageDialog({ stages, stageLabel, onClose, onCreated }: NewStageDialogProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [afterKey, setAfterKey] = useState(stages[stages.length - 1]?.key ?? "");
  const [busy, setBusy] = useState(false);
  const canCreate = useMemo(() => !!code.trim() && !!name.trim() && !!afterKey, [code, name, afterKey]);

  const create = async () => {
    setBusy(true);
    try {
      await createPipelineStage({ code, name, description, afterKey });
      toast.success("Stage created");
      await onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create stage");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Pipeline Stage</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-stage-code">Code</Label>
            <Input
              id="new-stage-code"
              value={code}
              maxLength={STAGE_CODE_MAX_LENGTH}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. L6"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-stage-name">Display name</Label>
            <Input
              id="new-stage-name"
              value={name}
              maxLength={STAGE_NAME_MAX_LENGTH}
              onChange={(e) => setName(e.target.value.slice(0, STAGE_NAME_MAX_LENGTH))}
              placeholder="e.g. Post-Close Review"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-stage-description">Description</Label>
            <Textarea
              id="new-stage-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={DESCRIPTION_PLACEHOLDER}
              rows={4}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Position After</Label>
            <Select value={afterKey} onValueChange={setAfterKey} disabled={busy}>
              <SelectTrigger aria-label="Position after">
                <SelectValue placeholder="Select a stage…" />
              </SelectTrigger>
              <SelectContent>
                {stages.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {stageLabel(s.key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void create()} disabled={busy || !canCreate}>
            {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Create Stage
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
