'use client';

import { useCallback, useRef, useState } from 'react';
import { CloudUpload, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  confirmProfileMemories,
  extractProfileMemories,
  extractProfileMemoriesFromFile,
} from '@/lib/api/profileMemory';

/**
 * Longest paste the endpoint accepts. Mirrored from `MAX_IMPORT_CHARS` in
 * `userMemoryService` so the textarea can say "too long" before a 100k-character
 * round trip; the server still enforces it.
 */
const MAX_CHARS = 100_000;

/** Matches the server's `MAX_FILE_BYTES`, for the same reason. */
const MAX_FILE_MB = 10;

/**
 * What the server's `extractTextFromFile` can read. The picker enforces this
 * through `accept`, but a drag-and-drop bypasses that entirely — so the same
 * list is checked on drop, or dropping would be laxer than clicking.
 */
const ACCEPTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt', '.md'] as const;
const ACCEPTED_FILES = `${ACCEPTED_EXTENSIONS.join(',')},text/plain,application/pdf`;

/** Mirrors the server's `MAX_FILE_BYTES`, so an oversized file is caught before upload. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Why a file cannot be used, or null when it can. */
export function rejectFileReason(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return `"${file.name}" is not a kind of file we can read. Try a PDF, Word file, or plain text.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `"${file.name}" is larger than ${MAX_FILE_MB}MB.`;
  }
  return null;
}

/** Which half of the two-step import the dialog is showing. */
type Phase = 'choose' | 'digesting' | 'review';

export interface MemoryImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after memories are saved so the list behind the dialog refreshes. */
  onImported: () => void;
}

/**
 * "Import memory from another location" — a two-step flow, deliberately.
 *
 * Step one reads a file or a paste and the CoPilot proposes what it would
 * remember. Step two shows those proposals for the user to edit or drop, and
 * only the survivors are stored. An import writes to a store that is read back
 * into unrelated conversations for months, so it is never the side effect of
 * pressing one button.
 *
 * The source material is not kept — only the statements the user approves.
 */
export default function MemoryImportDialog({
  open,
  onOpenChange,
  onImported,
}: MemoryImportDialogProps) {
  const [phase, setPhase] = useState<Phase>('choose');
  const [tab, setTab] = useState<'file' | 'text'>('file');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [origin, setOrigin] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tooLong = text.length > MAX_CHARS;
  const busy = phase === 'digesting' || saving;
  const canExtract =
    !busy && (tab === 'file' ? file !== null : text.trim().length > 0 && !tooLong);

  /** One route for both the picker and a drop, so they validate identically. */
  const pickFile = useCallback((candidate: File | null | undefined) => {
    if (!candidate) return;
    const reason = rejectFileReason(candidate);
    if (reason) {
      toast.error(reason);
      return;
    }
    setFile(candidate);
  }, []);

  const reset = useCallback(() => {
    setPhase('choose');
    setDragging(false);
    setTab('file');
    setText('');
    setNote('');
    setFile(null);
    setDrafts([]);
    setOrigin(null);
  }, []);

  const close = useCallback(
    (next: boolean) => {
      // Work in flight is a server-side agent run; closing would orphan it with
      // no way to report back.
      if (busy) return;
      if (!next) reset();
      onOpenChange(next);
    },
    [busy, reset, onOpenChange],
  );

  const handleExtract = useCallback(async () => {
    setPhase('digesting');
    try {
      const proposal =
        tab === 'file' && file
          ? await extractProfileMemoriesFromFile({ file, note: note.trim() || undefined })
          : await extractProfileMemories({ text: text.trim() });

      setOrigin(proposal.origin);
      setDrafts(proposal.statements);
      setPhase('review');

      if (proposal.statements.length === 0) {
        toast.info(
          proposal.summary || 'Nothing worth remembering was found in that.',
        );
      }
    } catch (err) {
      setPhase('choose');
      toast.error(err instanceof Error ? err.message : 'Could not read that');
    }
  }, [tab, file, note, text]);

  const handleSave = useCallback(async () => {
    const statements = drafts.map((s) => s.trim()).filter(Boolean);
    if (statements.length === 0) return;

    setSaving(true);
    try {
      const result = await confirmProfileMemories({ statements, origin });
      if (result.added > 0) {
        toast.success(
          `Saved ${result.added} ${result.added === 1 ? 'memory' : 'memories'}.`,
        );
      } else {
        // Deliberately not "everything was already remembered": nothing landing
        // can also mean the extraction behind the save failed, and claiming a
        // cause we cannot verify sent the last report chasing the wrong thing.
        toast.info('Nothing new was added to memory.');
      }
      onImported();
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save those memories');
    } finally {
      setSaving(false);
    }
  }, [drafts, origin, onImported, reset, onOpenChange]);

  const editDraft = useCallback((index: number, value: string) => {
    setDrafts((current) => current.map((item, i) => (i === index ? value : item)));
  }, []);

  const removeDraft = useCallback((index: number) => {
    setDrafts((current) => current.filter((_, i) => i !== index));
  }, []);

  const remaining = drafts.filter((s) => s.trim()).length;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className={phase === 'review' ? 'max-h-[85vh] max-w-2xl overflow-y-auto' : 'max-w-xl'}
        data-testid="memory-import-dialog"
        // A file dropped anywhere but the zone would otherwise make the browser
        // navigate to it, throwing away the note and the review list. Swallowed
        // here so missing the target by a few pixels costs nothing.
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
        {phase === 'digesting' ? (
          <div
            className="flex flex-col items-center gap-3.5 py-10"
            data-testid="memory-import-digesting"
          >
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
            <p className="text-sm font-medium">
              Working out what&apos;s worth remembering…
            </p>
            <p className="text-center text-sm text-muted-foreground">
              Only durable facts about you are kept. You&apos;ll see them before
              anything is saved.
            </p>
          </div>
        ) : phase === 'review' ? (
          <>
            <DialogHeader>
              <DialogTitle>Review what the CoPilot will remember</DialogTitle>
              <DialogDescription>
                Here&apos;s what it pulled out as durable. Edit or remove anything
                before saving — nothing is stored until you do.
              </DialogDescription>
            </DialogHeader>

            {drafts.length === 0 ? (
              <div
                className="rounded-xl border bg-muted p-6 text-center"
                data-testid="memory-review-empty"
              >
                <p className="text-sm text-muted-foreground">
                  Nothing durable about you was found in that. Go back and try
                  something else, or close this.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2.5" data-testid="memory-review-list">
                {drafts.map((draft, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <Textarea
                      value={draft}
                      onChange={(e) => editDraft(index, e.target.value)}
                      rows={2}
                      className="flex-1 resize-y text-sm"
                      aria-label={`Memory ${index + 1}`}
                      data-testid={`memory-review-item-${index}`}
                      disabled={saving}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
                      aria-label={`Remove memory ${index + 1}`}
                      onClick={() => removeDraft(index)}
                      disabled={saving}
                      data-testid={`memory-review-remove-${index}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)} disabled={saving}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={remaining === 0 || saving}
                data-testid="memory-review-save"
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  `Save ${remaining} to memory`
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Import memory</DialogTitle>
              <DialogDescription>
                Bring in context from another tool or export so the CoPilot can use
                it. You&apos;ll review everything before it is saved.
              </DialogDescription>
            </DialogHeader>

            <Tabs value={tab} onValueChange={(v) => setTab(v as 'file' | 'text')}>
              <TabsList className="w-full justify-start">
                <TabsTrigger value="file" data-testid="memory-import-tab-file">
                  Upload a file
                </TabsTrigger>
                <TabsTrigger value="text" data-testid="memory-import-tab-text">
                  Paste text
                </TabsTrigger>
              </TabsList>

              <TabsContent value="file" className="mt-4 flex flex-col gap-3.5">
                {/* A button so it stays keyboard-reachable, with the drop
                    handlers on the same element — `onDragOver` must preventDefault
                    or the browser navigates to the file instead of dropping it. */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={(e) => {
                    // Fires when crossing into a child too; ignore those so the
                    // highlight does not flicker over the icon and labels.
                    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    setDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    pickFile(e.dataTransfer.files?.[0]);
                  }}
                  className={`flex flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed px-4 py-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    dragging
                      ? 'border-primary bg-accent'
                      : 'bg-muted hover:bg-accent/60'
                  }`}
                  data-testid="memory-import-file-picker"
                >
                  <CloudUpload
                    className={`h-6 w-6 ${dragging ? 'text-primary' : 'text-muted-foreground'}`}
                  />
                  <span className="text-sm font-semibold">
                    {dragging ? 'Drop it here' : 'Drag a file here, or click to upload'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Documents (.pdf, .doc, .docx) or plain text — up to {MAX_FILE_MB}MB
                  </span>
                  {file && (
                    <Badge variant="secondary" className="mt-1 max-w-full truncate">
                      {file.name}
                    </Badge>
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_FILES}
                  className="hidden"
                  data-testid="memory-import-file"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="memory-import-note">
                    Context for this file (optional)
                  </Label>
                  <Input
                    id="memory-import-note"
                    data-testid="memory-import-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Notes from our last board meeting"
                  />
                </div>
              </TabsContent>

              <TabsContent value="text" className="mt-4 flex flex-col gap-1.5">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    'Paste the text you want the CoPilot to remember. For example:\n\n' +
                    '- Works as an investment associate covering Indonesian mining.\n' +
                    '- Prefers short answers with the numbers up front.'
                  }
                  rows={9}
                  className="resize-y font-mono text-xs"
                  data-testid="memory-import-text"
                />
                <p
                  className={`text-xs ${tooLong ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
                  data-testid="memory-import-count"
                >
                  {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters
                  {tooLong ? ' — too long, import it in smaller pieces.' : ''}
                </p>
              </TabsContent>
            </Tabs>

            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleExtract}
                disabled={!canExtract}
                data-testid="memory-import-submit"
              >
                <Upload className="mr-2 h-4 w-4" />
                Import
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
