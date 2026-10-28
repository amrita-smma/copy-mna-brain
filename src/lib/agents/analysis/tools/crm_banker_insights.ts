import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createContainer } from "@/lib/services/container";
import { isoDay, NO_INTERACTION_DATA } from "@/lib/crm/displayText";
import type { BankerListResult, BankerRow } from "@/lib/services/bankerListService";
import type { ContactInsights } from "@/lib/services/contactInsightsService";
import type { ContactConversation } from "@/lib/services/contactConversationService";
import { runtimeViewer, type RuntimeViewer } from "../../runtimeViewer";

const DEFAULT_LIMIT = 10;
export const MAX_RANKING_LIMIT = 25;
/** Candidates shown when a name matches more than one person. */
const DISAMBIGUATION_SIZE = 10;
const RELATED_COMPANIES_SHOWN = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const BANKER_RANKING_METRICS = [
  "deals_brought",
  "reached_l1",
  "recent_activity",
  "team_members",
  "emails",
] as const;
type RankingMetric = (typeof BANKER_RANKING_METRICS)[number];

/** Ranking metric → the banker list sort that implements it. */
const SORT_FOR_METRIC: Record<RankingMetric, string> = {
  deals_brought: "deals_brought",
  reached_l1: "reached_l1",
  recent_activity: "recent",
  team_members: "team_members",
  emails: "emails",
};

const METRIC_LABELS: Record<RankingMetric, string> = {
  deals_brought: "deals brought",
  reached_l1: "deals brought that reached L1",
  recent_activity: "most recent contact",
  team_members: "number of our team members in touch",
  emails: "emails exchanged",
};

const DEAL_METRICS = new Set<RankingMetric>(["deals_brought", "reached_l1"]);

type Container = ReturnType<typeof createContainer>;

interface BankerInsightsArgs {
  mode: "contact" | "ranking";
  contact?: string;
  metric?: RankingMetric;
  limit?: number;
  active_within_days?: number;
}

function pct(ratio: number | null): string {
  return ratio === null ? "n/a, nothing brought" : `${Math.round(ratio * 100)}%`;
}

