import type { CompanySlidesRepository, TablesInsert } from '@/lib/repositories';
import {
  runSlideGeneration,
  SLIDE_GENERATION_TIMEOUT_SECONDS,
  type SlideGenerationPayload,
} from '@/lib/jobs/handlers/slideGeneration';
import type { JobDispatcher } from './jobDispatcher';

export class SlideService {
  constructor(
    private readonly slidesRepo: CompanySlidesRepository,
    private readonly jobDispatcher: JobDispatcher,
  ) {}

  findByCompanyId(companyId: string) {
    return this.slidesRepo.findByCompanyId(companyId);
  }

  create(data: Omit<TablesInsert<'company_slides'>, 'workspace_id'>) {
    return this.slidesRepo.insert(data);
  }

  update(id: string, updates: Parameters<CompanySlidesRepository['update']>[1]) {
    return this.slidesRepo.update(id, updates);
  }

  delete(id: string) {
    return this.slidesRepo.delete(id);
  }

  generateDispatch(payload: SlideGenerationPayload): Promise<{ jobId: string }> {
    return this.jobDispatcher.dispatch({
      type: 'slide_generation',
      payload: payload as unknown as Record<string, unknown>,
      timeoutSeconds: SLIDE_GENERATION_TIMEOUT_SECONDS,
      work: async () => runSlideGeneration(payload),
    });
  }
}
