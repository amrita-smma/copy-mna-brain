import type { DealNoteRepository } from '@/lib/repositories';
import { normalizeOccurredAt } from '@/lib/timeline/occurredAt';

/** A note body that is empty once trimmed — there is nothing to store. */
export class EmptyNoteError extends Error {
  constructor() {
    super('A note needs some text');
    this.name = 'EmptyNoteError';
  }
}

/** No note with that id is reachable from the active workspace. */
export class NoteNotFoundError extends Error {
  constructor(id: string) {
    super(`Note ${id} was not found`);
    this.name = 'NoteNotFoundError';
  }
}

export class DealNoteService {
  constructor(private readonly dealNoteRepo: DealNoteRepository) {}

  /**
   * @param occurredAt When the entry happened, if the author backdated it on
   * the timeline composer. Omitted means "now" — the column default stamps it.
   */
  create(dealId: string, content: string, stage?: string, occurredAt?: string | null) {
    const at = normalizeOccurredAt(occurredAt);
    return this.dealNoteRepo.insert({
      deal_id: dealId,
      content,
      stage: stage || 'L0',
      ...(at ? { created_at: at, updated_at: at } : {}),
    });
  }

  async update(id: string, content: string) {
    const trimmed = content?.trim();
    if (!trimmed) throw new EmptyNoteError();

    const row = await this.dealNoteRepo.update(id, { content: trimmed });
    if (!row) throw new NoteNotFoundError(id);
    return row;
  }

  delete(id: string) {
    return this.dealNoteRepo.delete(id);
  }
}
