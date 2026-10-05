import { describe, it, expect } from 'vitest';
import { buildAddCompanyPrompt } from './addCompanyPrompt';

describe('buildAddCompanyPrompt', () => {
  it('lists the four required fields and ends by asking for the company name', () => {
    const prompt = buildAddCompanyPrompt([]);
    expect(prompt).toContain('Required (must have all 4):');
    expect(prompt).toContain('- Company name');
    expect(prompt).toContain('- Segment (broad category');
    expect(prompt).toContain('- HQ country (single country');
    expect(prompt).toContain('- What the company does (1-2 lines)');
    expect(prompt.trimEnd().endsWith('What’s the company name?')).toBe(true);
  });

  it('names only the active theses as the screen the financials feed', () => {
    const prompt = buildAddCompanyPrompt([
      { title: 'SEA Industrial Tech Roll-Up', is_active: true },
      { title: 'Dormant Thesis', is_active: false },
      { title: '  Korea Chemicals  ', is_active: true },
    ]);
    expect(prompt).toContain(
      '- Most recent fiscal year revenue, EBITDA, EV (USD mn) — these feed this workspace’s active thesis screen (SEA Industrial Tech Roll-Up; Korea Chemicals)',
    );
    expect(prompt).not.toContain('Dormant Thesis');
  });

  it('drops the thesis clause when no thesis is active', () => {
    const prompt = buildAddCompanyPrompt([
      { title: 'Dormant Thesis', is_active: false },
      { title: '   ', is_active: true },
      { title: null, is_active: true },
    ]);
    expect(prompt).toContain('- Most recent fiscal year revenue, EBITDA, EV (USD mn)\n');
    expect(prompt).not.toContain('active thesis screen');
  });
});
