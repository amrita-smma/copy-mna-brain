import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";

/**
 * narrate_step — structured trace-card narration tool.
 *
 * The agent calls this once per model turn in parallel with whatever real
 * work it's doing. The tool body is a deliberate no-op: we only care about
 * the *args*, which `buildTrace` lifts out of the AIMessage.tool_calls to
 * populate each step's title / overview / detailed fields.
 *
 * Why a tool and not a JSON-in-content convention:
 *   - Zod enforces the shape; malformed args are rejected by the framework
 *     before they reach the trace mapper.
 *   - Doesn't pollute the model's visible content with structured markup.
 *   - Tool args are part of the AIMessage even when the turn is paused by
 *     HITL, so the trace card renders correctly during waiting states too.
 *
 * Workforce-only. The chat agent has no trace UI, so narration would just
 * burn tokens with no consumer.
 */
export const narrateStep = tool(
  async ({ title }: { title: string; overview: string; plan?: string[] }) => {
    logger.debug(`🔧 TOOL CALLED: narrate_step(title='${title}')`);
    return "ok";
  },
  {
    name: "narrate_step",
    description: `Record a structured narration of what you're doing this turn. Call this EVERY model turn, in parallel with any other tool calls, so the user sees a coherent trace.

Args:
    title: Short headline (≤ 60 chars). Describes the action, not the result.
    overview: One-sentence plain-English summary of what you're doing and why.
    plan: (Optional, FIRST TURN ONLY) An ordered outline of the step titles you intend to execute, including this one. Use this so the user sees the full plan up-front with a progress bar. Skip on subsequent turns unless you're deliberately revising the plan.

Returns:
    "ok" — the tool exists for structured side-effects, not for data.`,
    schema: z.object({
      title: z
        .string()
        .max(120)
        .describe("Short headline for the trace card (≤ 60 chars ideal)."),
      overview: z
        .string()
        .describe("One-sentence summary of what this turn does and why."),
      plan: z
        .array(z.string().max(120))
        .max(12)
        .optional()
        .describe(
          "Ordered outline of step titles (this turn first). Pass on the first turn so the UI can render the full plan and a progress bar.",
        ),
    }),
  },
);
