import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET() {
  try {
    const db = createDb();
    const { fundSourceService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundSourceService.listFundSources();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch fund sources';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name } = await req.json();
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const db = createDb();
    const { fundSourceService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundSourceService.createFundSource({ name });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create fund source';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
