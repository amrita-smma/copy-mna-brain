import type { DealLinkRepository } from '@/lib/repositories';
import { normalizeOccurredAt } from '@/lib/timeline/occurredAt';

export class DealLinkService {
  constructor(private readonly dealLinkRepo: DealLinkRepository) {}

  /**
   * @param occurredAt When the entry happened, if the author backdated it on
   * the timeline composer. Omitted means "now" — the column default stamps it.
   */
  create(
    dealId: string,
    url: string,
    title?: string | null,
    stage?: string,
    occurredAt?: string | null,
  ) {
    const at = normalizeOccurredAt(occurredAt);
    return this.dealLinkRepo.insert({
      deal_id: dealId,
      url,
      title: title || null,
      stage: stage || 'L0',
      ...(at ? { created_at: at } : {}),
    });
  }

  delete(id: string) {
    return this.dealLinkRepo.delete(id);
  }
}
