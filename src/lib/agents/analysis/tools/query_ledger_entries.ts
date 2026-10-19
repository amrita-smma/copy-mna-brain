import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import type { FlPortfolioLedgerEntry } from "@/lib/services/flPortfolioService";
import {
  ENTRY_TYPE_KEYS,
  buildLedgerIndex,
  describeFromTo,
  entriesAsOf,
  entryTypeLabel,
  formatDateNumeric,
  formatMoneyAbs,
  toIsoDate,
  rollupPosition,
  sortEntriesNewestFirst,
  summarizeLedger,
  type FlEntryType,
  type LedgerIndex,
} from "@/lib/fundLedger";
import { toDecimalString } from "@/lib/services/flDecimal";
import { CURRENCY_SYMBOL } from "@/lib/currency";
import { logger } from "../../logger";
import { fuzzySearch, matchLabel } from "./fuzzySearch";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * A delta as a plain ASCII decimal — "-43780000.00".
 *
 * The page renders these with a Unicode minus and thousands separators, which
 * reads well but is awkward for a model that then has to add them up. The tool
 * emits the bare number instead; the prose around the table carries the
 * readable forms.
 */
const plainAmount = (value: string | null | undefined, scale = 2) => {
  try {
    return toDecimalString(String(value ?? "0"), scale);
  } catch {
    return (0).toFixed(scale);
  }
};

/**
 * A unit count at whatever precision it actually carries — fractional units
 * would be rounded away by the two-place money format.
 */
const plainQuantity = (value: string | null | undefined) => {
  const full = plainAmount(value, 8);
  const [whole, fraction = ""] = full.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
};

/** Everything an entity name could match against on a single row. */
function namesOnEntry(entry: FlPortfolioLedgerEntry, index: LedgerIndex): string[] {
  const position = index.positions.get(entry.position_id);
  const names = [
    position?.holder.name,
    position?.instrument.name,
    position?.fundingSource?.name,
  ];
  if (entry.counterparty_position_id) {
    names.push(index.positions.get(entry.counterparty_position_id)?.holder.name);
  }
  for (const allocation of entry.allocations ?? []) {
    names.push(index.fundingSources.get(allocation.funding_source_id)?.name);
  }
  return names.filter((name): name is string => !!name);
}

/**
 * Read the fund ledger — the posted rows themselves, rather than the roll-ups
 * the other investment tools report.
 *
 * Answers off the same shared model the Ledger page renders from, so a figure
 * quoted in chat matches the figure on screen. Read-only.
 */
