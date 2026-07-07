import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

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

    const data = await screeningService.prepare(groups);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to prepare screenings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
