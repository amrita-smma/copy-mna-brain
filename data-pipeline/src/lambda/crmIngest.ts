import { createLambdaDb } from '../db';
import { withJob } from '../withJob';
import { runCrmIngest } from '../handlers/crmIngest';

export const handler = async (event: unknown, _ctx: unknown): Promise<{ ok: boolean; result: unknown }> => {
  const payload = (event ?? {}) as Record<string, unknown>;
  const { pgClient, db } = await createLambdaDb();
  try {
    const result = await withJob(db, 'crm_ingest', payload, (deps) =>
      runCrmIngest(payload as never, deps),
    );
    return { ok: true, result };
  } finally {
    await pgClient.end();
  }
};
