import { describe, it, expect } from 'vitest';
import { MINERBA_PROMPT } from './prompt';
import { MINERBA_SEED } from './seed';
import { INSIGHT_DATA_LIMIT_MARKER_GUIDE } from '@/lib/agents/sector/evidenceMarkers';

describe('MINERBA_PROMPT', () => {
  it('states every declared data limit verbatim with its id, and teaches the data-limit block (MB-542)', () => {
    for (const limit of MINERBA_SEED.dataLimits) {
      expect(MINERBA_PROMPT).toContain(limit.statement);
      expect(MINERBA_PROMPT).toContain(`(id \`${limit.id}\`)`);
    }
    expect(MINERBA_PROMPT).toContain(MINERBA_SEED.limitsRule);
    expect(MINERBA_PROMPT).toContain(INSIGHT_DATA_LIMIT_MARKER_GUIDE);
    // The chat renderer's data-limit callout keys on this bold lead.
    expect(MINERBA_PROMPT).toContain('Open that part of the answer with "**Data limit:**"');
  });

  it('carries its identity, question and cohort', () => {
    expect(MINERBA_PROMPT).toContain('You are @minerba');
    expect(MINERBA_PROMPT).toContain(MINERBA_SEED.answers);
    for (const m of MINERBA_SEED.cohort.members) expect(MINERBA_PROMPT).toContain(`- ${m}`);
  });

  it('points out-of-sector questions at @dikti and @bangun', () => {
    const section = MINERBA_PROMPT.slice(MINERBA_PROMPT.indexOf('## Outside your sector'));
    expect(section).toContain('**@dikti**');
    expect(section).toContain('**@bangun**');
    expect(section).not.toContain('**@minerba**');
  });

  it('names the premium data tools in its premium data section', () => {
    expect(MINERBA_PROMPT).toContain('## Premium data sources');
    const section = MINERBA_PROMPT.slice(MINERBA_PROMPT.indexOf('## Premium data sources'));
    for (const tool of ['valyu_search', 'inven_paid_data_source_search']) {
      expect(section).toContain(tool);
    }
    // AlphaSense is retired — no agent holds the tool, so no prompt names it.
    expect(section).not.toContain('alphasense_search');
  });

  it('does not teach the @dikti or @bangun pills', () => {
    expect(MINERBA_PROMPT).not.toContain('data-evidence="observed"');
    expect(MINERBA_PROMPT).not.toContain('data-evidence="modelled"');
  });
});
