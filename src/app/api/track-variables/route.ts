import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { trackVariableService } = createContainer(db, await getActiveWorkspaceId());
    const trackId = req.nextUrl.searchParams.get('trackId') ?? undefined;
    const data = await trackVariableService.findAll(trackId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch track variables';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const db = createDb();
    const { trackVariableService } = createContainer(db, await getActiveWorkspaceId());
    const { trackId, name, unit, type, options, sortOrder } = await req.json();
    if (!trackId || !name) {
      return NextResponse.json(
        { error: 'trackId and name are required' },
        { status: 400 },
      );
    }
    const data = await trackVariableService.create({
      trackId,
      name,
      unit,
      type,
      options,
      sortOrder,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create track variable';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
