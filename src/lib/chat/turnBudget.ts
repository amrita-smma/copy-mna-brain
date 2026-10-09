import { ChatAnthropic } from '@langchain/anthropic';
import { BETWEEN_TOOLS_THINKING } from '@/lib/ai/thinking';
import { BaseMessage } from '@langchain/core/messages';
import type { UIMessageChunk } from 'ai';
import { parseInsightTemplateBlock } from '@/lib/insights/templateAttachment';

/**
 * Two-stage turn budget.
 *
 * A Next.js route's `maxDuration` is a build-time segment config: one value per
 * route file, statically analysed, unable to read the request. It therefore
 * cannot vary by effort tier, and letting it fire is the worst available
 * outcome — the client already holds a 200, the stream simply stops, and
 * LangGraph writes no checkpoint for the in-flight node, so the entire
 * assistant turn (thinking, tool calls, partial prose) is discarded.
 *
 * So each tier carries its own `turnBudgetMs` (see EFFORT_TIERS), enforced in
 * the route with an AbortSignal that fires *before* the platform limit. When it
 * fires we stop the graph and spend the remaining headroom on one short,
 * tool-free call that reports what the turn actually gathered. The user gets
 * the research back instead of silence.
 */

/** Fast model for the wrap-up — deliberately not the tier's model. */
export const WRAP_UP_MODEL = 'claude-sonnet-5-5';
export const WRAP_UP_MAX_TOKENS = 1500;
export const WRAP_UP_TIMEOUT_MS = 60_000;

/** Caps on the digest fed to the wrap-up call, so it stays fast and cheap. */
export const WRAP_UP_PER_TOOL_CHARS = 1500;
export const WRAP_UP_DIGEST_CHARS = 10_000;

export const WRAP_UP_SYSTEM_PROMPT =
  'A research turn was stopped because it ran out of time before the assistant ' +
  'could write its answer. You are writing the closing message in the ' +
  "assistant's own voice, first person, continuing the conversation.\n\n" +
  'You are given the user\'s question and the raw results the turn managed to ' +
  'gather before it was stopped. Report what those results actually show — ' +
  'concrete findings, figures and names, not a description of the process. ' +
  'Open by saying plainly that the turn ran out of time, in one short sentence. ' +
  'Then give what was found. Close with one line naming what is still missing ' +
  'so the user can ask for it directly.\n\n' +
  'Never invent a finding that is not in the gathered results. If the results ' +
  'are empty or useless, say so instead of padding. Do not apologise more than ' +
  'once and do not describe your own limitations.\n\n' +
  'Each result below is a short excerpt, clipped only for this summary — the ' +
  'tool itself returned it in full, and the full result is kept in the thread. ' +
  'Never tell the user a result was truncated, cut off or incomplete because ' +
  'its excerpt ends.';

/**
 * Budget as an adjective — always singular ("a 7-minute budget"), and in
 * seconds below two minutes so a 90s budget doesn't round to "2 minutes".
 */
export function formatBudget(budgetMs: number): string {
  if (budgetMs < 120_000) return `${Math.round(budgetMs / 1000)}-second`;
  return `${Math.round(budgetMs / 60_000)}-minute`;
}

/**
 * A stable phrase that appears only in the zero-work notice — never in the
 * with-tools notice, and independent of the tier's budget — so the next turn
 * can recognise the notice in the thread's persisted messages
 * (`previousTurnTimedOut`) and route the retry to the Workforce.
 */
export const ZERO_WORK_NOTICE_MARKER = 'before any step finished, so there is nothing to pick up from';

/**
 * Shown when the wrap-up call itself cannot run. Never empty.
 *
 * With no completed tool call there is nothing to resume, and "continue" would
 * only restart the same generation — almost always one tool call trying to
 * carry a whole document — so that notice offers the Workforce instead.
 */
