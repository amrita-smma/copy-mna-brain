import type { BaseMessage } from '@langchain/core/messages';
import {
  isBudgetWrapUpWithOffer,
  isZeroWorkBudgetNotice,
  messageText,
} from '@/lib/chat/turnBudget';

/**
 * What a chat turn reads back from the thread's persisted messages so that a
 * large document ends up with the Workforce rather than looping on "continue":
 *
 * - whether the previous turn timed out, and whether any tool had finished
 *   first, so this turn is told to hand a document off rather than retry it;
 * - the attachments of the most recent user turn that carried any, so a
 *   handoff on a later turn still carries the file;
 * - which whole-document tools to withhold on a turn that must hand off.
 *
 * Pure: no I/O. The route reads the messages once and passes them in.
 */

/**
 * The key, on a user turn's HumanMessage `additional_kwargs`, under which the
 * route records the turn's chat attachment refs (S3 key + display metadata).
 * It rides in the checkpoint with the message — no schema change — and never
 * reaches the model: human `additional_kwargs` are not sent to Anthropic.
 */
export const CHAT_ATTACHMENTS_KWARG = 'chat_attachments';

/** The system-context line for the turn after a zero-work timeout. */
export const ZERO_WORK_FOLLOW_UP_CONTEXT =
  'The previous turn timed out before any tool finished — almost certainly because one tool call tried to carry a whole document. ' +
  'Do not try to write the document in this turn. Call propose_workforce_handoff now with the user\'s full original request (include any template_id).';

/**
 * The system-context line for the turn after a timeout that had done some
 * work. The turn may have been research that only needed its answer written,
 * so "continue" stays open — but a document request is handed off.
 */
export const TIMED_OUT_FOLLOW_UP_CONTEXT =
  'The previous turn ran out of time before it could finish. ' +
  'If the request is to create or edit an insight or another long document, do not write it in this turn: call propose_workforce_handoff with the user\'s full original request (include the insight_id, the selected section key or element path, and any template_id). ' +
  'Otherwise continue from the tool results already in the thread.';

/**
 * Tools that write a whole document in one call. One call of that size cannot
 * finish inside a chat turn's budget, so a turn that must hand off does not
 * get them. `propose_insight_edit` is one: it carries the full edited document.
 */
export const WHOLE_DOCUMENT_TOOL_NAMES = [
  'propose_insight_create',
  'propose_insight_edit',
  'replace_insight_document',
] as const;

function lastHumanIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === 'human') return i;
  }
  return -1;
}

/** How the thread's previous turn hit its budget, if it did. */
export type PreviousTurnTimeout = 'no-work' | 'with-work' | null;

/**
 * Whether the thread's previous turn ended on a budget wrap-up: the last
 * assistant message after the last user message is the zero-work notice
 * (`'no-work'`) or a wrap-up closing on the Workforce offer (`'with-work'`).
 * Only the previous turn counts — an older wrap-up already had its follow-up.
 */
export function previousTurnTimedOut(messages: BaseMessage[]): PreviousTurnTimeout {
  const start = lastHumanIndex(messages) + 1;
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (message?.getType() !== 'ai') continue;
    const text = messageText(message).trim();
    if (isZeroWorkBudgetNotice(text)) return 'no-work';
    if (isBudgetWrapUpWithOffer(text)) return 'with-work';
    return null;
  }
  return null;
}

/** The system-context line for the turn after a timeout, or null. */
export function timeoutFollowUpContext(timeout: PreviousTurnTimeout): string | null {
  if (timeout === 'no-work') return ZERO_WORK_FOLLOW_UP_CONTEXT;
  if (timeout === 'with-work') return TIMED_OUT_FOLLOW_UP_CONTEXT;
  return null;
}

/**
 * The attachments of the most recent user turn that carried any, as validated
 * by `validate` (shape and workspace ownership — see
 * ChatAttachmentService.ownedRefs). A turn whose refs are all rejected is
 * skipped, so an earlier valid turn still counts.
 */
export function latestUserAttachments<T>(
  messages: BaseMessage[],
  validate: (raw: unknown) => T[],
): T[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.getType() !== 'human') continue;
    const raw = (message.additional_kwargs as Record<string, unknown> | undefined)?.[
      CHAT_ATTACHMENTS_KWARG
    ];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const valid = validate(raw);
    if (valid.length > 0) return valid;
  }
  return [];
}

/**
 * The whole-document tools to withhold this turn: all of them when the turn
 * must hand off — the previous turn timed out, or this turn carries a template
 * or HTML file too large for chat — otherwise none.
 */
export function wholeDocumentToolsToWithhold(opts: {
  previousTurnTimedOut: boolean;
  carriesTooLargeDocument: boolean;
}): string[] {
  return opts.previousTurnTimedOut || opts.carriesTooLargeDocument
    ? [...WHOLE_DOCUMENT_TOOL_NAMES]
    : [];
}
