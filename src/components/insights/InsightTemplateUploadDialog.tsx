'use client';

import { useState } from 'react';
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
import { uploadInsightTemplate } from '@/lib/api/insightTemplates';
import { InsightTemplateIconSelect } from './InsightTemplateIconSelect';
import {
  InsightTemplateFileDrop,
  canSaveTemplateSelection,
  type TemplateFileSelection,
} from './InsightTemplateFileDrop';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export interface InsightTemplateUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded?: () => void;
}

export function InsightTemplateUploadDialog({
  open,
  onOpenChange,
  onUploaded,
}: InsightTemplateUploadDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [selection, setSelection] = useState<TemplateFileSelection | null>(null);
  const [uploading, setUploading] = useState(false);

  const resetState = () => {
    setName('');
    setDescription('');
    setIcon(null);
    setSelection(null);
    setUploading(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (uploading) return;
    if (!nextOpen) {
      resetState();
    }
    onOpenChange(nextOpen);
  };

  const handleSelectionChange = (next: TemplateFileSelection | null) => {
    setSelection(next);
    if (next && !name.trim()) {
      // Pre-fill the name from the file name without its extension.
      const baseName = next.file.name.replace(/\.[^/.]+$/, '').trim();
      if (baseName) setName(baseName);
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || !canSaveTemplateSelection(selection) || uploading) return;

    setUploading(true);
    try {
      await uploadInsightTemplate({
        name: trimmedName,
        description: description.trim() || null,
        icon,
        html: selection.html,
      });
      toast.success('Template uploaded');
      // Close directly: handleOpenChange ignores close requests mid-upload,
      // and `uploading` is still true in this closure.
      resetState();
      onOpenChange(false);
      onUploaded?.();
    } catch (err: unknown) {
      console.error('Failed to upload template', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to upload template',
      );
    } finally {
      setUploading(false);
    }
  };

  const isUploadDisabled =
    uploading || !name.trim() || !canSaveTemplateSelection(selection);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="bg-card text-card-foreground border border-border sm:max-w-md p-6 shadow-lg max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => {
          if (uploading) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (uploading) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            Upload Template
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleUpload} className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label
              htmlFor="template-name-input"
              className="text-sm font-medium text-foreground"
            >
              Template Name
            </Label>
            <Input
              id="template-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Market Brief"
              disabled={uploading}
              className="bg-card text-foreground border border-input"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="template-description-input"
              className="text-sm font-medium text-foreground"
            >
              Description
            </Label>
            <Textarea
              id="template-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe this template..."
              disabled={uploading}
              className="bg-card text-foreground border border-input min-h-[80px]"
            />
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="template-icon-select"
              className="text-sm font-medium text-foreground"
            >
              Icon
            </Label>
            <InsightTemplateIconSelect
              id="template-icon-select"
              value={icon}
              onChange={setIcon}
              disabled={uploading}
            />
          </div>

          <InsightTemplateFileDrop
            selection={selection}
            onSelectionChange={handleSelectionChange}
            disabled={uploading}
            testIdPrefix="template-upload"
          />

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={uploading}
              className="bg-card text-foreground border-border hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isUploadDisabled}
              className="bg-primary text-primary-foreground hover:bg-primary"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Uploading...
                </>
              ) : (
                'Upload'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
