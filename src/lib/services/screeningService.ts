import type {
  ScreeningGroupInput,
  ScreeningRepository,
  TablesInsert,
} from '@/lib/repositories';

export class ScreeningService {
  constructor(private readonly screeningRepo: ScreeningRepository) {}

  findAll(opts: { companyId?: string; onlyL0?: boolean }) {
    return this.screeningRepo.findAllWithRelations(opts);
  }

  create(data: TablesInsert<'screenings'>) {
    return this.screeningRepo.insert(data);
  }

  update(id: string, updates: Parameters<ScreeningRepository['update']>[1]) {
    return this.screeningRepo.update(id, updates);
  }

  /** Prepare per-track screening groups: one (company, track, criterion) row each. */
  prepare(groups: ScreeningGroupInput[]) {
    return this.screeningRepo.upsertOrReset(groups);
  }
}