export function buildBudgetNotice(opts: {
  budgetMs: number;
  toolNames?: string[];
}): string {
  const budget = formatBudget(opts.budgetMs);
  if (!opts.toolNames?.length) {
    return (
      `This turn hit its ${budget} budget ${ZERO_WORK_NOTICE_MARKER} — asking me to continue would just retry the same thing.` +
      ' Large documents are built by the AI Workforce, section by section and without a time limit.' +
      " Reply and I'll hand this to the Workforce."
    );
  }
  const ran = ` It completed ${opts.toolNames.length} tool ${
    opts.toolNames.length === 1 ? 'call' : 'calls'
  } first (${[...new Set(opts.toolNames)].join(', ')}), and those results are kept in this thread.`;
  return (
    `This turn hit its ${budget} budget before I could write the answer.${ran}` +
    ' Ask me to continue and I will pick up from here.\n\n' +
    TIMEOUT_WORKFORCE_OFFER
  );
}

/**
 * The closing line of every budget wrap-up that did some work. The turn most
 * likely ran out of time writing a whole document, which "continue" would only
 * retry, so the user is offered the Workforce. Stable text: the next turn
 * recognises it (`previousTurnTimedOut`) and steers a document request into a
 * handoff.
 */
export const TIMEOUT_WORKFORCE_OFFER =
  "If this was creating or editing an insight or another long document, reply and I'll hand it to the AI Workforce instead — it works in the background with no time limit, so you don't have to wait here.";

/** True for a budget wrap-up that ends with the Workforce offer. */
export function isBudgetWrapUpWithOffer(text: string): boolean {
  return text.includes(TIMEOUT_WORKFORCE_OFFER);
}

/** True for the zero-work budget notice (see ZERO_WORK_NOTICE_MARKER). */
export function isZeroWorkBudgetNotice(text: string): boolean {
  return text.includes(ZERO_WORK_NOTICE_MARKER);
}

/** Flatten LangChain message content (string or content-block array) to text. */
export function messageText(
  messageOrContent: unknown,
  separator = '\n',
): string {
  const content =
    messageOrContent &&
    typeof messageOrContent === 'object' &&
    'content' in messageOrContent
      ? (messageOrContent as { content: unknown }).content
      : messageOrContent;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      const text = (block as { type?: string; text?: unknown }).text;
      if ((block as { type?: string }).type === 'text' && typeof text === 'string') {
        parts.push(text);
      }
    }
  }
  return parts.join(separator);
}

export interface AbandonedTurnWork {
  /** The user message the abandoned turn was answering, if one is present. */
  question: string;
  /** Tool names the turn completed, in call order (duplicates preserved). */
  toolNames: string[];
  /** Truncated tool output, ready to paste into the wrap-up prompt. */
  digest: string;
  /** True when there is gathered work worth reporting. */
  hasWork: boolean;
}

/**
 * Pull the work from the trailing turn — everything after the last human
 * message. That slice is exactly what the aborted turn produced and what the
 * checkpointer did persist: the tool rounds that completed before the model
 * call that never returned.
 */
/** The user's own words, without an attached `<insight_template>` block (its HTML, or its outline). */
function userQuestionText(message: BaseMessage): string {
  const content = Array.isArray(message.content)
    ? message.content.filter((block) => {
        const text = (block as { text?: unknown }).text;
        return !(typeof text === 'string' && parseInsightTemplateBlock(text));
      })
    : message.content;
  return messageText(content).trim();
}

