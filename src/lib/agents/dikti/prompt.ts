/**
 * @dikti's sector prompt, built from its seed. Role-neutral: sector/rolePrompt.ts
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
import { INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE } from '@/lib/agents/sector/evidenceMarkers';
import { DIKTI_SEED, type DiktiSeed } from './seed';

function renderMechanism(seed: DiktiSeed): string {
  return `## How control of a campus changes hands

${seed.mechanismModel.map((m) => `- ${m}`).join('\n')}

So a campus rarely "sells": watch for the reportable events and the composition of the Pembina, not for a share transfer.`;
}

function renderWorkedCase(seed: DiktiSeed): string {
  const c = seed.workedCase;
  return `## Worked case: ${c.name}

${c.timeline.map((t) => `- ${t}`).join('\n')}

${c.corroboration} ${c.notes.join(' ')}

Use it as the pattern for how a quiet acquisition surfaces: a decree and a badan penyelenggara change, corroborated by the buyer's own disclosures, with no price.`;
}

/** US-04 (MB-543): every control-change finding is classified. */
export function renderObservedVsInferred(seed: DiktiSeed): string {
  const types = seed.observedSignalTypes;
  const list = `${types.slice(0, -1).join(', ')}, or ${types[types.length - 1]}`;
  return `## Observed versus inferred — hard rule

Every finding about a control change carries an explicit **Observed** or **Inferred** label.
- **Observed** is limited to ${list}.
- **Inferred** is everything else. Every inferred conclusion names the observed signals it was built from.
- Never present an inference as a disclosed transaction.
- Keep the labels when you write a finding into an insight or dashboard, not only in chat.

In chat, write the label in bold — **Observed**, or **Inferred** followed by "from:" and the observed signals it was built from — so the CoPilot shows it as a label.

${INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE}`;
}

export function buildDiktiPrompt(seed: DiktiSeed = DIKTI_SEED): string {
  return [
    renderIdentity(seed.key, seed.answers),
    renderMechanism(seed),
    renderSources('Signal sources', seed.sources, seed.dataLimits),
    renderPremiumSources(),
    renderMetricLayers('Metric set', seed.metricLayers),
    renderCohort(seed.cohort),
    renderWorkedCase(seed),
    renderObservedVsInferred(seed),
    renderDataLimits(seed.dataLimits),
    renderRefreshScope(seed.refreshScope),
    renderOutOfSector(seed.key),
  ].join('\n\n');
}

export const DIKTI_PROMPT = buildDiktiPrompt();
