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
import type { PipelineStageRepository } from '@/lib/repositories';
import {
  CAPTAIN_FROM_STAGE_KEY,
  liveStages,
  stageKeysFrom,
  type PipelineStageDef,
} from '@/lib/pipeline/stages';

export class CompanyNotFoundForCardError extends Error {
  constructor(public readonly query: string) {
    super(`No company found matching "${query}".`);
    this.name = 'CompanyNotFoundForCardError';
  }
}

export interface CompanyCardDeck {
  /**
   * Id of the company the slides describe. Callers that assemble a multi-company
   * deck dedupe on this — display titles are not unique (two records can share a
   * name, and an unnamed one falls back to a placeholder).
   */
  companyId: string;
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
    // Optional: the workspace's stages, for the card's stage track and the
    // Sponsor/Captain label. Without it the six original stages are drawn.
    private readonly pipelineStageRepo?: PipelineStageRepository,
  ) {}

  private stagesPromise: Promise<PipelineStageDef[]> | null = null;

  /** Read once per service instance: an email of several cards builds each by id. */
  private pipelineStages(): Promise<PipelineStageDef[]> {
    if (!this.pipelineStageRepo) return Promise.resolve([]);
    this.stagesPromise ??= this.pipelineStageRepo
      .list()
      .then((rows) =>
        rows.map((r) => ({
          key: r.key,
          code: r.code,
          name: r.name,
          description: r.description,
          position: r.position,
          deleted: r.deleted_at !== null,
        })),
      )
      .catch((err: unknown) => {
        this.stagesPromise = null;
        throw err;
      });
    return this.stagesPromise;
  }

  /** Build the card slides for a company id. */
  async buildById(companyId: string): Promise<CompanyCardDeck> {
    const [company, analysis, tracks, currency, stageDefs] = await Promise.all([
      this.companyService.findByIdDTO(companyId),
      this.companyAnalysisService.findByCompanyId(companyId),
      this.investmentThesisService.list(),
      this.workspaceService.getDefaultCurrency(this.workspaceId),
      this.pipelineStages(),
    ]);
    const stages = stageDefs.length > 0 ? liveStages(stageDefs) : undefined;
    const captainStageKeys =
      stageDefs.length > 0 ? stageKeysFrom(stageDefs, CAPTAIN_FROM_STAGE_KEY) : undefined;

    const trackVariables = await this.resolveTrackVariables(
      company.slide_track_variable_ids ?? [],
      company.track_specific_variables ?? {},
    );

    const stage = company.pipeline_stage || 'L0';
    const dealLead = effectiveDealLead(company, stage, tracks as TrackLike[], captainStageKeys);

    const appUrl = (
      process.env.APP_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.NEXTAUTH_URL ??
      'http://localhost:3000'
    ).replace(/\/+$/, '');

    return {
      companyId,
      title: companyDisplayTitle(company, 'Company'),
      slides: buildCompanyCardSlides({
        company,
        analysis,
        currency,
        dealLead,
        trackVariables,
        companyUrl: `${appUrl}/pipeline/${companyId}`,
        stages,
        captainStageKeys,
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
