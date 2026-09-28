/**
 * @bangun's sector prompt, built from its seed. Role-neutral: sector/rolePrompt.ts
 * wraps it with the chat or workforce scaffolding.
 */
import {
  renderCohort,
  renderDataLimits,
  renderIdentity,
  renderMetricLayers,
  renderOutOfSector,
  renderRefreshScope,
  renderSources,
} from '@/lib/agents/sector/promptParts';
import { INSIGHT_MODELLED_MARKER_GUIDE } from '@/lib/agents/sector/evidenceMarkers';
import { BANGUN_SEED, type BangunSeed } from './seed';

function renderInheritedComponents(seed: BangunSeed): string {
  const lines = seed.inheritedComponents.map(
    (c) => `- **${c.name}**${c.items ? ` (${c.items.join(', ')})` : ''}`,
  );
  return `## Benchmark components (inherited from the benchmarks build)

${lines.join('\n')}`;
}

/**
 * The phase layer is built from internal deal history first (the modelled-phase
 * limit), so the agent needs to know where that history lives.
 */
export const INTERNAL_HISTORY_GUIDE = `## Working from internal deal history

Internal deal history is your first source for the phase layer. Find the deals and companies with \`query_companies\` and \`get_company_details\`, and the memos, models and teasers behind them with \`query_files\`. Say which deal or document each phase figure came from.`;

/** MB-542 AC5: phase figures carry their basis. */
export const MODELLED_PHASE_RULE = `## Modelled versus observed phase figures — hard rule

Label every phase-layer figure **Observed** (taken from a filing, a disclosure or internal deal history) or **Modelled** (derived, assumed or extrapolated). Never let a modelled phase figure read as observed — in chat or inside an insight or dashboard.

${INSIGHT_MODELLED_MARKER_GUIDE}`;

export function buildBangunPrompt(seed: BangunSeed = BANGUN_SEED): string {
  return [
    renderIdentity(seed.key, seed.answers),
    renderSources('Sources', seed.sources, seed.dataLimits),
    renderMetricLayers('Metric set', seed.metricLayers),
    renderInheritedComponents(seed),
    INTERNAL_HISTORY_GUIDE,
    renderCohort(seed.cohort),
    MODELLED_PHASE_RULE,
    renderDataLimits(seed.dataLimits),
    renderRefreshScope(seed.refreshScope),
    renderOutOfSector(seed.key),
  ].join('\n\n');
}

export const BANGUN_PROMPT = buildBangunPrompt();
