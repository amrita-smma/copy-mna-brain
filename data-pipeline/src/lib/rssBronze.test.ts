import { describe, it, expect, vi } from 'vitest';
import { writeBronze, bronzeKey } from './rssBronze';
import type { NormalizedItem } from '../handlers/rssNormalize';

function item(hash: string, category: NormalizedItem['category']): NormalizedItem {
  return {
    item_hash: hash,
    feed_id: 'f1',
    category,
    source_name: 'Wire',
    region: 'US',
    feed_tier: 'curated',
    title: 'T',
    link: 'https://example.com/x',
    summary: null,
    authors: null,
    tags: null,
    published_at: null,
  };
}

describe('bronzeKey', () => {
  it('uses hive-style category and ingest_date partitions', () => {
    expect(bronzeKey('new_funding', '2026-09-02', '20260902T0830Z')).toBe(
      'bronze/category=new_funding/ingest_date=2026-09-02/run_20260902T0830Z.ndjson',
    );
  });
});

describe('writeBronze', () => {
  it('writes one NDJSON object per category partition', async () => {
    const send = vi.fn().mockResolvedValue({});
    const keys = await writeBronze(
      [item('a', 'new_funding'), item('b', 'ma_partnerships'), item('c', 'new_funding')],
      '20260902T0830Z',
      { send, bucket: 'rss-lake', now: new Date('2026-09-02T08:30:00Z') },
    );

    expect(keys).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('serialises each item as its own NDJSON line', async () => {
    const send = vi.fn().mockResolvedValue({});
    await writeBronze([item('a', 'new_funding'), item('c', 'new_funding')], '20260902T0830Z', {
      send,
      bucket: 'rss-lake',
      now: new Date('2026-09-02T08:30:00Z'),
    });

    const body = send.mock.calls[0][0].input.Body as string;
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).item_hash).toBe('a');
  });

  it('writes nothing when there are no new items', async () => {
    const send = vi.fn();
    expect(
      await writeBronze([], '20260902T0830Z', { send, bucket: 'rss-lake', now: new Date() }),
    ).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips the archive entirely when no bucket is configured', async () => {
    const send = vi.fn();
    const keys = await writeBronze([item('a', 'new_funding')], '20260902T0830Z', {
      send,
      bucket: undefined,
      now: new Date(),
    });
    expect(keys).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces an S3 failure rather than silently losing the archive', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    await expect(
      writeBronze([item('a', 'new_funding')], '20260902T0830Z', {
        send,
        bucket: 'rss-lake',
        now: new Date(),
      }),
    ).rejects.toThrow('AccessDenied');
  });
});
