import { runWithWorkforceWorkspaceId } from '@/lib/workspace';

/** Generates the "Today's Recap" markdown by asking the Analyst agent. Injectable
 * so the service can be tested without spinning up a real agent. */
export type DailyPulseGenerator = (now: Date, workspaceId: string) => Promise<string>;

/**
 * The prompt handed to the Analyst agent. It gathers the numbers itself via its
 * data tools (`query_companies` with `created_after`/`created_before`,
 * `get_company_stats`, `analyze_stalled_deals`) and returns the finished recap as
 * markdown — shown in the dashboard card as-is. `now` fixes "today" so the
 * trailing-24h vs prior-24h windows are unambiguous.
 */
export function buildDailyPulsePrompt(now: Date): string {
  const nowIso = now.toISOString();
  const dayAgoIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const twoDaysAgoIso = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

  return [
    'You are a Managing Partner with 25 years leading private equity deal teams. You have run thousands of daily pipeline stand-ups and you know the difference between a dashboard that gets read and one that gets ignored. Generate the daily pipeline pulse for the origination team: a single-day view of pipeline health — what happened today versus yesterday — that a busy partner can absorb in 20 seconds and act on. Be ruthless about signal over noise: every number you surface must be capable of changing a decision. Do not pad, do not celebrate vanity metrics, and name specific companies and owners when something needs attention.',
    '',
    `Reference time ("now"): ${nowIso}.`,
    `Compare TODAY (the last 24h: ${dayAgoIso} → ${nowIso}) against the PRIOR DAY (${twoDaysAgoIso} → ${dayAgoIso}).`,
    '',
    'Gather the data yourself with your tools — do not ask the user for it:',
    '- Use `query_companies` with `created_after` / `created_before` to pull deals added (and their source inbound/outbound, segment, geography, revenue, EBITDA, stage) for each 24h window.',
    '- Use `get_company_stats` for pipeline/AI-opinion aggregates (pass/fail/tentative verdicts and coverage) per window.',
    '- Use `analyze_stalled_deals` for days-in-stage and stalled/frozen deals.',
    'Compute the deltas yourself. Use medians (never averages) for revenue/EBITDA.',
    '',
    'Core rules (non-negotiable):',
    '- Deltas over totals: express every metric as "today vs. yesterday" with direction (↑/↓/flat). A raw total with no comparison is noise.',
    '- Respect low daily volume: on a single day counts are small, so a rate can swing hard or read 0% purely because there were few or no adds. When that is the cause, say so — never present a low-volume artifact as a real trend.',
    '- Exceptions are the product: a quiet day should read quiet. Only raise a flag when a trigger below fired. "No exceptions today." is a valid, good output — do not manufacture concern.',
    '- Name names: when flagging a stalled deal, weak drop, or out-of-mandate add, cite the specific company, its days-in-stage/owner, and the specific signal.',
    '- Every metric ties to an action or it does not appear.',
    '',
    'Exception triggers (only surface when true):',
    '- Any active deal crossing 14 days in its current stage (new stalls get priority).',
    '- Any L1+ deal frozen >90 days still open.',
    '- Any new add today outside the firm mandate (flag segment/geography and why it is out of scope).',
    '- Any drop today whose rationale does NOT cite a named screening criterion (a financial threshold, mandate scope, or competitive signal) — flag it, naming the company and the weak rationale.',
    '- Outbound share at 0% for 3+ consecutive days.',
    '- Pass rate or AI-opinion coverage dropping >15pp vs. yesterday.',
    '',
    'Output ONLY GitHub-flavoured markdown (no preamble, no code fences), in this order:',
    '1. A one-line **headline** (bold) — the single most important thing about today, with its delta.',
    '2. **Scoreboard** — a short bullet list of 5–7 metrics, each as `metric: today vs yesterday (↑/↓/flat)`: deals added, pass rate, AI coverage, outbound share, median EBITDA of adds, stalled-deal count.',
    '3. **Commentary** — 2–4 sentences interpreting the deltas as a PE lead would (what is improving, what is slipping, and why, including any low-volume effect).',
    '4. **Flags** — bulleted exceptions with named companies and the trigger that fired; or "No exceptions today."',
    '5. **Open actions** — bulleted carry-forward items, each naming an owner and an age in days where known; or "None."',
    '',
    'Tone: write like a partner talking to their team, not a report generator. Direct, quantitative, occasionally pointed. No hedging, no marketing language, no exclamation marks. If the day was bad, say it plainly. If nothing changed, say that too and keep it short.',
  ].join('\n');
}

/**
 * Generate the daily pulse by sending {@link buildDailyPulsePrompt} to the
 * existing Analyst (stateless chat) agent and returning its markdown answer
 * verbatim. The agent runs under the given workspace's context so its data tools
 * scope correctly (including from the session-less cron). Throws when the agent
 * is unavailable or returns nothing; the service caches nothing on throw.
 */
export const generateDailyPulse: DailyPulseGenerator = async (now, workspaceId) => {
  // Dynamic import: a static one would close a require cycle, since the Analyst
  // agent's tools import `@/lib/services` (createContainer) and this module is
  // reached from that same container. Deferring to call-time breaks the cycle.
  const { getStatelessAgentGraph, extractFirstTurn, HumanMessage } = await import(
    '@/lib/agents/analysis'
  );

  const graph = await getStatelessAgentGraph();
  if (!graph) {
    throw new Error('Analyst agent is unavailable');
  }

  const result = await runWithWorkforceWorkspaceId(workspaceId, () =>
    graph.invoke({ messages: [new HumanMessage(buildDailyPulsePrompt(now))] }),
  );

  const { assistantText } = extractFirstTurn(result.messages);
  const text = assistantText.trim();
  if (!text) {
    throw new Error('Daily pulse generation returned an empty result');
  }
  return text;
};
