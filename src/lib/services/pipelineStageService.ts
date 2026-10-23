import { randomBytes } from 'node:crypto';
import type {
  CompanyRepository,
  PipelineStageEdit,
  PipelineStagePatch,
  PipelineStageRepository,
  PipelineStageRow,
} from '@/lib/repositories';
import type { CompanyService } from './companyService';
import {
  CUSTOM_STAGE_KEY_PREFIX,
  FIRST_STAGE_KEY,
  STAGE_CODE_MAX_LENGTH,
  STAGE_DESCRIPTION_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
  liveStages,
  type PipelineStageDef,
} from '@/lib/pipeline/stages';

export class PipelineStageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineStageValidationError';
  }
}

export class PipelineStageNotFoundError extends Error {
  constructor(key: string) {
    super(`Pipeline stage "${key}" not found`);
    this.name = 'PipelineStageNotFoundError';
  }
}

/** The first stage (L0) can be renamed, but not deleted or moved. */
export class PipelineStageLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineStageLockedError';
  }
}

export interface CreatePipelineStageInput {
  code: unknown;
  name: unknown;
  description?: unknown;
  /** The live stage the new one goes directly after. */
  afterKey: unknown;
}

export interface UpdatePipelineStageInput {
  code?: unknown;
  name?: unknown;
  description?: unknown;
}

