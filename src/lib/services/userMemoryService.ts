import {
  MEMORY_COLLECTION,
  type UserMemoryRepository,
  type UserRepository,
} from '@/lib/repositories';
import {
  createUserMemory,
  type MemoryClientItem,
  type UserMemoryClient,
} from '@/lib/memory/client';
import { memoryConfigured } from '@/lib/memory/switch';
import { MAX_RECALLED_MEMORIES, formatRecalledMemories } from '@/lib/memory/prompt';
import { extractUserFacts, type UserFactExtractor } from '@/lib/memory/extract';
import { runMemoryImport } from '@/lib/agents/memory_import';
import {
  MAX_IMPORT_CHARS,
  MAX_IMPORT_STATEMENTS,
  MAX_IMPORT_STATEMENT_CHARS,
} from '@/lib/memory/limits';

/** The @memory_import entrypoint, as this service depends on it. */
export type MemoryImportRunner = typeof runMemoryImport;

/** One memory as the Profile → Memory tab shows it. */
export interface UserMemoryItem {
  id: string;
  memory: string;
  createdAt: string;
  updatedAt: string;
  /** Broad provenance: learned from a chat, or brought in by an import. */
  source: UserMemorySource;
  /**
   * For an import, what it came from — a filename, or the note the user wrote.
   * Null for a conversation memory, which has no name worth showing.
   */
  origin: string | null;
}

export type UserMemorySource = 'copilot' | 'import';

export interface UserMemoryList {
  items: UserMemoryItem[];
  /** Every memory this user has here, not just the page. */
  total: number;
  /** True when `offset + items.length < total` — there is another page. */
  hasMore: boolean;
}

export interface RememberTurnInput {
  userId: string;
  chatId: string;
  userText: string;
  assistantText: string;
}

export interface ImportMemoriesInput {
  userId: string;
  /** Statements the user confirmed, after reviewing what the agent proposed. */
  statements: string[];
  /** Free-text label for where they came from, shown nowhere but stored. */
  origin?: string;
}

export interface ExtractForReviewInput {
  userId: string;
  /** Pasted text, or the text extracted from an uploaded file. */
  text: string;
  origin?: string;
  signal?: AbortSignal;
}

export interface ExtractForReviewResult {
  /** Proposed statements, awaiting the user's review. Nothing is stored yet. */
  statements: string[];
  /** The agent's own one-line account, for the dialog. */
  summary: string;
}

export interface ImportMemoriesResult {
  /** Statements handed to mem0 after the agent extracted and capped them. */
  submitted: number;
  /** Memories mem0 actually wrote. */
  added: number;
  /**
   * `submitted - added` — statements mem0 folded into something it already
   * knew, or judged not worth remembering. It reports only what it created, so
   * this is a difference, not a count it hands back.
   */
  skipped: number;
}

/** How many memories the Profile tab lists in one page. */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * How long a turn will wait for recall before giving up and running without it.
 *
 * Recall sits on the chat turn's critical path — the agent cannot start until
 * it resolves — so catching errors is not enough: a Bedrock or mem0 call that
 * hangs rather than fails would hold the user's turn open indefinitely. A
 * timeout is treated exactly like a failure: no memories, turn proceeds.
 *
 * 1.5 s, not the 6 s it once was: a healthy recall (one embedding plus one
 * indexed query) finishes well under a second, and anything slower is worth
 * less to the user than the wait. The turn is on the hook for every one of
 * these milliseconds before the model is even called.
 */
export const RECALL_TIMEOUT_MS = 1_500;

/**
 * Statements per `add` call. mem0 compares a batch against at most 10 existing
 * memories, so one enormous call would dedup badly; batches are run in
 * sequence, never in parallel, because each one has to see what the previous
 * one wrote. At most `MAX_IMPORT_STATEMENTS / IMPORT_BATCH_SIZE` LLM calls.
 */
const IMPORT_BATCH_SIZE = 25;

/** Sentinel for the recall race; a value no mem0 result can collide with. */
const TIMED_OUT = Symbol('memory recall timed out');