export function collectAbandonedTurnWork(
  messages: BaseMessage[],
): AbandonedTurnWork {
  let lastHumanIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === 'human') {
      lastHumanIndex = i;
      break;
    }
  }

  const question =
    lastHumanIndex >= 0 ? userQuestionText(messages[lastHumanIndex]) : '';

  const toolNames: string[] = [];
  const chunks: string[] = [];
  let used = 0;

  for (let i = lastHumanIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.getType() !== 'tool') continue;

    const name =
      typeof (message as { name?: unknown }).name === 'string'
        ? ((message as { name: string }).name)
        : 'tool';
    toolNames.push(name);

    if (used >= WRAP_UP_DIGEST_CHARS) continue;
    const body = messageText(message).trim();
    if (!body) continue;

    const room = Math.min(WRAP_UP_PER_TOOL_CHARS, WRAP_UP_DIGEST_CHARS - used);
    const slice = body.length > room ? `${body.slice(0, room)}…[excerpt ends]` : body;
    chunks.push(`## ${name}\n${slice}`);
    used += slice.length;
  }

  return {
    question,
    toolNames,
    digest: chunks.join('\n\n'),
    hasWork: chunks.length > 0,
  };
}

/** Bounded, tool-free completion. Injected so tests never reach the network. */
export type WrapUpCompletion = (input: {
  system: string;
  user: string;
}) => Promise<string>;

const defaultCompletion =
  (apiKey: string): WrapUpCompletion =>
  async ({ system, user }) => {
    const llm = new ChatAnthropic({
      model: WRAP_UP_MODEL,
      anthropicApiKey: apiKey,
      maxTokens: WRAP_UP_MAX_TOKENS,
      // No thinking and no tools: this call exists to be fast and to finish.
      // between_tools is how Sonnet 5.5 spells that — it rejects the
      // {type:'disabled'} that @langchain/anthropic would otherwise send.
      thinking: BETWEEN_TOOLS_THINKING,
      temperature: undefined,
    });
    const res = await llm.invoke(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { timeout: WRAP_UP_TIMEOUT_MS },
    );
    return messageText(res.content, '');
  };

/**
 * One short call that turns an abandoned turn's tool output into an answer.
 * Always resolves to non-empty text: on any failure it degrades to the
 * deterministic notice rather than leaving the turn silent, which is the whole
 * point of the exercise.
 */
export async function summarizeAbandonedTurn(opts: {
  messages: BaseMessage[];
  budgetMs: number;
  apiKey?: string;
  complete?: WrapUpCompletion;
}): Promise<string> {
  const work = collectAbandonedTurnWork(opts.messages);
  const notice = buildBudgetNotice({
    budgetMs: opts.budgetMs,
    toolNames: work.toolNames,
  });

  const complete =
    opts.complete ?? (opts.apiKey ? defaultCompletion(opts.apiKey) : undefined);
  if (!complete || !work.hasWork) return notice;

  try {
    const text = await complete({
      system: WRAP_UP_SYSTEM_PROMPT,
      user:
        `The user asked:\n${work.question || '(no question text captured)'}\n\n` +
        `Results gathered before the turn was stopped:\n\n${work.digest}`,
    });
    const trimmed = String(text ?? '').trim();
    return trimmed ? `${trimmed}\n\n${TIMEOUT_WORKFORCE_OFFER}` : notice;
  } catch {
    return notice;
  }
}

/**
 * Pass a UI message stream through, but when it fails *because the turn budget
 * fired* — as opposed to the user pressing stop — swallow the error and close
 * the stream with the wrap-up text instead.
 *
 * Errors that are not a budget abort propagate unchanged, so the route's
 * existing `onError` classification (recursion limit, user abort, everything
 * else) is untouched.
 */
export function withBudgetWrapUp(
  source: ReadableStream<UIMessageChunk>,
  opts: {
    isBudgetAbort: () => boolean;
    wrapUp: () => Promise<string>;
  },
): ReadableStream<UIMessageChunk> {
  const reader = source.getReader();
  const id = 'turn-budget-wrapup';
  let closed = false;

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (closed) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        closed = true;
        if (!opts.isBudgetAbort()) {
          controller.error(err);
          return;
        }
        let text = '';
        try {
          text = (await opts.wrapUp()) ?? '';
        } catch {
          text = '';
        }
        if (text) {
          controller.enqueue({ type: 'text-start', id });
          controller.enqueue({ type: 'text-delta', id, delta: text });
          controller.enqueue({ type: 'text-end', id });
        }
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
