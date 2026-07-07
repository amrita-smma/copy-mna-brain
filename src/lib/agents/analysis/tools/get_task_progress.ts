import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { AiWorkforceQueueRepository } from "@/lib/repositories";
import type { WorkforceQueueRow, WorkforceStatus } from "@/lib/repositories";

const WORKFORCE_STATUSES = [
  "pending",
  "running",
  "waiting_for_human_input",
  "waiting_for_subagent",
  "resume_ready",
  "succeeded",
  "failed",
  "rejected",
  "timed_out",
] as const satisfies readonly WorkforceStatus[];

const STATUS_GROUPS = {
  active: [
    "pending",
    "running",
    "waiting_for_human_input",
    "waiting_for_subagent",
    "resume_ready",
  ] as WorkforceStatus[],
  done: ["succeeded"] as WorkforceStatus[],
  errored: ["failed", "rejected", "timed_out"] as WorkforceStatus[],
} as const;

type StatusFilter =
  | (typeof WORKFORCE_STATUSES)[number]
  | keyof typeof STATUS_GROUPS;

function resolveStatusFilter(
  filter: StatusFilter | undefined,
): WorkforceStatus | WorkforceStatus[] | undefined {
  if (!filter) return undefined;
  if (filter in STATUS_GROUPS) {
    return STATUS_GROUPS[filter as keyof typeof STATUS_GROUPS];
  }
  return filter as WorkforceStatus;
}

function formatRow(row: WorkforceQueueRow, index: number): string {
  const title = row.title?.trim() || "(untitled)";
  const created = row.created_at;
  const started = row.started_at ?? "—";
  const ended = row.ended_at ?? "—";

  const errorPayload = row.error as Record<string, unknown> | null;
  const errorSummary =
    errorPayload && typeof errorPayload === "object"
      ? (errorPayload.message as string | undefined) ??
        (errorPayload.code as string | undefined) ??
        JSON.stringify(errorPayload).slice(0, 200)
      : null;

  const lines = [
    `### ${index + 1}. ${title}`,
    `- **ID:** ${row.id}`,
    `- **Agent:** ${row.agent_name}`,
    `- **Status:** ${row.status}`,
    `- **Created:** ${created}`,
    `- **Started:** ${started}`,
    `- **Ended:** ${ended}`,
  ];

  if (row.resume_reason) {
    lines.push(`- **Waiting reason:** ${row.resume_reason}`);
  }
  if (row.last_heartbeat_at && row.status === "running") {
    lines.push(`- **Last heartbeat:** ${row.last_heartbeat_at}`);
  }
  if (errorSummary) {
    lines.push(`- **Error:** ${errorSummary}`);
  }

  return lines.join("\n");
}

export const getTaskProgress = tool(
  async ({
    status,
    agent_name,
    limit = 10,
  }: {
    status?: StatusFilter;
    agent_name?: string;
    limit?: number;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: get_task_progress(status='${status ?? "any"}', agent='${agent_name ?? "any"}', limit=${limit})`,
    );

    try {
      const repo = new AiWorkforceQueueRepository(createDb(), await getActiveWorkspaceId());
      const rows = await repo.listFiltered({
        status: resolveStatusFilter(status),
        agentName: agent_name?.trim() || undefined,
        limit: Math.min(Math.max(limit, 1), 25),
      });

      if (rows.length === 0) {
        const scope = [
          status ? `status="${status}"` : null,
          agent_name ? `agent="${agent_name}"` : null,
        ]
          .filter(Boolean)
          .join(", ");
        return scope
          ? `No Workforce tasks found matching ${scope}.`
          : "No Workforce tasks found.";
      }

      const header = `**Workforce tasks (${rows.length} most recent${
        status ? `, status=${status}` : ""
      }${agent_name ? `, agent=${agent_name}` : ""}):**`;
      return [header, "", ...rows.map((r, i) => formatRow(r, i))].join("\n\n");
    } catch (error) {
      logger.error(`get_task_progress error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "get_task_progress",
    description: `Check the status and progress of recent AI Workforce tasks.

Use this when the user asks about the state of background work they've kicked off — e.g. "is my task done", "what's the status of the Korean CMP search", "any failed tasks today", "what's running right now". Returns the most recent matching tasks with id, title, status, timestamps, and (when relevant) error or waiting-reason.

Args:
    status: Optional filter. Either a specific workforce status (pending, running, waiting_for_human_input, waiting_for_subagent, resume_ready, succeeded, failed, rejected, timed_out) or one of the convenience groups: "active" (anything in flight), "done" (succeeded), "errored" (failed/rejected/timed_out).
    agent_name: Optional filter by workforce agent name (e.g. "chat_handoff").
    limit: Max rows to return, default 10, capped at 25.

Returns:
    A markdown summary of matching tasks ordered by created_at desc, or a "no tasks found" message.`,
    schema: z.object({
      status: z
        .enum([
          ...WORKFORCE_STATUSES,
          "active",
          "done",
          "errored",
        ] as [StatusFilter, ...StatusFilter[]])
        .optional()
        .describe(
          "Workforce status or convenience group (active/done/errored)",
        ),
      agent_name: z
        .string()
        .optional()
        .describe("Filter by workforce agent_name"),
      limit: z
        .number()
        .int()
        .optional()
        .default(10)
        .describe("Max rows to return (1-25, default 10)"),
    }),
  },
);
