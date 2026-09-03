'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Lock, Save, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import RichTextEditor from '@/components/ui/rich-text-editor';
import { cn } from '@/lib/utils';
import type { VoteChoice } from '@/lib/voting/tally';
import type { VoteTabState } from '@/lib/api/votes';
import { CHOICE_ORDER, choiceStyle } from './choiceStyles';
import {
  browserDraftStorage,
  clearBallotDraft,
  initialBallotFields,
  writeBallotDraft,
} from './ballotDraftStore';

export interface BallotPanelProps {
  /** The round this ballot belongs to — namespaces the local draft cache. */
  sessionId: string;
  ballot: NonNullable<VoteTabState['viewer']['ballot']>;
  /** Disables everything — the deadline has passed but the sweep hasn't run. */
  locked?: boolean;
  saving?: boolean;
  submitting?: boolean;
  onSave: (input: { choice: VoteChoice | null; bodyHtml: string }) => void;
  onSubmit: (input: { choice: VoteChoice; bodyHtml: string }) => void;
}

/**
 * The voter's own ballot: the five-point choice, the WYSIWYG rationale, and the
 * save / cancel / submit controls.
 *
 * "Cancel" discards local edits back to what is stored — it never touches the
 * server, which is why it is purely local state here.
 *
 * Unsaved edits survive leaving the tab. Radix unmounts an inactive
 * `TabsContent`, so this component is destroyed the moment the user looks at
 * Overview — without the `ballotDraftStore` mirror below, a half-written
 * rationale would be gone on the way back.
 */
export default function BallotPanel({
  sessionId,
  ballot,
  locked,
  saving,
  submitting,
  onSave,
  onSubmit,
}: BallotPanelProps) {
  // `sessionStorage`, or null when unavailable (SSR / storage disabled), in
  // which case the fields simply fall back to the stored ballot.
  const storage = useMemo(() => browserDraftStorage(), []);

  const [choice, setChoice] = useState<VoteChoice | null>(
    () => initialBallotFields(storage, sessionId, ballot).choice,
  );
  const [body, setBody] = useState(
    () => initialBallotFields(storage, sessionId, ballot).bodyHtml,
  );

  const submitted = ballot.status === 'submitted';
  const readOnly = submitted || locked === true;
  const dirty = useMemo(
    () => choice !== ballot.choice || body !== (ballot.bodyHtml ?? ''),
    [choice, body, ballot.choice, ballot.bodyHtml],
  );
  const busy = saving === true || submitting === true;

  // Re-seed only when the STORED ballot actually changes (a save landing, or the
  // initiator sending submissions back) — not on mount, which would throw away
  // the draft we just restored.
  const savedSignature = `${ballot.status}|${ballot.choice ?? ''}|${ballot.bodyHtml ?? ''}`;
  const lastSavedSignature = useRef(savedSignature);
  useEffect(() => {
    if (lastSavedSignature.current === savedSignature) return;
    lastSavedSignature.current = savedSignature;
    setChoice(ballot.choice);
    setBody(ballot.bodyHtml ?? '');
    clearBallotDraft(storage, sessionId);
  }, [savedSignature, ballot.choice, ballot.bodyHtml, storage, sessionId]);

  // Mirror unsaved work out, and drop the cache as soon as there is nothing
  // unsaved left to protect (saved, cancelled, or submitted).
  useEffect(() => {
    if (!storage) return;
    if (submitted || !dirty) {
      clearBallotDraft(storage, sessionId);
      return;
    }
    writeBallotDraft(storage, sessionId, { choice, bodyHtml: body });
  }, [storage, sessionId, submitted, dirty, choice, body]);

  return (
    <div className="space-y-5" data-testid="ballot-panel">
      {submitted && (
        <div
          className="flex items-center gap-2 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300"
          data-testid="ballot-submitted-banner"
        >
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            Your vote is submitted and can no longer be changed. Only the
            initiator can send submissions back for revision.
          </span>
        </div>
      )}

      <div>
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Your vote
        </Label>
        <div className="mt-2 flex flex-wrap gap-2" data-testid="ballot-choices">
          {CHOICE_ORDER.map((option) => {
            const style = choiceStyle(option);
            const selected = choice === option;
            return (
              <Button
                key={option}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={selected}
                data-selected={selected}
                data-testid={`ballot-choice-${option}`}
                disabled={readOnly || busy}
                className={cn('text-xs font-semibold', style.button)}
                onClick={() => setChoice(option)}
              >
                {selected && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />}
                {style.label}
              </Button>
            );
          })}
        </div>
      </div>

      <div>
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Your rationale
        </Label>
        <div className="mt-2">
          <RichTextEditor
            value={body}
            onChange={setBody}
            editable={!readOnly && !busy}
            placeholder="Set out your reasoning — positives, concerns, and what the team should establish next."
            bodyClassName="min-h-[260px]"
          />
        </div>
      </div>

      {!readOnly && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && (
            <span className="mr-auto text-xs text-muted-foreground">
              Unsaved changes
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || busy}
            data-testid="ballot-cancel"
            onClick={() => {
              setChoice(ballot.choice);
              setBody(ballot.bodyHtml ?? '');
              clearBallotDraft(storage, sessionId);
            }}
          >
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid="ballot-save"
            onClick={() => onSave({ choice, bodyHtml: body })}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save draft
          </Button>
          <Button
            size="sm"
            disabled={busy || !choice}
            title={choice ? undefined : 'Pick a vote before submitting'}
            data-testid="ballot-submit"
            onClick={() => choice && onSubmit({ choice, bodyHtml: body })}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Submit
          </Button>
        </div>
      )}
    </div>
  );
}
