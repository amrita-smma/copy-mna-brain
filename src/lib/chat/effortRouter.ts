import { ChatAnthropic } from '@langchain/anthropic';
import { asEffortChoice, maxEffort, type EffortChoice } from './effortTiers';
import { messageText } from './turnBudget';

/**
 * Auto-tier routing for the Copilot.
 *
 * The chat UI's "Auto" option used to be decorative — it resolved to the same
 * call as "Medium". This picks a real tier with a single frontier-model call.
 *
 * Cost/latency shape, and why it is affordable:
 *   - It runs ONCE PER THREAD, not once per turn. The chosen tier is persisted
 *     on `copilot_chats.effort_tier` and reused; only a turn that carries a new
 *     attachment re-routes (see `shouldRoute`).
 *   - The caller starts it before the agent graph is built and awaits it later,
 *     so it overlaps work the chat route already does and adds ~no wall-clock.
 *   - It never de-escalates: the caller clamps the result with `maxEffort`
 *     against the tier already stored on the thread. A tier change invalidates
 *     the thread's cached prefix, so bounding changes matters more than picking
 *     the perfect tier.
 */

/**
 * Routing is classification, not analysis. A small fast model picking from four
 * labelled outcomes is both cheaper and quicker than a frontier model, and the
 * decision quality is bounded by the signal (one message), not by the router.
 */
const ROUTER_MODEL = 'claude-sonnet-5';

/**
 * Adaptive thinking stays on and `effort` is dropped to `low` instead of being
 * switched off — cheaper and better behaved than opting out of reasoning
 * entirely, and it keeps the reply a clean one-word answer.
 */
const ROUTER_EFFORT = 'low' as const;

/** Room for a short adaptive-thinking pass plus a one-word answer. */
const ROUTER_MAX_TOKENS = 2048;

/** A hung router must never hold up the user's turn. */
export const ROUTER_TIMEOUT_MS = 4000;

/**
 * Fail to `medium`, not `low`. When routing fails we do not know the shape of
 * the task, and under-powering a deep analysis costs more (a bad answer, then a
 * retry) than over-powering a lookup.
 */
export const ROUTER_FALLBACK: EffortChoice = 'medium';

export const EFFORT_ROUTER_SYSTEM_PROMPT =
  'You route turns for an M&A / investment research copilot to a compute tier. ' +
  'You are NOT answering the user and you do NOT perform the task. ' +
  'Reply with exactly one word: low, medium, high, or deep.\n\n' +
  'low — a lookup or a short conversational turn. One fact, one record, one ' +
  'filter, a follow-up question, a greeting, a formatting tweak. Answerable ' +
  'with a single tool call or none.\n' +
  'medium — several steps or several tools. Comparing a handful of records, ' +
  'summarising a page or a document, drafting a short email, a question that ' +
  'needs the web plus internal data.\n' +
  'high — analysis that needs judgement rather than retrieval. Does this company ' +
  'fit the thesis, is this valuation sane, what are the risks in this deal, ' +
  'write this memo section.\n' +
  'deep — long open-ended work: diligence across many sources, multi-company ' +
  'research, building an insight end to end, valuation reasoning carried ' +
  'through several steps. Reserve it for turns that will genuinely take many ' +
  'tool calls to answer well.\n\n' +
  'When a turn sits between two tiers, choose the lower one. Reply with the ' +
  'single word only.';

export interface RouteEffortInput {
  /** The user's message for this turn. */
  message: string;
  /** Whether this turn carries file attachments. */
  hasAttachments?: boolean;
  /** Short description of the page the user is looking at, when known. */
  pageSummary?: string | null;
}

/** Build the user-side routing prompt. Exported for tests. */
export function buildRouterPrompt(input: RouteEffortInput): string {
  const parts = [`Turn: ${input.message.trim().slice(0, 4000)}`];
  if (input.hasAttachments) {
    parts.push('The turn carries one or more file attachments.');
  }
  if (input.pageSummary) {
    parts.push(`The user is viewing: ${input.pageSummary}`);
  }
  return parts.join('\n\n');
}