/** A stage row (soft-deleted ones too) as a stage definition. */
export function toDef(row: PipelineStageRow): PipelineStageDef {
  return {
    key: row.key,
    code: row.code,
    name: row.name,
    description: row.description,
    position: row.position,
    deleted: row.deleted_at !== null,
  };
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PipelineStageValidationError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new PipelineStageValidationError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function descriptionText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new PipelineStageValidationError('Description must be text');
  }
  if (value.length > STAGE_DESCRIPTION_MAX_LENGTH) {
    throw new PipelineStageValidationError(
      `Description must be at most ${STAGE_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return value.trim();
}

/**
 * A workspace's pipeline stages: rename and renumber, describe, add, reorder
 * and delete (MB-651). The stage rules stay on stage keys, so none of these
 * operations changes what a stage *does* — only how it reads and where it sits.
 */
export class PipelineStageService {
  constructor(
    private readonly stageRepo: PipelineStageRepository,
    private readonly companyRepo: CompanyRepository,
    private readonly companyService: CompanyService,
  ) {}

  /** Every stage in pipeline order, deleted ones included (flagged) so old deals can name them. */
  async list(): Promise<PipelineStageDef[]> {
    const rows = await this.stageRepo.list();
    return rows.map(toDef);
  }

  /** Add a stage directly after a live stage. Its key is generated and never changes. */
  async create(input: CreatePipelineStageInput): Promise<PipelineStageDef> {
    const code = requiredText(input.code, 'Code', STAGE_CODE_MAX_LENGTH);
    const name = requiredText(input.name, 'Display name', STAGE_NAME_MAX_LENGTH);
    const description = descriptionText(input.description);
    if (typeof input.afterKey !== 'string' || input.afterKey === '') {
      throw new PipelineStageValidationError('Choose the stage the new stage goes after');
    }
    const stages = await this.list();
    const after = liveStages(stages).find((s) => s.key === input.afterKey);
    if (!after) throw new PipelineStageNotFoundError(input.afterKey);
    this.assertCodeFree(stages, code);

    const key = `${CUSTOM_STAGE_KEY_PREFIX}${randomBytes(4).toString('hex')}`;
    const row = await this.stageRepo.insertAfter(after.position, { key, code, name, description });
    return toDef(row);
  }

  /** Change a live stage's code, display name or description. */
  async update(key: string, input: UpdatePipelineStageInput): Promise<PipelineStageDef> {
    const patch: PipelineStagePatch = {};
    if (input.code !== undefined) patch.code = requiredText(input.code, 'Code', STAGE_CODE_MAX_LENGTH);
    if (input.name !== undefined) {
      patch.name = requiredText(input.name, 'Display name', STAGE_NAME_MAX_LENGTH);
    }
    if (input.description !== undefined) patch.description = descriptionText(input.description);
    if (Object.keys(patch).length === 0) {
      throw new PipelineStageValidationError('Nothing to update');
    }
    if (patch.code !== undefined) {
      this.assertCodeFree(await this.list(), patch.code, key);
    }
    const row = await this.stageRepo.update(key, patch);
    if (!row) throw new PipelineStageNotFoundError(key);
    return toDef(row);
  }

  /**
   * Save every edited stage's code, display name and description together —
   * the Pipeline Settings "Save changes" button. All-or-nothing: each edit is
   * validated, and codes must be unique across the live stages *after* the
   * edits, so two stages can swap codes in one save. One write transaction.
   */
  async updateMany(input: unknown): Promise<PipelineStageDef[]> {
    if (!Array.isArray(input) || input.length === 0) {
      throw new PipelineStageValidationError('stages must be a non-empty list');
    }
    const edits: PipelineStageEdit[] = input.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PipelineStageValidationError('Each stage must be an object');
      }
      const { key, code, name, description } = item as Record<string, unknown>;
      if (typeof key !== 'string' || key === '') {
        throw new PipelineStageValidationError('Each stage needs its key');
      }
      return {
        key,
        code: requiredText(code, 'Code', STAGE_CODE_MAX_LENGTH),
        name: requiredText(name, 'Display name', STAGE_NAME_MAX_LENGTH),
        description: descriptionText(description),
      };
    });

    const editByKey = new Map(edits.map((e) => [e.key, e]));
    if (editByKey.size !== edits.length) {
      throw new PipelineStageValidationError('Each stage can only be edited once per save');
    }
    const live = liveStages(await this.list());
    for (const key of editByKey.keys()) {
      if (!live.some((s) => s.key === key)) throw new PipelineStageNotFoundError(key);
    }
    const seen = new Set<string>();
    for (const stage of live) {
      const code = editByKey.get(stage.key)?.code ?? stage.code;
      if (seen.has(code.toLowerCase())) {
        throw new PipelineStageValidationError(`Another stage already uses the code "${code}"`);
      }
      seen.add(code.toLowerCase());
    }

    await this.stageRepo.updateMany(edits);
    return this.list();
  }

  /**
   * Swap a live stage with its live neighbour. Its companies move with it —
   * they stay in their stage; only the order changes. L0 stays first: it
   * cannot move, and nothing can move above it.
   */
  async move(key: string, direction: 'up' | 'down'): Promise<PipelineStageDef[]> {
    if (key === FIRST_STAGE_KEY) {
      throw new PipelineStageLockedError('The first stage cannot be moved');
    }
    const live = liveStages(await this.list());
    const index = live.findIndex((s) => s.key === key);
    if (index === -1) throw new PipelineStageNotFoundError(key);
    const neighbour = live[direction === 'up' ? index - 1 : index + 1];
    if (!neighbour) {
      throw new PipelineStageValidationError(`The stage is already ${direction === 'up' ? 'first' : 'last'}`);
    }
    if (neighbour.key === FIRST_STAGE_KEY) {
      throw new PipelineStageLockedError('No stage can move above the first stage');
    }
    const stage = live[index];
    await this.stageRepo.setPositions([
      { key: stage.key, position: neighbour.position },
      { key: neighbour.key, position: stage.position },
    ]);
    return this.list();
  }

  /**
   * Delete a live stage. Its active deals move to `targetKey` first (required
   * when it has any), logged as ordinary stage moves so stage history and
   * stalled-deal timing stay correct. Dropped deals stay at the deleted stage
   * and keep naming it; restoring one asks for a stage. The stage row is
   * soft-deleted, so this cannot be undone from the UI.
   */
  async delete(key: string, targetKey?: string): Promise<{ moved: number }> {
    if (key === FIRST_STAGE_KEY) {
      throw new PipelineStageLockedError('The first stage cannot be deleted');
    }
    const live = liveStages(await this.list());
    if (!live.some((s) => s.key === key)) throw new PipelineStageNotFoundError(key);
    if (targetKey !== undefined) {
      if (targetKey === key) {
        throw new PipelineStageValidationError('Choose a different stage to move the companies to');
      }
      if (!live.some((s) => s.key === targetKey)) throw new PipelineStageNotFoundError(targetKey);
    }

    let moved = await this.moveActiveDeals(key, targetKey);
    const deleted = await this.stageRepo.softDelete(key);
    if (!deleted) throw new PipelineStageNotFoundError(key);
    // A deal moved into the stage between the move above and the delete would
    // be stranded in a deleted stage; sweep once more now that no new move can
    // target it.
    moved += await this.moveActiveDeals(key, targetKey);
    return { moved };
  }

  private async moveActiveDeals(fromKey: string, targetKey: string | undefined): Promise<number> {
    const ids = await this.companyRepo.findActiveIdsByStage(fromKey);
    if (ids.length === 0) return 0;
    if (!targetKey) {
      throw new PipelineStageValidationError(
        'This stage has companies in it. Choose a stage to move them to.',
      );
    }
    await this.companyService.promoteMany(
      ids.map((id) => ({ id, currentStage: fromKey })),
      targetKey,
    );
    return ids.length;
  }

  /** Codes are unique (case-insensitive) among live stages. */
  private assertCodeFree(stages: PipelineStageDef[], code: string, exceptKey?: string): void {
    const taken = liveStages(stages).some(
      (s) => s.key !== exceptKey && s.code.toLowerCase() === code.toLowerCase(),
    );
    if (taken) {
      throw new PipelineStageValidationError(`Another stage already uses the code "${code}"`);
    }
  }
}
