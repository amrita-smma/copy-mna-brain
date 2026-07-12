import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import {
  RELATION_TYPES,
  type RelationType,
} from "@/lib/repositories/companyRelationRepository";

/** Max edges per generate_relationship_graph call — must stay in sync with that tool. */
const GRAPH_BATCH_SIZE = 100;

/**
 * Normalize the counterparty list into a clean string[].
 *
 * Models are unreliable at emitting a long JSON array (hundreds of quoted,
 * comma-separated strings), which is what caused the recurring "empty" calls.
 * So we ALSO accept the raw list the model already has in context as a single
 * delimited string — the same shape the user pastes (e.g. "Aaron Co., Ltd.;
 * ABC Technology; Aegis; …"). We split ONLY on newlines and semicolons, never
 * on commas, because company names routinely contain commas ("Aaron Co.,
 * Ltd.", "Transene Company INC."). Whitespace-only entries are dropped, and
 * duplicates are removed while preserving first-seen order.
 */
function normalizeCounterparties(
  input: string[] | string | undefined,
): string[] {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : input.split(/\r?\n|;/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Format a self-contained instruction for the AI Workforce.
 *
 * The Workforce agent receives ONLY the instruction string as its first
 * HumanMessage. It has no access to the CoPilot chat history, uploaded
 * files, or any other conversation context. This tool converts the structured
 * context the chat agent already holds (company IDs, full counterparty lists,
 * relation direction) into an explicit, unambiguous instruction so the
 * Workforce can execute without inference or guesswork.
 *
 * For bulk relationship graph additions the emitted instruction names:
 *   - the hub company's exact name AND company_id
 *   - the exact relation_type and edge direction (who is source, who is target)
 *   - every counterparty name verbatim
 *   - which generate_relationship_graph args to use
 *   - how many batches are needed (tool cap = GRAPH_BATCH_SIZE per call)
 */
export const formatWorkforceInstruction = tool(
  async ({
    action_type,
    hub_company_name,
    hub_company_id,
    hub_company_project_name,
    counterparty_names,
    relation_type,
    relation_direction,
    source_reference,
    edge_notes,
    raw_intent,
    context_pairs,
  }: {
    action_type: "bulk_relationship_graph" | "generic";
    hub_company_name?: string;
    hub_company_id?: string;
    hub_company_project_name?: string;
    counterparty_names?: string[] | string;
    relation_type?: RelationType;
    relation_direction?: "hub_to_counterparty" | "counterparty_to_hub";
    source_reference?: string;
    edge_notes?: string;
    raw_intent?: string;
    context_pairs?: Array<{ label: string; value: string }>;
  }) => {
    const rawCount = Array.isArray(counterparty_names)
      ? counterparty_names.length
      : typeof counterparty_names === "string"
        ? counterparty_names.split(/\r?\n|;/).filter(Boolean).length
        : 0;
    logger.debug(
      `🔧 TOOL CALLED: format_workforce_instruction(` +
        `action_type='${action_type}', ` +
        `hub='${hub_company_name ?? ""}', ` +
        `hub_id='${hub_company_id ?? ""}', ` +
        `project='${hub_company_project_name ?? ""}', ` +
        `counterparty_count=${rawCount}, ` +
        `relation_type='${relation_type ?? ""}', ` +
        `relation_direction='${relation_direction ?? ""}', ` +
        `source_reference='${source_reference ?? ""}', ` +
        `edge_notes='${edge_notes ?? ""}', ` +
        `raw_intent='${raw_intent ? raw_intent.slice(0, 80) : ""}', ` +
        `context_pairs_count=${context_pairs?.length ?? 0})`,
    );

    if (action_type === "bulk_relationship_graph") {
      const counterparties = normalizeCounterparties(counterparty_names);

      if (!hub_company_name) {
        return `**Error:** hub_company_name is required for action_type='bulk_relationship_graph'.`;
      }
      if (counterparties.length === 0) {
        return (
          `**Error:** no counterparty names were provided. Populate \`counterparty_names\` with the COMPLETE list — ` +
          `you can pass it either as a JSON array (["Aaron Co., Ltd.", "ABC Technology", …]) OR, easier for long lists, ` +
          `as ONE string with names separated by semicolons or newlines (e.g. "Aaron Co., Ltd.; ABC Technology; Aegis; …"). ` +
          `Do NOT use commas as separators — many names contain commas (e.g. "Aaron Co., Ltd."). ` +
          `Copy every name from the source verbatim; do not summarise or truncate.`
        );
      }
      if (!relation_type) {
        return `**Error:** relation_type is required for action_type='bulk_relationship_graph'.`;
      }
      if (!relation_direction) {
        return `**Error:** relation_direction is required for action_type='bulk_relationship_graph'.`;
      }

      // The hub is the one company that usually already exists; include its
      // company_id when we have it so the Workforce pins the exact row. The
      // counterparties, by contrast, are name-only — most are not in the
      // database yet (see the note emitted below).
      const hubQualifiers = [
        hub_company_project_name,
        hub_company_id ? `company_id: ${hub_company_id}` : null,
      ].filter(Boolean);
      const hubLabel = hubQualifiers.length
        ? `${hub_company_name} (${hubQualifiers.join(", ")})`
        : hub_company_name;

      const isHubSource = relation_direction === "hub_to_counterparty";
      const directionLine = isHubSource
        ? `${hub_company_name} --[${relation_type}]--> <counterparty>  (${hub_company_name} is source_company; each counterparty is target_company)`
        : `<counterparty> --[${relation_type}]--> ${hub_company_name}  (each counterparty is source_company; ${hub_company_name} is target_company)`;

      const hubArgName = isHubSource ? "source_company" : "target_company";
      const counterpartyArgName = isHubSource
        ? "target_company"
        : "source_company";

      const batchCount = Math.ceil(counterparties.length / GRAPH_BATCH_SIZE);
      const batchNote =
        batchCount > 1
          ? `generate_relationship_graph accepts up to ${GRAPH_BATCH_SIZE} edges per call — split into ${batchCount} batches.`
          : `All ${counterparties.length} edges fit in a single generate_relationship_graph call.`;

      const lines: string[] = [
        `Add ${counterparties.length} directed relationship graph edges for ${hubLabel}.`,
      ];
      if (source_reference) lines.push(`Source: ${source_reference}.`);
      lines.push("");
      lines.push(`Edge direction for every edge:`);
      lines.push(`  ${directionLine}`);
      lines.push("");
      lines.push(`Call generate_relationship_graph with:`);
      lines.push(
        `  - ${hubArgName} = "${hub_company_name}"  ← constant across all edges`,
      );
      lines.push(`  - ${counterpartyArgName} = <counterparty name>`);
      lines.push(`  - relation_type = "${relation_type}"`);
      if (edge_notes) lines.push(`  - notes = "${edge_notes}"`);
      lines.push(`  - ${batchNote}`);
      lines.push("");
      lines.push(
        `IMPORTANT: the counterparties below are provided as NAMES ONLY. Most are NOT yet in the database. Do NOT look each one up first, and do NOT pre-create them with add_company — generate_relationship_graph automatically creates any company it cannot match at the "discovered" stage. Pass the names straight through as edges and let the tool create them.`,
      );
      lines.push("");
      lines.push(`Counterparties (${counterparties.length} total):`);
      lines.push(counterparties.join("; "));

      return lines.join("\n");
    }

    // generic
    if (!raw_intent) {
      return `**Error:** raw_intent is required for action_type='generic'.`;
    }

    const contextBlock =
      context_pairs && context_pairs.length > 0
        ? "\n\nContext:\n" +
          context_pairs.map((p) => `  - ${p.label}: ${p.value}`).join("\n")
        : "";

    return `${raw_intent.trim()}${contextBlock}`;
  },
  {
    name: "format_workforce_instruction",
    description: `Produce a fully self-contained instruction string for the AI Workforce.

The Workforce agent receives ONLY the instruction string — it has NO access to the CoPilot chat history, uploaded files, or any other context from this conversation. Call this tool BEFORE propose_workforce_handoff whenever the action involves:
- A specific company ID or UUID that must be named explicitly.
- A list of items from this chat or an uploaded file that the Workforce cannot retrieve on its own (e.g. 50+ counterparty names from a pasted register).
- Any context that lives only in the conversation and would require guesswork without it.

The return value is a ready-to-use instruction string — pass it verbatim as the instruction arg to propose_workforce_handoff.

## action_type = "bulk_relationship_graph"

For adding many directed edges to the relationship graph. The emitted instruction specifies:
- The hub company's exact name (and company_id if you have one).
- The relation_type and exact edge direction (which side is source_company, which is target_company).
- Every counterparty name verbatim.
- Which generate_relationship_graph args to use, and how many batches are needed.

The counterparties are passed as NAMES ONLY — you do NOT need to look them up or create them first. Most will not exist in the database yet; generate_relationship_graph auto-creates any unknown company at the "discovered" stage. The emitted instruction states this explicitly so the Workforce does not waste steps pre-creating them.

Passing the counterparty list: for long lists, pass \`counterparty_names\` as a SINGLE string with names separated by semicolons or newlines — this is much more reliable than emitting a huge JSON array and avoids dropped/empty calls. (A JSON array is also accepted.) Commas are never separators, so names like "Aaron Co., Ltd." stay intact. Blank entries and duplicates are cleaned up automatically.

relation_direction:
  "hub_to_counterparty" → hub --[type]--> each counterparty (hub is the seller / investor / source).
    Use when hub company is providing the relationship: e.g. Hosan sells to customers, Firm A invested in Company B.
  "counterparty_to_hub" → each counterparty --[type]--> hub (hub is the buyer / investee / target).
    Use when counterparties are providing the relationship: e.g. suppliers sell to Hosan.

## action_type = "generic"

For any other write action. Appends key-value context_pairs to raw_intent so no implicit knowledge is required.`,
    schema: z.object({
      action_type: z
        .enum(["bulk_relationship_graph", "generic"])
        .describe(
          '"bulk_relationship_graph" for adding directed graph edges in bulk. "generic" for any other write action.',
        ),

      // ── bulk_relationship_graph fields ────────────────────────────────────
      hub_company_name: z
        .string()
        .optional()
        .describe(
          "bulk_relationship_graph: exact display name of the hub (central) company.",
        ),
      hub_company_id: z
        .string()
        .optional()
        .describe(
          "bulk_relationship_graph: UUID of the hub company if you already have it (from get_company_details or the current context). Optional — include it to pin the exact row, but the hub is also matched by name if omitted.",
        ),
      hub_company_project_name: z
        .string()
        .optional()
        .describe(
          'bulk_relationship_graph: project codename if applicable (e.g. "Project Hercules").',
        ),
      counterparty_names: z
        .union([z.array(z.string()), z.string()])
        .optional()
        .describe(
          'bulk_relationship_graph: the COMPLETE list of counterparty company names, verbatim. For long lists PREFER passing a single string with names separated by SEMICOLONS or newlines (e.g. "Aaron Co., Ltd.; ABC Technology; Aegis; …") — this is far more reliable than a large JSON array. A JSON array of strings is also accepted. Never use commas as separators (names like "Aaron Co., Ltd." contain commas). Include EVERY name; do NOT summarise or truncate.',
        ),
      relation_type: z
        .enum(RELATION_TYPES as unknown as [RelationType, ...RelationType[]])
        .optional()
        .describe(
          'bulk_relationship_graph: the directed relationship type for every edge. Prefer "SELLS_TO" for supply/customer relationships.',
        ),
      relation_direction: z
        .enum(["hub_to_counterparty", "counterparty_to_hub"])
        .optional()
        .describe(
          '"hub_to_counterparty": hub --[type]--> each counterparty (hub is source_company). "counterparty_to_hub": each counterparty --[type]--> hub (hub is target_company).',
        ),
      source_reference: z
        .string()
        .optional()
        .describe(
          'The document, register, or source this data comes from (e.g. "Hercules — Direct Customers register (v2)").',
        ),
      edge_notes: z
        .string()
        .optional()
        .describe("Optional notes to attach to every edge in the batch."),

      // ── generic fields ────────────────────────────────────────────────────
      raw_intent: z
        .string()
        .optional()
        .describe("generic: complete imperative for the Workforce to execute."),
      context_pairs: z
        .array(z.object({ label: z.string(), value: z.string() }))
        .optional()
        .describe(
          "generic: key-value pairs of context the Workforce needs that are not obvious from raw_intent (e.g. company IDs, specific dates, resolved names).",
        ),
    }),
  },
);
