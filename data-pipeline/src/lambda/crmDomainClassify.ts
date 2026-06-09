import { loadSecretsFromSsm } from '../secrets';
import { createLambdaDb } from '../db';
import { withJob } from '../withJob';
import { runCrmDomainClassify } from '../handlers/crmDomainClassify';

export const handler = async (event: unknown, _ctx: unknown): Promise<{ ok: boolean; result: unknown }> => {
  const payload = (event ?? {}) as Record<string, unknown>;
  await loadSecretsFromSsm();
  const { pgClient, db } = await createLambdaDb();
  try {
    const result = await withJob(db, 'crm_domain_classify', payload, (deps) =>
      runCrmDomainClassify(payload as never, deps),
    );
    return { ok: true, result };
  } finally {
    await pgClient.end();
  }
};
