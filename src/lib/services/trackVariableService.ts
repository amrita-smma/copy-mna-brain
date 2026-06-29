import type { TrackVariableRepository } from '@/lib/repositories';
import type { TrackVariableType } from '@/lib/db/schema';

export interface TrackVariableInput {
  trackId: string;
  name: string;
  unit?: string | null;
  type?: TrackVariableType;
  options?: string[];
  sortOrder?: number;
}

export interface TrackVariableUpdate {
  name?: string;
  unit?: string | null;
  type?: TrackVariableType;
  options?: string[];
  sortOrder?: number;
}

export class TrackVariableService {
  constructor(private readonly trackVariableRepo: TrackVariableRepository) {}

  findAll(trackId?: string) {
    return this.trackVariableRepo.findAll(trackId);
  }

  create(input: TrackVariableInput) {
    return this.trackVariableRepo.insert({
      track_id: input.trackId,
      name: input.name,
      unit: input.unit ?? null,
      type: input.type ?? 'textbox',
      options: input.options ?? [],
      sort_order: input.sortOrder ?? 0,
    });
  }

  update(id: string, updates: TrackVariableUpdate) {
    return this.trackVariableRepo.update(id, {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.unit !== undefined ? { unit: updates.unit } : {}),
      ...(updates.type !== undefined ? { type: updates.type } : {}),
      ...(updates.options !== undefined ? { options: updates.options } : {}),
      ...(updates.sortOrder !== undefined ? { sort_order: updates.sortOrder } : {}),
    });
  }

  delete(id: string) {
    return this.trackVariableRepo.delete(id);
  }
}
