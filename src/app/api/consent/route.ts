import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';

export async function POST(_request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = createDb();
    // Consent is user-scoped, not workspace-scoped — `getActiveWorkspaceId()`
    // (not the throwing variant) is only here to satisfy `createContainer`'s
    // signature and never affects what ConsentService does.
    const { consentService } = createContainer(db, await getActiveWorkspaceId());
    const data = await consentService.recordConsent(session.user.id);

    return NextResponse.json({ data });
  } catch (error) {
    console.error('POST consent error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
