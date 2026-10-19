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
  /** Optional criteria that must pass for the track to pass screening; null = original rule. */
  min_optional_criteria_pass?: number | null;
}

interface ScanConfigBody {
  /** Theses ("Tracks") that make up the active market-scanning set. */
  thesisIds: string[];
  scan_frequency?: string;
  sources_count?: number;
}

/** Raised when a track's minimum optional criteria is not a non-negative whole number. */
export class InvalidTrackPassRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTrackPassRuleError';
  }
}

/** `undefined` = leave as is, `null` = back to the original rule, else a whole number >= 0. */
function parseMinOptionalPass(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidTrackPassRuleError(
      '`min_optional_criteria_pass` must be a whole number of at least 0, or null',
    );
  }
  return value;
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
    const min_optional_criteria_pass = parseMinOptionalPass(body.min_optional_criteria_pass);
    const saved = id
      ? await this.thesisRepo.update(id, {
          title,
          content,
          pic,
          scan_frequency,
          sources_count,
          min_optional_criteria_pass,
        })
      : await this.thesisRepo.insert({
          title: title || 'Default Thesis',
          content: content ?? '',
          pic,
          scan_frequency,
          sources_count,
          next_scan_at,
          min_optional_criteria_pass,
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
