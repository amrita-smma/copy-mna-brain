import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { EmployerNotFoundError } from '@/lib/services/crmService';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.getEmployerDetail(id);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof EmployerNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.updateEmployer(id, body);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof EmployerNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    await crmService.deleteEmployer(id);
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
