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
  const dateLabel = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return [
    'Generate a sharp, insight-driven daily pipeline recap for senior management. You are a seasoned deal professional who reads between the lines — surface what the numbers mean, not just what they are.',
    '',
    `Reference time ("now"): ${nowIso}.`,
    `TODAY window: ${dayAgoIso} → ${nowIso}. PRIOR DAY window: ${twoDaysAgoIso} → ${dayAgoIso}.`,
    '',
    'Gather the data yourself with your tools — do not ask the user for it:',
    '- Use `query_companies` with `created_after` / `created_before` to pull deals added (stage, source, segment, geography) for each window.',
    '- Use `get_company_stats` for pipeline aggregates.',
    '- Use `analyze_stalled_deals` for days-in-stage.',
    '',
    'Scope: EXCLUDE companies in the "discovered" stage from every count, metric, and flag.',
    'Pre-pipeline = companies screened but not yet committed to L0–L5. L0–L5 = committed pipeline deals.',
    'Keep these two populations distinct throughout — never aggregate them.',
    '',
    'Output ONLY the following markdown, beginning directly with the first line. Total response must not exceed 220 words.',
    '',
    `**Today's recap — ${dateLabel}**`,
    '',
    '**Headline:** [1–2 sentences. The sharpest observation from today — what changed, what it signals, and whether it matters. Distinguish pre-pipeline activity from committed L0–L5 movement. A flat or quiet day is fine to say plainly; do not inflate it. Do not describe a one- or two-day movement as a trend — call it an observation or early warning.]',
    '',
    '**Key metrics**',
    '[Include only metrics you can calculate. Up to four. Omit unavailable or uninformative ones without explanation. Use ↑/↓/→ for direction vs. yesterday:]',
    '- New L0–L5 deals: [today vs. yesterday]',
    '- Stalled deals (≥14 days): [count of active deals stuck in current stage]',
    '- Pre-pipeline additions: [new screening adds today]',
    '- [One other metric only if it adds insight — e.g., pass rate, outbound share]',
    '',
    '**Attention required**',
    '[Surface only items where a trigger below fired. If none, write "None." Be specific: name the company, state why it matters, and what the implication is for the pipeline. Do not invent owners or conclusions.]',
    '',
    'Triggers:',
    '- Any active deal stalled ≥14 days in its current stage.',
    '- Any new add outside the firm mandate (flag segment/geography).',
    '- Any drop whose rationale does not cite a named screening criterion.',
    '- Pass rate or AI-opinion coverage dropping >15pp vs. yesterday.',
    '',
    '**Recommended actions**',
    '[For each attention item above, recommend a concrete next step. Assign a severity tag: 🔴 Critical (blocks a deal or risks a miss), 🟡 Watch (warrants monitoring this week), 🟢 Informational (no immediate action needed). Format each as: `[severity] Action — reason`. If no attention items, write "None."]',
    '',
    'Writing rules:',
    '- Short bullets, not paragraphs.',
    '- Do not repeat information between sections.',
    '- Do not use hollow phrases ("bright spot", "pipeline has stalled", "that\'s the story").',
    '- Do not treat a one- or two-day movement as a trend.',
    '- Do not invent owners, explanations, or conclusions.',
    '- Include financial detail only when it directly supports a decision.',
    '- Insight over completeness: a sharper, shorter recap is better than an exhaustive one.',
  ].join('\n');
}

/**
 * Per-call system-context override for the pulse generation. The shared chat
 * system prompt the stateless agent runs on tells it to wrap reasoning in
 * `<!-- THINKING_START -->` … `<!-- THINKING_END -->` delimiters for the chat
 * UI — but the pulse card renders the answer verbatim and has no thinking UI.
 * That conflict makes the agent narrate its process (sometimes without the
 * delimiters, which then leaks straight into the card). This override cancels
 * the delimiter protocol and bans any preamble for this one call; the appended
 * position (after the base prompt) lets it win. {@link stripThinking} stays as a
 * safety net for the delimited case.
 */
const PULSE_SYSTEM_CONTEXT = [
  '## Daily Pulse output contract (overrides any conflicting instruction above)',
  '- This response is generated once and rendered verbatim in a dashboard card. There is NO chat UI and NO collapsible "Thinking" section.',
  '- Do NOT emit `<!-- THINKING_START -->` or `<!-- THINKING_END -->` delimiters, and do NOT include any internal reasoning, planning, or narration about what you are about to do or check.',
  "- Do NOT write any preamble. Your entire response MUST begin directly with the bold date header (**Today's recap — …**) and contain nothing but the recap markdown requested.",
  '- Maximum 220 words in the final response.',
].join('\n');

/**
 * Strip the Analyst agent's internal-reasoning block from its answer. The shared
 * chat system prompt tells the agent to wrap its reasoning in
 * `<!-- THINKING_START -->` … `<!-- THINKING_END -->` so the chat UI can show it
 * as a collapsible "Thinking" section; the pulse card renders the markdown
 * verbatim and has no such UI, so those blocks (and any stray delimiter) must be
 * removed, leaving only the final answer. Mirrors the chat bubble's own
 * delimiter handling.
 */
export function stripThinking(text: string): string {
  return text
    // Remove complete THINKING_START…THINKING_END blocks (non-greedy, across lines).
    .replace(/<!--\s*THINKING_START\s*-->[\s\S]*?<!--\s*THINKING_END\s*-->/g, '')
    // Drop any leftover stray delimiter (unbalanced pair, e.g. truncated output).
    .replace(/<!--\s*THINKING_(?:START|END)\s*-->/g, '')
    .trim();
}

/**
 * Generate the daily pulse by sending {@link buildDailyPulsePrompt} to the
 * existing Analyst (stateless chat) agent and returning its markdown answer.
 * The agent runs under the given workspace's context so its data tools scope
 * correctly (including from the session-less cron). A per-call system-context
 * override ({@link PULSE_SYSTEM_CONTEXT}) suppresses the chat prompt's thinking
 * delimiters and preamble, and {@link stripThinking} strips any delimited block
 * that slips through, so only the final recap reaches the card. Throws when the
 * agent is unavailable or returns nothing; the service caches nothing on throw.
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
    graph.invoke({
      messages: [new HumanMessage(buildDailyPulsePrompt(now))],
      additionalSystemContext: PULSE_SYSTEM_CONTEXT,
    }),
  );

  const { assistantText } = extractFirstTurn(result.messages);
  const text = stripThinking(assistantText);
  if (!text) {
    throw new Error('Daily pulse generation returned an empty result');
  }
  return text;
};
