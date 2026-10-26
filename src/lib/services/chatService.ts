import type { InvestmentThesisRepository, CriteriaRepository } from '@/lib/repositories';

export class ChatService {
  constructor(
    private readonly thesisRepo: InvestmentThesisRepository,
    private readonly criteriaRepo: CriteriaRepository,
  ) {}

  async buildContext(): Promise<string> {
    try {
      const contextParts: string[] = [];

      // Independent reads, issued together: this runs on every chat turn's
      // critical path, so two sequential round trips would be paid twice.
      const [theses, criteria] = await Promise.all([
        this.thesisRepo.findActiveList(3),
        this.criteriaRepo.findAll(),
      ]);

      if (theses.length > 0) {
        contextParts.push('## Current Investment Thesis\n');
        theses.forEach((thesis, i) => {
          contextParts.push(`### ${i + 1}. ${thesis.title}`);
          contextParts.push(thesis.content);
          contextParts.push('');
        });
      }

      if (criteria.length > 0) {
        contextParts.push('## Screening Criteria\n');
        contextParts.push('The following criteria are used to evaluate companies:\n');
        criteria.forEach((c, i) => {
          contextParts.push(`${i + 1}. **${c.name}**${c.must_pass ? ' (must-pass)' : ''}: ${c.prompt}`);
        });
        contextParts.push('');
      }

      if (contextParts.length > 0) {
        return `\n---\n**CONTEXT: Use the following investment thesis and screening criteria to inform your analysis:**\n\n${contextParts.join('\n')}\n---\n\n`;
      }

      return '';
    } catch (error) {
      console.error('Error fetching context data:', error);
      return '';
    }
  }
}
