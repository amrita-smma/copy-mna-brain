/**
 * Feedback on a Copilot reply (MB-693): the closed reason list and the shape a
 * vote travels in. Client safe — the bubble's feedback row, the history page
 * and the feedback service all read these, so the reason ids and limits
 * cannot drift between layers.
 */
import { stripComposerMarkup } from './composerMarkup';

/** What a reason chip needs from the reply before it is offered. */
export type ResponseFeedbackReasonRequirement = 'tools' | 'structured';

export interface ResponseFeedbackReason {
  id: string;
  label: string;
  /** Offered only when the reply used tools, or rendered structured output. */
  requires?: ResponseFeedbackReasonRequirement;
}

/** The chips offered on a thumbs-down, in display order. */
export const RESPONSE_FEEDBACK_REASONS = [
  { id: 'misunderstood', label: 'Misunderstood my request' },
  { id: 'ignored', label: 'Ignored my instructions' },
  { id: 'wrong_info', label: 'Wrong or made-up info' },
  { id: 'missed_context', label: 'Missed my context' },
  { id: 'unwanted_actions', label: "Did things I didn't ask", requires: 'tools' },
  { id: 'shallow', label: 'Incomplete or too shallow' },
  { id: 'broken_display', label: 'Hard to read or broken display', requires: 'structured' },
  { id: 'other', label: 'Something else' },
] as const satisfies readonly ResponseFeedbackReason[];

export type ResponseFeedbackReasonId = (typeof RESPONSE_FEEDBACK_REASONS)[number]['id'];

const REASON_IDS: ReadonlySet<string> = new Set(RESPONSE_FEEDBACK_REASONS.map((r) => r.id));

export const MAX_RESPONSE_FEEDBACK_COMMENT_LENGTH = 2000;

/** +1 thumbs up, -1 thumbs down. */
export type ResponseFeedbackRating = 1 | -1;

/** A user's feedback on one reply, as the bubble holds it and the API takes it. */
export interface ResponseFeedbackValue {
  rating: ResponseFeedbackRating | null;
  reasons: ResponseFeedbackReasonId[];
  comment: string | null;
}

export function isResponseFeedbackReasonId(value: unknown): value is ResponseFeedbackReasonId {
  return typeof value === 'string' && REASON_IDS.has(value);
}

/** The reasons worth offering for a reply, given what it contained. */
export function responseFeedbackReasonsFor(reply: {
  usedTools: boolean;
  structured: boolean;
}): readonly ResponseFeedbackReason[] {
  return RESPONSE_FEEDBACK_REASONS.filter(
    (r: ResponseFeedbackReason) =>
      !r.requires ||
      (r.requires === 'tools' && reply.usedTools) ||
      (r.requires === 'structured' && reply.structured),
  );
}

/**
 * The follow-up "Ask Brain to Improve" sends after a thumbs-down: the user's
 * reasons and comment, worded as a request for a better answer.
 */
export function improveRequestText(value: Pick<ResponseFeedbackValue, 'reasons' | 'comment'>): string {
  const labels = RESPONSE_FEEDBACK_REASONS.filter(
    (r) => r.id !== 'other' && value.reasons.includes(r.id),
  ).map((r) => r.label.toLowerCase());
  const lines = ['Your last answer missed the mark. Please try again and improve it.'];
  if (labels.length > 0) lines.push(`What was wrong: ${labels.join('; ')}.`);
  if (value.comment?.trim()) lines.push(`More detail: ${value.comment.trim()}`);
  return lines.join('\n');
}

/**
 * The question to send again for each reply (Retry), keyed by the reply's
 * index: the user text of the nearest message before it, without the
 * composer's attachment markup (the files themselves are not re-sent). No
 * entry when that message is not the user's own — another bot's or a
 * routine's — or carries no text.
 */
export function retryQuestionTexts(
  messages: readonly { role: string; parts?: readonly { type: string; text?: string }[]; metadata?: unknown }[],
): Map<number, string> {
  const out = new Map<number, string>();
  let question: string | null = null;
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      const meta = (m.metadata ?? {}) as { fromBot?: unknown; fromRoutine?: unknown };
      const text = stripComposerMarkup(
        (m.parts ?? []).map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('\n'),
      );
      question = meta.fromBot || meta.fromRoutine || !text ? null : text;
    } else if (m.role === 'assistant' && question) {
      out.set(i, question);
    }
  });
  return out;
}

/** A stored vote (validated when written) as the UI holds it. */
export function toResponseFeedbackValue(row: {
  rating: number | null;
  reasons: string[];
  comment: string | null;
}): ResponseFeedbackValue {
  return {
    rating: row.rating === 1 || row.rating === -1 ? row.rating : null,
    reasons: row.reasons.filter(isResponseFeedbackReasonId),
    comment: row.comment,
  };
}

export type ParsedResponseFeedback = { value: ResponseFeedbackValue } | { error: string };

/**
 * Validate and normalise a vote from an untrusted body. Reasons only stand on
 * a thumbs-down (a thumbs-up drops them), are deduplicated and kept in display
 * order; a blank comment is null. A vote must carry a rating or a comment.
 */
export function parseResponseFeedback(input: {
  rating?: unknown;
  reasons?: unknown;
  comment?: unknown;
}): ParsedResponseFeedback {
  const { rating, reasons, comment } = input;
  if (rating !== null && rating !== undefined && rating !== 1 && rating !== -1) {
    return { error: 'rating must be 1, -1 or null' };
  }
  if (reasons !== undefined && reasons !== null && !Array.isArray(reasons)) {
    return { error: 'reasons must be an array' };
  }
  const reasonList: unknown[] = Array.isArray(reasons) ? reasons : [];
  const unknownReason = reasonList.find((r) => !isResponseFeedbackReasonId(r));
  if (unknownReason !== undefined) {
    return { error: `unknown reason: ${String(unknownReason)}` };
  }
  if (comment !== null && comment !== undefined && typeof comment !== 'string') {
    return { error: 'comment must be a string' };
  }
  const trimmed = typeof comment === 'string' ? comment.trim() : '';
  if (trimmed.length > MAX_RESPONSE_FEEDBACK_COMMENT_LENGTH) {
    return {
      error: `comment must be ${MAX_RESPONSE_FEEDBACK_COMMENT_LENGTH} characters or fewer`,
    };
  }
  const normalizedRating: ResponseFeedbackRating | null = rating === 1 || rating === -1 ? rating : null;
  if (normalizedRating === null && !trimmed) {
    return { error: 'feedback needs a rating or a comment' };
  }
  const picked = new Set(reasonList);
  return {
    value: {
      rating: normalizedRating,
      reasons:
        normalizedRating === -1
          ? RESPONSE_FEEDBACK_REASONS.filter((r) => picked.has(r.id)).map((r) => r.id)
          : [],
      comment: trimmed || null,
    },
  };
}
