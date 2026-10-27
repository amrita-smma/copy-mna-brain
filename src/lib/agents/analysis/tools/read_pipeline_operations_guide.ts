import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  MNA_PIPELINE_OPERATIONS_GUIDE,
  PIPELINE_OPERATION_TOPIC_KEYS,
  PIPELINE_OPERATION_TOPICS,
  PIPELINE_OPERATIONS_GUIDE_TOOL,
} from "../flavors/pipelineOperations";
import { logger } from "../../logger";

const TOPIC_VALUES = [...PIPELINE_OPERATION_TOPIC_KEYS, "all"] as const;

/**
 * Progressive disclosure for the pipeline-operations guide
 * (`../flavors/pipelineOperations.ts`): the chat prompts carry the routing
 * rules and point here for the procedure of the operation at hand, so the
 * ~6k tokens of mechanics are read only by the turns that write. Pure text —
 * no I/O — so it can never fail the turn.
 */
export const readPipelineOperationsGuide = tool(
  async ({ topic }: { topic: (typeof TOPIC_VALUES)[number] }) => {
    logger.debug(`🔧 TOOL CALLED: ${PIPELINE_OPERATIONS_GUIDE_TOOL}(topic=${topic})`);
    if (topic === "all") return MNA_PIPELINE_OPERATIONS_GUIDE;
    return PIPELINE_OPERATION_TOPICS[topic].body;
  },
  {
    name: PIPELINE_OPERATIONS_GUIDE_TOOL,
    description: `Read the binding procedure for one pipeline operation BEFORE performing it. Topics: ${PIPELINE_OPERATION_TOPIC_KEYS.map(
      (key) => `${key} — ${PIPELINE_OPERATION_TOPICS[key].summary}`,
    ).join("; ")}. Pass "all" for the whole guide.

Call it once per topic per conversation (the text stays in the thread) and follow what it returns exactly — the field names, instruction formats, thresholds and warning-block syntax are not to be improvised. Research and read-only questions never need it.`,
    schema: z.object({
      topic: z
        .enum(TOPIC_VALUES)
        .describe("The operation about to be performed, or \"all\" for the whole guide."),
    }),
  },
);

