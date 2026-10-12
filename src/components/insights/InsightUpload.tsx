'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/layout/PageHeader';
import { useWorkspacePush } from '@/hooks/useWorkspaceHref';
import { uploadInsightFile } from '@/lib/api/insights';
import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/srcdoc';
import { suggestInsightUploadName } from '@/lib/insights/upload';
import { InsightFrame } from './InsightFrame';
import {
  INSIGHT_UPLOAD_FILE_RULES,
  InsightTemplateFileDrop,
  canSaveTemplateSelection,
  inspectFileForDrop,
  type TemplateFileSelection,
} from './InsightTemplateFileDrop';
import { clearPendingInsightUpload, peekPendingInsightUpload } from './pendingInsightUpload';
import { ArrowRight, CheckCircle2, Loader2, RotateCcw, Upload, XCircle } from 'lucide-react';

type UploadStatus =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'success'; insight: { id: string; name: string } }
  | { kind: 'error'; message: string };

/**
 * Upload an HTML file as a new insight (MB-635): pick a file, check it and
 * preview it in the sandboxed frame, name it, then save. The upload shows
 * a loader while it runs, then a success panel with a link to the new
 * insight, or the reason it failed.
 */
export function InsightUpload() {
  const push = useWorkspacePush();
  const [selection, setSelection] = useState<TemplateFileSelection | null>(null);
  const [name, setName] = useState('');
  // Once the user types a name, picking another file no longer replaces it.
  const [nameEdited, setNameEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<UploadStatus>({ kind: 'idle' });

  const handleSelectionChange = (next: TemplateFileSelection | null) => {
    setSelection(next);
    if (next?.html && !nameEdited) {
      setName(suggestInsightUploadName(next.file.name, next.html));
    }
  };

  // A file dropped on the insight list arrives here already chosen.
  useEffect(() => {
    const dropped = peekPendingInsightUpload();
    if (!dropped) return;
    let cancelled = false;
    void inspectFileForDrop(dropped, INSIGHT_UPLOAD_FILE_RULES).then((next) => {
      if (cancelled) return;
      clearPendingInsightUpload(dropped);
      if (next) handleSelectionChange(next);
    });
    return () => {
      cancelled = true;
    };
    // Mount only: the slot is read once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setSelection(null);
    setName('');
    setNameEdited(false);
    setDescription('');
    setStatus({ kind: 'idle' });
  };

  const canUpload = status.kind === 'idle' && canSaveTemplateSelection(selection);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canUpload || !selection) return;
    setStatus({ kind: 'uploading' });
    try {
      const insight = await uploadInsightFile({ file: selection.file, name, description });
      setStatus({ kind: 'success', insight: { id: insight.id, name: insight.name } });
    } catch (err: unknown) {
      console.error('Failed to upload insight', err);
      setStatus({
        kind: 'error',
        message: err instanceof Error && err.message ? err.message : 'Failed to create the insight.',
      });
    }
  };

  if (status.kind === 'uploading') {
    return (
      <UploadPanel testId="insight-upload-progress">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <h2 className="text-lg font-semibold text-foreground">Creating your insight…</h2>
        <p className="text-sm text-muted-foreground">
          Uploading <span className="font-medium text-foreground">{selection?.file.name}</span>.
          Large files can take a moment.
        </p>
      </UploadPanel>
    );
  }

  if (status.kind === 'success') {
    return (
      <UploadPanel testId="insight-upload-success">
        <CheckCircle2 className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
        <h2 className="text-lg font-semibold text-foreground">Insight created</h2>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{status.insight.name}</span> was uploaded
          and is ready to view.
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <Button type="button" variant="outline" onClick={reset} data-testid="insight-upload-another">
            <Upload className="h-4 w-4" />
            Upload another
          </Button>
          <Button
            type="button"
            onClick={() => push(`/insight/${status.insight.id}`)}
            data-testid="insight-upload-view"
          >
            View insight
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </UploadPanel>
    );
  }

  if (status.kind === 'error') {
    return (
      <UploadPanel testId="insight-upload-error">
        <XCircle className="h-10 w-10 text-destructive" />
        <h2 className="text-lg font-semibold text-foreground">Couldn&apos;t create the insight</h2>
        <p
          className="max-w-xl text-left text-sm text-muted-foreground whitespace-pre-line break-words"
          data-testid="insight-upload-error-message"
        >
          {status.message}
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <Button type="button" variant="outline" onClick={reset}>
            Choose another file
          </Button>
          <Button
            type="button"
            onClick={() => setStatus({ kind: 'idle' })}
            data-testid="insight-upload-retry"
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      </UploadPanel>
    );
  }

  return (
    <div className="min-h-full">
      <PageHeader
        title="Upload HTML file"
        subtitle="Turn an HTML document into an insight without prompting Copilot. It is saved exactly as uploaded, and you can refine it with Copilot afterwards."
        innerClassName="mx-auto w-full max-w-5xl"
      />

      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-6 space-y-6">
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-border bg-card p-5 space-y-4"
        data-testid="insight-upload-form"
      >
        <InsightTemplateFileDrop
          selection={selection}
          onSelectionChange={handleSelectionChange}
          testIdPrefix="insight-upload"
          rules={INSIGHT_UPLOAD_FILE_RULES}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="insight-upload-name">Name</Label>
            <Input
              id="insight-upload-name"
              value={name}
              maxLength={MAX_INSIGHT_NAME_LENGTH}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              placeholder="Taken from the file if left blank"
              data-testid="insight-upload-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="insight-upload-description">Description</Label>
            <Textarea
              id="insight-upload-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="min-h-[38px]"
              rows={1}
              data-testid="insight-upload-description"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => push('/insight/list')}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canUpload} data-testid="insight-upload-submit">
            <Upload className="h-4 w-4" />
            Upload insight
          </Button>
        </div>
      </form>

      {canSaveTemplateSelection(selection) && (
        <section className="rounded-xl border border-border bg-card p-3 space-y-2" data-testid="insight-upload-preview">
          <p className="px-1 text-xs font-medium text-muted-foreground">
            Preview — rendered the way the insight will be, with the same restrictions
          </p>
          <div className="rounded-lg border border-border bg-card overflow-hidden min-w-0">
            <InsightFrame
              html={selection.html}
              title={`Preview of ${selection.file.name}`}
              minHeight={300}
              maxHeight={720}
            />
          </div>
        </section>
      )}
      </div>
    </div>
  );
}

function UploadPanel({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-12">
      <div
        className="rounded-xl border border-border bg-card p-8 flex flex-col items-center text-center gap-3"
        data-testid={testId}
        role="status"
        aria-live="polite"
      >
        {children}
      </div>
    </div>
  );
}
