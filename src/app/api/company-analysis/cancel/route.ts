import { NextRequest, NextResponse, after } from 'next/server';
import { auth } from '@/auth';
import { createDb, withBackgroundDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { dispatcherTick } from '@/lib/workforce';

interface CancelBody {
  companyId?: unknown;
}

/**
 * Cancel an in-flight AI Company Card generation for a company.
 *
 * Looks up the non-terminal workforce run by company id (so it works even when
 * the client doesn't hold the runId, e.g. after a reload), flips it to a
 * terminal cancelled state, and clears the in-progress analysis row so the UI
 * returns to the "Generate AI Company Card" state.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as CancelBody;
    const companyId =
      typeof body.companyId === 'string' ? body.companyId.trim() : '';
    if (!companyId) {
      return NextResponse.json(
        { error: 'Missing required field: companyId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { companyAnalysisService } = createContainer(db, await getActiveWorkspaceId());
    const result = await companyAnalysisService.cancelDispatch(
      companyId,
      session.user.id,
    );

    // Free the dispatcher slot promptly instead of waiting for the cron tick.
    after(async () => {
      try {
        await withBackgroundDb(async (bgDb) => {
          await dispatcherTick(bgDb);
        });
      } catch (err) {
        console.error('[company-analysis cancel] dispatcher kick failed:', err);
      }
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('POST company-analysis/cancel error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
