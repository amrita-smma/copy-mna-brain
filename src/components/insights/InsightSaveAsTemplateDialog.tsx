'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { saveInsightAsTemplate } from '@/lib/api/insightTemplates';
import { Loader2, AlertTriangle, LayoutTemplate } from 'lucide-react';
import { toast } from 'sonner';

export interface InsightSaveAsTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  insightId: string;
  defaultName: string;
}

export function InsightSaveAsTemplateDialog({
  open,
  onOpenChange,
  insightId,
  defaultName,
}: InsightSaveAsTemplateDialogProps) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setDescription('');
      setSubmitting(false);
    }
  }, [open, defaultName]);

  const trimmed = name.trim();
  const isSaveDisabled = submitting || !trimmed;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaveDisabled) return;

    setSubmitting(true);
    try {
      const template = await saveInsightAsTemplate(insightId, {
        name: trimmed,
        description: description.trim() ? description.trim() : null,
      });
      toast.success(`Saved as template "${template.name}"`);
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('Failed to save insight as template', err);
      toast.error(
        err instanceof Error
          ? err.message
          : 'Failed to save insight as template. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (submitting) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="bg-card text-card-foreground border border-border sm:max-w-lg p-6 shadow-lg"
        onPointerDownOutside={(e) => {
          if (submitting) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (submitting) e.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <LayoutTemplate className="h-5 w-5 text-primary" />
            <DialogTitle className="text-xl font-semibold">
              Save as Template
            </DialogTitle>
          </div>
          <DialogDescription className="text-muted-foreground text-sm">
            Save this insight as a reusable template for your workspace.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div
            data-testid="save-as-template-keep-note"
            className="p-3 rounded-lg bg-muted text-muted-foreground border border-border flex items-start gap-2.5 text-xs sm:text-sm leading-relaxed"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
            <span>Real figures, names and dates will be visible to everyone in this workspace.</span>
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="template-name"
              className="text-sm font-medium text-foreground"
            >
              Template Name
            </Label>
            <Input
              id="template-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Portfolio Executive Summary"
              disabled={submitting}
              className="bg-card text-foreground border border-input"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="template-description"
              className="text-sm font-medium text-foreground"
            >
              Description (optional)
            </Label>
            <Textarea
              id="template-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the structure or purpose of this template..."
              disabled={submitting}
              rows={3}
              className="bg-card text-foreground border border-input resize-none"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="bg-card text-foreground border-border hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={isSaveDisabled}
              className="bg-primary text-primary-foreground hover:bg-primary"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
