"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Megaphone, RotateCcw, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { sentNow } from "@/lib/chat/messageTime";
import {
  MAX_RESPONSE_FEEDBACK_COMMENT_LENGTH,
  improveRequestText,
  responseFeedbackReasonsFor,
  type ResponseFeedbackRating,
  type ResponseFeedbackReasonId,
  type ResponseFeedbackValue,
} from "@/lib/chat/responseFeedback";
import { saveResponseFeedback } from "@/lib/api/responseFeedback";
import { useChatActions, useChatStatus, useChatThread } from "./ChatProvider";

const EMPTY_FEEDBACK: ResponseFeedbackValue = { rating: null, reasons: [], comment: null };
/** How long "Copied" stays up before the control resets. */
const CONFIRM_MS = 1500;

interface ResponseActionsProps {
  /** The reply's answer text, for Copy. */
  text: string;
  /** The question to send again; Retry is hidden without one. */
  retryText?: string | null;
  /** Only the latest finished reply takes feedback. */
  showFeedback: boolean;
  /** The reply's `metadata.questionId` — feedback is hidden without one. */
  questionId?: string;
  /** The user's stored feedback on the reply (from history). */
  initialFeedback?: ResponseFeedbackValue;
  /** Offer "Did things I didn't ask". */
  usedTools: boolean;
  /** Offer "Hard to read or broken display". */
  structured: boolean;
}

/**
 * The row under a finished reply (MB-693): Copy and Retry, and — on the latest
 * reply — "Write a feedback" and thumbs up/down. A thumbs-down opens the
 * reason chips and "Ask Brain to Improve". The thumb is saved on click; the
 * reasons and comment on Submit, as one vote per reply. A submitted vote is
 * final: the form closes and the row thanks the user instead.
 *
 * Only the latest reply mounts `ResponseFeedback`, the part that reads the
 * thread (`useChatThread` changes several times a turn), so older replies'
 * rows do not re-render with it.
 */
export function ResponseActions(props: ResponseActionsProps) {
  const { showFeedback, questionId } = props;
  if (showFeedback && questionId) {
    return <ResponseFeedback {...props} questionId={questionId} />;
  }
  return (
    <div className="flex w-full items-center gap-0.5" data-testid="response-actions">
      <CopyRetry text={props.text} retryText={props.retryText} />
    </div>
  );
}

function useIdle(): boolean {
  const { status } = useChatStatus();
  return status === "ready" || status === "error";
}

function useConfirmTimers() {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return (fn: () => void) => {
    timers.current.push(setTimeout(fn, CONFIRM_MS));
  };
}

function CopyRetry({ text, retryText }: { text: string; retryText?: string | null }) {
  const { sendMessage } = useChatActions();
  const idle = useIdle();
  const later = useConfirmTimers();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      later(() => setCopied(false));
    } catch {
      toast.error("Could not copy the reply");
    }
  };

  const handleRetry = () => {
    if (!retryText || !idle) return;
    void sendMessage({ text: retryText, metadata: sentNow() });
  };

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className="-ml-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        data-testid="response-copy"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      {retryText && (
        <button
          type="button"
          onClick={handleRetry}
          disabled={!idle}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          data-testid="response-retry"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Retry
        </button>
      )}
    </>
  );
}

