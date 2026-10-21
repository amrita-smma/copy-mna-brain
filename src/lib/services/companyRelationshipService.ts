import type { CompanyRepository, Tables, TablesUpdate } from '@/lib/repositories';
import type { RelationType } from '@/lib/repositories/companyRelationRepository';
import { DISCOVERED_STAGE } from '@/lib/constants';
import type { CompanyService } from './companyService';
import type { CompanyGraphService } from './companyGraphService';
import type { RelatedCompany } from '@/lib/jobs/handlers/companyAnalysis';

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

export interface CombineCompaniesInput {
  /** The surviving company all edges and aliases roll up into. */
  mainId: string;
  /** Companies absorbed into `mainId` — their graph edges are rerouted to the
   *  main company, their names become aliases of it, and their rows are deleted. */
  otherIds: string[];
}

export interface CombineCompaniesResult {
  mainId: string;
  /** Number of companies absorbed. */
  combined: number;
  /** The main company's alias list after the merge. */
  aliases: string[];
}

/** Raised when a company referenced by a combine request does not exist. */
export class CompanyNotFoundError extends Error {
  constructor(id: string) {
    super(`Company ${id} not found`);
    this.name = 'CompanyNotFoundError';
  }
}

/** Raised when a combine request is structurally invalid (no main, no others). */
export class InvalidCombineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCombineError';
  }
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

  /**
   * Link every related company a Company Card surfaced to the analysed
   * company, skipping blanks and self-references. Best-effort per company: a
   * failed link is reported in its line and does not stop the rest. Returns
   * one human-readable line per attempted link.
   */
  async linkRelatedCompanies(
    companyName: string,
    relatedCompanies: RelatedCompany[],
  ): Promise<string[]> {
    const linked: string[] = [];
    for (const rc of relatedCompanies) {
      const name = rc.name?.trim();
      if (!name || name.toLowerCase() === companyName.toLowerCase()) continue;
      try {
        const { target } = await this.linkByName({
          sourceName: companyName,
          targetName: name,
          type: rc.relation_type,
          notes: rc.notes?.trim() || undefined,
          evidence: rc.evidence?.trim() || undefined,
        });
        linked.push(
          `"${target.row.target}" (${rc.relation_type}${target.created ? ', new discovered' : ''})`,
        );
      } catch (err) {
        console.error(`[companyRelationship] failed to link "${name}":`, err);
        linked.push(`"${name}" — link failed: ${(err as Error).message}`);
      }
    }
    return linked;
  }

  /**
   * Combine several companies into one. All graph edges to/from each non-main
   * company are rerouted onto the main company (Neo4j), the absorbed companies'
   * display names and existing aliases are recorded as aliases on the main
   * company (so future fuzzy name matching resolves to it), and the absorbed
   * company rows are deleted from Postgres (cascading their related data).
   *
   * The main company's aliases are persisted first — that write mirrors the
   * main node into the graph, guaranteeing it exists before edges are rerouted
   * onto it. Each absorbed company is then rerouted-and-deleted in the graph and
   * removed from Postgres.
   *
   * This is a privileged, workspace-admin-only action; the caller (route) is
   * responsible for the authorization gate.
   */
  async combineCompanies(input: CombineCompaniesInput): Promise<CombineCompaniesResult> {
    const mainId = input.mainId?.trim();
    if (!mainId) throw new InvalidCombineError('mainId is required');

    // De-dupe and drop the main id if it slipped into the others list.
    const otherIds = Array.from(new Set(input.otherIds ?? []))
      .map((id) => id?.trim())
      .filter((id): id is string => Boolean(id) && id !== mainId);
    if (otherIds.length === 0) {
      throw new InvalidCombineError('At least one other company to combine is required');
    }

    const main = await this.findCompanyOrThrow(mainId);
    const others: Tables<'companies'>[] = [];
    for (const id of otherIds) {
      others.push(await this.findCompanyOrThrow(id));
    }

    // Merge aliases case-insensitively, preserving first-seen casing. Seed with
    // the main company's current aliases, then fold in each absorbed company's
    // display name and its own aliases. Exclude the main company's own name.
    const mainName = displayName(main).toLowerCase();
    const byKey = new Map<string, string>();
    const add = (value: string | null | undefined) => {
      const v = value?.trim();
      if (!v) return;
      const key = v.toLowerCase();
      if (key === mainName) return;
      if (!byKey.has(key)) byKey.set(key, v);
    };
    (main.aliases ?? []).forEach(add);
    for (const other of others) {
      add(displayName(other));
      (other.aliases ?? []).forEach(add);
    }
    const aliases = Array.from(byKey.values());

    // Persist aliases first (this also mirrors the main node into the graph).
    await this.companyRepo.update(mainId, { aliases } as TablesUpdate<'companies'>);

    // Reroute each absorbed company's edges onto main, then delete it.
    for (const other of others) {
      await this.companyGraphService.reassignAndDeleteNode(other.id, mainId);
      await this.companyService.delete(other.id);
    }

    return { mainId, combined: others.length, aliases };
  }

  private async findCompanyOrThrow(id: string): Promise<Tables<'companies'>> {
    try {
      return await this.companyRepo.findById(id);
    } catch {
      throw new CompanyNotFoundError(id);
    }
  }
}

/** Display name for a company row: `target`, falling back to `project_name`. */
function displayName(company: Tables<'companies'>): string {
  return (company.target ?? company.project_name ?? '').trim();
}
