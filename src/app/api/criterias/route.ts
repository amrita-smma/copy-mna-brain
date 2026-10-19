import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { criteriaService } = createContainer(db, await getActiveWorkspaceId());
    const thesisId = req.nextUrl.searchParams.get('thesisId') ?? undefined;
    const data = await criteriaService.findAll(thesisId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch criterias';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const db = createDb();
    const { criteriaService } = createContainer(db, await getActiveWorkspaceId());
    const { name, prompt, investmentThesisId, mustPass } = await req.json();
    const data = await criteriaService.create(name, prompt, investmentThesisId, mustPass === true);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create criteria';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