export class MemoryUnavailableError extends Error {
  constructor() {
    super('Memory is not configured on this deployment');
    this.name = 'MemoryUnavailableError';
  }
}

export class MemoryImportTooLargeError extends Error {
  constructor(public readonly length: number) {
    super(`Import is ${length} characters; the limit is ${MAX_IMPORT_CHARS}`);
    this.name = 'MemoryImportTooLargeError';
  }
}

/**
 * The CoPilot's long-term memory, per user.
 *
 * mem0 owns the hard part — deciding, against everything already remembered,
 * whether a fact from this turn is new, a refinement, or a contradiction to
 * drop. This service owns the boundaries around it: who a memory belongs to,
 * what a turn is allowed to contribute, how it is rendered into a prompt, and
 * what the Profile tab is allowed to read and delete.
 *
 * Reads for the UI go straight to the repository rather than through mem0:
 * listing is an ordinary paged query over an indexed scope, and routing it
 * through mem0 would mean an embedding call to answer "show me my memories".
 *
 * Every mem0 call is best-effort on the chat path. Memory is an enhancement;
 * a failure to recall or to remember must never fail the user's turn.
 *
 * Two switches gate it, and BOTH must be on:
 *   - `COPILOT_MEMORY_ENABLED`, a deployment-wide env kill-switch, and
 *   - the user's own `copilot_memory_enabled`.
 *
 * `enabledForUser()` checks both, and `recallForTurn`, `rememberTurn`,
 * `extractForReview` and `saveReviewed` each call it rather than trusting
 * their caller — the import path reaches the service from two separate routes,
 * and a check that lives in only one of them is a check that will be missed.
 */
export class UserMemoryService {
  /** Built lazily and reused for the life of the request. */
  private clientPromise: Promise<UserMemoryClient> | null = null;

  /** Resolved once per service; the preference cannot change mid-request. */
  private preferencePromise: Promise<boolean> | null = null;

  constructor(
    private readonly repository: UserMemoryRepository,
    private readonly users: Pick<
      UserRepository,
      'findCopilotMemoryEnabled' | 'setCopilotMemoryEnabled'
    >,
    private readonly userId: string,
    /** Injected in tests; defaults to the real mem0 client. */
    private readonly buildClient: typeof createUserMemory = createUserMemory,
    private readonly isConfigured: typeof memoryConfigured = memoryConfigured,
    /** Injected in tests so the deadline can be driven without a real wait. */
    private readonly recallTimeoutMs: number = RECALL_TIMEOUT_MS,
    /** Injected in tests; decides what a turn contributes. See memory/extract.ts. */
    private readonly extractFacts: UserFactExtractor = extractUserFacts,
    /** Injected in tests; the @memory_import agent run. */
    private readonly runImport: MemoryImportRunner = runMemoryImport,
  ) {}

  /**
   * Whether this deployment can run memory at all: the kill-switch is on and
   * there is a model to extract with. Both are operator-level, so the UI shows
   * one answer for either.
   */
  available(): boolean {
    return this.isConfigured();
  }

  /**
   * Whether memory is on for this user: the deployment is configured AND they
   * have not turned it off. Memoized for the life of the service so a turn
   * that checks it twice (recall, then the write-back) reads the row once.
   */
  async enabledForUser(): Promise<boolean> {
    if (!this.available()) return false;
    this.preferencePromise ??= this.users.findCopilotMemoryEnabled(this.userId);
    return this.preferencePromise;
  }

  /** The user's own preference, ignoring whether the deployment can run it. */
  preference(): Promise<boolean> {
    this.preferencePromise ??= this.users.findCopilotMemoryEnabled(this.userId);
    return this.preferencePromise;
  }

  /**
   * Turn memory on or off for this user. Existing memories are untouched —
   * "Forget all" is the separate, destructive action.
   */
  async setPreference(enabled: boolean): Promise<boolean> {
    const stored = await this.users.setCopilotMemoryEnabled(this.userId, enabled);
    this.preferencePromise = Promise.resolve(stored);
    return stored;
  }

