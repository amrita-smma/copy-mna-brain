import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { InvalidTrackPassRuleError } from '@/lib/services/investmentThesisService';

export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { investmentThesisService } = createContainer(db, await getActiveWorkspaceId());
    // `?all=1` returns every thesis ("Track"); default returns the active one.
    const all = req.nextUrl.searchParams.get('all');
    const data = all
      ? await investmentThesisService.list()
      : await investmentThesisService.findActive();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch investment thesis';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const db = createDb();
    const { investmentThesisService } = createContainer(db, await getActiveWorkspaceId());
    const body = await req.json();
    const data = await investmentThesisService.upsert(body);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof InvalidTrackPassRuleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to save investment thesis';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
