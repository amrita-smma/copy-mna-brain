"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  ALWAYS_REQUIRED_PIPELINE_FIELD_KEYS,
  PIPELINE_REQUIRED_FIELDS,
  normalizePipelineRequiredFieldKeys,
  type PipelineFieldKey,
} from "@/lib/pipeline/requiredFields";
import {
  getPipelineRequiredFields,
  savePipelineRequiredFields,
} from "@/lib/api/pipelineRequiredFields";
import { PIPELINE_REQUIRED_FIELDS_QUERY_ROOT } from "@/hooks/usePipelineRequiredFields";

interface RequiredFieldsSettingsProps {
  /** The footer's Cancel: closes the Pipeline Settings dialog, dropping unsaved edits. */
  onCancel?: () => void;
}

const sameKeys = (a: readonly PipelineFieldKey[], b: readonly PipelineFieldKey[]) =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * The Required Fields tab of the Pipeline Settings dialog: which fields a
 * company must have before it can enter the pipeline. Enforced server-side on
 * every path into the pipeline (promote, the Current Stage dropdown, Smart Files approval,
 * auto-promote). An unconfigured workspace requires every field.
 */
export default function RequiredFieldsSettings({ onCancel }: RequiredFieldsSettingsProps) {
  const [saved, setSaved] = useState<PipelineFieldKey[]>([]);
  const [draft, setDraft] = useState<PipelineFieldKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    getPipelineRequiredFields()
      .then((keys) => {
        if (cancelled) return;
        const normalized = normalizePipelineRequiredFieldKeys(keys);
        setSaved(normalized);
        setDraft(normalized);
      })
      .catch((err) => {
        console.error("Failed to load required fields:", err);
        toast.error("Failed to load required fields");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => !sameKeys(saved, draft), [saved, draft]);

  const toggle = (key: PipelineFieldKey, on: boolean) =>
    setDraft((prev) =>
      normalizePipelineRequiredFieldKeys(on ? [...prev, key] : prev.filter((k) => k !== key)),
    );

  const save = async () => {
    setSaving(true);
    try {
      const next = normalizePipelineRequiredFieldKeys(await savePipelineRequiredFields(draft));
      setSaved(next);
      setDraft(next);
      void queryClient.invalidateQueries({ queryKey: [PIPELINE_REQUIRED_FIELDS_QUERY_ROOT] });
      toast.success("Required fields saved");
    } catch (err: any) {
      console.error("Failed to save required fields:", err);
      toast.error(`Failed to save: ${err.message || "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-[60vh] flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <div>
          <h3 className="text-base font-semibold">Required Fields</h3>
          <p className="text-sm text-muted-foreground">
            Choose which fields a company must have before it can enter the pipeline.
            Companies already in the pipeline are not affected.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <div className="divide-y rounded-lg border bg-card">
            {PIPELINE_REQUIRED_FIELDS.map((field) => {
              const locked = ALWAYS_REQUIRED_PIPELINE_FIELD_KEYS.includes(field.key);
              const checked = draft.includes(field.key);
              const id = `pipeline-required-${field.key}`;
              return (
                <div
                  key={field.key}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                  data-testid={`required-field-${field.key}`}
                >
                  <label htmlFor={id} className={cn("min-w-0", !locked && "cursor-pointer")}>
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {field.label}
                      {locked && (
                        <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Always required" />
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">{field.hint}</span>
                  </label>
                  <Switch
                    id={id}
                    checked={checked}
                    onCheckedChange={(on) => toggle(field.key, on)}
                    disabled={locked || saving}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-6 py-3.5 border-t">
        <p className="text-sm text-muted-foreground">
          {dirty ? "Unsaved changes" : null}
        </p>
        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button
            type="button"
            data-testid="required-fields-save"
            onClick={() => void save()}
            disabled={loading || saving || !dirty}
          >
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </div>
    </div>
  );
}
