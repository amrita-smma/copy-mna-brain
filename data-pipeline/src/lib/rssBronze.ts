/**
 * Bronze layer: the immutable raw archive of everything the poller accepted.
 *
 * Postgres is the serving store; this is the replay log. If extraction or
 * classification improves later we can re-derive from bronze instead of
 * re-polling feeds that no longer carry old entries.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NormalizedItem } from '../handlers/rssNormalize';

export interface BronzeDeps {
  /** Injected for tests; defaults to a real S3 client in the configured region. */
  send?: (command: PutObjectCommand) => Promise<unknown>;
  bucket?: string;
  now?: Date;
}

let cachedClient: S3Client | null = null;

function defaultSend(command: PutObjectCommand): Promise<unknown> {
  cachedClient ??= new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-3' });
  return cachedClient.send(command);
}

export function bronzeKey(category: string, ingestDate: string, runTimestamp: string): string {
  return `bronze/category=${category}/ingest_date=${ingestDate}/run_${runTimestamp}.ndjson`;
}

export async function writeBronze(
  items: NormalizedItem[],
  runTimestamp: string,
  deps: BronzeDeps = {},
): Promise<string[]> {
  const bucket = deps.bucket ?? process.env.RSS_BRONZE_BUCKET;
  // No bucket configured (local dev / SAM) — the DB is still the source of
  // truth, so skip the archive instead of failing the run.
  if (!bucket || items.length === 0) return [];

  const send = deps.send ?? defaultSend;
  const ingestDate = (deps.now ?? new Date()).toISOString().slice(0, 10);

  const byCategory = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    const bucketed = byCategory.get(item.category);
    if (bucketed) bucketed.push(item);
    else byCategory.set(item.category, [item]);
  }

  const keys: string[] = [];
  for (const [category, categoryItems] of byCategory) {
    const key = bronzeKey(category, ingestDate, runTimestamp);
    const body = categoryItems.map((i) => JSON.stringify(i)).join('\n') + '\n';
    await send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/x-ndjson',
      }),
    );
    keys.push(key);
  }

  return keys;
}
