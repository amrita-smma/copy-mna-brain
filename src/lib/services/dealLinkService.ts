import type { DealDocumentRepository, DealLinkRepository } from '@/lib/repositories';
import { normalizeOccurredAt } from '@/lib/timeline/occurredAt';
import { assertFeaturableLink } from './featuredSlide';

export class DealLinkService {
  constructor(
    private readonly dealLinkRepo: DealLinkRepository,
    private readonly dealDocRepo: DealDocumentRepository,
  ) {}

  /**
   * @param occurredAt When the entry happened, if the author backdated it on
   * the timeline composer. Omitted means "now" — the column default stamps it.
   * @param featured Make this link the deal's Featured Slide (YouTube only),
   * superseding whatever document or link held it.
   */
  async create(
    dealId: string,
    url: string,
    title?: string | null,
    stage?: string,
    occurredAt?: string | null,
    featured = false,
  ) {
    const at = normalizeOccurredAt(occurredAt);
    if (featured) {
      assertFeaturableLink(url);
      await this.clearFeaturedSlide(dealId);
    }
    return this.dealLinkRepo.insert({
      deal_id: dealId,
      url,
      title: title || null,
      stage: stage || 'L0',
      ...(featured ? { is_featured: true } : {}),
      ...(at ? { created_at: at } : {}),
    });
  }

  /** Features a link already on the deal's timeline instead of adding a new one. */
  async setFeatured(dealId: string, linkId: string) {
    const row = await this.dealLinkRepo.findById(linkId);
    if (row.deal_id !== dealId) {
      throw new Error('Link does not belong to this deal');
    }
    assertFeaturableLink(row.url);
    await this.clearFeaturedSlide(dealId);
    await this.dealLinkRepo.markFeatured(linkId);
  }

  /** The featured slide is one item across documents and links — clear both. */
  private async clearFeaturedSlide(dealId: string) {
    await this.dealDocRepo.clearFeaturedByDealId(dealId);
    await this.dealLinkRepo.clearFeaturedByDealId(dealId);
  }

  delete(id: string) {
    return this.dealLinkRepo.delete(id);
  }
}
