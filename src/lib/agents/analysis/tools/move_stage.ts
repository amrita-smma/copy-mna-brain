import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import { CompanyRepository } from "@/lib/repositories";
import type { TablesUpdate } from "@/lib/repositories";
import { PipelineStageUnavailableError } from "@/lib/services/companyService";
import { screeningRunWriteRefusal } from "@/lib/screening/screeningRunGuard";
import { buildCompanyMentionsMarker } from "@/lib/navigation/companyMentions";
import { FIRST_STAGE_KEY, isInPipelineStage } from "@/lib/pipeline/stages";
import {
  isForwardStageMove,
  rungLabel,
  stageMoveRequiresApproval,
  stageNeighbors,
} from "@/lib/pipeline/stageMoves";
import { DEAL_TYPES, normalizeDealType } from "@/lib/companies/dealTypes";
import { MOVE_STAGE_TOOL_NAME } from "../hitl";
import { logger } from "../../logger";

interface MoveStageArgs {
  company_name: string;
  from_stage: string;
  to_stage: string;
  reason: string;
  note?: string;
  segment?: string;
  geography?: string;
  deal_type?: string;
  source?: "inbound" | "outbound";
  banker?: string;
  banker_source?: string;
}

/** The resume value langchain's HITL middleware contract uses; the decision route sends it. */
interface HitlResume {
  decisions?: Array<{ type?: string; message?: string }>;
}

/**
 * Move a company one step along the stage ladder (Pending Confirmation → L0 →
 * the workspace's later stages, or back). The target is whatever
 * `lookup_pipeline_stage` reported as the previous or next stage, so no stage
 * is hardcoded.
 *
 * Approval: a move into or out of a stage after L0 pauses the run for a human
 * decision before anything is written. The pause is a LangGraph `interrupt()`
 * raised here rather than a `humanInTheLoopMiddleware` entry, because the
 * middleware can only gate a tool name as a whole and intake ↔ Pending ↔ L0
 * moves must keep running unattended. The interrupt carries the same
 * HITLRequest shape (`actionRequests`) and takes the same resume value
 * (`{ decisions: [...] }`), so runAgent, the decision route, the trace and the
 * approval email treat it exactly like a middleware pause. On resume the tool
 * re-runs from the top, so everything before the interrupt is read-only.
 */
