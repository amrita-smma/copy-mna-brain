/**
 * Laying a thread's freshly read tail over the messages already on screen.
 *
 * A reply from another bot reaches an open tab as a `reply` event, after
 * which the client reads the thread's latest page. Replacing the whole
 * message list with it would rebuild every bubble (and show the loading
 * state in between): the transcript blips. This merge keeps every message
 * the tail confirms as the very object already rendered — same React key,
 * same reference — and only adds what is new, so an unchanged bubble is not
 * touched at all.
 */

export interface MergeableMessage {
  id: string;
  role: string;
  parts?: ReadonlyArray<{ type: string; text?: string }>;
  /** The AI SDK types this `unknown`; only `createdAt` is read here. */
  metadata?: unknown;
}

/** The stored-time stamp a message carries, if any. */
function createdAtOf(message: MergeableMessage): string | undefined {
  const raw = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt;
  return typeof raw === 'string' && raw ? raw : undefined;
}

/** A message's text parts joined, the identity the stored row shares with the streamed one. */
export function mergeMessageText(message: MergeableMessage): string {
  return (message.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
}

/**
 * Same message, whether or not it has the same id. A turn this tab streamed
 * carries the stream's ids; the stored rows for it carry the rows' ids. Text
 * and role tell them apart well enough for one thread's last few turns.
 */
export function sameMessage(a: MergeableMessage, b: MergeableMessage): boolean {
  return a.role === b.role && mergeMessageText(a) === mergeMessageText(b);
}

/**
 * `prev` with `tail` — the thread's last page, oldest first — laid over it.
 *
 * Everything on screen before the point where the tail starts is kept as is.
 * From that point the tail is authoritative: each of its messages is the
 * on-screen object when one matches (by id, or by role and text for a turn
 * this tab streamed under other ids), and the server's otherwise. An
 * on-screen message the tail does not confirm from that point on is dropped,
 * as a reload would drop it. With no overlap at all the tail is appended.
 * A kept message that has no `createdAt` takes the stored row's, so a turn
 * that streamed without a stamp still gets its timestamp. Returns `prev`
 * itself when nothing changed.
 */
export function mergeHistoryTail<M extends MergeableMessage>(prev: readonly M[], tail: readonly M[]): M[] {
  if (tail.length === 0) return prev as M[];
  const tailIds = new Set(tail.map((m) => m.id));
  let cut = prev.findIndex((m) => tailIds.has(m.id));
  if (cut === -1) cut = prev.findIndex((m) => sameMessage(m, tail[0]));
  if (cut === -1) cut = prev.length;

  const pool = prev.slice(cut);
  const merged = tail.map((incoming) => {
    const at = pool.findIndex((shown) => shown.id === incoming.id || sameMessage(shown, incoming));
    if (at === -1) return incoming;
    const [shown] = pool.splice(at, 1);
    // The same id with other content is the server's newer word on it.
    if (!sameMessage(shown, incoming)) return incoming;
    const stamp = createdAtOf(incoming);
    if (stamp && !createdAtOf(shown)) {
      return { ...shown, metadata: { ...((shown.metadata ?? {}) as Record<string, unknown>), createdAt: stamp } };
    }
    return shown;
  });

  const next = [...prev.slice(0, cut), ...merged];
  const unchanged = next.length === prev.length && next.every((m, i) => m === prev[i]);
  return unchanged ? (prev as M[]) : next;
}
