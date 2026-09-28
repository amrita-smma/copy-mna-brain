'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  replaceInsightTemplateHtml,
  updateInsightTemplate,
  type InsightTemplateSummary,
} from '@/lib/api/insightTemplates';
import { InsightTemplateIconSelect } from './InsightTemplateIconSelect';
import {
  InsightTemplateFileDrop,
  canSaveTemplateSelection,
  type TemplateFileSelection,
} from './InsightTemplateFileDrop';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export interface InsightTemplateEditDialogProps {
  template: InsightTemplateSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

export function InsightTemplateEditDialog({
  template,
  open,
  onOpenChange,
  onSaved,
}: InsightTemplateEditDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<TemplateFileSelection | null>(null);
  const [replacing, setReplacing] = useState(false);

  const busy = saving || replacing;

  useEffect(() => {
    if (template && open) {
      setName(template.name);
      setDescription(template.description ?? '');
      setIcon(template.icon ?? null);
      setSelection(null);
    }
  }, [template, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (busy) return;
    onOpenChange(nextOpen);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || !template || busy) return;

    setSaving(true);
    try {
      await updateInsightTemplate(template.id, {
        name: trimmedName,
        description: description.trim() || null,
        icon,
      });
      toast.success('Template updated');
      onOpenChange(false);
      onSaved?.();
    } catch (err: unknown) {
      console.error('Failed to update template', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to update template',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReplace = async () => {
    if (!template || busy || !canSaveTemplateSelection(selection)) return;
    setReplacing(true);
    try {
      await replaceInsightTemplateHtml(template.id, selection.html);
      toast.success('Template HTML replaced');
      setSelection(null);
      onSaved?.();
    } catch (err: unknown) {
      console.error('Failed to replace template HTML', err);
      toast.error(err instanceof Error ? err.message : 'Failed to replace template HTML');
    } finally {
      setReplacing(false);
    }
  };

  const isSaveDisabled = busy || !name.trim();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="bg-card text-card-foreground border border-border sm:max-w-lg p-6 shadow-lg max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            Edit Template
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSave} className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label
              htmlFor="edit-template-name-input"
              className="text-sm font-medium text-foreground"
            >
              Template Name
            </Label>
            <Input
              id="edit-template-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Market Brief"
              disabled={busy}
              className="bg-card text-foreground border border-input"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="edit-template-description-input"
              className="text-sm font-medium text-foreground"
            >
              Description
            </Label>
            <Textarea
              id="edit-template-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe this template..."
              disabled={busy}
              className="bg-card text-foreground border border-input min-h-[80px]"
            />
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="edit-template-icon-select"
              className="text-sm font-medium text-foreground"
            >
              Icon
            </Label>
            <InsightTemplateIconSelect
              id="edit-template-icon-select"
              value={icon}
              onChange={setIcon}
              disabled={busy}
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
              className="bg-card text-foreground border-border hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaveDisabled}
              className="bg-primary text-primary-foreground hover:bg-primary"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </DialogFooter>
        </form>

        <section className="space-y-3 border-t border-border pt-4" aria-labelledby="replace-html-heading">
          <div>
            <h3 id="replace-html-heading" className="text-sm font-semibold text-foreground">
              Replace HTML
            </h3>
            <p className="text-xs text-muted-foreground">
              Upload a new file to replace the template&rsquo;s current HTML.
            </p>
          </div>
          <InsightTemplateFileDrop
            selection={selection}
            onSelectionChange={setSelection}
            disabled={busy}
            testIdPrefix="template-replace"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={handleReplace}
              disabled={busy || !canSaveTemplateSelection(selection)}
              data-testid="template-replace-submit"
            >
              {replacing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Replacing...
                </>
              ) : (
                'Replace HTML'
              )}
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
