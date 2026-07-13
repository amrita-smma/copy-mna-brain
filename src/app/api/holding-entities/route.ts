import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET() {
  try {
    const db = createDb();
    const { holdingEntityService } = createContainer(db, await getActiveWorkspaceId());
    const data = await holdingEntityService.listHoldingEntities();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch holding entities';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, holdingEntityType } = await req.json();
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { holdingEntityService } = createContainer(db, workspaceId);
    const data = await holdingEntityService.createHoldingEntity({
      name,
      entity_type: holdingEntityType,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create holding entity';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
