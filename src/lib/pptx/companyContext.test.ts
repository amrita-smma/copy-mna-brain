import { describe, expect, it } from 'vitest';
import { buildPresentationCompanyContext } from './companyContext';

describe('buildPresentationCompanyContext', () => {
  it('leads with the company name and its structured fields', () => {
    const context = buildPresentationCompanyContext(
      { target: 'Acme', segment: 'Semiconductor', geography: 'South Korea' },
      null,
    );

    expect(context).toContain('Company: Acme');
    expect(context).toContain('Segment: Semiconductor');
    expect(context).toContain('Geography: South Korea');
  });

  it('includes the deal team context so generated slides can use it', () => {
    const context = buildPresentationCompanyContext(
      { target: 'Acme', context: '## Background\nFounder wants out.' },
      null,
    );

    expect(context).toContain('Context recorded by the deal team');
    expect(context).toContain('Founder wants out.');
  });

  it('omits the context block when the company has none', () => {
    expect(
      buildPresentationCompanyContext({ target: 'Acme', context: '   ' }, null),
    ).not.toContain('Context recorded by the deal team');
    expect(
      buildPresentationCompanyContext({ target: 'Acme' }, null),
    ).not.toContain('Context recorded by the deal team');
  });

  it('truncates an oversized context so one company cannot swamp the prompt', () => {
    const context = buildPresentationCompanyContext(
      { target: 'Acme', context: `${'x'.repeat(2_600)}TAIL` },
      null,
    );

    expect(context).not.toContain('TAIL');
    expect(context).toContain('…');
  });
});
