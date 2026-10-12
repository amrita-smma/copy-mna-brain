import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { MAX_IMPORT_STATEMENTS, MAX_IMPORT_STATEMENT_CHARS } from '@/lib/memory/limits';
import { logger } from '../../logger';

/**
 * The one tool @memory_import has: hand back the statements it found.
 *
 * It does NOT write them. An import is confirmed by the user — they see what
 * was pulled out, edit or drop any of it, and only then is anything stored
 * (Profile → Memory → Import). So the tool collects into an array the caller
 * owns and `runMemoryImport` returns; the save happens afterwards, in
 * `UserMemoryService.saveReviewed`, against whatever the user approved.
 *
 * Collecting through `configurable` rather than the tool's return value is
 * deliberate: a tool's return goes to the model, not to us, and parsing the
 * agent's prose for a list is exactly the fragility this avoids.
 */
export const proposeMemoriesSchema = z.object({
  memories: z
    .array(z.string().trim().min(1).max(MAX_IMPORT_STATEMENT_CHARS))
    .max(MAX_IMPORT_STATEMENTS)
    .describe(
      'Every durable fact about the user found in the text, one per entry, ' +
        'third person and self-contained. Empty when the text contained none.',
    ),
});

export type ProposeMemoriesInput = z.infer<typeof proposeMemoriesSchema>;

/** The `configurable` keys this tool reads. Set by the service, never by the model. */
export interface MemoryImportContext {
  /** The run's collector. The tool appends to it; the caller reads it after. */
  memory_proposal?: string[];
  /** Free-text label for where the text came from, carried into metadata later. */
  memory_origin?: string;
}

export function readMemoryImportContext(
  configurable: Record<string, unknown> | undefined,
): MemoryImportContext {
  const proposal = configurable?.memory_proposal;
  return {
    memory_proposal: Array.isArray(proposal) ? (proposal as string[]) : undefined,
    memory_origin:
      typeof configurable?.memory_origin === 'string' ? configurable.memory_origin : undefined,
  };
}

export const proposeMemories = tool(
  async ({ memories }: ProposeMemoriesInput, runtime?: RunnableConfig) => {
    logger.debug('🔧 TOOL CALLED: propose_memories()');

    const { memory_proposal: collector } = readMemoryImportContext(runtime?.configurable);
    if (!collector) {
      // Only reachable if the agent is run outside the import service. Say so
      // rather than silently dropping what it found.
      return '**Error:** This run has nowhere to put the proposed memories, so none were kept.';
    }

    if (memories.length === 0) {
      return 'Nothing durable about the user was found in that text.';
    }

    // Appended, not assigned: a model that calls the tool twice should not
    // silently discard its first batch.
    collector.push(...memories);

    return `Proposed ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} for the user to review. They are not saved yet — the user confirms them next.`;
  },
  {
    name: 'propose_memories',
    description: `Hand back the memories you extracted from the text, for the user to review.

Call this exactly once, with every statement you decided to keep. Pass an empty list when the text contained nothing durable about the user.

Each entry must be one self-contained sentence, written in the third person about the user, under 200 characters. Do not pass raw excerpts from the text.

Nothing is saved by this call. The user sees your proposals, edits or removes any of them, and only then are the survivors stored — so propose what you genuinely found and let them decide.`,
    schema: proposeMemoriesSchema,
  },
);
