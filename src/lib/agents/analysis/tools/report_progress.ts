import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * report_progress — snapshot of an in-flight iteration for the trace UI.
 *
 * Like narrate_step, this is a deliberate no-op: we only care about the
 * args. The agent calls it on turns where it's working through a list
 * (screening N candidates, checking N files, etc.) so the user can watch
 * each item's state update in a "Live · partial output" block on the
 * current trace step.
 *
 * Usage pattern: call once per turn while iterating, passing the FULL
 * items list each time with the current per-item status. Skip on turns
 * where you aren't iterating — there's no need to re-emit a stale list.
 *
 * Workforce-only (chat has no trace UI).
 */
export const reportProgress = tool(
  async () => "ok",
  {
    name: "report_progress",
    description: `Report progress on an in-flight iteration (e.g. screening N candidates one by one). The UI renders the items as a "Live · partial output" block on the current trace step so the user can watch each row's state update.

Args:
    items: The FULL list of items you're iterating through, each with its current status. Re-emit the full list every turn while iterating — the latest call wins.

Per-item status:
    pending  — not started yet (default for items you haven't touched)
    checking — currently being evaluated this turn
    done     — finished; \`detail\` carries the result (e.g. "match", "kept")
    fail     — finished; rejected, failed, or eliminated; \`detail\` carries the reason

Returns:
    "ok" — exists for the side-effect of recording args; not data.`,
    schema: z.object({
      items: z
        .array(
          z.object({
            label: z
              .string()
              .max(120)
              .describe("Display name of the item (≤ 60 chars ideal)."),
            status: z
              .enum(["pending", "checking", "done", "fail"])
              .describe("Current status of this item."),
            detail: z
              .string()
              .max(200)
              .optional()
              .describe("Short result/reason text shown next to the status."),
          }),
        )
        .max(20)
        .describe(
          "Full ordered list of items in the iteration. Re-emit every turn while iterating.",
        ),
    }),
  },
);