  private client(): Promise<UserMemoryClient> {
    if (!this.available()) return Promise.reject(new MemoryUnavailableError());
    this.clientPromise ??= this.buildClient({
      repository: this.repository,
      userId: this.userId,
    });
    return this.clientPromise;
  }

  /**
   * The system-context block for this turn, or null when there is nothing to
   * recall (or memory is off, or the lookup failed — all three are the same
   * thing from the turn's point of view).
   */
  async recallForTurn(query: string): Promise<string | null> {
    const trimmed = query?.trim();
    if (!trimmed || !(await this.enabledForUser())) return null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The client is built before the clock starts: on a cold serverless
      // start that is the mem0 module import, which has nothing to do with
      // how long the search takes and used to eat most of the budget.
      const client = await this.client();
      const recall = (async () => {
        const { results } = await client.search(trimmed, {
          filters: { user_id: this.userId },
          topK: MAX_RECALLED_MEMORIES,
        });
        return formatRecalledMemories(results.map(toRecalled));
      })();
      const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), this.recallTimeoutMs);
      });

      const winner = await Promise.race([recall, deadline]);
      if (winner === TIMED_OUT) {
        console.error(
          `[memory] recall exceeded ${this.recallTimeoutMs}ms; the turn runs without memory`,
        );
        // The losing promise is left to settle on its own; it is never read,
        // and this catch keeps a late rejection from becoming unhandled. It is
        // NOT cancelled — neither mem0's search nor the Bedrock embed under it
        // takes a signal — so a slow recall keeps running after the turn moved
        // on. That costs one in-flight call, not a blocked turn, which is the
        // trade this timeout is making.
        void recall.catch(() => {});
        return null;
      }
      return winner;
    } catch (err) {
      console.error('[memory] recall failed; the turn runs without memory:', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Record what one finished turn established about the user. Runs after the
   * response has streamed, so its cost is off the user's critical path; the
   * chat route schedules it.
   *
   * The turn is NOT handed to mem0 as a conversation. It goes through
   * `extractUserFacts` first (see `memory/extract.ts`), which is where the
   * "only what the user said, and only if it is durable" judgement lives;
   * mem0 is then asked only to de-duplicate whatever survived against what the
   * user already has. Most turns produce nothing and stop here, never reaching
   * mem0 at all.
   *
   * Returns how many memories were written, for logging — callers ignore it.
   */
  async rememberTurn({
    userId,
    chatId,
    userText,
    assistantText,
  }: RememberTurnInput): Promise<number> {
    if (userId !== this.userId) {
      throw new Error('rememberTurn called for a different user than this service is scoped to');
    }
    if (!userText?.trim() || !assistantText?.trim()) return 0;
    if (!(await this.enabledForUser())) return 0;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return 0;

    try {
      const facts = await this.extractFacts({ userText, assistantText, apiKey });
      // The common case. Nothing is embedded, searched or stored.
      if (facts.length === 0) return 0;

      const client = await this.client();
      const { results } = await client.add(
        facts.map((content) => ({ role: 'user' as const, content })),
        {
          userId: this.userId,
          metadata: { source: 'copilot' satisfies UserMemorySource, chat_id: chatId },
        },
      );

      // mem0's `add` still runs its own extraction pass over what we sent it
      // (that is what gives us de-duplication against existing memories), and
      // that pass is the maximalist one — `customInstructions` asks it to pass
      // statements through unchanged, but asking is not the same as knowing.
      // So verify: anything it wrote that is not one of the facts WE extracted
      // is drift, and is removed again. This is what makes "mem0 de-duplicates
      // only" a property of the system rather than a request.
      const drifted = results.filter((result) => !isOneOf(result.memory, facts));
      if (drifted.length > 0) {
        console.error(
          `[memory] mem0 returned ${drifted.length} memor${drifted.length === 1 ? 'y' : 'ies'} ` +
            `not in the extracted set; removing them`,
        );
        await this.repository.deleteByIds(
          this.userId,
          drifted.map((result) => result.id),
        );
      }
      return results.length - drifted.length;
    } catch (err) {
      console.error('[memory] failed to record the turn:', err);
      return 0;
    }
  }

  /**
   * Read a paste or an uploaded file and return what the CoPilot proposes
   * remembering — WITHOUT storing any of it.
   *
   * This is the first half of the import: the user sees these statements, edits
   * or removes any of them, and the survivors come back to `saveReviewed`.
   * Splitting it is the point — an import writes to a store that is read back
   * into unrelated conversations for months, so it should never be the side
   * effect of pressing one button.
   */
  async extractForReview({
    userId,
    text,
    origin,
    signal,
  }: ExtractForReviewInput): Promise<ExtractForReviewResult> {
    if (userId !== this.userId) {
      throw new Error('extractForReview called for a different user than this service is scoped to');
    }
    if (!(await this.enabledForUser())) throw new MemoryUnavailableError();

    const trimmed = text?.trim() ?? '';
    if (!trimmed) return { statements: [], summary: '' };
    if (trimmed.length > MAX_IMPORT_CHARS) {
      throw new MemoryImportTooLargeError(trimmed.length);
    }

    const { statements, summary } = await this.runImport({
      dump: trimmed,
      origin,
      signal,
    });

    // The cap is applied here rather than in the agent: it proposes what it
    // found, and the ceiling on how much one import may contribute is a
    // product decision this service owns.
    return { statements: statements.slice(0, MAX_IMPORT_STATEMENTS), summary };
  }

  /**
   * Write the statements the user approved on the review step.
   *
   * These have been through two filters already — the agent proposed them, and
   * the user edited or dropped any they did not want — so this is a write, not
   * a judgement. mem0's inference stays ON for the one thing it is still good
   * for here: checking each against what the user already remembers, so
   * re-importing an overlapping export does not duplicate half their memory.
   *
   * Unlike the chat path this one throws. The user is watching a dialog and
   * needs to be told when it fails.
   */
  async saveReviewed({
    userId,
    statements,
    origin,
  }: ImportMemoriesInput): Promise<ImportMemoriesResult> {
    if (userId !== this.userId) {
      throw new Error('saveReviewed called for a different user than this service is scoped to');
    }
    if (!(await this.enabledForUser())) throw new MemoryUnavailableError();

    // Capped here, not only in the agent's schema: the review step lets the
    // user retype an entry, so the schema's limit is not the last word on what
    // reaches the store.
    const cleaned = statements
      .map((s) => s?.trim())
      .filter((s): s is string => Boolean(s))
      .map((s) =>
        s.length > MAX_IMPORT_STATEMENT_CHARS
          ? `${s.slice(0, MAX_IMPORT_STATEMENT_CHARS).trimEnd()}…`
          : s,
      )
      .slice(0, MAX_IMPORT_STATEMENTS);
    if (cleaned.length === 0) return { submitted: 0, added: 0, skipped: 0 };

    const client = await this.client();
    const metadata = {
      source: 'import' satisfies UserMemorySource,
      ...(origin ? { origin } : {}),
    };

    let added = 0;
    const drifted: string[] = [];
    // Sequential by necessity: batch N must dedup against what batch N-1 wrote.
    for (let i = 0; i < cleaned.length; i += IMPORT_BATCH_SIZE) {
      const batch = cleaned.slice(i, i + IMPORT_BATCH_SIZE);
      const { results } = await client.add(
        batch.map((content) => ({ role: 'user' as const, content })),
        { userId: this.userId, metadata },
      );

      // Same guarantee the chat path enforces, and it matters more here: the
      // user read these statements and approved them. mem0's `add` still runs
      // its own extraction pass over what we send, so anything it wrote that is
      // not one of the approved statements is removed again — otherwise
      // "review before saving" would not be true.
      const extra = results.filter((result) => !isOneOf(result.memory, batch));
      drifted.push(...extra.map((result) => result.id));
      added += results.length - extra.length;
    }

    if (drifted.length > 0) {
      console.error(
        `[memory] mem0 wrote ${drifted.length} memor${drifted.length === 1 ? 'y' : 'ies'} ` +
          `the user did not approve; removing them`,
      );
      await this.repository.deleteByIds(this.userId, drifted);
    }

    return { submitted: cleaned.length, added, skipped: Math.max(cleaned.length - added, 0) };
  }

  /** The Profile → Memory listing. Newest first, capped, pageable. */
  async list(limit = DEFAULT_LIST_LIMIT, offset = 0): Promise<UserMemoryList> {
    const capped = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit) || DEFAULT_LIST_LIMIT));
    const skip = Math.max(0, Math.floor(offset) || 0);
    const [rows, total] = await Promise.all([
      this.repository.list(this.userId, MEMORY_COLLECTION, capped, {}, skip),
      this.repository.count(this.userId, MEMORY_COLLECTION),
    ]);

    return {
      hasMore: skip + rows.length < total,
      items: rows.map((row) => ({
        id: row.id,
        memory: row.payload.data ?? row.memory,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // mem0 spreads the `metadata` handed to `add()` into the payload it
        // writes (`createMemory`), stripping only user_id/agent_id/run_id, so
        // the `source` stamped on the write survives here. Anything else —
        // including a row written before this stamp existed — reads as a
        // conversation memory, which is the common case.
        source: row.payload.source === 'import' ? 'import' : 'copilot',
        // Stamped at import time (filename, or "filename — note"); absent on a
        // conversation memory.
        origin: typeof row.payload.origin === 'string' ? row.payload.origin : null,
      })),
      total,
    };
  }

  /** How many memories this user has. Used to report what an import landed. */
  count(): Promise<number> {
    return this.repository.count(this.userId, MEMORY_COLLECTION);
  }

  /** Forget one memory. False when it wasn't this user's to forget. */
  async forget(id: string): Promise<boolean> {
    return (await this.repository.deleteByIds(this.userId, [id])) > 0;
  }

  /** Forget everything this user has. Returns the count. */
  async forgetAll(): Promise<number> {
    // The entity index is dropped too — leaving it would keep links pointing
    // at memories that no longer exist, which skews later recall.
    const [memories] = await Promise.all([
      this.repository.deleteAll(this.userId, MEMORY_COLLECTION),
      this.repository.deleteAll(this.userId, `${MEMORY_COLLECTION}_entities`),
    ]);
    return memories;
  }
}

