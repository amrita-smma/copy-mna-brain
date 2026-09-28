import { describe, it, expect } from 'vitest';
import { BANGUN_PROMPT, MODELLED_PHASE_RULE } from './prompt';
import { BANGUN_SEED } from './seed';
import {
  INSIGHT_DATA_LIMIT_MARKER_GUIDE,
  INSIGHT_MODELLED_MARKER_GUIDE,
} from '@/lib/agents/sector/evidenceMarkers';

describe('BANGUN_PROMPT', () => {
  it('states every declared data limit verbatim with its id, and teaches the data-limit block (MB-542)', () => {
    for (const limit of BANGUN_SEED.dataLimits) {
      expect(BANGUN_PROMPT).toContain(limit.statement);
      expect(BANGUN_PROMPT).toContain(`(id \`${limit.id}\`)`);
    }
    expect(BANGUN_PROMPT).toContain(INSIGHT_DATA_LIMIT_MARKER_GUIDE);
    // The chat renderer's data-limit callout keys on this bold lead.
    expect(BANGUN_PROMPT).toContain('Open that part of the answer with "**Data limit:**"');
  });

  it('carries the cohort', () => {
    for (const m of BANGUN_SEED.cohort.members) expect(BANGUN_PROMPT).toContain(`- ${m}`);
  });

  it('points out-of-sector questions at @minerba and @dikti', () => {
    const section = BANGUN_PROMPT.slice(BANGUN_PROMPT.indexOf('## Outside your sector'));
    expect(section).toContain('**@minerba**');
    expect(section).toContain('**@dikti**');
    expect(section).not.toContain('**@bangun**');
  });

  it('is not granted the premium data section', () => {
    expect(BANGUN_PROMPT).not.toContain('## Premium data sources');
  });

  it('teaches only the modelled insight pill, inside the modelled-phase rule (MB-542 AC5)', () => {
    expect(MODELLED_PHASE_RULE).toContain(INSIGHT_MODELLED_MARKER_GUIDE);
    expect(BANGUN_PROMPT).toContain(MODELLED_PHASE_RULE);
    expect(BANGUN_PROMPT).not.toContain('data-evidence="observed"');
  });
});
