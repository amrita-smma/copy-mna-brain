/**
 * The transcript's grouping of other bots' messages. A message another bot
 * sent this one — its reply back, or its hand-off — is shown collapsed by
 * default, since the bot relays what matters in its own answer, and a run of
 * them (three bots answering at once) folds into one collapsible with the
 * senders side by side. Pure, so the transcript can memoise it.
 */
import type { FromBot } from './uiMessages';

export interface RelayMessageLike {
  id: string;
  role: string;
  metadata?: { fromBot?: FromBot };
}

export type TranscriptItem<M extends RelayMessageLike> =
  | { kind: 'message'; message: M; index: number }
  | { kind: 'relay'; id: string; messages: M[]; senders: FromBot[]; label: string; lastIndex: number };

/** Another bot's words: a reply back or a hand-off, not the user's own @mention typed elsewhere. */
export function relaySender<M extends RelayMessageLike>(message: M): FromBot | null {
  const fromBot = message.metadata?.fromBot;
  if (message.role !== 'user' || !fromBot || fromBot.kind === 'user_mention') return null;
  return fromBot;
}

/** The collapsed row's label: who sent what, in one line. */
export function relayLabel(messages: readonly { fromBot: FromBot }[]): string {
  const senders = uniqueSenders(messages.map((m) => m.fromBot));
  const names = joinNames(senders.map((s) => s.name));
  const kinds = new Set(messages.map((m) => m.fromBot.kind ?? 'bot'));
  if (kinds.size === 1 && kinds.has('bot_reply')) {
    return senders.length === 1 && messages.length === 1 ? `Reply from ${names}` : `Replies from ${names}`;
  }
  if (kinds.size === 1) return `${names} mentioned this bot`;
  return `${messages.length} messages from ${names}`;
}

export function groupRelayMessages<M extends RelayMessageLike>(messages: readonly M[]): TranscriptItem<M>[] {
  const out: TranscriptItem<M>[] = [];
  let run: { messages: M[]; senders: FromBot[] } | null = null;
  const flush = () => {
    if (!run) return;
    out.push({
      kind: 'relay',
      id: run.messages[0].id,
      messages: run.messages,
      senders: uniqueSenders(run.senders),
      label: relayLabel(run.messages.map((m, i) => ({ fromBot: run!.senders[i] }))),
      lastIndex: out.length === 0 ? run.messages.length - 1 : lastIndexOf(out) + run.messages.length,
    });
    run = null;
  };
  messages.forEach((message, index) => {
    const sender = relaySender(message);
    if (sender) {
      if (!run) run = { messages: [], senders: [] };
      run.messages.push(message);
      run.senders.push(sender);
      return;
    }
    flush();
    out.push({ kind: 'message', message, index });
  });
  flush();
  return out;
}

function lastIndexOf<M extends RelayMessageLike>(items: TranscriptItem<M>[]): number {
  const last = items[items.length - 1];
  return last.kind === 'message' ? last.index : last.lastIndex;
}

function uniqueSenders(senders: readonly FromBot[]): FromBot[] {
  const seen = new Set<string>();
  return senders.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'another bot';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
