import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { auth } from '@/auth';

export async function POST(req: NextRequest) {
  try {
    const db = createDb();
    const { screeningService } = createContainer(db, await getActiveWorkspaceId());
    const { groups } = await req.json();

    if (
      !Array.isArray(groups) ||
      groups.some(
        (g) =>
          !g ||
          typeof g.companyId !== 'string' ||
          typeof g.trackId !== 'string' ||
          !Array.isArray(g.criteriaIds),
      )
    ) {
      return NextResponse.json(
        {
          error:
            'groups must be an array of { companyId, trackId, criteriaIds }',
        },
        { status: 400 },
      );
    }

    // Attributes the server-side `ai_screening_started` capture to the user who
    // kicked the run off rather than to 'server'.
    const session = await auth();
    const data = await screeningService.prepare(groups, session?.user?.id ?? null);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to prepare screenings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
