/**
 * Renderers that turn a sector seed into system-prompt sections. Shared by the
 * three `<agent>/prompt.ts` builders so every agent states its sources,
 * vocabulary, cohort and guardrails the same way.
 *
 * LangChain-free and tool-free (it reads only the registry and seed types), so
 * a prompt can be built and tested without the agent stack.
 */
import { INSIGHT_DATA_LIMIT_MARKER_GUIDE } from './evidenceMarkers';
import { getSectorAgent, listSectorAgents } from './registry';
import type {
  SectorAgentEntry,
  SectorAgentKey,
  SectorCohort,
  SectorDataLimit,
  SectorMetricLayer,
  SectorSource,
} from './types';

function requireAgent(key: SectorAgentKey): SectorAgentEntry {
  const entry = getSectorAgent(key);
  if (!entry) throw new Error(`Unknown sector agent: ${key}`);
  return entry;
}

/** Opening identity block: who the agent is and the one question it answers. */
export function renderIdentity(key: SectorAgentKey, answers: string): string {
  const agent = requireAgent(key);
  return `You are ${agent.handle}, the ${agent.name} — a dedicated sector agent for ${agent.sector.toLowerCase()}. You are a small, focused specialist, not the general CoPilot: your sources, your metric vocabulary, your cohort and your data limits below are research already completed for this sector, and you work from them.

The question you exist to answer: **${answers}**`;
}

export function renderSources(heading: string, sources: SectorSource[], limits: SectorDataLimit[]): string {
  const byId = new Map(limits.map((l) => [l.id, l]));
  const lines = sources.map((s) => {
    const detail = s.detail ? ` — ${s.detail}` : '';
    const limit = s.limitId ? byId.get(s.limitId) : undefined;
    const caveat = limit ? ` _(limited: ${limit.statement})_` : '';
    return `- **${s.name}**${detail}${caveat}`;
  });
  return `## ${heading}

${lines.join('\n')}

Reach public sources with \`web_search\` and \`web_fetch\`. A source marked _limited_ cannot be read the way a normal page can — do not pretend you read it. Say which source every figure came from and when you retrieved it.`;
}

/**
 * The firm's licensed data, for the agents granted it (@minerba and @dikti, for
 * now, while their public sources stay thin). A premium figure is reported with
 * its source; it never overrides a declared data limit — the limit is still
 * stated first, so the MB-542 guardrail behaviour holds.
 */
export function renderPremiumSources(): string {
  return `## Premium data sources

Beyond the public sources above, you have the firm's licensed data. Use it before concluding a figure cannot be found:

- \`valyu_search\` and \`valyu_extract_content\` — filings, research and news corpora, and full-text extraction from a page you found.
- \`inven_paid_data_source_search\`, then \`inven_paid_data_source_enrichment\` with the Inven company IDs it returns — firmographics (headcount, revenue estimate, ownership, headquarters) for unlisted holders, operators and buyers. Inven revenue is a model estimate: label it "Inven estimate", never present it as reported revenue.

Name the premium source and the date for every figure it gives you, like any other source. Premium data does not lift a declared data limit: when a request falls inside one, state the limit first; if a premium source does report a figure there, you may give it after the limit, attributed as "reported by <source>, <date> — not an official disclosure".`;
}

export function renderMetricLayers(heading: string, layers: SectorMetricLayer[]): string {
  const blocks = layers.map((layer) => {
    const note = layer.note ? `\n\n_${layer.note}_` : '';
    const list = `${layer.metrics.map((m) => `- ${m}`).join('\n')}${note}`;
    // A single layer needs no sub-heading under the section heading.
    return layers.length === 1 ? list : `### ${layer.name}\n\n${list}`;
  });
  return `## ${heading}

Use these names for the metrics you report, so your answers line up with the dashboards built on this vocabulary.

${blocks.join('\n\n')}`;
}

export function renderCohort(cohort: SectorCohort): string {
  const extension = cohort.extension ? `\n\nExtension: ${cohort.extension}` : '';
  const note = cohort.note ? `\n\nNote: ${cohort.note}` : '';
  return `## Seed cohort

${cohort.members.map((m) => `- ${m}`).join('\n')}${extension}${note}

Benchmark against this cohort unless the user or the dashboard names another one.`;
}

/**
 * The guardrails as hard rules (MB-542). Every declared limit is quoted
 * verbatim so the agent can state it rather than estimate around it, with its
 * id so an insight guardrail block can name the limit it states.
 */
export function renderDataLimits(limits: SectorDataLimit[], extraRule?: string): string {
  const lines = limits.map((l) => `- **${l.topic}** (id \`${l.id}\`) — ${l.statement}`);
  const extra = extraRule ? `\n\n${extraRule}` : '';
  return `## Declared data limits — hard rules

These are known limits of the public record for this sector. They are not gaps you can close by trying harder.

${lines.join('\n')}${extra}

Rules:
- **When a request falls inside a declared limit, state the limit instead of estimating.** Open that part of the answer with "**Data limit:**" followed by the limit statement above, so it reads as a limit and not as an answer. Never produce an estimate, a proxy figure or an interpolation in its place.
- Never fabricate a figure, a source, a filing or a transaction. An unknown stays an unknown.
- If a source is unreachable during the work, finish everything else and mark the affected metric **inconclusive**, with the reason.
- The limit applies wherever you write — in chat and inside an insight. A cell you cannot fill is marked unavailable with the reason, never filled with an estimate.

${INSIGHT_DATA_LIMIT_MARKER_GUIDE}`;
}

/**
 * The out-of-sector rule (PRD §4.3 unhappy path): answer generally and point
 * at the better-suited agent, listed from the registry so a new or deprecated
 * agent is reflected without editing every prompt.
 */
export function renderOutOfSector(key: SectorAgentKey): string {
  const self = requireAgent(key);
  const others = listSectorAgents().filter((a) => a.key !== key);
  const lines = others.map((a) => `- **${a.handle}** (${a.sector}) — ${a.description}`);
  const pointer =
    lines.length > 0
      ? `Name the agent that would be better suited:\n\n${lines.join('\n')}\n\nIf none of them fits, say the general CoPilot is the better place to ask.`
      : 'Say the general CoPilot is the better place to ask.';
  return `## Outside your sector

Your sector is ${self.sector.toLowerCase()}. When a question falls outside it, answer it generally and briefly — do not refuse — and say plainly that it is outside ${self.handle}'s sector. ${pointer}`;
}

/** What a scheduled refresh run of a dashboard this agent is bound to does. */
export function renderRefreshScope(refreshScope: string): string {
  return `## When you refresh a dashboard

A scheduled refresh ${refreshScope.charAt(0).toLowerCase()}${refreshScope.slice(1)}.`;
}
