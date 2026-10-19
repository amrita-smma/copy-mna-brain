import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import { CompanyRepository } from "@/lib/repositories";
import { buildCompanyMentionsMarker } from "@/lib/navigation/companyMentions";
import {
  rungLabel,
  stageLadder,
  stageMoveRequiresApproval,
  stageNeighbors,
  type StageRung,
} from "@/lib/pipeline/stageMoves";
import { logger } from "../../logger";

/**
 * Where a company sits in the workspace's stage ladder (Pending Confirmation,
 * then the live pipeline stages in order) and which single move it can make
 * next. `move_stage` refuses a call whose `from_stage` doesn't match the
 * company's stage, so this lookup always runs first.
 */
export const lookupPipelineStage = tool(
  async ({ company_name }: { company_name: string }) => {
    logger.debug(`🔧 TOOL CALLED: lookup_pipeline_stage(company_name='${company_name}')`);

    const trimmedName = company_name?.trim() ?? "";
    if (trimmedName.length === 0) {
      return `**Error:** company_name is required.`;
    }

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const company = await new CompanyRepository(db, workspaceId).findByNameFuzzy(trimmedName);
      if (!company) {
        return `No company found matching "${trimmedName}". Use query_companies to confirm spelling.`;
      }

      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { pipelineStageService } = createContainer(db, workspaceId);
      const stages = await pipelineStageService.list();

      const current = company.pipeline_stage ?? null;
      const ladder = stageLadder(stages);
      const neighbors = stageNeighbors(stages, current);

      const lines: string[] = [
        `**${company.target}** — current stage: **${rungLabel(stages, current)}** (key \`${current ?? "none"}\`), status ${company.status ?? "active"}.`,
        "",
        "**Stage order** (a move goes one step at a time):",
        "",
        "| # | Stage | Key | |",
        "| --- | --- | --- | --- |",
      ];
      ladder.forEach((rung, i) => {
        const marker =
          rung.key === current
            ? "← current"
            : rung.key === neighbors.previous?.key
              ? "previous"
              : rung.key === neighbors.next?.key
                ? "next"
                : "";
        lines.push(`| ${i + 1} | ${rungLabel(stages, rung.key)} | ${rung.key} | ${marker} |`);
      });
      lines.push("");

      if (company.status === "dropped") {
        lines.push(
          `This company is **dropped** and read-only — it cannot be moved. Report that instead of calling move_stage.`,
        );
      } else if (neighbors.targets.length === 0) {
        lines.push(`There is no stage this company can move to from here.`);
      } else {
        const describe = (rung: StageRung) =>
          `${rungLabel(stages, rung.key)} (\`${rung.key}\`) — ${
            stageMoveRequiresApproval(current, rung.key)
              ? "requires human approval"
              : "moves without approval"
          }`;
        lines.push(`- Previous stage: ${neighbors.previous ? describe(neighbors.previous) : "none"}`);
        lines.push(`- Next stage: ${neighbors.next ? describe(neighbors.next) : "none"}`);
        const extra = neighbors.targets.filter(
          (r) => r.key !== neighbors.previous?.key && r.key !== neighbors.next?.key,
        );
        for (const rung of extra) lines.push(`- Also allowed: ${describe(rung)}`);
        lines.push(
          "",
          `To move it, call move_stage with company_name, from_stage: "${current ?? ""}" and to_stage set to one of: ${neighbors.targets
            .map((r) => `"${r.key}"`)
            .join(", ")}.`,
        );
      }

      const mentions = buildCompanyMentionsMarker(
        [company.target, company.project_name]
          .filter((name): name is string => !!name?.trim())
          .map((name) => ({ id: company.id, name })),
      );
      const out = lines.join("\n");
      return mentions ? `${out}\n${mentions}` : out;
    } catch (error) {
      logger.error(`lookup_pipeline_stage error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "lookup_pipeline_stage",
    description: `Look up which pipeline stage a company is in, the workspace's stage order, and the stages it can move to next. ALWAYS call this before move_stage.

The stage order is Pending Confirmation (key "unreviewed"), then the workspace's live pipeline stages in order (L0, L1, …; workspaces rename, reorder, add and delete stages, so never assume them). The result marks the company's current, previous and next stage, gives each stage's key, and says which moves need a human's approval.

Args:
    company_name: The company (fuzzy-matched against target and project name).`,
    schema: z.object({
      company_name: z.string().min(1).describe("Company target name or project name (fuzzy match)"),
    }),
  },
);