/**
 * Pull a tier out of the model's reply. Defensive in the same way
 * `normalizeChatTitle` is: a router that answers the user instead of routing
 * must degrade to the fallback rather than throw.
 */
export function parseRoutedEffort(raw: string): EffortChoice | null {
  const cleaned = String(raw).toLowerCase().trim();

  const exact = asEffortChoice(cleaned.replace(/[^a-z]/g, ''));
  if (exact) return exact;

  // The model wrote a sentence. Take the FIRST tier word it used.
  const match = cleaned.match(/\b(low|medium|high|deep)\b/);
  return match ? asEffortChoice(match[1]) : null;
}

/**
 * Whether Auto should spend a routing call on this turn.
 *
 * Turn 1 always routes (nothing is stored yet). After that a thread reuses its
 * tier, so the router costs one call per conversation — except when the turn
 * brings a new attachment, which is the one cheap, reliable signal that the
 * work just got heavier.
 */
export function shouldRoute(
  storedTier: EffortChoice | null,
  hasAttachments: boolean,
): boolean {
  return storedTier === null || hasAttachments;
}

/**
 * The lowest tier Auto runs a turn made on an open insight at.
 *
 * The router reads only the prompt text, and an edit request is short ("remove
 * this sidebar"), so it reads as a formatting tweak and picks `low`. But an
 * edit rewrites the whole document in one `propose_insight_edit` call: a
 * document at the chat cap (CHAT_INLINE_DOCUMENT_MAX_CHARS) needs about a
 * minute of output, which `low`'s 90 s budget cannot hold once thinking and
 * the reads are added. `medium` is the tier that cap was sized for.
 */
export const OPEN_INSIGHT_EFFORT_FLOOR: EffortChoice = 'medium';

/**
 * Resolves the effort tier for a turn:
 * - An explicit user choice (`requested`) takes precedence.
 * - Otherwise takes the routed tier (or fallback) clamped against stored tier
 *   so a thread may escalate, never de-escalate, and then raised to `floor`
 *   when one applies. The floor binds Auto only — a tier the user picked by
 *   hand is never overridden.
 */
export function resolveTurnEffort(input: {
  requested?: EffortChoice | null;
  stored?: EffortChoice | null;
  routed?: EffortChoice | null;
  floor?: EffortChoice | null;
}): EffortChoice {
  if (input.requested) {
    return input.requested;
  }
  const candidate = input.routed ?? input.stored ?? ROUTER_FALLBACK;
  const effort = input.stored ? maxEffort(input.stored, candidate) : candidate;
  return input.floor ? maxEffort(effort, input.floor) : effort;
}

/**
 * One-shot frontier-model call returning a tier (or null when it fails, so the
 * caller can apply `ROUTER_FALLBACK`). Never throws.
 */
export async function routeEffort(
  input: RouteEffortInput,
  apiKey: string,
): Promise<EffortChoice | null> {
  const text = input.message?.trim();
  if (!text) return null;

  try {
    const llm = new ChatAnthropic({
      model: ROUTER_MODEL,
      anthropicApiKey: apiKey,
      maxTokens: ROUTER_MAX_TOKENS,
      // Newer models reject `temperature`; leave it unset.
      temperature: undefined,
      thinking: { type: 'adaptive' },
      outputConfig: { effort: ROUTER_EFFORT },
    });

    const res = await llm.invoke(
      [
        { role: 'system', content: EFFORT_ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: buildRouterPrompt(input) },
      ],
      { timeout: ROUTER_TIMEOUT_MS },
    );

    return parseRoutedEffort(messageText(res.content, ' '));
  } catch {
    // Routing is best-effort: the caller falls back rather than failing the turn.
    return null;
  }
}
