import type { InvestmentThesisRepository } from '@/lib/repositories';
import type { MarketScanningRoutineService } from './marketScanningRoutineService';

interface ThesisBody {
  id?: string;
  title?: string;
  content?: string;
  pic?: string | null;
  scan_frequency?: string;
  sources_count?: number;
  next_scan_at?: string;
}

interface ScanConfigBody {
  /** Theses ("Tracks") that make up the active market-scanning set. */
  thesisIds: string[];
  scan_frequency?: string;
  sources_count?: number;
}

export class InvestmentThesisService {
  constructor(
    private readonly thesisRepo: InvestmentThesisRepository,
    private readonly marketScanningRoutineService: MarketScanningRoutineService,
  ) {}

  findActive() {
    return this.thesisRepo.findActive();
  }

  /** List all theses ("Tracks") for the Track Settings manager. */
  list() {
    return this.thesisRepo.findAll();
  }

  remove(id: string) {
    return this.thesisRepo.deleteById(id);
  }

  /**
   * Configure the AI market scanner: choose which theses ("Tracks") are active
   * and apply the shared scan cadence + companies-per-scan to them. Returns the
   * full thesis list so the caller can reflect the new active set.
   */
  async configureScan({ thesisIds, scan_frequency, sources_count }: ScanConfigBody) {
    await this.thesisRepo.setActive(thesisIds);
    if (thesisIds.length > 0 && (scan_frequency !== undefined || sources_count !== undefined)) {
      await this.thesisRepo.updateMany(thesisIds, { scan_frequency, sources_count });
    }

    // Realign the permanent market-scanning routine with the chosen cadence.
    // Best-effort: a routine sync hiccup must not fail the configuration save.
    try {
      await this.marketScanningRoutineService.sync(scan_frequency);
    } catch (err) {
      console.error('[InvestmentThesisService] market-scanning routine sync failed:', err);
    }

    return this.thesisRepo.findAll();
  }

  async upsert(body: ThesisBody) {
    const { id, title, content, pic, scan_frequency, sources_count, next_scan_at } = body;
    const saved = id
      ? await this.thesisRepo.update(id, { title, content, pic, scan_frequency, sources_count })
      : await this.thesisRepo.insert({
          title: title || 'Default Thesis',
          content: content ?? '',
          pic,
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