export const moveStage = tool(
  async (args: MoveStageArgs, runtime?: { configurable?: Record<string, unknown> }) => {
    const { company_name, from_stage, to_stage, reason, note } = args;
    logger.debug(
      `🔧 TOOL CALLED: move_stage(company_name='${company_name}', ${from_stage} → ${to_stage})`,
    );

    // Pending Confirmation promote/drop follows the Auto promote / Auto drop
    // toggles via run_ai_screening; a screening task may not do it itself.
    const refusal = screeningRunWriteRefusal(runtime, "Moving a company between stages");
    if (refusal) return refusal;

    const trimmedName = company_name?.trim() ?? "";
    if (!trimmedName) return `**Error:** company_name is required.`;
    const trimmedReason = reason?.trim() ?? "";
    if (!trimmedReason) {
      return `**Error:** reason is required. Explain why the company should move — a reviewer may read it before approving.`;
    }
    const fromKey = from_stage?.trim() ?? "";
    const toKey = to_stage?.trim() ?? "";
    if (!toKey) return `**Error:** to_stage is required. Call lookup_pipeline_stage for the allowed keys.`;

    let plan: {
      companyId: string;
      companyName: string;
      projectName: string | null;
      fromLabel: string;
      toLabel: string;
      currentStage: string | null;
      needsApproval: boolean;
      forward: boolean;
      l0Updates: TablesUpdate<"companies">;
    };
    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const company = await new CompanyRepository(db, workspaceId).findByNameFuzzy(trimmedName);
      if (!company) {
        return `No company found matching "${trimmedName}". Use query_companies to confirm spelling.`;
      }
      if (company.status === "dropped") {
        return `Cannot move "${company.target}": this company is dropped and is read-only.`;
      }

      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { pipelineStageService } = createContainer(db, workspaceId);
      const stages = await pipelineStageService.list();

      const current = company.pipeline_stage ?? null;
      if ((current ?? "") !== fromKey) {
        return `Cannot move "${company.target}": it is at ${rungLabel(stages, current)} (key "${current ?? ""}"), not "${fromKey}". Call lookup_pipeline_stage again and use the stage it reports.`;
      }
      if (toKey === current) {
        return `"${company.target}" is already at ${rungLabel(stages, current)}; nothing to move.`;
      }
      const neighbors = stageNeighbors(stages, current);
      if (!neighbors.targets.some((r) => r.key === toKey)) {
        const allowed = neighbors.targets.map((r) => `${rungLabel(stages, r.key)} ("${r.key}")`);
        return `Cannot move "${company.target}" from ${rungLabel(stages, current)} to "${toKey}": a move goes one stage at a time. Allowed from here: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`;
      }

      // Entering L0 from outside the pipeline runs the L0 entry checks, so
      // fill any required fields the agent supplied before the move.
      const l0Updates: TablesUpdate<"companies"> = {};
      if (toKey === FIRST_STAGE_KEY && !isInPipelineStage(current)) {
        if (args.segment?.trim()) l0Updates.segment = args.segment.trim();
        if (args.geography?.trim()) l0Updates.geography = args.geography.trim();
        // deal_type is a Postgres enum: normalize, and refuse rather than
        // writing whatever the agent typed.
        if (args.deal_type?.trim()) {
          const normalized = normalizeDealType(args.deal_type);
          if (!normalized) {
            return `**Error:** deal_type must be one of ${DEAL_TYPES.join(", ")}; got "${args.deal_type}".`;
          }
          l0Updates.deal_type = normalized;
        }
        if (args.source) l0Updates.source = args.source;
        if (args.banker?.trim()) l0Updates.banker = args.banker.trim();
        if (args.banker_source?.trim()) l0Updates.banker_source = args.banker_source.trim();
        if (!company.source && !l0Updates.source) l0Updates.source = "outbound";
      }

      plan = {
        companyId: company.id,
        companyName: company.target,
        projectName: company.project_name ?? null,
        fromLabel: rungLabel(stages, current),
        toLabel: rungLabel(stages, toKey),
        currentStage: current,
        needsApproval: stageMoveRequiresApproval(current, toKey),
        forward: isForwardStageMove(stages, current, toKey),
        l0Updates,
      };
    } catch (error) {
      logger.error(`move_stage error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }

    // Outside the try: interrupt() pauses the run by throwing, and that must
    // reach the graph rather than be returned as a tool error.
    if (plan.needsApproval) {
      const { interrupt } = await import("@langchain/langgraph");
      const resume = interrupt({
        actionRequests: [
          {
            name: MOVE_STAGE_TOOL_NAME,
            args: { ...args, from_label: plan.fromLabel, to_label: plan.toLabel },
            description: `Move ${plan.companyName} from ${plan.fromLabel} to ${plan.toLabel}?`,
          },
        ],
        reviewConfigs: [
          { actionName: MOVE_STAGE_TOOL_NAME, allowedDecisions: ["approve", "reject"] },
        ],
      }) as HitlResume;
      const decision = resume?.decisions?.[0];
      if (decision?.type !== "approve") {
        const message = decision?.message?.trim();
        return `The reviewer rejected moving "${plan.companyName}" from ${plan.fromLabel} to ${plan.toLabel}.${message ? ` Their note: "${message}".` : ""} Do not retry the move; leave the company where it is and report the rejection.`;
      }
    }

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const { createContainer } = await import("@/lib/services/container");
      const { companyService } = createContainer(db, workspaceId);

      if (Object.keys(plan.l0Updates).length > 0) {
        await companyService.update(plan.companyId, plan.l0Updates);
      }
      const trimmedNote = note?.trim();
      const recordedNote = trimmedNote
        ? `Reason: ${trimmedReason}\n\nNote: ${trimmedNote}`
        : `Reason: ${trimmedReason}`;
      await companyService.promote(
        plan.companyId,
        plan.currentStage ?? undefined,
        toKey,
        recordedNote,
        undefined,
        undefined,
        undefined,
        // Only a step forward is a promotion reason; a move back still lands
        // its reason on the notes timeline above.
        plan.forward ? trimmedReason : undefined,
      );

      logger.debug(`✓ Moved ${plan.companyName} (${plan.companyId}) ${plan.fromLabel} → ${plan.toLabel}`);
      const mentions = buildCompanyMentionsMarker(
        [plan.companyName, plan.projectName]
          .filter((name): name is string => !!name?.trim())
          .map((name) => ({ id: plan.companyId, name })),
      );
      const out = `Moved "${plan.companyName}" from ${plan.fromLabel} to ${plan.toLabel}. Reason and any note recorded on the deal.`;
      return mentions ? `${out}\n${mentions}` : out;
    } catch (error) {
      if (error instanceof PipelineStageUnavailableError) {
        return `Cannot move "${plan.companyName}" to ${plan.toLabel}: this workspace has just deleted that stage. Call lookup_pipeline_stage again.`;
      }
      logger.error(`move_stage error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: MOVE_STAGE_TOOL_NAME,
    description: `Move a company ONE stage along the pipeline — to the next stage or back to the previous one. Call lookup_pipeline_stage first: it reports the company's current stage key and the keys of the stages it may move to.

Stage order: Pending Confirmation ("unreviewed") → L0 → the workspace's later stages. A company in an intake bucket (market_screening, discovered) or with no stage can enter at Pending Confirmation or directly at L0. Use "unreviewed" as to_stage to send a company to, or back to, Pending Confirmation.

Approval: moves among the intake buckets, Pending Confirmation and L0 run immediately. Any move into or out of a stage after L0 pauses the run until a human approves or rejects it — call the tool and let the runtime pause; if the result says it was rejected, do not retry.

Entering L0 from outside the pipeline runs the L0 entry checks (segment, geography, deal_type, source, and a banker for inbound deals). Supply any of those that are missing in the same call.

Args:
    company_name: The company (fuzzy-matched against target and project name).
    from_stage: The company's CURRENT stage key, exactly as lookup_pipeline_stage reported it. The tool refuses if it no longer matches.
    to_stage: The key of the stage to move to — the previous or next stage from lookup_pipeline_stage.
    reason: REQUIRED. Why the company should move, in 1–3 sentences a reviewer can read in isolation. For a gated move cite concrete evidence (financials, comparables, screening outcome).
    note: Optional caveat recorded alongside the reason (e.g. "user acknowledged weak FY2024 EBITDA").
    segment, geography, deal_type, source, banker, banker_source: Optional L0 entry fields, used only when entering L0 from outside the pipeline.`,
    schema: z.object({
      company_name: z.string().min(1).describe("Company target name or project name (fuzzy match)"),
      from_stage: z
        .string()
        .describe("The company's current stage key, exactly as lookup_pipeline_stage reported it ('' when it has none)"),
      to_stage: z.string().min(1).describe("Key of the previous or next stage, from lookup_pipeline_stage"),
      reason: z.string().min(1).describe("Why the company should move — shown to a reviewer on gated moves"),
      note: z.string().optional().describe("Optional caveat recorded alongside the reason"),
      segment: z.string().optional().describe('Broad sector/segment (e.g. "Semiconductor"). Always in English. L0 entry only.'),
      geography: z.string().optional().describe("Exactly ONE country name. Always in English. L0 entry only."),
      deal_type: z.string().optional().describe(`Deal type, one of: ${DEAL_TYPES.join(", ")}. L0 entry only.`),
      source: z.enum(["inbound", "outbound"]).optional().describe("inbound or outbound. L0 entry only."),
      banker: z.string().optional().describe("Banker name (needed for inbound deals). L0 entry only."),
      banker_source: z.string().optional().describe("Banker firm. L0 entry only."),
    }),
  },
);