function toRecalled(item: MemoryClientItem) {
  return { id: item.id, memory: item.memory, score: item.score };
}

/**
 * Whether what mem0 wrote is one of our facts, allowing for how mem0's own
 * extraction pass restates a statement even when told not to: it drops or
 * adds a "User …" / "The user …" subject, re-cases, re-punctuates. A result
 * that says the same thing in other words is kept; only content that is not
 * in the extracted set at all is "drift" and removed. (Deleting a restated
 * fact lost the memory altogether: the original was never stored.)
 */
export function isOneOf(candidate: string | undefined, allowed: string[]): boolean {
  const normalized = normalizeFact(candidate);
  if (!normalized) return false;
  const candidateTokens = tokens(normalized);
  return allowed.some((fact) => {
    const known = normalizeFact(fact);
    if (!known) return false;
    if (known === normalized) return true;
    // One is the other with a word or two added ("short answers" → "short, concise answers").
    if (known.includes(normalized) || normalized.includes(known)) return true;
    // Otherwise nearly the same words: a topic-adjacent restatement ("interested in
    // Indonesian coal assets" for "covers Indonesian coal and nickel") does not pass.
    const knownTokens = tokens(known);
    return shared(candidateTokens, knownTokens) >= SAME_FACT_MIN_SHARED && overlap(candidateTokens, knownTokens) >= SAME_FACT_OVERLAP;
  });
}

/** Share of the larger word set that both have in common, for `isOneOf`. */
const SAME_FACT_OVERLAP = 0.75;
/** And at least this many words in common, so two short facts cannot pass on one word. */
const SAME_FACT_MIN_SHARED = 2;

function normalizeFact(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/, '')
    // mem0 writes "User …" / "The user …" / "They …"; our facts are subjectless.
    .replace(/^(?:the user|user|they|he|she)(?:'s| is| are| has| have)? /, '');
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are']);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t)),
  );
}

function shared(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return shared(a, b) / Math.max(a.size, b.size);
}
