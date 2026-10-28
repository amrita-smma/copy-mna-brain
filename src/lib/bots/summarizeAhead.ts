/**
 * Summarize a permanent bot thread ahead of need.
 *
 * A bot thread's history is bounded by the summarization middleware
 * (`botThreadMiddleware`): past `BOT_SUMMARY_TRIGGER_TOKENS` its
 * `beforeModel` summarizes the older messages — one Sonnet call over tens
 * of thousands of tokens, ten seconds or more, paid in line before that
 * turn's first model call. Whichever turn happens to cross the trigger is
 * the slow one.
 *
 * This runs the same summarization after a turn instead, off the critical
 * path and off the thread's lock, once the thread passes the lower
 * `BOT_SUMMARY_AHEAD_TOKENS`: the summary is computed from a read of the
 * thread, then written under the lock only if the thread has not moved
 * since that read (`AgentGraph.replaceMessagesIfAt`). A turn that started in
 * between either holds the lock or has moved the checkpoint, and the write
 * is dropped — the next turn's hook tries again. The in-line trigger stays
 * as the safety net for a thread that grows a fifth of the ceiling in one
 * turn.
 */
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentGraph, ThreadSnapshot } from '@/lib/agents/analysis/runtime';
import { SUMMARIZATION_SOURCE } from './summary';
import { summarizeAheadUpdate } from './threadMiddleware';

/** How long the write may hold the thread; the write is one checkpoint round trip. */
export const SUMMARY_WRITE_LOCK_SECONDS = 60;

/** The library's summarizer writes its own failure into the summary text instead of throwing. */
const SUMMARY_FAILURE_PREFIX = 'Error generating summary:';

export type SummarizeAheadOutcome =
  /** Under the mark, or paused on an interrupt whose open tool calls a summary would fold away. */
  | 'nothing_to_do'
  | 'summarized'
  /** The summarizer failed; nothing was written. */
  | 'failed'
  /** A turn holds the thread; the next turn's hook will try again. */
  | 'busy'
  /** A turn ran between the read and the write; the summary is dropped. */
  | 'moved';

export interface SummarizeAheadDeps {
  agent: Pick<AgentGraph, 'getThreadSnapshot' | 'replaceMessagesIfAt'>;
  chatId: string;
  claimTurn(chatId: string, ttlSeconds: number): Promise<boolean>;
  releaseTurn(chatId: string): Promise<void>;
  /** The thread as the caller last read it, to skip a second checkpoint read. */
  known?: ThreadSnapshot;
  /** The summarizer; `summarizeAheadUpdate` unless a test injects one. */
  summarize?: (messages: BaseMessage[]) => Promise<BaseMessage[] | null>;
}

function summaryFailed(update: BaseMessage[]): boolean {
  const summary = update.find((m) => m.additional_kwargs?.lc_source === SUMMARIZATION_SOURCE);
  const text = typeof summary?.content === 'string' ? summary.content : '';
  return text.includes(SUMMARY_FAILURE_PREFIX);
}

export async function summarizeThreadAhead(deps: SummarizeAheadDeps): Promise<SummarizeAheadOutcome> {
  const snapshot = deps.known ?? (await deps.agent.getThreadSnapshot(deps.chatId));
  if (snapshot.hasInterrupt) return 'nothing_to_do';
  // The slow part, off the lock: a turn may start and finish meanwhile.
  const update = await (deps.summarize ?? summarizeAheadUpdate)(snapshot.messages);
  if (!update) return 'nothing_to_do';
  if (summaryFailed(update)) return 'failed';
  if (!(await deps.claimTurn(deps.chatId, SUMMARY_WRITE_LOCK_SECONDS))) return 'busy';
  try {
    const written = await deps.agent.replaceMessagesIfAt(deps.chatId, snapshot.checkpointId, update);
    return written ? 'summarized' : 'moved';
  } finally {
    await deps.releaseTurn(deps.chatId);
  }
}
