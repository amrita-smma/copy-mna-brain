/**
 * @minerba's sector prompt, built from its seed. Role-neutral: sector/rolePrompt.ts
 * wraps it with the chat or workforce scaffolding.
 */
import {
  renderCohort,
  renderDataLimits,
  renderIdentity,
  renderMetricLayers,
  renderOutOfSector,
  renderPremiumSources,
  renderRefreshScope,
  renderSources,
} from '@/lib/agents/sector/promptParts';
import { MINERBA_SEED, type MinerbaSeed } from './seed';

function renderWatchlist(seed: MinerbaSeed): string {
  const lines = seed.regulatoryWatchlist.map(
    (w) => `- ${w.instrument}${w.note ? ` (${w.note})` : ''}`,
  );
  return `## Regulatory watchlist

${lines.join('\n')}

These instruments move royalty, quota and licence positions. When a question turns on one of them, check it for changes before you rely on the version you know, and date what you report.`;
}

export function buildMinerbaPrompt(seed: MinerbaSeed = MINERBA_SEED): string {
  return [
    renderIdentity(seed.key, seed.answers),
    renderSources('Sources', seed.sources, seed.dataLimits),
    renderPremiumSources(),
    renderMetricLayers('Metric set', seed.metricLayers),
    renderWatchlist(seed),
    renderCohort(seed.cohort),
    renderDataLimits(seed.dataLimits, seed.limitsRule),
    renderRefreshScope(seed.refreshScope),
    renderOutOfSector(seed.key),
  ].join('\n\n');
}

export const MINERBA_PROMPT = buildMinerbaPrompt();
