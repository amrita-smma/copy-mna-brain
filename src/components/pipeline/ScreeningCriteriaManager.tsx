"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import {
  createCriteria,
  deleteCriteria,
  updateCriteria,
  type Criteria,
} from "@/lib/api/pipeline";

/**
 * Manage the screening criteria that belong to one Track (investment_thesis):
 * create / edit / delete. Controlled — the parent holds the full criteria list
 * (`criterias`); this component shows and scopes everything to `thesisId`.
 */
interface ScreeningCriteriaManagerProps {
  /** The Track these criteria belong to; create assigns this id. */
  thesisId: string;
  /** Full criteria list across all Tracks. */
  criterias: Criteria[];
  onChange: (next: Criteria[]) => void;
  disabled?: boolean;
}

export default function ScreeningCriteriaManager({
  thesisId,
  criterias,
  onChange,
  disabled,
}: ScreeningCriteriaManagerProps) {
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Only this Track's criteria are shown / counted.
  const trackCriterias = criterias.filter(
    (c) => c.investment_thesis_id === thesisId,
  );

  const addCriterion = async () => {
    if (!newName.trim() || !newPrompt.trim()) return;
    setIsSaving(true);
    try {
      const data = await createCriteria(
        newName.trim(),
        newPrompt.trim(),
        thesisId,
      );
      onChange([...criterias, data]);
      setNewName("");
      setNewPrompt("");
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
                    <div className="font-medium text-sm">{criterion.name}</div>
                    <div className="text-muted-foreground text-sm break-words">
                      {criterion.prompt}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
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
        <div className="space-y-2 p-3 border rounded-lg border-dashed">
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
