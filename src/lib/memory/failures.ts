/**
 * Turning a memory-write failure into something the person reading it can act
 * on.
 *
 * Writing a memory is the one path in this feature that depends on more than an
 * LLM key: it embeds through Bedrock and inserts into `user_memories`. Neither
 * is checked by `memoryConfigured()`, which only looks at the kill-switch and
 * `ANTHROPIC_API_KEY` — so a deployment can report memory as available, extract
 * an import successfully (that is Anthropic only), and then fail on save.
 *
 * Collapsing all of that into "Please try again" is worse than unhelpful: for a
 * missing Bedrock credential or an unapplied migration, retrying never works,
 * and the user has no way to know that. So the common operator-level failures
 * are named plainly — without echoing provider messages, which carry model ids,
 * endpoints and occasionally request payloads.
 */

export interface MemoryFailure {
  status: number;
  /** Safe to show a user: no provider text, no identifiers. */
  message: string;
  /** True when retrying cannot help — someone has to change configuration. */
  permanent: boolean;
}

/**
 * Everything the error chain has to say, lowercased, for matching.
 *
 * Reads `code` explicitly: a `pg` error carries its SQLSTATE there rather than
 * in the message, and an Error's own `toString()` would never include it.
 */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;

  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current === 'object') {
      const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
      for (const field of [record.name, record.message, record.code]) {
        if (typeof field === 'string' || typeof field === 'number') parts.push(String(field));
      }
      current = record.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }

  return parts.join(' ').toLowerCase();
}

/**
 * Classify a failure from the memory write path.
 *
 * Deliberately conservative: anything not recognised is reported as transient,
 * because telling someone their deployment is broken when it was a blip is the
 * worse error of the two.
 */
export function describeMemoryFailure(err: unknown): MemoryFailure {
  const text = errorText(err);

  // The table is missing — the migrations have not been applied here.
  // Postgres 42P01, or its message.
  if (text.includes('42p01') || text.includes('user_memories" does not exist')) {
    return {
      status: 503,
      permanent: true,
      message:
        'Memory storage is not set up on this deployment yet — the database is missing the memories table. An administrator needs to run the pending migrations.',
    };
  }

  // pgvector is absent, so the embedding column cannot exist.
  if (text.includes('type "vector" does not exist') || text.includes('extension "vector"')) {
    return {
      status: 503,
      permanent: true,
      message:
        'Memory storage is not set up on this deployment yet — the database is missing the pgvector extension. An administrator needs to enable it.',
    };
  }

  // Bedrock could not be reached or refused us: no credentials in the
  // environment, the wrong region, or the Titan model not enabled on the
  // account. All operator-level, none fixable by retrying.
  if (
    text.includes('credential') ||
    text.includes('unrecognizedclient') ||
    text.includes('accessdenied') ||
    text.includes('bedrock') ||
    text.includes('could not load credentials') ||
    text.includes('validationexception')
  ) {
    return {
      status: 503,
      permanent: true,
      message:
        'Memory could not reach the embedding service, so nothing was saved. This is a configuration problem on this deployment rather than something you did — an administrator needs to check it.',
    };
  }

  // A model rejecting a sampling parameter we sent. Always a code/config
  // mismatch — the model moved on and a call still names the old field — and
  // retrying is guaranteed to fail the same way. See `@/lib/ai/modelParams`.
  if (text.includes('is deprecated for this model')) {
    return {
      status: 503,
      permanent: true,
      message:
        'Memory could not reach the language model with the settings this deployment sends, so nothing was saved. This is a configuration problem rather than something you did — an administrator needs to check it.',
    };
  }

  // No model to extract or de-duplicate with.
  if (text.includes('anthropic api key') || text.includes('api key is required')) {
    return {
      status: 503,
      permanent: true,
      message:
        'Memory is not fully configured on this deployment, so nothing was saved. An administrator needs to finish setting it up.',
    };
  }

  // Provider overload / rate limit — genuinely worth retrying.
  if (text.includes('429') || text.includes('529') || text.includes('overloaded')) {
    return {
      status: 503,
      permanent: false,
      message: 'The service is busy right now and nothing was saved. Please try again in a moment.',
    };
  }

  return {
    status: 500,
    permanent: false,
    message: 'Could not save those memories. Please try again.',
  };
}
