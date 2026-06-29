import type { CriteriaRepository } from '@/lib/repositories';

export class CriteriaService {
  constructor(private readonly criteriaRepo: CriteriaRepository) {}

  findAll(thesisId?: string) {
    return this.criteriaRepo.findAll(thesisId);
  }

  create(name: string, prompt: string, investmentThesisId?: string | null) {
    return this.criteriaRepo.insert({
      name,
      prompt,
      investment_thesis_id: investmentThesisId ?? null,
    });
  }

  update(id: string, name: string, prompt: string) {
    return this.criteriaRepo.update(id, { name, prompt });
  }

  delete(id: string) {
    return this.criteriaRepo.delete(id);
  }
}
