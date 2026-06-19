import type { CompanyRepository, Tables } from '@/lib/repositories';
import type { RelationType } from '@/lib/repositories/companyRelationRepository';
import { DISCOVERED_STAGE } from '@/lib/constants';
import type { CompanyService } from './companyService';
import type { CompanyGraphService } from './companyGraphService';

/** One resolved side of a relationship plus whether we created it. */
export interface ResolvedCompany {
  row: Tables<'companies'>;
  /** True when the company was not on record and created at the `discovered` stage. */
  created: boolean;
}

export interface LinkByNameInput {
  sourceName: string;
  targetName: string;
  type: RelationType;
  notes?: string;
  evidence?: string;
  date?: string;
}

export interface LinkByNameResult {
  source: ResolvedCompany;
  target: ResolvedCompany;
}

/**
 * Business logic for linking two companies in the relationship graph (Neo4j).
 *
 * Resolution: each side is fuzzy-matched against existing companies by name
 * (`target` / `project_name`). If a side has no match, a new companies row is
 * created at the special `discovered` stage — these are companies surfaced
 * only because they appeared in a relationship, not because they entered the
 * deal pipeline. The resolved rows are then linked in the graph via
 * `CompanyGraphService.relateCompanies` (which upserts both nodes first so the
 * edge always attaches).
 *
 * Shared by the `update_company_relationship` agent tool (explicit single
 * relationship) and the `generate_company_card` flow (one edge per related
 * company surfaced in a company card).
 */
export class CompanyRelationshipService {
  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly companyService: CompanyService,
    private readonly companyGraphService: CompanyGraphService,
  ) {}

  /**
   * Resolve a company by name, creating a `discovered` row when absent.
   */
  async resolveOrCreateDiscovered(name: string): Promise<ResolvedCompany> {
    const trimmed = name.trim();
    const existing = await this.companyRepo.findByNameFuzzy(trimmed);
    if (existing) return { row: existing, created: false };

    const created = await this.companyService.create(
      {
        target: trimmed,
        pipeline_stage: DISCOVERED_STAGE,
        status: 'active',
      } as never,
      'CREATED_AS_DISCOVERED',
    );
    return { row: created, created: true };
  }

  /**
   * Link source --[type]--> target by name. Each side is resolved (or created
   * as `discovered`) and the directed edge is upserted in the graph.
   */
  async linkByName(input: LinkByNameInput): Promise<LinkByNameResult> {
    const source = await this.resolveOrCreateDiscovered(input.sourceName);
    const target = await this.resolveOrCreateDiscovered(input.targetName);

    await this.companyGraphService.relateCompanies({
      source: source.row,
      target: target.row,
      type: input.type,
      notes: input.notes,
      evidence: input.evidence,
      date: input.date,
    });

    return { source, target };
  }
}
