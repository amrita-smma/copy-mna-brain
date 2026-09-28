import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSIGHT_REFRESH_PROMPT,
  INSIGHT_REFRESH_SOURCES_PARAGRAPH,
  buildInsightRefreshPrompt,
} from './insightRefresh';

describe('buildInsightRefreshPrompt', () => {
  const NAMED = 'This is a scheduled refresh of the insight "Weekly Overview" (insight_id: ins-1).';
  const UNNAMED = 'This is a scheduled refresh of insight ins-1.';

  it.each([
    ['a named insight', 'Weekly Overview', 'Focus on supply chain issues.', NAMED, 'Focus on supply chain issues.'],
    ['an unnamed insight', null, 'Focus on market metrics.', UNNAMED, 'Focus on market metrics.'],
    ['a padded prompt, trimmed', 'Weekly Overview', '  \n Analyze Series B rounds.  \t ', NAMED, 'Analyze Series B rounds.'],
    ['an empty prompt, defaulted', 'Weekly Overview', '', NAMED, DEFAULT_INSIGHT_REFRESH_PROMPT],
    ['a whitespace prompt, defaulted', null, '   \n \t  ', UNNAMED, DEFAULT_INSIGHT_REFRESH_PROMPT],
  ])('wraps %s as header, prompt, then the fixed Sources paragraph', (_label, insightName, userPrompt, header, body) => {
    expect(buildInsightRefreshPrompt({ insightId: 'ins-1', insightName, userPrompt }).split('\n\n')).toEqual([
      header,
      body,
      INSIGHT_REFRESH_SOURCES_PARAGRAPH,
    ]);
  });

  it('keeps the Sources paragraph pointing at the section, markers and tools the refresh relies on', () => {
    expect(INSIGHT_REFRESH_SOURCES_PARAGRAPH).toContain('replace_insight_document');
    expect(INSIGHT_REFRESH_SOURCES_PARAGRAPH).toContain('edit_insight_section');
    expect(INSIGHT_REFRESH_SOURCES_PARAGRAPH).toContain('<section data-section="sources">');
    expect(INSIGHT_REFRESH_SOURCES_PARAGRAPH).toContain('data-evidence="unavailable"');
    expect(INSIGHT_REFRESH_SOURCES_PARAGRAPH).toContain('data-source-ref');
  });
});
