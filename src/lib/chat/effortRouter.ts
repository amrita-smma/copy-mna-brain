import { ChatAnthropic } from '@langchain/anthropic';
import { withLangfuseCallbacks } from '@/lib/langfuse';
import { DISABLED_THINKING } from '@/lib/ai/thinking';
import { asEffortChoice, maxEffort, type EffortChoice } from './effortTiers';
import { messageText } from './turnBudget';

/**
 * Auto-tier routing for the Copilot.
 *
 * The chat UI's "Auto" option used to be decorative — it resolved to the same
 * call as "Medium". This picks a real tier with one small, fast model call.
 *
 * Cost/latency shape, and why it is affordable:
 *   - It runs on EVERY Auto turn of a permanent bot thread: a stored,
 *     only-escalating tier would leave every later turn on the most expensive
 *     one (`shouldRoute` still supports a stored tier for callers that keep
 *     one). That is why the call has to be cheap: Haiku with thinking off,
 *     a one-word answer, and a hard 1.5 s cap.
 *   - The caller starts it as soon as the turn's text is known and awaits it
 *     just before the graph is built, so it overlaps the thread open, the
 *     context reads and the memory recall instead of adding to them.
 *   - It never de-escalates a thread that does store a tier: the caller
 *     clamps the result with `maxEffort` against the stored one.
 */

/**
 * Routing is classification, not analysis. A small fast model picking from four
 * labelled outcomes is both cheaper and quicker than a frontier model, and the
 * decision quality is bounded by the signal (one message), not by the router.
 */
const ROUTER_MODEL = 'claude-haiku-5-5';

/**
 * No up-front reasoning: the answer is one word from a fixed set, and every
 * thinking token here is paid for before the user's turn can start. Haiku
 * accepts `disabled` at effort `high` or below (see `@/lib/ai/thinking`).
 */
const ROUTER_EFFORT = 'low' as const;

/** One tier word; the ceiling only has to cover a model that writes a sentence. */
const ROUTER_MAX_TOKENS = 32;

/**
 * A hung router must never hold up the user's turn. The call is on the
 * critical path, so this is also the most the router may ever cost a turn.
 */
export const ROUTER_TIMEOUT_MS = 1500;

/**
 * Fail to `medium`, not `low`, for a turn that looks like real work. When
 * routing fails we do not know the shape of the task, and under-powering a
 * deep analysis costs more (a bad answer, then a retry) than over-powering a
 * lookup — but see `fallbackEffort`: a short turn with nothing attached is
 * almost always a lookup, and `medium` would make it wait on `high` effort.
 */
export const ROUTER_FALLBACK: EffortChoice = 'medium';

/** A turn at most this long, with nothing attached, falls back to `low`. */
export const SHORT_TURN_CHARS = 240;

/**
 * The tier a turn runs at when the router gives no answer (timeout, error,
 * unparseable reply): `low` for a short, attachment-free turn — a greeting, a
 * follow-up, one lookup — and `ROUTER_FALLBACK` otherwise.
 */
export function fallbackEffort(input: { message: string; hasAttachments?: boolean }): EffortChoice {
  if (input.hasAttachments) return ROUTER_FALLBACK;
  return input.message.trim().length <= SHORT_TURN_CHARS ? 'low' : ROUTER_FALLBACK;
}

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
 * A turn at most this long, with nothing attached, is not routed at all: it
 * runs at `low` (see `shouldRoute`). Distinct from `SHORT_TURN_CHARS`, which
 * only decides where a turn the router could not place lands.
 *
 * Why: the router is the longest pre-stream stage on an Auto turn (median
 * ~0.7–0.9 s, p90 ~1.4 s measured from a developer machine) and, with every
 * database read now hidden behind it, the one the user actually waits for.
 * A greeting, an acknowledgement, a "continue", one lookup or one follow-up
 * is under this length and routes `low` almost every time, so the call buys
 * nothing there. What it costs: a short *work* request — "write a memo
 * section on Acme's risks" — runs at `low` (Sonnet at medium effort) instead
 * of the tier the router would have picked; and the page in view, which the
 * router is told about (`pageSummary`), no longer lifts a short question
 * asked on a company or pipeline view. The open-insight floor still applies,
 * and a tier picked by hand is never routed anyway.
 */
export const ROUTER_SKIP_CHARS = 60;

/** Whether a turn is short enough to run at `low` without asking the router. */
export function isVeryShortTurn(message: string): boolean {
  return message.trim().length <= ROUTER_SKIP_CHARS;
}

/**
 * Whether Auto should spend a routing call on this turn.
 *
 * - A turn with an attachment always routes: that is the one cheap, reliable
 *   signal that the work just got heavier.
 * - A thread that stores a tier reuses it otherwise, so the router costs one
 *   call per conversation for such callers.
 * - A very short turn (`ROUTER_SKIP_CHARS`) is not routed; the caller's
 *   fallback (`fallbackEffort`) places it at `low`. Only when the message is
 *   given — a caller without the text keeps routing.
 */
export function shouldRoute(
  storedTier: EffortChoice | null,
  hasAttachments: boolean,
  message?: string,
): boolean {
  if (hasAttachments) return true;
  if (storedTier !== null) return false;
  return message === undefined || !isVeryShortTurn(message);
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
 * - Otherwise takes the routed tier (or `fallback`, default `ROUTER_FALLBACK`)
 *   clamped against stored tier so a thread may escalate, never de-escalate,
 *   and then raised to `floor` when one applies. The floor binds Auto only — a
 *   tier the user picked by hand is never overridden.
 */
export function resolveTurnEffort(input: {
  requested?: EffortChoice | null;
  stored?: EffortChoice | null;
  routed?: EffortChoice | null;
  floor?: EffortChoice | null;
  /** The tier for a turn the router could not place; see `fallbackEffort`. */
  fallback?: EffortChoice | null;
}): EffortChoice {
  if (input.requested) {
    return input.requested;
  }
  const candidate = input.routed ?? input.stored ?? input.fallback ?? ROUTER_FALLBACK;
  const effort = input.stored ? maxEffort(input.stored, candidate) : candidate;
  return input.floor ? maxEffort(effort, input.floor) : effort;
}

/**
 * One-shot small-model call returning a tier (or null when it fails, so the
 * caller can apply `fallbackEffort`). Never throws.
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
      thinking: DISABLED_THINKING,
      outputConfig: { effort: ROUTER_EFFORT },
    });

    const res = await llm.invoke(
      [
        { role: 'system', content: EFFORT_ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: buildRouterPrompt(input) },
      ],
      withLangfuseCallbacks({
        timeout: ROUTER_TIMEOUT_MS,
        runName: 'chat.effort_router',
      }),
    );

    return parseRoutedEffort(messageText(res.content, ' '));
  } catch {
    // Routing is best-effort: the caller falls back rather than failing the turn.
    return null;
  }
}
