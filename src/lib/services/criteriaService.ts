import type { CriteriaRepository } from '@/lib/repositories';

export class CriteriaService {
  constructor(private readonly criteriaRepo: CriteriaRepository) {}

  findAll(thesisId?: string) {
    return this.criteriaRepo.findAll(thesisId);
  }

  create(name: string, prompt: string, investmentThesisId: string, mustPass = false) {
    return this.criteriaRepo.insert({
      name,
      prompt,
      investment_thesis_id: investmentThesisId,
      must_pass: mustPass,
    });
  }

  /** `mustPass` left undefined keeps the criterion's current must-pass flag. */
  update(id: string, name: string, prompt: string, mustPass?: boolean) {
    return this.criteriaRepo.update(id, {
      name,
      prompt,
      ...(mustPass === undefined ? {} : { must_pass: mustPass }),
    });
  }

  delete(id: string) {
    return this.criteriaRepo.delete(id);
  }
}
