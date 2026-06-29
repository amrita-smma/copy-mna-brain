"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import {
  createTrackVariable,
  deleteTrackVariable,
  updateTrackVariable,
  type TrackVariable,
  type TrackVariableType,
} from "@/lib/api/pipeline";

/**
 * Manage the custom variables that belong to one Track (investment_thesis):
 * create / edit / delete. Controlled — the parent holds the full variable list
 * (`variables`); this component shows and scopes everything to `trackId`.
 *
 * A variable has a `name`, a `unit` (e.g. percentage / tonne / currency), and a
 * `type` that controls how its value is captured on the Company Card:
 * `textbox` (free text) or `radio` (one of a fixed set of `options`).
 */
interface TrackVariablesManagerProps {
  /** The Track these variables belong to; create assigns this id. */
  trackId: string;
  /** Full variable list across all Tracks. */
  variables: TrackVariable[];
  onChange: (next: TrackVariable[]) => void;
  disabled?: boolean;
}

/** Common units offered in the combobox (free-text entry is still allowed). */
const UNIT_OPTIONS = [
  "percentage",
  "tonne",
  "Mt",
  "currency",
  "USD/oz",
  "USD/t",
  "x (multiple)",
  "years",
];

const TYPE_OPTIONS: { value: TrackVariableType; label: string }[] = [
  { value: "textbox", label: "Text box" },
  { value: "radio", label: "Radio button" },
];

