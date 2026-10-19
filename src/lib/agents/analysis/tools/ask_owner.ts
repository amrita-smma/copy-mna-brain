import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { ASK_OWNER_TOOL_NAME, buildAskOwnerDeclinedMessage } from "../hitl";

/**
 * ask_owner — pause a workforce run and put one question to its owner (MB-561).
 *
 * The call is gated by the workforce HITL middleware (see ../hitl.ts), so the
 * body only runs after a human decided:
 *   - Accept recommendation → the decision route re-issues the call with
 *     owner_decision 'accepted' and the recommendation as owner_answer.
 *   - Answer differently   → owner_decision 'answered' + the owner's text.
 *   - Reject               → owner_decision 'declined' (+ the owner's note in
 *     owner_answer); the body returns the "do not guess" message.
 * owner_decision/owner_answer are only trustworthy because the middleware
 * accepts nothing but `edit` for this tool: every executed call carries args
 * the route built from server state, whatever the agent put in them.
 */

const MAX_OPTIONS = 6;

export const askOwnerSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("The one question the owner must answer, phrased so it can be answered in a line."),
  recommendation: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("REQUIRED. Your recommended answer — what you would do if you had to decide."),
  rationale: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Why you recommend it, and what goes wrong if you guess. Cite the evidence."),
  options: z
    .array(z.string().trim().min(1).max(200))
    .max(MAX_OPTIONS)
    .optional()
    .describe("Optional short answer choices the owner can pick with one click. Include your recommendation."),
  owner_decision: z
    .enum(["accepted", "answered", "declined"])
    .optional()
    .describe("Set by the system when the owner decides. Never set it yourself."),
  owner_answer: z
    .string()
    .optional()
    .describe("Set by the system when the owner decides. Never set it yourself."),
});

export type AskOwnerInput = z.infer<typeof askOwnerSchema>;

export function askOwnerResult(input: AskOwnerInput): string {
  const answer = input.owner_answer?.trim();
  if (input.owner_decision === "declined") {
    return buildAskOwnerDeclinedMessage(input.question, answer);
  }
  if (input.owner_decision === "accepted" && answer) {
    return `The owner accepted your recommendation. Their answer: "${answer}". Proceed on that basis.`;
  }
  if (input.owner_decision === "answered" && answer) {
    return (
      `The owner answered differently: "${answer}". Use this answer instead of ` +
      `your recommendation ("${input.recommendation}") and proceed on that basis.`
    );
  }
  return (
    "No answer from the owner was recorded for this question. Do not guess an " +
    "answer: finish without making the change the question was about, and say " +
    "so in your report."
  );
}

export const askOwner = tool(
  async (input: AskOwnerInput) => {
    logger.debug(
      `🔧 TOOL CALLED: ask_owner(decision='${input.owner_decision ?? "none"}')`,
    );
    return askOwnerResult(input);
  },
  {
    name: ASK_OWNER_TOOL_NAME,
    description: `Pause this run and ask the task's owner ONE question, with your recommended answer. The run waits (possibly for hours) until the owner accepts your recommendation, answers differently, or declines; nothing you have drafted is published while it waits.

Use it ONLY for genuine ambiguity that would otherwise force you to guess or to publish something unsound — e.g. the instruction and the data contradict each other, a source the task depends on is gone and the replacement changes the meaning, or two readings of the instruction lead to materially different output. Never use it for routine confirmations, progress updates, or anything you can settle yourself with the tools you have.

In a scheduled refresh of an insight, use this instead of guessing: the owner is asked and the refresh publishes after they answer.

Rules:
- Always state your recommended answer in \`recommendation\` and why in \`rationale\`. A question without a recommendation is not allowed.
- One question per call. Never call ask_owner twice in the same turn, and never in the same turn as a gated move_stage (narrate_step alongside it is fine).
- Leave \`owner_decision\` and \`owner_answer\` unset — the system fills them in.

Returns the owner's answer. If the owner declines, you are told not to guess: finish without changes or end with "✗ Could not complete: …".`,
    schema: askOwnerSchema,
  },
);
