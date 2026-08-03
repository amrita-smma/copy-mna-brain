import { describe, expect, it } from 'vitest';
import { buildAgentPresentationPrompt } from './presentationPrompt';

describe('buildAgentPresentationPrompt', () => {
  it('includes title, brief, fidelity rules, and flexible structure note', () => {
    const prompt = buildAgentPresentationPrompt({
      title: 'Bank comps',
      brief: 'Compare Mandiri and BBCA.',
      companyContexts: ['Company: Mandiri\nSegment: Banking'],
    });
    expect(prompt).toContain('Bank comps');
    expect(prompt).toContain('Compare Mandiri and BBCA.');
    expect(prompt).toContain('Company: Mandiri');
    expect(prompt).toMatch(/Data fidelity/i);
    expect(prompt).toMatch(/NOT force a fixed 7-slide/i);
  });

  it('notes when no company context is attached', () => {
    const prompt = buildAgentPresentationPrompt({
      title: 'Topic deck',
      brief: 'Sector overview',
    });
    expect(prompt).toMatch(/No structured company records/i);
  });
});