const splitOptions = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export default function TrackVariablesManager({
  trackId,
  variables,
  onChange,
  disabled,
}: TrackVariablesManagerProps) {
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState<string | null>(null);
  const [newType, setNewType] = useState<TrackVariableType>("textbox");
  const [newOptions, setNewOptions] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUnit, setEditUnit] = useState<string | null>(null);
  const [editType, setEditType] = useState<TrackVariableType>("textbox");
  const [editOptions, setEditOptions] = useState("");

  const [isSaving, setIsSaving] = useState(false);

  const trackVariables = variables.filter((v) => v.track_id === trackId);

  const resetNew = () => {
    setNewName("");
    setNewUnit(null);
    setNewType("textbox");
    setNewOptions("");
  };

  const addVariable = async () => {
    if (!newName.trim()) return;
    if (newType === "radio" && splitOptions(newOptions).length === 0) {
      toast.error("Radio button variables need at least one option");
      return;
    }
    setIsSaving(true);
    try {
      const data = await createTrackVariable({
        trackId,
        name: newName.trim(),
        unit: newUnit?.trim() || null,
        type: newType,
        options: newType === "radio" ? splitOptions(newOptions) : [],
        sortOrder: trackVariables.length,
      });
      onChange([...variables, data]);
      resetNew();
      toast.success("Variable added");
    } catch (error) {
      console.error("Error adding variable:", error);
      toast.error("Failed to add variable");
    } finally {
      setIsSaving(false);
    }
  };

  const removeVariable = async (variable: TrackVariable) => {
    try {
      await deleteTrackVariable(variable.id);
      onChange(variables.filter((v) => v.id !== variable.id));
      toast.success("Variable deleted");
    } catch (error) {
      console.error("Error deleting variable:", error);
      toast.error("Failed to delete variable");
    }
  };

  const startEdit = (variable: TrackVariable) => {
    setEditingId(variable.id);
    setEditName(variable.name);
    setEditUnit(variable.unit);
    setEditType(variable.type);
    setEditOptions((variable.options ?? []).join(", "));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditUnit(null);
    setEditType("textbox");
    setEditOptions("");
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    if (editType === "radio" && splitOptions(editOptions).length === 0) {
      toast.error("Radio button variables need at least one option");
      return;
    }
    setIsSaving(true);
    try {
      const payload = {
        name: editName.trim(),
        unit: editUnit?.trim() || null,
        type: editType,
        options: editType === "radio" ? splitOptions(editOptions) : [],
      };
      await updateTrackVariable(editingId, payload);
      onChange(
        variables.map((v) =>
          v.id === editingId ? { ...v, ...payload } : v,
        ),
      );
      cancelEdit();
      toast.success("Variable updated");
    } catch (error) {
      console.error("Error updating variable:", error);
      toast.error("Failed to update variable");
    } finally {
      setIsSaving(false);
    }
  };

  const busy = disabled || isSaving;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Custom variables</h3>
          <p className="text-xs text-muted-foreground">
            Mandatory fields shown on every company matched to this track.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {trackVariables.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            No variables yet. Add your first variable below.
          </div>
        ) : (
          trackVariables.map((variable, index) => (
            <div
              key={variable.id}
              className="flex items-start gap-3 p-3 border rounded-lg bg-card"
            >
              <Badge
                variant="secondary"
                className="shrink-0 h-6 w-6 rounded-full p-0 flex items-center justify-center bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
              >
                {index + 1}
              </Badge>

              {editingId === variable.id ? (
                <div className="flex-1 space-y-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Name
                    </label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Variable name"
                      disabled={isSaving}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Unit
                    </label>
                    <StatusCombobox
                      value={editUnit}
                      options={UNIT_OPTIONS}
                      placeholder="Select or type a unit…"
                      searchPlaceholder="Search or type a unit…"
                      emptyText="Type to add a unit."
                      onChange={setEditUnit}
                      disabled={isSaving}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Type
                    </label>
                    <RadioGroup
                      value={editType}
                      onValueChange={(v) => setEditType(v as TrackVariableType)}
                      className="flex gap-4 mt-1"
                      disabled={isSaving}
                    >
                      {TYPE_OPTIONS.map((opt) => (
                        <label
                          key={opt.value}
                          className="flex items-center gap-1.5 text-sm cursor-pointer"
                        >
                          <RadioGroupItem
                            value={opt.value}
                            id={`edit-type-${variable.id}-${opt.value}`}
                          />
                          {opt.label}
                        </label>
                      ))}
                    </RadioGroup>
                  </div>
                  {editType === "radio" && (
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">
                        Options (comma-separated)
                      </label>
                      <Input
                        value={editOptions}
                        onChange={(e) => setEditOptions(e.target.value)}
                        placeholder="e.g. open pit, underground"
                        disabled={isSaving}
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={saveEdit}
                      disabled={isSaving || !editName.trim()}
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
                    <div className="font-medium text-sm">{variable.name}</div>
                    <div className="text-muted-foreground text-xs flex flex-wrap items-center gap-1.5 mt-0.5">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {variable.type === "radio" ? "Radio button" : "Text box"}
                      </Badge>
                      {variable.unit && (
                        <span className="text-muted-foreground">
                          unit: {variable.unit}
                        </span>
                      )}
                      {variable.type === "radio" &&
                        (variable.options?.length ?? 0) > 0 && (
                          <span className="text-muted-foreground break-words">
                            • {variable.options?.join(" / ")}
                          </span>
                        )}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => startEdit(variable)}
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
                      onClick={() => removeVariable(variable)}
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

        {/* Add New Variable */}
        <div className="space-y-2 p-3 border rounded-lg border-dashed">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              placeholder="e.g. JORC Proven Reserves"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Unit
            </label>
            <StatusCombobox
              value={newUnit}
              options={UNIT_OPTIONS}
              placeholder="Select or type a unit…"
              searchPlaceholder="Search or type a unit…"
              emptyText="Type to add a unit."
              onChange={setNewUnit}
              disabled={busy}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Type
            </label>
            <RadioGroup
              value={newType}
              onValueChange={(v) => setNewType(v as TrackVariableType)}
              className="flex gap-4 mt-1"
              disabled={busy}
            >
              {TYPE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-1.5 text-sm cursor-pointer"
                >
                  <RadioGroupItem value={opt.value} id={`new-type-${opt.value}`} />
                  {opt.label}
                </label>
              ))}
            </RadioGroup>
          </div>
          {newType === "radio" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Options (comma-separated)
              </label>
              <Input
                placeholder="e.g. open pit, underground"
                value={newOptions}
                onChange={(e) => setNewOptions(e.target.value)}
                disabled={busy}
              />
            </div>
          )}
          <Button
            type="button"
            onClick={addVariable}
            disabled={!newName.trim() || busy}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Plus className="h-4 w-4 mr-1" />
                Add Variable
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