function sameText(a: string | null | undefined, b: string): boolean {
  return !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Contact mode
// ---------------------------------------------------------------------------

function renderInteractions(insights: ContactInsights): string[] {
  const s = insights.interactions;
  const lines = ["### Interactions with our team"];
  if (!s.hasSyncedData) {
    lines.push(`- ${NO_INTERACTION_DATA}. Say you don't know who on our team has talked to this person.`);
    return lines;
  }
  if (s.team.length === 0) {
    lines.push("- No email between this person and anyone on our team is on record.");
    return lines;
  }
  lines.push(
    `- Last contact: ${isoDay(s.lastContactAt) ?? "none recorded"}`,
    `- Totals (distinct): ${s.totalEmailsFromUs} email(s) from us, ${s.totalEmailsFromThem} email(s) from them`,
    `- Team members in touch: ${s.teamMemberCount}`,
    "",
    "| Team member | Emails from us | Emails from them | Last email |",
    "|---|---|---|---|",
  );
  for (const t of s.team) {
    const who = t.name && t.email ? `${t.name} (${t.email})` : (t.name ?? t.email ?? t.userId);
    lines.push(
      `| ${who} | ${t.emailsFromUs} | ${t.emailsFromThem} | ${isoDay(t.lastEmailAt) ?? "—"} |`,
    );
  }
  return lines;
}

function renderDeals(insights: ContactInsights): string[] {
  const { scorecard, deals } = insights;
  const lines = ["### Brain deals"];
  if (!scorecard.hasDealLinks && deals.length === 0) {
    lines.push(
      "- No deal links recorded for this person — deals brought / involved are unknown, not zero.",
    );
  } else {
    lines.push(
      `- Deals brought (source): ${scorecard.dealsBrought} · involved: ${scorecard.dealsInvolved}`,
      `- Reached L1 (passed screening, any time): ${scorecard.reachedL1} of ${scorecard.dealsBrought} brought · conversion ${pct(scorecard.conversion)}`,
    );
    // The breakdown lists every live stage (zeros included) for the funnel UI.
    const reached = scorecard.stageBreakdown.filter((b) => b.count > 0);
    if (reached.length > 0) {
      lines.push(
        `- Furthest stage reached by the deals brought: ${reached
          .map((b) => `${b.label} ×${b.count}`)
          .join(", ")}`,
      );
    }
    for (const d of deals) {
      const role = d.role === "source" ? "brought" : "involved";
      lines.push(
        `- ${d.companyName} — ${role} — current stage ${d.stageLabel}${d.isDropped ? " (dropped)" : ""}`,
      );
    }
  }
  return lines;
}

function renderRelated(insights: ContactInsights): string[] {
  const related = insights.relatedCompanies;
  if (related.length === 0) {
    return [
      "### Related companies (from this person's own emails)",
      insights.interactions.hasSyncedData ? "- None on record." : `- ${NO_INTERACTION_DATA}`,
    ];
  }
  return [
    "### Related companies (from this person's own emails)",
    ...related
      .slice(0, RELATED_COMPANIES_SHOWN)
      .map((r) => {
        const last = isoDay(r.lastSeenAt);
        return `- ${r.companyName} — ${r.evidenceCount} email(s)${last ? `, last ${last}` : ""}`;
      }),
    ...(related.length > RELATED_COMPANIES_SHOWN
      ? [`- +${related.length - RELATED_COMPANIES_SHOWN} more`]
      : []),
  ];
}

/** The conversation read failed: unknown, never reported as none. */
const CONVERSATION_UNREADABLE =
  "- Could not be read right now. Say you don't know — not that there are none.";

function renderRoles(conversation: ContactConversation | undefined): string[] {
  const lines = ["### Role in investment"];
  if (!conversation) {
    lines.push(CONVERSATION_UNREADABLE);
    return lines;
  }
  const { roles } = conversation;
  if (roles.roles.length === 0) {
    lines.push("- No role signals recorded.");
    return lines;
  }
  lines.push(`- ${roles.roles.map((r) => `${r.label} (${r.confidence})`).join(", ")}`);
  if (conversation.overview.roleSummary) {
    lines.push(`- Across their emails: ${conversation.overview.roleSummary}`);
  }
  if (roles.evidence) {
    lines.push(`- Evidence: ${roles.evidence}`);
  }
  return lines;
}

/**
 * Who reached whom is what the team wants from these notes; meeting logistics
 * (when, where, how to join) are not, and a missing reply is not evidence of
 * anything.
 */
const CONVERSATION_NOTES_GUIDANCE =
  "_Use these to say who on our team has been in touch with this person, who reached out to whom, and what about. Mention a meeting or call only as held or planned — never its time, place or link — and don't comment on replies or confirmations these notes don't record._";

/** "from Alice (us), also on it: Bob" / "from their side, to Alice". */
function noteParties(n: ContactConversation["notes"][number]): string {
  const sender = n.teamMembers.find((m) => m.sent);
  const others = n.teamMembers.filter((m) => m !== sender).map((m) => m.name);
  if (n.direction === "outbound") {
    const from = sender ? `from ${sender.name} (us)` : "from us";
    return others.length > 0 ? `${from}, also on it: ${others.join(", ")}` : from;
  }
  return others.length > 0 ? `from their side, to ${others.join(", ")}` : "from their side";
}

function renderConversationNotes(conversation: ContactConversation | undefined): string[] {
  const lines = ["### Conversation notes"];
  if (!conversation) {
    lines.push(CONVERSATION_UNREADABLE);
    return lines;
  }
  const { notes } = conversation;
  if (notes.length === 0) {
    lines.push("- no conversation notes yet");
    return lines;
  }
  lines.push(CONVERSATION_NOTES_GUIDANCE);
  for (const n of notes.slice(0, 10)) {
    const d = isoDay(n.sentAt) ?? n.sentAt.slice(0, 10);
    const next = n.nextStep ? ` — Next step: ${n.nextStep}` : "";
    lines.push(`- ${d} · ${noteParties(n)}: ${n.summary}${next}`);
  }
  return lines;
}

async function contactMode(container: Container, query: string, viewer: RuntimeViewer): Promise<string> {
  const { bankerListService, contactInsightsService, contactConversationService } = container;
  const found = await bankerListService.listBankers({
    q: query,
    sort: "recent",
    pageSize: DISAMBIGUATION_SIZE,
  });

  // An exact name/email hit wins over partial matches ("Jim" vs "Jimmy").
  const exact = found.rows.filter((r) => sameText(r.name, query) || sameText(r.email, query));
  const candidates = exact.length > 0 ? exact : found.rows;

  if (candidates.length === 0) {
    return `No CRM contact in this workspace matches "${query}". Do not guess — say you could not find this person, or ask for their email.`;
  }
  if (candidates.length > 1) {
    const more =
      exact.length === 0 && found.total > found.rows.length
        ? `\n- …and ${found.total - found.rows.length} more; ask for a fuller name or the email.`
        : "";
    return `## Several people match "${query}"
Ask the user which one they mean (or call again with the email). Do not merge their numbers — every banker is reported on their own.
${candidates
  .map((r) => `- ${r.name} — ${r.firm.name}${r.email ? ` — ${r.email}` : ""}${r.title ? ` (${r.title})` : ""}`)
  .join("\n")}${more}`;
  }

  const person: BankerRow = candidates[0];
  const [insights, conversation] = await Promise.all([
    contactInsightsService.getContactInsights(person.correspondentId),
    // Email notes are private to the people on each email. In chat they are
    // read as the signed-in user; with no user ("") no note is readable and
    // the roles come without evidence. An AI Workforce run may use the full
    // context: its trace redacts this tool's output (traceMapper
    // PRIVATE_OUTPUT_TOOLS) and only its report is shared. A failed read is
    // undefined, which renders as unknown.
    (viewer.workforce
      ? contactConversationService.getConversationForWorkforce(person.correspondentId, { limit: 10 })
      : contactConversationService.getConversation(person.correspondentId, viewer.userId ?? "", { limit: 10 })
    ).catch(() => undefined),
  ]);
  logger.debug(`✓ crm_banker_insights: contact ${person.name} @ ${person.firm.name}`);

  return [
    `## Banker insights — ${person.name} @ ${person.firm.name}`,
    `_These are ${person.name}'s own numbers — not ${person.firm.name}'s. Other people at the firm have their own._`,
    ...(person.email ? [`- Email: ${person.email}`] : []),
    ...(person.title ? [`- Title: ${person.title}`] : []),
    "",
    ...renderRoles(conversation),
    "",
    ...renderConversationNotes(conversation),
    "",
    ...renderInteractions(insights),
    "",
    ...renderDeals(insights),
    "",
    ...renderRelated(insights),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Ranking mode
// ---------------------------------------------------------------------------

function renderRankRow(r: BankerRow, rank: number, result: BankerListResult): string {
  const parts: string[] = [];
  // No link either way is "unknown", not zero deals — same as contact mode.
  if (result.hasDealLinks && r.dealsBrought + r.dealsInvolved > 0) {
    parts.push(
      `brought ${r.dealsBrought}, involved ${r.dealsInvolved}, reached L1 ${r.reachedL1} (conversion ${pct(r.conversion)})`,
    );
  } else {
    parts.push("deals: no deal links recorded");
  }
  if (result.hasSyncedData) {
    parts.push(
      `emails ${r.totals.emailsFromUs} from us / ${r.totals.emailsFromThem} from them`,
      `team members ${r.teamMemberCount}`,
      `last contact ${isoDay(r.lastContactAt) ?? "none recorded"}`,
    );
    if (r.topTeamMembers.length > 0) {
      parts.push(`top team: ${r.topTeamMembers.map((t) => `${t.name ?? t.userId} (${t.total})`).join(", ")}`);
    }
  } else {
    parts.push(`interactions: ${NO_INTERACTION_DATA}`);
  }
  return `${rank}. **${r.name}** @ ${r.firm.name}${r.email ? ` (${r.email})` : ""} — ${parts.join("; ")}`;
}

async function rankingMode(
  container: Container,
  metric: RankingMetric,
  limit: number,
  activeWithinDays: number | undefined,
): Promise<string> {
  const window =
    activeWithinDays !== undefined
      ? {
          lastContact: "custom",
          customDate: new Date(Date.now() - activeWithinDays * DAY_MS).toISOString(),
        }
      : {};
  const result = await container.bankerListService.listBankers({
    sort: SORT_FOR_METRIC[metric],
    pageSize: limit,
    ...window,
  });

  if (DEAL_METRICS.has(metric) && !result.hasDealLinks) {
    return `## Bankers by ${METRIC_LABELS[metric]}
This workspace has no deal links (no Brain deal is linked to a banker yet), so a ranking by ${METRIC_LABELS[metric]} cannot be computed. Say so — do not rank by anything else in its place.`;
  }
  if (!DEAL_METRICS.has(metric) && !result.hasSyncedData) {
    return `## Bankers by ${METRIC_LABELS[metric]}
${NO_INTERACTION_DATA} — no email is synced for this workspace, so there is nothing to rank by. Say you don't know.`;
  }

  const windowLine =
    activeWithinDays !== undefined ? ` · contacted in the last ${activeWithinDays} day(s)` : "";
  // A banker with nothing brought / nothing past L0 is not a "top" banker on a deal metric.
  const rows =
    metric === "deals_brought"
      ? result.rows.filter((r) => r.dealsBrought > 0)
      : metric === "reached_l1"
        ? result.rows.filter((r) => r.reachedL1 > 0)
        : result.rows;
  if (rows.length === 0) {
    return `## Bankers by ${METRIC_LABELS[metric]}${windowLine}
No banker matches.`;
  }

  logger.debug(`✓ crm_banker_insights: ranking ${metric}, ${rows.length} row(s)`);
  return `## Bankers by ${METRIC_LABELS[metric]}${windowLine}
_Top ${rows.length}${rows.length === result.rows.length ? ` of ${result.total} bankers listed` : ""}. One line per PERSON — never add them up into a firm._
${rows.map((r, i) => renderRankRow(r, i + 1, result)).join("\n")}`;
}

/**
 * Per-PERSON banker insights for the chat (MB-859): who on our team emails one
 * banker, which Brain deals they brought or were part of and how far
 * those got — or the top bankers by one of those measures. The firm-level
 * picture is `lookup_crm`'s job; this tool never aggregates a firm.
 */
export const crmBankerInsights = tool(
  async (args: BankerInsightsArgs, runtime?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: crm_banker_insights(${JSON.stringify(args)})`);

    const query = args.contact?.trim();
    if (args.mode === "contact" && !query) {
      return 'contact mode needs `contact` — the banker\'s name or email. For a ranking, call with mode="ranking" and a metric.';
    }
    if (args.mode === "ranking" && !args.metric) {
      return `ranking mode needs \`metric\`, one of: ${BANKER_RANKING_METRICS.join(", ")}.`;
    }

    try {
      const container = createContainer(createDb(), await getActiveWorkspaceId());
      if (args.mode === "contact") {
        return await contactMode(container, query, runtimeViewer(runtime));
      }
      // The schema already holds both to integers.
      const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_RANKING_LIMIT);
      const days =
        args.active_within_days === undefined ? undefined : Math.max(args.active_within_days, 1);
      return await rankingMode(container, args.metric, limit, days);
    } catch (error) {
      logger.error(`crm_banker_insights error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "crm_banker_insights",
    description: `Per-PERSON banker insights from synced email, plus the Brain deals each banker brought.

Use this — not lookup_crm — for questions about one banker as a person or for ranking bankers:
"who on our team has talked to Jane Doe and how often?", "when did we last email Jane?",
"which deals did Jane bring / was Jane part of, and how far did they get?",
"which bankers bring leads that reach L1?", "who are our most active bankers this month?".
Use lookup_crm for the FIRM (a bank's bankers, topics, notes, coverage).

TWO MODES:

1. mode="contact", contact=<name or email> — one person: each team member's emails
   each way and last email, last contact; deals brought / involved with current stage, furthest stage reached, reached-L1
   count and conversion; related companies. If several people match, the tool
   returns a short list (name, firm, email) — ask the user which one; never
   merge them.

2. mode="ranking", metric=<deals_brought | reached_l1 | recent_activity |
   team_members | emails>, optional limit (default 10, max 25),
   optional active_within_days — the top bankers, one line per person.

Rules for the answer:
- Answer about the PERSON only. Two bankers at the same firm have different
  numbers; never add a firm's bankers together or attribute one's numbers to another.
- Quote the tool's numbers. Where it says "no data (email sync may be off)",
  "none recorded" or "no deal links recorded", say you don't know — never
  turn that into 0 and never estimate.
- From the conversation notes, say who on our team reached out to whom and
  what about. Leave out meeting logistics (a meeting's time, place or link)
  and never guess whether someone replied or a meeting is confirmed.

Returns:
    Markdown.`,
    schema: z.object({
      mode: z
        .enum(["contact", "ranking"])
        .describe('"contact" for one banker, "ranking" for the top bankers by a metric.'),
      contact: z
        .string()
        .optional()
        .describe("contact mode: the banker's name or email (partial match is fine)."),
      metric: z
        .enum(BANKER_RANKING_METRICS)
        .optional()
        .describe(
          "ranking mode: deals_brought, reached_l1 (deals brought that passed screening), recent_activity (most recent contact), team_members, emails.",
        ),
      limit: z
        .number()
        .int()
        .optional()
        .describe(`ranking mode: how many bankers (default ${DEFAULT_LIMIT}, max ${MAX_RANKING_LIMIT}).`),
      active_within_days: z
        .number()
        .int()
        .optional()
        .describe("ranking mode: only bankers we emailed within this many days."),
    }),
  },
);
