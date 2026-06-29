import { describe, expect, it, vi } from 'vitest';
import { EmailAttachmentRepository } from './emailAttachmentRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
}

describe('EmailAttachmentRepository.listDistinctNeedsExtractHashes', () => {
  it('returns the resolved attachment banker_source and custodian_email for each content hash group', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([
      {
        id: 'att-1',
        content_hash: 'hash-1',
        doc_type: 'teaser',
        mime_type: 'application/pdf',
        filename: 'teaser.pdf',
        s3_key: 'attachments/hash-1.pdf',
        s3_bucket: 'mbox-archive',
        banker_source: 'Goldman Sachs',
        custodian_email: 'hendric@starcapital.co.id',
      },
      {
        id: 'att-2',
        content_hash: 'hash-1',
        doc_type: 'teaser',
        mime_type: 'application/pdf',
        filename: 'teaser.pdf',
        s3_key: 'attachments/hash-1.pdf',
        s3_bucket: 'mbox-archive',
        banker_source: 'Goldman Sachs',
        custodian_email: 'hendric@starcapital.co.id',
      },
    ]);

    const repo = new EmailAttachmentRepository(db as never);
    const out = await repo.listDistinctNeedsExtractHashes(100);

    expect(db.leftJoin).toHaveBeenCalledTimes(2);
    expect(out).toEqual([
      {
        content_hash: 'hash-1',
        doc_type: 'teaser',
        mime_type: 'application/pdf',
        filename: 'teaser.pdf',
        s3_key: 'attachments/hash-1.pdf',
        s3_bucket: 'mbox-archive',
        banker_source: 'Goldman Sachs',
        custodian_email: 'hendric@starcapital.co.id',
        ids: ['att-1', 'att-2'],
      },
    ]);
  });
});
