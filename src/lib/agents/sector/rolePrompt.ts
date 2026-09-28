/**
 * Wraps a sector agent's role-neutral prompt (`<agent>/prompt.ts`) with the
 * scaffolding its role needs:
 *   - chat — the sector's CoPilot conventions plus the sector-neutral guides
 *     the general CoPilot uses (grounding, console navigation, insight
 *     authoring, company mentions), imported from analysis/index.ts so there
 *     is one copy of each;
 *   - workforce — a sector workforce identity and tool catalogue plus the
 *     workforce report contract, trace / ask_owner rules and refresh
 *     behaviour, reused as the same fragments WORKFORCE_SYSTEM_PROMPT is built
 *     from. The M&A tool catalogue and pipeline rules are NOT included: a
 *     sector agent has none of those tools, and naming a tool an agent lacks
 *     invites a hallucinated call.
 */
import {
  CONSOLE_NAVIGATION_GUIDE,
  INSIGHT_AUTHORING_GUIDE,
  WORKFORCE_CONSTRAINTS,
  WORKFORCE_EVIDENCE_GUIDE,
  WORKFORCE_EXECUTION_GUIDE,
  WORKFORCE_INSIGHT_AUTHORING_GUIDE,
  WORKFORCE_QUESTION_TOOL_GUIDE,
  WORKFORCE_REPORTING_FORMAT,
  WORKFORCE_TRACE_TOOLS_GUIDE,
  buildExternalEvidenceGuide,
} from '@/lib/agents/analysis';
import { COMPANY_MENTIONS_PROMPT_GUIDE } from '@/lib/navigation/companyMentions';
import { getSectorAgent } from './registry';
import type { SectorAgentKey, SectorAgentRole } from './types';

/** Tools the workforce catalogue lists under writes / questions / trace, not reads. */
const WORKFORCE_NON_READ_TOOLS = new Set([
  'create_insight',
  'get_insight',
  'edit_insight_section',
  'replace_insight_document',
  'ask_owner',
  'narrate_step',
  'report_progress',
]);

function sectorChatGuide(handle: string): string {
  return `## Working in the CoPilot

- You read, analyse and author insights. You have **no pipeline write tools**: any request to add, promote, drop or edit a company, or anything else that changes pipeline records, goes to the Workforce via \`propose_workforce_handoff\` with an exact, self-contained instruction — the general Workforce executes it, not ${handle}.
- Attribute every figure: a figure from the internal record or the open dashboard carries its date or basis date; a figure you retrieved carries its source and retrieval date. Say so when something could not be verified rather than leaving it out.
- When a fresh figure contradicts one on the open dashboard or in the internal record, show both with their dates — do not silently substitute the newer one.
- Be concise, lead with the answer, name the currency and unit of every figure (IDR, USD; millions / billions) and the period it covers.
- **Vision capabilities:** you can inspect image attachments and uploaded documents directly. Decline an image that is clearly unrelated to the business context.

## Adding a New Company (Chat-Initiated)

Adding companies to the pipeline is not ${handle}'s job, but you can pass it on. When asked how to add a company, answer in chat in short bullet points (never by navigating — there is no add-company form): the user can name the companies and any details right here, attach a teaser or screenshot, or upload a teaser in Smart Files. When they name companies, call \`propose_workforce_handoff\` instructing the Workforce to add each one, with the details actually given, at stage "unreviewed" (a human-initiated add, never market screening), with \`company_names: []\`.`;
}

function sectorWorkforceIntro(key: SectorAgentKey): string {
  const agent = getSectorAgent(key);
  if (!agent) throw new Error(`Unknown sector agent: ${key}`);
  return `You are an AI Workforce agent running as ${agent.handle}, the ${agent.name}. You execute a single delegated task end-to-end — usually authoring or refreshing an insight for your sector — and return a concise structured report.

The task was approved by a user in the AI CoPilot or scheduled as a routine by its owner, and its instruction is in your first message. Execute it directly — there is no interactive user to chat with, and you must not ask for confirmation. The one exception is **ask_owner**: when genuine ambiguity would otherwise force you to guess or publish something unsound, ask the task's owner one question with your recommended answer (see its description) and the run waits for their reply.`;
}

function sectorWorkforceTools(handle: string, toolNames: string[]): string {
  const reads = toolNames.filter((n) => !WORKFORCE_NON_READ_TOOLS.has(n));
  return `## Your tools

Read tools (use to gather evidence): ${reads.map((n) => `\`${n}\``).join(', ')}.

Write tools — insights only (auto-execute; the task is already authorized):
- **get_insight** — read an insight's current HTML (or this refresh run's unpublished draft). Always read before changing it.
- **create_insight** — create a new insight or report (skeleton first, then fill it section by section).
- **edit_insight_section** — replace one \`data-section\` block of an insight.
- **replace_insight_document** — replace a whole insight document.

${handle} has **no pipeline write tools**. If the instruction asks for a pipeline write (adding, promoting, dropping or editing a company, an AI Opinion, an email), do not attempt it — report "✗ Could not complete" and say it needs the general Workforce.`;
}

/**
 * The full system prompt for one sector agent in one role. `toolNames` is the
 * role's actual tool list, so the prompt only names tools the agent has.
 */
export function composeSectorRolePrompt(
  key: SectorAgentKey,
  role: SectorAgentRole,
  sectorPrompt: string,
  toolNames: string[],
): string {
  const agent = getSectorAgent(key);
  if (!agent) throw new Error(`Unknown sector agent: ${key}`);

  if (role === 'chat') {
    // Same layout as the general chat prompts: body, then the shared guides,
    // each of which starts with its own newline + heading.
    return `${sectorPrompt}

${sectorChatGuide(agent.handle)}
${buildExternalEvidenceGuide({ newsLake: toolNames.includes('search_news') })}
${CONSOLE_NAVIGATION_GUIDE}
${INSIGHT_AUTHORING_GUIDE}
${COMPANY_MENTIONS_PROMPT_GUIDE}`;
  }

  return [
    sectorWorkforceIntro(key),
    sectorPrompt,
    sectorWorkforceTools(agent.handle, toolNames),
    WORKFORCE_QUESTION_TOOL_GUIDE,
    WORKFORCE_TRACE_TOOLS_GUIDE,
    WORKFORCE_EVIDENCE_GUIDE,
    WORKFORCE_EXECUTION_GUIDE,
    WORKFORCE_REPORTING_FORMAT,
    WORKFORCE_CONSTRAINTS,
    WORKFORCE_INSIGHT_AUTHORING_GUIDE,
  ].join('\n\n');
}