function ResponseFeedback({
  text,
  retryText,
  questionId,
  initialFeedback,
  usedTools,
  structured,
}: ResponseActionsProps & { questionId: string }) {
  const { sendMessage } = useChatActions();
  const { chatId } = useChatThread();
  const idle = useIdle();

  const [feedback, setFeedback] = useState<ResponseFeedbackValue>(initialFeedback ?? EMPTY_FEEDBACK);
  const [writeOpen, setWriteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(() => wasSubmitted(initialFeedback));
  const [improveRequested, setImproveRequested] = useState(false);

  const reasons = responseFeedbackReasonsFor({ usedTools, structured });
  const commentOpen = !submitted && (writeOpen || feedback.reasons.includes("other"));

  // Local state stays the source of truth: a save's response is never laid
  // back over it, so a slow save (a thumb click) cannot wipe chips or a
  // comment picked while it was in flight. Only the latest save's outcome is
  // reported.
  const saveSeq = useRef(0);
  const save = async (next: ResponseFeedbackValue): Promise<boolean> => {
    if (!chatId) return false;
    const seq = ++saveSeq.current;
    setSaving(true);
    try {
      await saveResponseFeedback(chatId, questionId, next);
      return seq === saveSeq.current;
    } catch (err) {
      console.error("[chat] failed to save response feedback:", err);
      if (seq === saveSeq.current) toast.error("Couldn't save your feedback");
      return false;
    } finally {
      if (seq === saveSeq.current) setSaving(false);
    }
  };

  const handleRate = (rating: ResponseFeedbackRating) => {
    if (submitted || feedback.rating === rating) return;
    const next = { ...feedback, rating, reasons: rating === -1 ? feedback.reasons : [] };
    setFeedback(next);
    void save(next);
  };

  const toggleReason = (id: ResponseFeedbackReasonId) => {
    setFeedback((prev) => ({
      ...prev,
      reasons: prev.reasons.includes(id) ? prev.reasons.filter((r) => r !== id) : [...prev.reasons, id],
    }));
  };

  const handleSubmit = async () => {
    if (feedback.rating === null && !feedback.comment?.trim()) return;
    if (await save(feedback)) {
      // The vote is stored; drop the form so it cannot be sent again. The
      // rating stays to show which way the user voted.
      setSubmitted(true);
      setWriteOpen(false);
      setFeedback((prev) => ({ ...prev, reasons: [], comment: null }));
    }
  };

  const handleImprove = () => {
    if (!idle || improveRequested) return;
    setImproveRequested(true);
    void sendMessage({ text: improveRequestText(feedback), metadata: sentNow() });
  };

  return (
    <div className="flex w-full flex-col gap-1.5" data-testid="response-actions">
      <div className="flex w-full items-center gap-0.5">
        <CopyRetry text={text} retryText={retryText} />
        <div className="ml-auto flex items-center gap-1">
          {submitted ? (
            <span
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
              data-testid="response-feedback-thanks"
            >
              <Check className="h-3 w-3" />
              Thanks for your feedback!
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setWriteOpen((open) => !open)}
              className="flex items-center gap-1 rounded-full border bg-card px-2.5 py-0.5 text-[11px] text-foreground transition-colors hover:border-primary hover:text-primary"
              data-testid="response-write-feedback"
            >
              <Megaphone className="h-3 w-3" />
              Write a feedback
            </button>
          )}
          <button
            type="button"
            onClick={() => handleRate(1)}
            disabled={submitted}
            aria-label="Good response"
            aria-pressed={feedback.rating === 1}
            className={cn(
              "ml-1 rounded-md p-1 transition-colors hover:bg-muted disabled:pointer-events-none",
              feedback.rating === 1 ? "text-primary" : "text-muted-foreground",
            )}
            data-testid="response-thumbs-up"
          >
            <ThumbsUp className={cn("h-3.5 w-3.5", feedback.rating === 1 && "fill-current")} />
          </button>
          <button
            type="button"
            onClick={() => handleRate(-1)}
            disabled={submitted}
            aria-label="Bad response"
            aria-pressed={feedback.rating === -1}
            className={cn(
              "rounded-md p-1 transition-colors hover:bg-muted disabled:pointer-events-none",
              feedback.rating === -1 ? "text-primary" : "text-muted-foreground",
            )}
            data-testid="response-thumbs-down"
          >
            <ThumbsDown className={cn("h-3.5 w-3.5", feedback.rating === -1 && "fill-current")} />
          </button>
        </div>
      </div>

      {!submitted && feedback.rating === -1 && (
        <div className="flex flex-col gap-1.5" data-testid="response-feedback-reasons">
          <button
            type="button"
            onClick={handleImprove}
            disabled={!idle || improveRequested}
            className="flex items-center gap-1 self-start rounded-full border border-primary bg-card px-2.5 py-0.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-60"
            data-testid="response-ask-improve"
          >
            <Sparkles className="h-3 w-3" />
            {improveRequested ? "Improvement requested" : "Ask Brain to Improve"}
          </button>
          <div className="flex flex-wrap gap-1.5">
            {reasons.map((reason) => {
              const id = reason.id as ResponseFeedbackReasonId;
              const active = feedback.reasons.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleReason(id)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "bg-card text-foreground hover:border-primary",
                  )}
                >
                  {reason.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {commentOpen && (
        <Textarea
          value={feedback.comment ?? ""}
          onChange={(e) => setFeedback((prev) => ({ ...prev, comment: e.target.value }))}
          maxLength={MAX_RESPONSE_FEEDBACK_COMMENT_LENGTH}
          placeholder={writeOpen ? "Tell us more about this response..." : "Tell us more (optional)..."}
          rows={writeOpen ? 3 : 2}
          className="min-h-0 bg-card text-xs"
          data-testid="response-feedback-comment"
        />
      )}

      {!submitted && (commentOpen || feedback.rating === -1) && (
        <div className="flex items-center justify-end gap-1.5">
          {writeOpen && (
            <button
              type="button"
              onClick={() => setWriteOpen(false)}
              className="rounded-full border bg-card px-3 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || (feedback.rating === null && !feedback.comment?.trim())}
            className="flex items-center gap-1 rounded-full border border-primary bg-primary px-3 py-0.5 text-[11px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            data-testid="response-feedback-submit"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A stored vote with reasons or a comment came through Submit, so a reloaded
 * reply opens already thanked. A bare thumb was saved on click and can still
 * be followed by a written note.
 */
function wasSubmitted(feedback: ResponseFeedbackValue | undefined): boolean {
  return !!feedback && (feedback.reasons.length > 0 || !!feedback.comment?.trim());
}
