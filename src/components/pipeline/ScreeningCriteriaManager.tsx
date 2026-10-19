"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import {
  createCriteria,
  deleteCriteria,
  updateCriteria,
  type Criteria,
} from "@/lib/api/pipeline";
import { optionalPassThresholdPercent } from "@/lib/screening/verdict";

/**
 * Manage the screening criteria that belong to one Track (investment_thesis):
 * create / edit / delete, mark a criterion must-pass, and set how many of the
 * optional (non-must-pass) criteria must pass for the track to pass.
 * Controlled — the parent holds the full criteria list (`criterias`) and the
 * track's minimum; this component shows and scopes everything to `thesisId`.
 * Criteria changes save immediately; the minimum saves with the track.
 */
interface ScreeningCriteriaManagerProps {
  /** The Track these criteria belong to; create assigns this id. */
  thesisId: string;
  /** Full criteria list across all Tracks. */
  criterias: Criteria[];
  onChange: (next: Criteria[]) => void;
  /** Optional criteria that must pass; `null` = the default rule. */
  minOptionalPass: number | null;
  onMinOptionalPassChange: (next: number | null) => void;
  disabled?: boolean;
}

export default function ScreeningCriteriaManager({
  thesisId,
  criterias,
  onChange,
  minOptionalPass,
  onMinOptionalPassChange,
  disabled,
}: ScreeningCriteriaManagerProps) {
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newMustPass, setNewMustPass] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Only this Track's criteria are shown / counted.
  const trackCriterias = criterias.filter(
    (c) => c.investment_thesis_id === thesisId,
  );
  const mustPassCount = trackCriterias.filter((c) => c.must_pass).length;
  const optionalCount = trackCriterias.length - mustPassCount;
  const thresholdPercent = optionalPassThresholdPercent(minOptionalPass, optionalCount);
  const usesDefaultRule =
    (minOptionalPass === null || minOptionalPass === 0) && mustPassCount === 0;

  const handleMinChange = (raw: string) => {
    if (raw.trim() === "") {
      onMinOptionalPassChange(null);
      return;
    }
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0) return;
    onMinOptionalPassChange(n);
  };

  const toggleMustPass = async (criterion: Criteria, mustPass: boolean) => {
    // Optimistic: flip it now, roll back if the save fails.
    onChange(
      criterias.map((c) => (c.id === criterion.id ? { ...c, must_pass: mustPass } : c)),
    );
    try {
      await updateCriteria(criterion.id, criterion.name, criterion.prompt, mustPass);
    } catch (error: any) {
      console.error("Error updating must-pass:", error);
      onChange(criterias);
      toast.error("Failed to update criterion");
    }
  };

  const addCriterion = async () => {
    if (!newName.trim() || !newPrompt.trim()) return;
    setIsSaving(true);
    try {
      const data = await createCriteria(
        newName.trim(),
        newPrompt.trim(),
        thesisId,
        newMustPass,
      );
      onChange([...criterias, data]);
      setNewName("");
      setNewPrompt("");
      setNewMustPass(false);
      posthog.capture("screening_criterion_added", {
        criterion_id: data.id,
        criterion_name: data.name,
      });
      toast.success("Criterion added");
    } catch (error: any) {
      console.error("Error adding criterion:", error);
      toast.error("Failed to add criterion");
    } finally {
      setIsSaving(false);
    }
  };

  const deleteCriterion = async (criterion: Criteria) => {
    try {
      await deleteCriteria(criterion.id);
      onChange(criterias.filter((c) => c.id !== criterion.id));
      posthog.capture("screening_criterion_deleted", {
        criterion_id: criterion.id,
        criterion_name: criterion.name,
      });
      toast.success("Criterion deleted");
    } catch (error: any) {
      console.error("Error deleting criterion:", error);
      toast.error("Failed to delete criterion");
    }
  };

  const startEdit = (criterion: Criteria) => {
    setEditingId(criterion.id);
    setEditName(criterion.name);
    setEditPrompt(criterion.prompt);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditPrompt("");
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim() || !editPrompt.trim()) return;
    setIsSaving(true);
    try {
      await updateCriteria(editingId, editName.trim(), editPrompt.trim());
      onChange(
        criterias.map((c) =>
          c.id === editingId
            ? { ...c, name: editName.trim(), prompt: editPrompt.trim() }
            : c,
        ),
      );
      cancelEdit();
      toast.success("Criterion updated");
    } catch (error: any) {
      console.error("Error updating criterion:", error);
      toast.error("Failed to update criterion");
    } finally {
      setIsSaving(false);
    }
  };

  const busy = disabled || isSaving;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Manage criteria</h3>
          <p className="text-xs text-muted-foreground">
            Define your criteria using Natural Language, AI will do the rest.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => document.getElementById("new-criterion-input")?.focus()}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add New
        </Button>
      </div>

      <div
        className="space-y-2 rounded-lg border bg-card p-3"
        data-testid="track-pass-rule"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label
            htmlFor="min-optional-pass-input"
            className="text-sm font-medium"
          >
            Minimum optional criteria to pass
          </label>
          <Input
            id="min-optional-pass-input"
            data-testid="min-optional-pass-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={optionalCount}
            step={1}
            className="h-8 w-20"
            placeholder="—"
            value={minOptionalPass ?? ""}
            onChange={(e) => handleMinChange(e.target.value)}
            disabled={busy}
          />
          <span className="text-sm text-muted-foreground">
            of {optionalCount} optional
          </span>
          <div
            className="flex items-center gap-2"
            title="Share of optional criteria that must pass"
          >
            <Progress
              value={thresholdPercent}
              className="h-1.5 w-24"
              aria-label="Passing threshold for optional criteria"
              data-testid="min-optional-pass-bar"
            />
            <span className="w-9 text-xs font-medium tabular-nums text-muted-foreground">
              {thresholdPercent}%
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {usesDefaultRule
            ? "Not set — the track uses the default rule: at least 3 criteria pass and at most 1 fails."
            : `The track passes when ${
                mustPassCount === 0
                  ? ""
                  : `all ${mustPassCount} must-pass ${mustPassCount === 1 ? "criterion passes" : "criteria pass"} and `
              }at least ${Math.min(minOptionalPass ?? 0, optionalCount)} of ${optionalCount} optional criteria pass. AI Screening and the AI Opinion both judge it this way.`}
          {minOptionalPass !== null && minOptionalPass > optionalCount && (
            <span className="text-amber-600 dark:text-amber-400">
              {" "}
              Only {optionalCount} optional {optionalCount === 1 ? "criterion exists" : "criteria exist"}, so the minimum is capped at {optionalCount}.
            </span>
          )}
        </p>
      </div>

      <div className="space-y-3">
        {trackCriterias.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            No screening criteria yet. Add your first criterion below.
          </div>
        ) : (
          trackCriterias.map((criterion, index) => (
            <div
              key={criterion.id}
              className="flex items-start gap-3 p-3 border rounded-lg bg-card"
            >
              <Badge
                variant="secondary"
                className="shrink-0 h-6 w-6 rounded-full p-0 flex items-center justify-center bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
              >
                {index + 1}
              </Badge>

              {editingId === criterion.id ? (
                <div className="flex-1 space-y-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Name
                    </label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Criterion name"
                      disabled={isSaving}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Prompt
                    </label>
                    <Textarea
                      value={editPrompt}
                      onChange={(e) => setEditPrompt(e.target.value)}
                      placeholder="Screening prompt"
                      rows={4}
                      autoFocus
                      disabled={isSaving}
                      className="resize-y"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={saveEdit}
                      disabled={isSaving || !editName.trim() || !editPrompt.trim()}
                    >
                      {isSaving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Save"
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={cancelEdit}
                      disabled={isSaving}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex-1 pt-0.5 min-w-0">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      {criterion.name}
                      {criterion.must_pass && (
                        <Badge variant="secondary" className="text-[10px]">
                          Must-pass
                        </Badge>
                      )}
                    </div>
                    <div className="text-muted-foreground text-sm break-words">
                      {criterion.prompt}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <label
                      className="mr-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                      title="A must-pass criterion has to pass for the track to pass; the rest count toward the minimum"
                    >
                      <Switch
                        data-testid={`criterion-must-pass-${criterion.id}`}
                        checked={criterion.must_pass}
                        disabled={busy}
                        onCheckedChange={(checked) => toggleMustPass(criterion, checked)}
                      />
                      Must-pass
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => startEdit(criterion)}
                    >
                      <Pencil className="h-3.5 w-3.5 mr-1" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                      onClick={() => deleteCriterion(criterion)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Delete
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))
        )}

        {/* Add New Criterion */}
        <div className="space-y-2 rounded-lg border border-dashed bg-card p-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              placeholder="e.g., Asia Revenue Check"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Prompt
            </label>
            <Input
              id="new-criterion-input"
              placeholder="e.g., Revenue contribution from Asia > 30%"
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && addCriterion()}
              disabled={busy}
            />
          </div>
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Switch
              data-testid="new-criterion-must-pass"
              checked={newMustPass}
              onCheckedChange={setNewMustPass}
              disabled={busy}
            />
            Must-pass — the track cannot pass unless this criterion passes
          </label>
          <Button
            type="button"
            onClick={addCriterion}
            disabled={!newName.trim() || !newPrompt.trim() || busy}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Add Criterion"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
