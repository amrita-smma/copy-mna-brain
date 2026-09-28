'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  MAX_TEMPLATE_CHARS,
  isValidTemplateExtension,
  validateTemplateFile,
} from '@/lib/api/insightTemplates';
import { checkTemplateHtml, type TemplateCheckResult } from '@/lib/insights/templateCheck';
import { AlertTriangle, CloudUpload, FileText, X, XCircle } from 'lucide-react';
import { toast } from 'sonner';

/** A picked file and what the pre-save check found in it. */
export interface TemplateFileSelection {
  file: File;
  /** The file's text, or null when it failed the upload rules. */
  html: string | null;
  check: TemplateCheckResult;
}

/** True when the selection may be saved: read, and no blocking errors. */
export function canSaveTemplateSelection(
  selection: TemplateFileSelection | null,
): selection is TemplateFileSelection & { html: string } {
  return selection !== null && selection.html !== null && selection.check.errors.length === 0;
}

export interface InsightTemplateFileDropProps {
  selection: TemplateFileSelection | null;
  onSelectionChange: (selection: TemplateFileSelection | null) => void;
  disabled?: boolean;
  testIdPrefix?: string;
}

/**
 * The template file drop zone shared by upload and Replace HTML. A picked
 * file is read and checked before anything is saved: errors (wrong size,
 * empty) block the save, structure warnings are shown but don't.
 */
export function InsightTemplateFileDrop({
  selection,
  onSelectionChange,
  disabled,
  testIdPrefix = 'template-file',
}: InsightTemplateFileDropProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A cleared selection (removed, or saved by the parent) also clears the
  // input, so picking the same file again still fires onChange.
  useEffect(() => {
    if (!selection && fileInputRef.current) fileInputRef.current.value = '';
  }, [selection]);

  const clear = () => {
    onSelectionChange(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    if (!isValidTemplateExtension(file.name)) {
      toast.error('Invalid file type. Only HTML files are supported.');
      return;
    }
    const result = await validateTemplateFile(file);
    if ('error' in result) {
      onSelectionChange({ file, html: null, check: { errors: [result.error], warnings: [] } });
      return;
    }
    onSelectionChange({ file, html: result.html, check: checkTemplateHtml(result.html) });
  };

  const stop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          stop(e);
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          stop(e);
          setIsDragging(false);
        }}
        onDrop={(e) => {
          stop(e);
          setIsDragging(false);
          if (!disabled) void handleFile(e.dataTransfer.files?.[0]);
        }}
        className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors bg-muted ${
          isDragging ? 'border-primary' : 'border-border'
        }`}
      >
        <CloudUpload className="h-8 w-8 mx-auto text-primary mb-2" />
        <div className="text-sm text-muted-foreground mb-2">Drag &amp; drop a file, or</div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          data-testid={`${testIdPrefix}-browse`}
        >
          Browse Files
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".html"
          className="hidden"
          data-testid={`${testIdPrefix}-input`}
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        <div className="text-xs text-muted-foreground mt-2">
          HTML up to {MAX_TEMPLATE_CHARS.toLocaleString('en-US')} characters
        </div>

        {selection && (
          <div className="mt-4 p-2.5 rounded-lg bg-card border border-border flex items-center justify-between text-left">
            <div className="flex items-center gap-2 min-w-0 mr-2">
              <FileText className="h-4 w-4 shrink-0 text-primary" />
              <span className="text-xs font-medium text-foreground truncate">
                {selection.file.name}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              disabled={disabled}
              onClick={clear}
            >
              <X className="h-3.5 w-3.5" />
              <span className="sr-only">Remove file</span>
            </Button>
          </div>
        )}
      </div>

      {selection && selection.check.errors.length > 0 && (
        <ul className="space-y-1" data-testid={`${testIdPrefix}-errors`}>
          {selection.check.errors.map((msg) => (
            <li key={msg} className="flex items-start gap-1.5 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5 mt-px shrink-0" />
              <span>{msg}</span>
            </li>
          ))}
        </ul>
      )}
      {selection && selection.check.warnings.length > 0 && (
        <ul className="space-y-1" data-testid={`${testIdPrefix}-warnings`}>
          {selection.check.warnings.map((msg) => (
            <li key={msg} className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0 text-amber-600 dark:text-amber-400" />
              <span>{msg}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
