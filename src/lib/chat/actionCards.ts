/**
 * Action cards: the cards in a Copilot reply that wait on the user — an
 * approval (`propose_*`), a set of options (`offer_options`), a Workforce
 * hand-off. Each is rendered from a marker its tool writes into its output,
 * and carries its own id (`approval_id` / `card_id` / `handoff_id`).
 *
 * The cards and their decisions are stored in `copilot_chat_cards`: the
 * history writer registers every card a stored reply offers, the card writes
 * the user's decision, the history pages lay each decision back onto its card,
 * and the chat's next turns are told the recent ones (`cardDecisionContext`).
 *
 * Pure and client-safe: the server finds cards in stored parts with it, and the
 * cards share its types.
 */
import { BOT_CHANGE_APPROVAL_MARKER, BOT_ROUTINE_APPROVAL_MARKER } from '@/lib/bots/approval';
import {
  INSIGHT_CREATE_APPROVAL_MARKER,
  INSIGHT_EDIT_APPROVAL_MARKER,
  INSIGHT_REFRESH_APPROVAL_MARKER,
  REPORT_PLAN_APPROVAL_MARKER,
  extractApprovalPayload,
} from '@/lib/insights/approvalMarker';
import { OPTION_CARD_MARKER } from '@/lib/chat/optionCards';

export type ActionCardStatus = 'pending' | 'accepted' | 'declined';
export type ActionCardDecisionStatus = Exclude<ActionCardStatus, 'pending'>;

/** A card's decision as the card renders it (history metadata and the decision endpoint). */
export interface ActionCardDecision {
  status: ActionCardDecisionStatus;
  resolutionText: string | null;
  data: Record<string, unknown> | null;
  decidedAt: string | null;
}

/** A card found in a reply's tool parts. */
export interface FoundActionCard {
  cardId: string;
  toolName: string;
  toolCallId: string | null;
  /** One line naming what the card asked, for the agent's context. */
  summary: string;
}

type Payload = Record<string, unknown>;

interface CardSpec {
  marker: string;
  /** `base64`: written with `encodeApprovalMarker`; `json`: raw JSON in the comment. */
  encoding: 'base64' | 'json';
  id: (p: Payload) => unknown;
  summary: (p: Payload) => string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const bulkSummary = (verb: string) => (p: Payload) => {
  const n = Array.isArray(p.candidates) ? p.candidates.length : 0;
  return `${verb} ${n} compan${n === 1 ? 'y' : 'ies'}: ${str(p.title)}`;
};

const botChangeSummary = (p: Payload) => {
  const after = (p.after ?? {}) as Payload;
  return p.action === 'create' ? `Create bot "${str(after.name)}"` : `Update bot "${str(after.name)}"`;
};

/**
 * Every tool whose output renders an action card. Keep in sync with
 * ChatMessageBubble. `message_bot` is not here: its card reports a message
 * already sent and waits on nothing.
 */
export const ACTION_CARD_SPECS: Readonly<Record<string, CardSpec>> = {
  propose_workforce_handoff: {
    marker: 'WORKFORCE_HANDOFF_JSON',
    encoding: 'json',
    id: (p) => p.handoff_id,
    summary: (p) => `Hand off to the Workforce: ${str(p.title)}`,
  },
  propose_bulk_drop_companies: {
    marker: 'BULK_DROP_APPROVAL_JSON',
    encoding: 'json',
    id: (p) => p.approval_id,
    summary: bulkSummary('Drop'),
  },
  propose_bulk_promote_companies: {
    marker: 'BULK_PROMOTE_APPROVAL_JSON',
    encoding: 'json',
    id: (p) => p.approval_id,
    summary: (p) => `${bulkSummary('Promote')(p)} (to ${str(p.target_stage)})`,
  },
  propose_insight_create: {
    marker: INSIGHT_CREATE_APPROVAL_MARKER,
    encoding: 'base64',
    id: (p) => p.approval_id,
    summary: (p) => `Create insight "${str(p.name)}"`,
  },
  propose_insight_edit: {
    marker: INSIGHT_EDIT_APPROVAL_MARKER,
    encoding: 'base64',
    id: (p) => p.approval_id,
    summary: (p) => `Edit insight ${str(p.insight_id)}: ${str(p.summary)}`,
  },
  propose_insight_refresh: {
    marker: INSIGHT_REFRESH_APPROVAL_MARKER,
    encoding: 'base64',
    id: (p) => p.approval_id,
    summary: (p) => `Refresh insight ${str(p.insight_id)}: ${str(p.reason)}`,
  },
  propose_report_plan: {
    marker: REPORT_PLAN_APPROVAL_MARKER,
    encoding: 'base64',
    id: (p) => p.approval_id,
    summary: (p) => `Report plan: ${str(p.request)}`,
  },
  propose_create_bot: {
    marker: BOT_CHANGE_APPROVAL_MARKER,
    encoding: 'base64',
    id: (p) => p.approval_id,
    summary: botChangeSummary,
  },
  update_bot: {
    marker: BOT_CHANGE_APPROVAL_MARKER,
    encoding: 'base64',
    id: (p) => p.approval_id,
    summary: botChangeSummary,
  },
  // The name update_bot had before; stored history still carries its cards.
  propose_update_bot: {
    marker: BOT_CHANGE_APPROVAL_MARKER,
    encoding: 'base64',
    id: (p) => p.approval_id,
    summary: botChangeSummary,
  },
  propose_create_routine: {
    marker: BOT_ROUTINE_APPROVAL_MARKER,
    encoding: 'base64',
    id: (p) => p.approval_id,
    summary: (p) => `Schedule routine "${str(((p.input ?? {}) as Payload).title)}" on ${str(p.bot_name)}`,
  },
  offer_options: {
    marker: OPTION_CARD_MARKER,
    encoding: 'base64',
    id: (p) => p.card_id,
    summary: (p) => `Options: ${str(p.question)}`,
  },
};

/** The longest summary stored; the agent only needs to recognise the card. */
export const ACTION_CARD_SUMMARY_MAX_CHARS = 240;

function extractRawJson(text: string, marker: string): Payload | null {
  const match = text.match(new RegExp(`<!--\\s*${marker}:(.*?)-->`, 's'));
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1].trim());
    return parsed && typeof parsed === 'object' ? (parsed as Payload) : null;
  } catch {
    return null;
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ACTION_CARD_SUMMARY_MAX_CHARS
    ? `${flat.slice(0, ACTION_CARD_SUMMARY_MAX_CHARS - 1)}…`
    : flat;
}

