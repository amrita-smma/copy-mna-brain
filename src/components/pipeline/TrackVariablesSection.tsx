"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Check, SlidersHorizontal, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import {
  getTrackVariables,
  updateCompany,
  type Track,
  type TrackVariable,
} from "@/lib/api/pipeline";
import type { TrackSpecificVariables } from "@/lib/db/schema";
import { trackDisplayName } from "@/lib/tracks/matchTracks";

/**
 * Renders the custom variables defined on a company's matched Tracks, grouped
 * by track, with each value editable (text box or radio) and persisted to
 * `companies.track_specific_variables`. Shown on the Company Card above Stage
 * History. Renders nothing when none of the matched tracks define variables.
 */
interface TrackVariablesSectionProps {
  companyId: string;
  /** Persisted matched track ids for this company. */
  matchedTrackIds: string[];
  /** Full track list, for display names. */
  tracks: Track[];
  /** Current persisted values: { [trackId]: { [variableId]: value } }. */
  values: TrackSpecificVariables | null | undefined;
  /** Called after a successful save with the persisted values. */
  onSaved?: (next: TrackSpecificVariables) => void;
  /**
   * Track variable ids currently surfaced on the Company Card slide deck
   * (under "Indicative Financials").
   */
  slideVariableIds?: string[] | null;
  /** Called after the slide-deck selection is persisted. */
  onSlideVariablesSaved?: (next: string[]) => void;
  disabled?: boolean;
}

export default function TrackVariablesSection({
  companyId,
  matchedTrackIds,
  tracks,
  values,
  onSaved,
  slideVariableIds,
  onSlideVariablesSaved,
  disabled,
}: TrackVariablesSectionProps) {
  const [allVariables, setAllVariables] = useState<TrackVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<TrackSpecificVariables>({});
  const [saving, setSaving] = useState(false);
  // Variable ids shown on the slide deck. Toggled via the per-variable eye icon
  // and persisted immediately (optimistic).
  const [slideSelected, setSlideSelected] = useState<Set<string>>(new Set());
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const matchedSet = useMemo(
    () => new Set(matchedTrackIds ?? []),
    [matchedTrackIds],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTrackVariables()
      .then((rows) => {
        if (!cancelled) setAllVariables(rows);
      })
      .catch((err) => {
        console.error("Failed to load track variables:", err);
        if (!cancelled) setAllVariables([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset the editable draft whenever the persisted values change.
  useEffect(() => {
    setDraft(values ? JSON.parse(JSON.stringify(values)) : {});
  }, [values]);

  // Mirror the persisted slide-deck selection into local state.
  useEffect(() => {
    setSlideSelected(new Set(slideVariableIds ?? []));
  }, [slideVariableIds]);

  const toggleSlideVariable = async (variableId: string) => {
    if (disabled || togglingId) return;
    const next = new Set(slideSelected);
    if (next.has(variableId)) next.delete(variableId);
    else next.add(variableId);
    const nextIds = Array.from(next);

    setSlideSelected(next);
    setTogglingId(variableId);
    try {
      await updateCompany(companyId, { slide_track_variable_ids: nextIds });
      onSlideVariablesSaved?.(nextIds);
    } catch (error) {
      console.error("Failed to update slide variables:", error);
      toast.error("Failed to update slide deck selection");
      // Revert on failure.
      setSlideSelected(new Set(slideVariableIds ?? []));
    } finally {
      setTogglingId(null);
    }
  };

  // Only matched tracks that actually define variables.
  const groups = useMemo(() => {
    const byTrack = new Map<string, TrackVariable[]>();
    for (const v of allVariables) {
      if (!matchedSet.has(v.track_id)) continue;
      const list = byTrack.get(v.track_id) ?? [];
      list.push(v);
      byTrack.set(v.track_id, list);
    }
    return Array.from(byTrack.entries()).map(([trackId, vars]) => {
      const track = tracks.find((t) => t.id === trackId);
      return {
        trackId,
        title: track ? trackDisplayName(track) : "Track",
        vars,
      };
    });
  }, [allVariables, matchedSet, tracks]);

  const getValue = (trackId: string, variableId: string): string =>
    draft[trackId]?.[variableId] ?? "";

  const setValue = (trackId: string, variableId: string, value: string) =>
    setDraft((prev) => ({
      ...prev,
      [trackId]: { ...(prev[trackId] ?? {}), [variableId]: value },
    }));

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(values ?? {}),
    [draft, values],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateCompany(companyId, { track_specific_variables: draft });
      toast.success("Variables saved");
      onSaved?.(draft);
    } catch (error) {
      console.error("Failed to save track variables:", error);
      toast.error("Failed to save variables");
    } finally {
      setSaving(false);
    }
  };

  if (loading || groups.length === 0) return null;

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Track Variables
        </p>
        {dirty && (
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1"
            onClick={handleSave}
            disabled={saving || disabled}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.trackId} className="space-y-2">
            {groups.length > 1 && (
              <p className="text-[11px] font-semibold text-muted-foreground">
                {group.title}
              </p>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {group.vars.map((variable) => (
                <div key={variable.id} className="min-w-[180px] flex-1 space-y-1">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1">
                    {variable.name}
                    {variable.unit && (
                      <span className="text-[10px] font-normal text-muted-foreground/70">
                        ({variable.unit})
                      </span>
                    )}
                    {(() => {
                      const shown = slideSelected.has(variable.id);
                      return (
                        <button
                          type="button"
                          onClick={() => toggleSlideVariable(variable.id)}
                          disabled={disabled || togglingId === variable.id}
                          aria-pressed={shown}
                          title={
                            shown
                              ? "Shown in slide deck — click to hide"
                              : "Hidden from slide deck — click to show"
                          }
                          aria-label={
                            shown
                              ? `Hide ${variable.name} from slide deck`
                              : `Show ${variable.name} in slide deck`
                          }
                          className={
                            "ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded transition-colors disabled:opacity-50 " +
                            (shown
                              ? "text-blue-600 hover:text-blue-700"
                              : "text-muted-foreground/50 hover:text-muted-foreground")
                          }
                        >
                          {togglingId === variable.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : shown ? (
                            <Eye className="h-3 w-3" />
                          ) : (
                            <EyeOff className="h-3 w-3" />
                          )}
                        </button>
                      );
                    })()}
                  </Label>
                  {variable.type === "radio" ? (
                    <RadioGroup
                      value={getValue(group.trackId, variable.id)}
                      onValueChange={(v) =>
                        setValue(group.trackId, variable.id, v)
                      }
                      className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5"
                      disabled={disabled}
                    >
                      {(variable.options ?? []).map((opt) => (
                        <label
                          key={opt}
                          className="flex items-center gap-1.5 text-sm cursor-pointer"
                        >
                          <RadioGroupItem
                            value={opt}
                            id={`tv-${variable.id}-${opt}`}
                          />
                          {opt}
                        </label>
                      ))}
                    </RadioGroup>
                  ) : (
                    <Input
                      value={getValue(group.trackId, variable.id)}
                      onChange={(e) =>
                        setValue(group.trackId, variable.id, e.target.value)
                      }
                      placeholder={variable.unit ? `Value in ${variable.unit}` : "Value"}
                      className="h-8 text-sm"
                      disabled={disabled}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
