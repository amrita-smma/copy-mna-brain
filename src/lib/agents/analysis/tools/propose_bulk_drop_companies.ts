import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyRepository } from "@/lib/repositories";

/**
 * Marker the chat UI ([ChatMessageBubble]) scans for to detect a bulk-drop
 * approval card in this tool's output and render the card. Keep in sync with
 * the client-side parser.
 */
export const BULK_DROP_APPROVAL_MARKER = "BULK_DROP_APPROVAL_JSON";

export interface BulkDropCandidate {
  id: string;
  name: string;
  current_stage: string | null;
  tag?: string;
  reason: string;
  meta?: string;
}

export interface BulkDropApprovalPayload {
  approval_id: string;
  title: string;
  description: string;
  candidates: BulkDropCandidate[];
}

interface CandidateInput {
  company_name: string;
  tag?: string;
  reason: string;
  meta?: string;
}

export const proposeBulkDropCompanies = tool(
  async ({
    title,
    description,
    candidates,
  }: {
    title: string;
    description: string;
    candidates: CandidateInput[];
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: propose_bulk_drop_companies(${candidates.length} candidates)`,
    );

    const db = createDb();
    const companyRepo = new CompanyRepository(db);

    const resolved: BulkDropCandidate[] = [];
    const unresolved: string[] = [];
    const alreadyDropped: string[] = [];

    for (const cand of candidates) {
      const name = cand.company_name?.trim();
      if (!name) continue;
      const company = await companyRepo.findByNameFuzzy(name);
      if (!company) {
        unresolved.push(name);
        continue;
      }
      if (company.status === "dropped") {
        alreadyDropped.push(company.target ?? name);
        continue;
      }
      resolved.push({
        id: company.id,
        name: company.target ?? name,
        current_stage: company.pipeline_stage ?? null,
        tag: cand.tag?.trim() || undefined,
        reason: cand.reason.trim(),
        meta: cand.meta?.trim() || undefined,
      });
    }

    if (resolved.length === 0) {
      const parts = ["Cannot render the bulk-drop card: no live candidates resolved."];
      if (unresolved.length > 0) {
        parts.push(`Unmatched in pipeline: ${unresolved.join(", ")}.`);
      }
      if (alreadyDropped.length > 0) {
        parts.push(`Already dropped: ${alreadyDropped.join(", ")}.`);
      }
      parts.push("Tell the user directly instead of retrying.");
      return parts.join(" ");
    }

    const payload: BulkDropApprovalPayload = {
      approval_id: randomUUID(),
      title: title.trim(),
      description: description.trim(),
      candidates: resolved,
    };

    const lines = [
      `Bulk drop proposal: **${payload.title}**`,
      ``,
      payload.description,
      ``,
      `Candidates (${resolved.length}):`,
      ...resolved.map((c) => `- ${c.name}${c.tag ? ` — ${c.tag}` : ""}: ${c.reason}`),
    ];
    if (alreadyDropped.length > 0) {
      lines.push(``, `Skipped (already dropped): ${alreadyDropped.join(", ")}.`);
    }
    if (unresolved.length > 0) {
      lines.push(``, `Skipped (unmatched): ${unresolved.join(", ")}.`);
    }
    lines.push(``, `<!-- ${BULK_DROP_APPROVAL_MARKER}:${JSON.stringify(payload)} -->`);
    return lines.join("\n");
  },
  {
    name: "propose_bulk_drop_companies",
    description: `Propose dropping a batch of companies from the pipeline via an approval card.

Use this tool when the user asks to clean up, prune, drop, or remove multiple stale/failed candidates at once (e.g. "run Q2 cleanup on L0", "who's stale in my pipeline?", "drop the companies that no longer meet criteria"). For dropping a single specific company, just propose it in chat — this tool is for batch reviews.

Calling this tool does NOT drop anything itself. It renders an approval card with a checkbox per candidate; the user can uncheck any they want to keep, then confirms via "Drop N companies" (which POSTs to /api/companies/drop-bulk) or backs out via "Keep all". After calling it, write ONE short sentence framing the proposal and then STOP — do not produce more output in the same turn.

The tool fuzzy-matches each \`company_name\` against \`target\` and \`project_name\` in the pipeline. Unmatched and already-dropped names are silently filtered. If zero candidates resolve, the tool returns a refusal string instead of the card — surface that to the user and do not retry.

Args:
    title: Card headline (e.g. "Drop 4 stale L0 candidates?").
    description: One short paragraph framing what the drop does and any reversibility caveat.
    candidates: One entry per company. Each carries:
      - company_name: target or project name (fuzzy-matched).
      - tag: optional short label rendered as a pill (e.g. "Fails L0", "Stale · 7mo", "Out of mandate"). Keep under ~20 chars.
      - reason: REQUIRED. One sentence explaining why this company should be dropped — cite the specific signal (financial threshold, staleness window, comp loss, mandate mismatch). User reads this verbatim.
      - meta: optional secondary line (e.g. "L0 since Feb 12 · Sponsor: Sarah Chen · Sector: Specialty chemicals").`,
    schema: z.object({
      title: z.string().describe("Card headline"),
      description: z
        .string()
        .describe(
          "One short paragraph framing the bulk drop and any reversibility caveat",
        ),
      candidates: z
        .array(
          z.object({
            company_name: z
              .string()
              .describe("Target or project name; fuzzy-matched against both"),
            tag: z
              .string()
              .optional()
              .describe(
                "Optional short label (e.g. 'Fails L0', 'Stale · 7mo'). ~20 char max.",
              ),
            reason: z
              .string()
              .describe("One-sentence drop reason citing the specific signal"),
            meta: z
              .string()
              .optional()
              .describe(
                "Optional secondary line (e.g. 'L0 since Feb 12 · Sponsor: Sarah Chen')",
              ),
          }),
        )
        .min(1)
        .describe("Companies to propose dropping; pass at least one"),
    }),
  },
);
