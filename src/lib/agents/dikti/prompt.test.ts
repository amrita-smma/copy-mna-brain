import { describe, it, expect } from 'vitest';
import { DIKTI_PROMPT } from './prompt';
import { DIKTI_SEED } from './seed';
import {
  INSIGHT_DATA_LIMIT_MARKER_GUIDE,
  INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE,
} from '@/lib/agents/sector/evidenceMarkers';

describe('DIKTI_PROMPT', () => {
  it('states every declared data limit verbatim with its id, and teaches the data-limit block (MB-542)', () => {
    for (const limit of DIKTI_SEED.dataLimits) {
      expect(DIKTI_PROMPT).toContain(limit.statement);
      expect(DIKTI_PROMPT).toContain(`(id \`${limit.id}\`)`);
    }
    expect(DIKTI_PROMPT).toContain(INSIGHT_DATA_LIMIT_MARKER_GUIDE);
    // The chat renderer's data-limit callout keys on this bold lead.
    expect(DIKTI_PROMPT).toContain('Open that part of the answer with "**Data limit:**"');
  });

  it('carries the mechanism model and the Kalbis worked case', () => {
    expect(DIKTI_PROMPT).toContain(DIKTI_SEED.mechanismModel[0]);
    expect(DIKTI_PROMPT).toContain(DIKTI_SEED.workedCase.corroboration);
  });

  it('points out-of-sector questions at @minerba and @bangun', () => {
    const section = DIKTI_PROMPT.slice(DIKTI_PROMPT.indexOf('## Outside your sector'));
    expect(section).toContain('**@minerba**');
    expect(section).toContain('**@bangun**');
    expect(section).not.toContain('**@dikti**');
  });

  it('names the premium data tools in its premium data section', () => {
    expect(DIKTI_PROMPT).toContain('## Premium data sources');
    const section = DIKTI_PROMPT.slice(DIKTI_PROMPT.indexOf('## Premium data sources'));
    for (const tool of ['valyu_search', 'valyu_extract_content']) {
      expect(section).toContain(tool);
    }
    // AlphaSense is retired — no agent holds the tool, so no prompt names it.
    expect(section).not.toContain('alphasense_search');
  });

  it('teaches the observed and inferred pills inside the observed-vs-inferred rule (MB-543)', () => {
    const start = DIKTI_PROMPT.indexOf('## Observed versus inferred — hard rule');
    expect(start).toBeGreaterThanOrEqual(0);
    const rule = DIKTI_PROMPT.slice(start, DIKTI_PROMPT.indexOf('## Declared data limits'));
    expect(rule).toContain(INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE);
    expect(rule).toContain('**Inferred** followed by "from:"');
    expect(DIKTI_PROMPT).not.toContain('data-evidence="modelled"');
  });
});