export const queryLedgerEntries = tool(
  async ({
    entity,
    entry_type,
    from_date,
    as_of_date,
    position_id,
    needs_checking_only,
    limit,
  }: {
    entity?: string;
    entry_type?: string;
    from_date?: string;
    as_of_date?: string;
    position_id?: string;
    needs_checking_only?: boolean;
    limit?: number;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: query_ledger_entries(entity='${entity ?? ""}', entry_type='${entry_type ?? ""}', from='${from_date ?? ""}', as_of='${as_of_date ?? ""}')`,
    );

    try {
      const workspaceId = await getActiveWorkspaceId();
      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { flPortfolioService, workspaceService } = createContainer(createDb(), workspaceId);
      // The Ledger relabels every figure to the workspace display currency, so
      // a total quoted in chat has to carry the same symbol the page shows.
      const symbol = CURRENCY_SYMBOL[await workspaceService.getDefaultCurrency(workspaceId)];
      const money = (value: string | null | undefined) => formatMoneyAbs(value, symbol);
      // Fetched unfiltered so the as-of date can be applied by the shared model
      // rather than by the read model, which is what keeps balances counting
      // from inception while the listed range narrows independently.
      const portfolio = await flPortfolioService.getPortfolio(workspaceId);
      const index = buildLedgerIndex(portfolio);

      if (index.entries.length === 0) {
        return "No ledger entries have been posted in this workspace yet.";
      }

      // The as-of date bounds the balances; everything else narrows the listing.
      // Defaults to today, matching the page: a future-dated row is posted but
      // not yet counted, and the copilot must not report totals the Ledger
      // doesn't show.
      const asOf = as_of_date?.trim() || toIsoDate(new Date());
      const asOfSet = entriesAsOf(index, asOf);

      let listed = asOfSet;
      const appliedFilters: string[] = [];

      if (from_date?.trim()) {
        listed = listed.filter((entry) => entry.entry_date >= from_date.trim());
        appliedFilters.push(`from ${from_date.trim()}`);
      }

      if (entry_type?.trim()) {
        const wanted = entry_type.trim().toLowerCase().replace(/[\s-]+/g, "_");
        if (!ENTRY_TYPE_KEYS.includes(wanted as FlEntryType)) {
          return `Unknown entry_type "${entry_type}". Valid types: ${ENTRY_TYPE_KEYS.join(", ")}.`;
        }
        listed = listed.filter((entry) => entry.entry_type === wanted);
        appliedFilters.push(`type ${wanted}`);
      }

      if (position_id?.trim()) {
        listed = listed.filter((entry) => entry.position_id === position_id.trim());
        appliedFilters.push(`position ${position_id.trim()}`);
      }

      if (needs_checking_only) {
        listed = listed.filter((entry) => entry.data_status === "needs_verification");
        appliedFilters.push("needs checking only");
      }

      let matchNote = "";
      if (entity?.trim()) {
        // Resolve the name once against every entity the ledger knows, then keep
        // the rows that touch the winner — matching each row separately would
        // let a weak hit on one row outrank a strong hit on another.
        const hits = fuzzySearch(
          entity.trim(),
          index.searchEntities,
          (candidate) => [candidate.name],
          { limit: 1 },
        );
        if (hits.length === 0) {
          return `Nothing in the ledger matches "${entity}". Try search_investments to find out whether it is a holding, a fund, an investor or a source of capital.`;
        }
        const matched = hits[0];
        listed = listed.filter((entry) =>
          namesOnEntry(entry, index).includes(matched.item.name),
        );
        matchNote = `Matched "${entity}" to **${matched.item.name}** (${matched.item.group.toLowerCase()}, ${matchLabel(matched.score)} match).`;
        appliedFilters.push(`involves ${matched.item.name}`);
      }

      const summary = summarizeLedger(asOfSet, listed);
      const cap = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const ordered = sortEntriesNewestFirst(listed);
      const shown = ordered.slice(0, cap);

      const lines: string[] = [];
      if (matchNote) lines.push(matchNote, "");

      lines.push(
        `**${listed.length} ledger ${listed.length === 1 ? "entry" : "entries"}**` +
          (appliedFilters.length ? ` · ${appliedFilters.join(" · ")}` : " · everything posted") +
          ` · as of ${asOf}`,
        "",
        `Cash out ${money(summary.cashOut)} across ${summary.cashOutRows} rows · cash in ${money(summary.cashIn)} across ${summary.cashInRows} rows.`,
        `Commitment ${money(summary.commitment)} · paid-in ${money(summary.paidIn)} · undrawn ${money(summary.undrawn)} (counted from inception to the as-of date, not narrowed by the filters above).`,
      );
      if (summary.needsChecking > 0) {
        lines.push(
          `${summary.needsChecking} of these rows still need checking — exclude or footnote them in any report.`,
        );
      }
      lines.push("");

      if (shown.length === 0) {
        lines.push("No rows match those filters.");
        return lines.join("\n");
      }

      lines.push(
        "| Date | From | To | Type | Sub-type | Commitment Δ | Quantity Δ | Cash Δ | Status |",
        "|---|---|---|---|---|---:|---:|---:|---|",
      );
      for (const entry of shown) {
        const flow = describeFromTo(entry, index);
        const status = [
          entry.data_status === "needs_verification" ? "needs checking" : "verified",
          entry.is_reversal ? "reversal" : null,
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `| ${formatDateNumeric(entry.entry_date)} | ${flow.from.name} | ${flow.to.name} | ${entryTypeLabel(entry.entry_type)} | ${entry.sub_type ?? "-"} | ${plainAmount(entry.commitment_delta)} | ${plainQuantity(entry.quantity_delta)} | ${plainAmount(entry.cash_delta)} | ${status} |`,
        );
      }

      if (ordered.length > shown.length) {
        lines.push(
          "",
          `Showing the ${shown.length} most recent of ${ordered.length} matching rows — narrow the dates or raise \`limit\` for more.`,
        );
      }

      // A single position was asked for, so report what it is actually worth.
      if (position_id?.trim()) {
        const rollup = rollupPosition(position_id.trim(), asOfSet);
        const position = index.positions.get(position_id.trim());
        lines.push(
          "",
          `**Position ${position ? `${position.holder.name} · ${position.instrument.name}` : position_id.trim()}** as of ${asOf}:`,
          `- Commitment ${money(rollup.commitment)}, undrawn ${money(rollup.undrawn)}`,
          `- Invested ${money(rollup.invested)} · net cash ${plainAmount(rollup.netCash)}`,
          `- Units held ${plainQuantity(rollup.units)}${rollup.blendedPrice ? ` at a blended ${plainAmount(rollup.blendedPrice, 4)} per unit` : " (no acquisitions, so no blended price)"}`,
        );
      }

      lines.push(
        "",
        "Every sign is read from the position holder: negative cash means they paid, positive means they received.",
      );

      return lines.join("\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      logger.error(`query_ledger_entries failed: ${message}`);
      return `Failed to read the ledger: ${message}`;
    }
  },
  {
    name: "query_ledger_entries",
    description: `Read the fund ledger row by row — every posted movement (commitments, capital calls, buys, sells, distributions, redemptions, transfers, income, expenses, adjustments) against the position that holds it.

Use this when the question is about *movements* rather than roll-ups: "what did we pay into Fund II this year?", "show every distribution from Startech", "which rows still need checking?", "what happened on the Akulaku position?". For headline performance (MOIC, DPI, IRR, FMV) use query_fund_assets / query_funds / get_fund_asset_details instead.

Every sign is read from the position **holder**: an investor's capital call is negative cash for them, and the fund's side of the same movement is the same number with the sign flipped. Distributions, redemptions, sells and income are all positive cash to the holder.

Two dates, doing different things. \`as_of_date\` bounds everything — balances, commitment and undrawn all count from inception up to it. \`from_date\` only narrows which rows are listed and which cash flows are totalled, so the commitment figures keep counting past it.

Args:
    entity: Optional name of an investor, fund, asset or source of fund. Matched fuzzily (case, punctuation, legal suffixes, partial words and typos are tolerated), then every row touching it — either side of the movement, the far leg of a transfer, or a funding split — is returned.
    entry_type: Optional entry type: ${ENTRY_TYPE_KEYS.join(", ")}.
    from_date: Optional ISO date (YYYY-MM-DD). Only rows on or after it are listed.
    as_of_date: Optional ISO date (YYYY-MM-DD). Nothing after it is counted at all; defaults to today.
    position_id: Optional position UUID. Also returns that position's balances — commitment, undrawn, invested, units and blended price.
    needs_checking_only: Set true to see only rows imported from a source that disagreed with itself.
    limit: Max rows in the table (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Totals always cover every matching row, not just the listed ones.

Returns:
    A markdown summary plus a table, one row per ledger entry.`,
    schema: z.object({
      entity: z
        .string()
        .optional()
        .describe(
          "Optional investor, fund, asset or source-of-fund name (fuzzy matched) whose rows to return",
        ),
      entry_type: z
        .string()
        .optional()
        .describe(`Optional entry type: ${ENTRY_TYPE_KEYS.join(", ")}`),
      from_date: z
        .string()
        .optional()
        .describe("Optional ISO start date (YYYY-MM-DD) for the rows listed"),
      as_of_date: z
        .string()
        .optional()
        .describe(
          "Optional ISO as-of date (YYYY-MM-DD); balances count from inception up to it",
        ),
      position_id: z
        .string()
        .optional()
        .describe("Optional position UUID to scope to, with that position's balances"),
      needs_checking_only: z
        .boolean()
        .optional()
        .describe("Only return rows flagged as needing verification"),
      limit: z
        .number()
        .optional()
        .describe(`Max rows to list (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
    }),
  },
);
