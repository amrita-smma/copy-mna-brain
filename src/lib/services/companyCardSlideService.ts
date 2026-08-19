/**
 * Assembles the data behind the "L0 → L1 Submission" Company Card and renders
 * it as PowerPoint shapes, so the exact card users see in `CompanyDetailDialog`
 * can be exported (today: emailed as a .pptx by the `send_email` tool).
 *
 * Only data assembly lives here — the layout/pagination maths is the pure
 * `@/lib/pptx/companyCardSlides` module, and writing the shapes it emits into a
 * .pptx is `@/lib/pptx/writePptx`. No headless browser is involved anywhere on
 * this path, so it works in runtimes with no Playwright binary.
 */
import type { CompanyService } from './companyService';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { InvestmentThesisService } from './investmentThesisService';
import type { TrackVariableService } from './trackVariableService';
import type { WorkspaceService } from './workspaceService';
import {
  buildCompanyCardSlides,
  type CompanyCardSlide,
  type CompanyCardTrackVariable,
} from '@/lib/pptx/companyCardSlides';
import { companyDisplayTitle } from '@/lib/companyDisplay';
import { effectiveDealLead, type TrackLike } from '@/lib/tracks/matchTracks';

export class CompanyNotFoundForCardError extends Error {
  constructor(public readonly query: string) {
    super(`No company found matching "${query}".`);
    this.name = 'CompanyNotFoundForCardError';
  }
}

export interface CompanyCardDeck {
  /** Display title of the company the slides describe. */
  title: string;
  slides: CompanyCardSlide[];
}

export class CompanyCardSlideService {
  constructor(
    private readonly companyService: CompanyService,
    private readonly companyAnalysisService: CompanyAnalysisService,
    private readonly investmentThesisService: InvestmentThesisService,
    private readonly trackVariableService: TrackVariableService,
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceId: string,
  ) {}

  /** Build the card slides for a company id. */
  async buildById(companyId: string): Promise<CompanyCardDeck> {
    const [company, analysis, tracks, currency] = await Promise.all([
      this.companyService.findByIdDTO(companyId),
      this.companyAnalysisService.findByCompanyId(companyId),
      this.investmentThesisService.list(),
      this.workspaceService.getDefaultCurrency(this.workspaceId),
    ]);

    const trackVariables = await this.resolveTrackVariables(
      company.slide_track_variable_ids ?? [],
      company.track_specific_variables ?? {},
    );

    const stage = (company.pipeline_stage || 'L0').toUpperCase();
    const dealLead = effectiveDealLead(company, stage, tracks as TrackLike[]);

    return {
      title: companyDisplayTitle(company, 'Company'),
      slides: buildCompanyCardSlides({
        company,
        analysis,
        currency,
        dealLead,
        trackVariables,
      }),
    };
  }

  /**
   * Build the card slides for a company referenced by name (target or project
   * name), as the agent tools address companies.
   */
  async buildByName(name: string): Promise<CompanyCardDeck> {
    const trimmed = name.trim();
    const company = trimmed ? await this.companyService.findByNameFuzzy(trimmed) : null;
    if (!company) throw new CompanyNotFoundForCardError(trimmed || name);
    return this.buildById(company.id);
  }

  /**
   * Pair the track-variable ids the user surfaced on the card with their
   * definitions and this company's stored values. Definitions are fetched once
   * for the whole set — never per id.
   */
  private async resolveTrackVariables(
    variableIds: string[],
    valuesByTrack: Record<string, Record<string, string>>,
  ): Promise<CompanyCardTrackVariable[]> {
    if (variableIds.length === 0) return [];
    const selected = new Set(variableIds);
    const defs = await this.trackVariableService.findAll();
    return defs
      .filter((v) => selected.has(v.id))
      .map((v) => ({
        name: v.name,
        unit: v.unit,
        value: valuesByTrack[v.track_id]?.[v.id] ?? '',
      }));
  }
}
