import type { InvestmentThesisRepository } from '@/lib/repositories';
import type { MarketScanningRoutineService } from './marketScanningRoutineService';

interface ThesisBody {
  id?: string;
  title?: string;
  content?: string;
  scan_frequency?: string;
  sources_count?: number;
  next_scan_at?: string;
}

export class InvestmentThesisService {
  constructor(
    private readonly thesisRepo: InvestmentThesisRepository,
    private readonly marketScanningRoutineService: MarketScanningRoutineService,
  ) {}

  findActive() {
    return this.thesisRepo.findActive();
  }

  async upsert(body: ThesisBody) {
    const { id, title, content, scan_frequency, sources_count, next_scan_at } = body;
    const saved = id
      ? await this.thesisRepo.update(id, { title, content, scan_frequency, sources_count })
      : await this.thesisRepo.insert({
          title: title || 'Default Thesis',
          content: content ?? '',
          scan_frequency,
          sources_count,
          next_scan_at,
        });

    // Realign the permanent market-scanning routine with the thesis cadence.
    // Best-effort: a routine sync hiccup must not fail the thesis save.
    try {
      await this.marketScanningRoutineService.sync(saved?.scan_frequency ?? scan_frequency);
    } catch (err) {
      console.error('[InvestmentThesisService] market-scanning routine sync failed:', err);
    }

    return saved;
  }
}
