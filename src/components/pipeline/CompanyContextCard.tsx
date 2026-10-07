'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen, Loader2, Pencil, Save, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { updateCompany } from '@/lib/api/pipeline';
import { cn } from '@/lib/utils';

interface CompanyContextCardProps {
  companyId: string;
  /** Current stored context. `null`/empty renders the empty state. */
  value: string | null | undefined;
  /**
   * Called with the text that was just persisted, so the parent can refresh the
   * company it holds without re-fetching. Only fires after a successful save.
   */
  onSaved?: (context: string) => void;
  /** `dialog` tightens the spacing for the company card dialog. */
  variant?: 'page' | 'dialog';
  className?: string;
}

const EMPTY_HINT =
  'No context yet. Write the background that no column captures — what the company does and why it matters, how it was sourced, the deal situation, caveats and open questions.';

/**
 * The company's free-form markdown Context: rendered markdown by default, an
 * editable source textarea with a Save button underneath while editing.
 *
 * This is not decoration. The text saved here is fed to the AI Opinion run, the
 * company card / slide generators, and the agent read tools (`query_companies`,
 * `get_company_details`), so it is the one place a deal team can put knowledge
 * the schema has no column for and still have every AI surface weigh it.
 *
 * Shared by `CompanyDetail` (full page) and `CompanyDetailDialog` (pipeline
 * dialog) so the two Context tabs cannot drift apart.
 */
export function CompanyContextCard({
  companyId,
  value,
  onSaved,
  variant = 'page',
  className,
}: CompanyContextCardProps) {
  const isDialog = variant === 'dialog';
  const stored = value ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);
  // Only the *saved* text is tracked, never `editing` — so a background refresh
  // of the company (the dialog refetches on open, the page polls after edits)
  // cannot wipe out what the user is halfway through typing.
  const lastSynced = useRef(stored);

  useEffect(() => {
    if (lastSynced.current === stored) return;
    lastSynced.current = stored;
    if (!editing) setDraft(stored);
  }, [stored, editing]);

  const startEditing = () => {
    setDraft(stored);
    setEditing(true);
  };

  const cancelEditing = () => {
    setDraft(stored);
    setEditing(false);
  };

  const save = async () => {
    const next = draft.trim();
    if (next === stored.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await updateCompany(companyId, { context: next || null });
      lastSynced.current = next;
      onSaved?.(next);
      setEditing(false);
      toast.success('Context saved');
    } catch (error) {
      console.error('Failed to save company context:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to save context',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className={className}>
      <CardHeader className={cn('flex-row items-start justify-between gap-2', isDialog && 'pb-3')}>
        <div className="space-y-1">
          <CardTitle className={cn('flex items-center gap-2', isDialog ? 'text-base' : 'text-lg')}>
            <BookOpen className="h-4 w-4" />
            Context
          </CardTitle>
          <CardDescription>
            Markdown background on this company. Read by the AI Opinion, the
            company card and slide generation, and the chat tools.
          </CardDescription>
        </div>
        {!editing && (
          <Button variant="outline" size="sm" className="shrink-0" onClick={startEditing}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Write the company's context in markdown…"
              className={cn('font-mono text-sm', isDialog ? 'min-h-[220px]' : 'min-h-[320px]')}
              disabled={saving}
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={saving}>
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save Context
              </Button>
            </div>
          </>
        ) : stored.trim() ? (
          <div
            className={cn(
              'rounded-lg border bg-muted p-4 overflow-x-auto',
              isDialog ? 'max-h-[320px] overflow-y-auto' : '',
            )}
          >
            <MarkdownRenderer content={stored} variant="card" />
          </div>
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="w-full rounded-lg border border-dashed bg-muted p-6 text-left text-sm text-muted-foreground transition-colors hover:border-primary"
          >
            {EMPTY_HINT}
          </button>
        )}
      </CardContent>
    </Card>
  );
}
