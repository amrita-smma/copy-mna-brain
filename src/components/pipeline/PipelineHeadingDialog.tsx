"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { savePipelineHeading } from "@/lib/api/pipelineHeading";
import {
  DEFAULT_PIPELINE_SUBTITLE,
  DEFAULT_PIPELINE_TITLE,
  PIPELINE_SUBTITLE_MAX_LENGTH,
  PIPELINE_TITLE_MAX_LENGTH,
  type PipelineHeading,
} from "@/lib/pipeline/heading";

interface PipelineHeadingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The heading currently rendered, used to seed the inputs. */
  heading: PipelineHeading;
  /** Receives the resolved heading the server stored, to paint in place. */
  onSaved: (heading: PipelineHeading) => void;
}

/**
 * Renames the Deal Pipeline page's title and subtitle for the whole workspace.
 * This is a shared setting, not a personal one — the copy here says so, since
 * nothing else on the page would tell the user that.
 *
 * Clearing a field restores the product default rather than leaving a blank
 * heading; `parsePipelineHeadingInput` stores blank input as NULL server-side.
 */
export default function PipelineHeadingDialog({
  open,
  onOpenChange,
  heading,
  onSaved,
}: PipelineHeadingDialogProps) {
  const [title, setTitle] = useState(heading.title);
  const [subtitle, setSubtitle] = useState(heading.subtitle);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await savePipelineHeading({
        title: title.trim() || null,
        subtitle: subtitle.trim() || null,
      });
      onSaved(saved);
      toast.success("Pipeline heading updated");
      onOpenChange(false);
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error ? error.message : "Could not save the pipeline heading",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="pipeline-heading-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit pipeline heading</DialogTitle>
          <DialogDescription>
            The title and subtitle shown at the top of this page. Saved for the whole
            workspace — everyone sees the same heading.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="pipeline-heading-title">Title</Label>
            <Input
              id="pipeline-heading-title"
              data-testid="pipeline-heading-title-input"
              value={title}
              maxLength={PIPELINE_TITLE_MAX_LENGTH}
              placeholder={DEFAULT_PIPELINE_TITLE}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pipeline-heading-subtitle">Subtitle</Label>
            <Input
              id="pipeline-heading-subtitle"
              data-testid="pipeline-heading-subtitle-input"
              value={subtitle}
              maxLength={PIPELINE_SUBTITLE_MAX_LENGTH}
              placeholder={DEFAULT_PIPELINE_SUBTITLE}
              onChange={(e) => setSubtitle(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Leave a field blank to restore its default.
          </p>
        </div>

        <DialogFooter>
          <Button
            data-testid="pipeline-heading-cancel-button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            data-testid="pipeline-heading-save-button"
            onClick={handleSave}
            disabled={saving}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
