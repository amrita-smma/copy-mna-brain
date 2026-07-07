import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { EmployerNotFoundError } from '@/lib/services/crmService';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const companyId: string = body?.companyId?.trim();
    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
        { status: 400 },
      );
    }
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.addRelatedCompanyToEmployer(id, companyId);
    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    if (err instanceof EmployerNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const msg = (err as Error).message;
    if (msg.includes('already') || msg.includes('not found') || msg.includes('no name')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
