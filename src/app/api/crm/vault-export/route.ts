import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { runVaultExport, VAULT_EXPORT_TIMEOUT_SECONDS } from '@/lib/jobs/handlers/vaultExport';
import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const db = createDb();
    const { jobService } = createContainer(db, await getActiveWorkspaceId());

    // Validate that the service account is configured before queuing
    if (!process.env.GOOGLE_VAULT_SERVICE_ACCOUNT) {
      return NextResponse.json(
        { error: 'GOOGLE_VAULT_SERVICE_ACCOUNT is not configured' },
        { status: 503 },
      );
    }

    const { dispatchJob } = await import('@/lib/jobs/dispatch');
    const { createDb: createFreshDb } = await import('@/lib/server/db');

    const { jobId } = await dispatchJob({
      db,
      createDb: createFreshDb,
      type: 'vault_export',
      payload: {
        daysBack: 5,
      },
      timeoutSeconds: VAULT_EXPORT_TIMEOUT_SECONDS,
      work: ({ job, db: jobDb }) =>
        runVaultExport({ daysBack: 1 }, { db: jobDb, job }),
    });

    return NextResponse.json({ data: { jobId } }, { status: 202 });
  } catch (err) {
    console.error('[vault-export] failed to dispatch job:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