function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  const content = (output as { kwargs?: { content?: unknown } } | null | undefined)?.kwargs?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * The action cards in a message's parts, in order. Never throws: a part that
 * is not a card tool, or whose marker is missing or corrupt, is skipped.
 */
export function findActionCards(parts: readonly unknown[]): FoundActionCard[] {
  const found: FoundActionCard[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: unknown; toolName?: unknown; toolCallId?: unknown; output?: unknown };
    if (p.type !== 'dynamic-tool' || typeof p.toolName !== 'string') continue;
    const spec = ACTION_CARD_SPECS[p.toolName];
    if (!spec) continue;
    const text = toolOutputText(p.output);
    if (!text) continue;
    const payload =
      spec.encoding === 'base64'
        ? extractApprovalPayload<Payload>(text, spec.marker)
        : extractRawJson(text, spec.marker);
    if (!payload || typeof payload !== 'object') continue;
    const cardId = spec.id(payload);
    if (typeof cardId !== 'string' || !cardId || seen.has(cardId)) continue;
    seen.add(cardId);
    found.push({
      cardId,
      toolName: p.toolName,
      toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : null,
      summary: clip(spec.summary(payload)),
    });
  }
  return found;
}

/** A stored card, as `cardDecisionContext` describes it. */
export interface ActionCardForContext {
  card_id: string;
  tool_name: string;
  summary: string;
  status: ActionCardStatus;
  resolution_text: string | null;
  decision_data: Record<string, unknown> | null;
  decided_at: string | null;
}

/** How many of a chat's most recent cards a turn is told about. */
export const CARD_CONTEXT_LIMIT = 10;

/**
 * The per-turn system block naming the chat's recent cards and what the user
 * decided on each, newest first, or null when there are none. A decision made
 * on a card that does not send a message (an approval) reaches the agent only
 * through this block.
 */
export function cardDecisionContext(cards: readonly ActionCardForContext[]): string | null {
  if (cards.length === 0) return null;
  const lines = cards.map((c) => {
    const head = `- [${c.tool_name} · ${c.card_id}] ${c.summary}`;
    if (c.status === 'pending') return `${head}\n  → Still waiting on the user.`;
    const verb = c.status === 'accepted' ? 'Accepted' : 'Declined';
    const when = c.decided_at ? ` (${c.decided_at})` : '';
    const what = c.resolution_text ? `: ${c.resolution_text}` : '';
    const data = c.decision_data && Object.keys(c.decision_data).length > 0
      ? `\n  Detail: ${JSON.stringify(c.decision_data)}`
      : '';
    return `${head}\n  → ${verb} by the user${when}${what}${data}`;
  });
  return [
    '## Your cards in this chat and the user\'s decisions',
    'Cards you offered in this chat (approvals, options, hand-offs), newest first, with what the user decided on each. ' +
      'This is authoritative: an approval the user accepted has already been carried out, and a declined one was not. ' +
      'Do not offer the same card again unless the user asks.',
    ...lines,
  ].join('\n');
}
