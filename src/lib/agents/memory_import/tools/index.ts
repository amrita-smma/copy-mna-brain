/**
 * @memory_import's tool set — deliberately one tool.
 *
 * The agent reads a block of arbitrary, untrusted text (a paste or an uploaded
 * file). Giving it anything that can read the workspace or reach the network
 * would make a prompt injection inside that text worth attempting; with only
 * `propose_memories` the worst an injection can do is suggest a statement the
 * user sees and rejects before anything is stored.
 */
import { proposeMemories } from './propose_memories';

export { proposeMemories };
export { readMemoryImportContext } from './propose_memories';
export type { MemoryImportContext, ProposeMemoriesInput } from './propose_memories';

export const MEMORY_IMPORT_TOOLS = [proposeMemories];
