import type { InvestmentThesisRepository, CriteriaRepository } from '@/lib/repositories';

export interface BuildContextOptions {
  /**
   * Identifying info for the currently-signed-in user. Only personalization
   * fields belong here — auth-sensitive values like email are NOT injected
   * into the system prompt; they're threaded through runtime config to the
   * tools that need them (see `email_research_summary`).
   */
  user?: {
    name?: string | null;
  };
}

export class ChatService {
  constructor(
    private readonly thesisRepo: InvestmentThesisRepository,
    private readonly criteriaRepo: CriteriaRepository,
  ) {}

  async buildContext(opts: BuildContextOptions = {}): Promise<string> {
    try {
      const contextParts: string[] = [];

      if (opts.user?.name) {
        contextParts.push('## User context\n');
        contextParts.push(`- Name: ${opts.user.name}`);
        contextParts.push('');
      }

      const theses = await this.thesisRepo.findActiveList(3);
      if (theses.length > 0) {
        contextParts.push('## Current Investment Thesis\n');
        theses.forEach((thesis, i) => {
          contextParts.push(`### ${i + 1}. ${thesis.title}`);
          contextParts.push(thesis.content);
          contextParts.push('');
        });
      }

      const criteria = await this.criteriaRepo.findAll();
      if (criteria.length > 0) {
        contextParts.push('## Screening Criteria\n');
        contextParts.push('The following criteria are used to evaluate companies:\n');
        criteria.forEach((c, i) => {
          contextParts.push(`${i + 1}. **${c.name}**: ${c.prompt}`);
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
