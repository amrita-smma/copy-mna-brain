import type { BotRequestRepository, BotRequestRow } from '@/lib/repositories';
import type { BotReplyEntry } from '@/lib/bots/runBotTurn';
import type { BotMessageJob } from './botService';

/**
 * How long a request may stay open before the sweep gives up on it: the
 * answering job's own budget (`BOT_MESSAGE_TIMEOUT_SECONDS`, 600 s: up to a
 * minute waiting for the thread's lock plus the turn) and a minute's slack.
 */
export const BOT_REQUEST_TIMEOUT_SECONDS = 660;
/**
 * How much of the asker's reply a request keeps as "what was asked" — the
 * reminder the reply turn is headed with, not the message itself.
 */
export const BOT_REQUEST_ASK_MAX_LENGTH = 600;
/** How many stale requests one sweep closes per workspace. */
export const BOT_REQUEST_SWEEP_BATCH = 50;

export const TIMED_OUT_NOTE = 'did not answer in time';

const clip = (text: string, max: number) => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

export interface BotRequestDeps {
  workspaceId: string;
  repo: BotRequestRepository;
  /** Send the asker its `bot_reply` turn (the same path @mentions use). */
  dispatchBotMessage(job: BotMessageJob): Promise<unknown>;
}

export interface OpenRequestsInput {
  userId: string;
  fromBot: { id: string; name: string };
  /** The asker's thread with the user: where its reply turn runs. */
  fromChatId: string;
  /** The asking turn; every request it made shares it. */
  groupId: string;
  targets: { id: string; name: string }[];
  /** The asker's reply, the message the targets are sent. */
  ask: string;
}

export type CloseOutcome = { answer: string } | { failure: string; status?: 'failed' | 'timed_out' };

/**
 * A bot asked another bot something (an @mention in its reply). The request
 * is a row, so the asker always hears back: the answering bot's job closes
 * it with its answer or its failure, the close that completes the group (every
 * bot one reply asked) dispatches a single `bot_reply` turn to the asker with
 * all the answers — fan-in, so the asker answers the user once — and the
 * dispatch cron (`sweepBotRequests`) times out anything nobody closed. While
 * a request is open the asker shows nothing special: no thinking icon.
 *
 * `user_mention` (the user typed @B in A's chat) opens no request: the user
 * asked, and B answers them in its own chat.
 */
export class BotRequestService {
  constructor(private readonly deps: BotRequestDeps) {}

  /** One row per target. Returns the rows in `targets` order. */
  async open(input: OpenRequestsInput): Promise<BotRequestRow[]> {
    const ask = clip(input.ask, BOT_REQUEST_ASK_MAX_LENGTH);
    const rows = await this.deps.repo.createMany(
      input.targets.map((target) => ({
        group_id: input.groupId,
        user_id: input.userId,
        from_bot_id: input.fromBot.id,
        from_bot_name: input.fromBot.name,
        from_chat_id: input.fromChatId,
        to_bot_id: target.id,
        to_bot_name: target.name,
        ask,
      })),
    );
    return rows;
  }

  /**
   * The answering bot is done (or gave up). Idempotent. When this closes the
   * group's last request, the asker gets its `bot_reply` turn.
   */
  async close(requestId: string, outcome: CloseOutcome): Promise<{ closed: boolean; repliedTo: string | null }> {
    const { closed, group } = await this.deps.repo.close(
      requestId,
      'answer' in outcome
        ? { status: 'done', answer: outcome.answer.trim() || null }
        // A failure keeps its note in `answer`, so the reply can say why.
        : { status: outcome.status ?? 'failed', answer: clip(outcome.failure, 500) || null },
    );
    if (!closed) return { closed: false, repliedTo: null };
    if (!group) return { closed: true, repliedTo: null };

    const replies: BotReplyEntry[] = group.map((r) => ({
      fromBot: { id: r.to_bot_id, name: r.to_bot_name },
      requestId: r.id,
      ask: r.ask,
      answer: r.status === 'done' ? (r.answer ?? '') : null,
      failure: r.status === 'done' ? null : r.status === 'timed_out' ? TIMED_OUT_NOTE : (r.answer ?? 'failed'),
    }));
    await this.deps.dispatchBotMessage({
      userId: closed.user_id,
      origin: { kind: 'bot_reply', replies },
      toBotId: closed.from_bot_id,
      text: formatReplies(replies),
    });
    return { closed: true, repliedTo: closed.from_bot_id };
  }

  /** Close requests nobody answered in time, each as `timed_out`. Returns how many. */
  async sweep(olderThanSeconds = BOT_REQUEST_TIMEOUT_SECONDS): Promise<number> {
    const stale = await this.deps.repo.findStale(olderThanSeconds, BOT_REQUEST_SWEEP_BATCH);
    let count = 0;
    for (const row of stale) {
      try {
        const { closed } = await this.close(row.id, { failure: TIMED_OUT_NOTE, status: 'timed_out' });
        if (closed) count++;
      } catch (err) {
        console.error(`[bot-requests] failed to time out request ${row.id}:`, err);
      }
    }
    return count;
  }
}

/** The message the asker's reply turn receives: every answer, in order. */
export function formatReplies(replies: BotReplyEntry[]): string {
  return replies
    .map((r) => {
      const head = `**${r.fromBot.name}** — you asked: «${r.ask}»`;
      const body = r.answer !== null ? r.answer : `Could not complete it: ${r.failure ?? 'no answer'}.`;
      return `${head}\n\n${body}`;
    })
    .join('\n\n---\n\n');
}
