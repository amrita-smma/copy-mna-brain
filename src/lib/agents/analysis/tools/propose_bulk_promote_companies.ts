import { randomUUID } from "node:crypto";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyRepository } from "@/lib/repositories";

/**
 * Marker the chat UI ([ChatMessageBubble]) scans for to detect a bulk-promote
 * approval card in this tool's output and render the card. Keep in sync with
 * the client-side parser.
 */
export const BULK_PROMOTE_APPROVAL_MARKER = "BULK_PROMOTE_APPROVAL_JSON";

export type SignalStatus = "pass" | "fail" | "warn";

export interface BulkPromoteSignal {
  label: string;
  value: string;
  status?: SignalStatus;
}

export interface BulkPromoteCandidate {
  id: string;
  name: string;
  current_stage: string | null;
  tags?: string[];
  reason: string;
  signals?: BulkPromoteSignal[];
  meta?: string;
}

export interface BulkPromoteApprovalPayload {
  approval_id: string;
  title: string;
  description: string;
  target_stage: string;
  candidates: BulkPromoteCandidate[];
}

interface CandidateInput {
  company_name: string;
  tags?: string[];
  reason: string;
  signals?: Array<{ label: string; value: string; status?: SignalStatus }>;
  meta?: string;
}

export const proposeBulkPromoteCompanies = tool(
  async ({
    title,
    description,
    target_stage,
    candidates,
  }: {
    title: string;
    description: string;
    target_stage: string;
    candidates: CandidateInput[];
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: propose_bulk_promote_companies(${candidates.length} → ${target_stage})`,
    );

    const db = createDb();
    const companyRepo = new CompanyRepository(db, await getActiveWorkspaceId());

    const resolved: BulkPromoteCandidate[] = [];
    const unresolved: string[] = [];
    const alreadyDropped: string[] = [];
    const alreadyAtOrPast: string[] = [];

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
      // Refuse to "promote" companies already at the target stage (no-op) — the
      // user would otherwise see a redundant row with no actual movement.
      if (company.pipeline_stage === target_stage) {
        alreadyAtOrPast.push(company.target ?? name);
        continue;
      }
      const tags = (cand.tags ?? [])
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const signals = (cand.signals ?? [])
        .map((s) => ({
          label: s.label.trim(),
          value: s.value.trim(),
          status: s.status,
        }))
        .filter((s) => s.label.length > 0 && s.value.length > 0);
      resolved.push({
        id: company.id,
        name: company.target ?? name,
        current_stage: company.pipeline_stage ?? null,
        tags: tags.length > 0 ? tags : undefined,
        reason: cand.reason.trim(),
        signals: signals.length > 0 ? signals : undefined,
        meta: cand.meta?.trim() || undefined,
      });
    }

    if (resolved.length === 0) {
      const parts = [
        `Cannot render the bulk-promote card to ${target_stage}: no eligible candidates resolved.`,
      ];
      if (unresolved.length > 0) {
        parts.push(`Unmatched in pipeline: ${unresolved.join(", ")}.`);
      }
      if (alreadyDropped.length > 0) {
        parts.push(`Already dropped: ${alreadyDropped.join(", ")}.`);
      }
      if (alreadyAtOrPast.length > 0) {
        parts.push(`Already at ${target_stage}: ${alreadyAtOrPast.join(", ")}.`);
      }
      parts.push("Tell the user directly instead of retrying.");
      return parts.join(" ");
    }

    const payload: BulkPromoteApprovalPayload = {
      approval_id: randomUUID(),
      title: title.trim(),
      description: description.trim(),
      target_stage: target_stage.trim(),
      candidates: resolved,
    };

    const lines = [
      `Bulk promote proposal: **${payload.title}**`,
      ``,
      payload.description,
      ``,
      `Candidates (${resolved.length} → ${target_stage}):`,
      ...resolved.map(
        (c) => `- ${c.name}${c.current_stage ? ` (${c.current_stage})` : ""}: ${c.reason}`,
      ),
    ];
    if (alreadyAtOrPast.length > 0) {
      lines.push(``, `Skipped (already at ${target_stage}): ${alreadyAtOrPast.join(", ")}.`);
    }
    if (alreadyDropped.length > 0) {
      lines.push(``, `Skipped (already dropped): ${alreadyDropped.join(", ")}.`);
    }
    if (unresolved.length > 0) {
      lines.push(``, `Skipped (unmatched): ${unresolved.join(", ")}.`);
    }
    lines.push(``, `<!-- ${BULK_PROMOTE_APPROVAL_MARKER}:${JSON.stringify(payload)} -->`);
    return lines.join("\n");
  },
  {
    name: "propose_bulk_promote_companies",
    description: `Propose promoting a batch of companies from their current pipeline stage to the next stage (typically L0 → L1) via an approval card.

Use this tool when the user asks to bulk promote, advance, move up, or run a promotion review on multiple candidates (e.g. "run the weekly L1 promotion check", "who's ready for L1?", "promote the companies that pass L1 criteria"). For a single named promotion, prefer propose_workforce_handoff instead — this tool is for batch reviews.

Calling this tool does NOT promote anything itself. It renders an approval card with a checkbox per candidate; the user can uncheck any they want to hold, then confirms via "Promote N to <stage>" (which POSTs to /api/companies/promote-bulk) or backs out via "Hold all". After calling it, write ONE short sentence framing the proposal and then STOP.

The tool fuzzy-matches each \`company_name\` against \`target\` and \`project_name\`. Unmatched, already-dropped, and already-at-target candidates are silently filtered. If zero candidates resolve, the tool returns a refusal string — surface that to the user and do not retry.

Args:
    title: Card headline (e.g. "Promote 3 candidates from L0 → L1?").
    description: One short paragraph framing what the promotion does (e.g. "Moves them onto your L1 worklist, notifies sponsors, queues L1 memo drafts").
    target_stage: The destination stage, e.g. "L1". Used in the action label and log entries.
    candidates: One entry per company. Each carries:
      - company_name: target or project name (fuzzy-matched).
      - tags: optional array of short labels rendered as pills (e.g. ["Passes L1"], ["Passes L1", "Strategic fit"]). Keep each under ~20 chars. **Tag ordering matters visually**: the FIRST tag is rendered as the primary green "Passes L1" pill — put the qualifying-criteria label there. Subsequent tags are rendered in neutral purple for additional context like "Strategic fit", "Adjacent thesis", "Sponsor pick".
      - reason: REQUIRED. One sentence explaining why this company is ready — cite the killer signal (financial fit, ownership clean, banker outreach). User reads this verbatim.
      - signals: optional array of {label, value, status?} key/value chips rendered inline (e.g. {label:"Revenue", value:"$112M", status:"pass"}). Status colors: pass=green, fail=red, warn=amber. Use for at-a-glance L1 threshold checks.
      - meta: optional secondary line (e.g. "L0 since Feb 12 · Sponsor: Sarah Chen · Sector: Specialty materials").`,
    schema: z.object({
      title: z.string().describe("Card headline"),
      description: z
        .string()
        .describe(
          "One short paragraph framing the bulk promotion",
        ),
      target_stage: z
        .string()
        .min(1)
        .describe("Destination pipeline stage (e.g. 'L1')"),
      candidates: z
        .array(
          z.object({
            company_name: z
              .string()
              .describe("Target or project name; fuzzy-matched against both"),
            tags: z
              .array(z.string())
              .optional()
              .describe(
                "Optional array of short pill labels (e.g. ['Passes L1', 'Strategic fit'])",
              ),
            reason: z
              .string()
              .describe(
                "One-sentence rationale citing the killer signal for promotion",
              ),
            signals: z
              .array(
                z.object({
                  label: z.string().describe("Signal name (e.g. 'Revenue')"),
                  value: z.string().describe("Signal value (e.g. '$112M')"),
                  status: z
                    .enum(["pass", "fail", "warn"])
                    .optional()
                    .describe(
                      "Color hint: pass=green, fail=red, warn=amber. Omit for neutral.",
                    ),
                }),
              )
              .optional()
              .describe(
                "Optional inline key/value signals (revenue, EBITDA, CAGR, ownership, etc.)",
              ),
            meta: z
              .string()
              .optional()
              .describe(
                "Optional secondary line (e.g. 'L0 since Feb 12 · Sponsor: Sarah Chen')",
              ),
          }),
        )
        .min(1)
        .describe("Companies to promote; pass at least one"),
    }),
  },
);
