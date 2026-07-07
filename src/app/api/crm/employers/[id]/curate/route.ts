import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { EmployerNotFoundError } from '@/lib/services/crmService';
import type { EmployerUpdate } from '@/lib/repositories';

interface Ctx {
  params: Promise<{ id: string }>;
}

type CuratePatch = EmployerUpdate & {
  primary_pic?: {
    name?: string | null;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
  };
};

function pickPatch(raw: Record<string, unknown>): CuratePatch {
  const patch: CuratePatch = {};
  if (typeof raw.name === 'string') patch.name = raw.name;
  if ('industry' in raw) patch.industry = (raw.industry ?? null) as string | null;
  const pic = raw.primary_pic;
  if (pic && typeof pic === 'object') {
    const p = pic as Record<string, unknown>;
    patch.primary_pic = {
      name: typeof p.name === 'string' ? p.name : null,
      title: typeof p.title === 'string' ? p.title : null,
      email: typeof p.email === 'string' ? p.email : null,
      phone: typeof p.phone === 'string' ? p.phone : null,
    };
  }
  return patch;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const decision = body?.decision === 'skip' ? 'skip' : 'approve';
    const patch = pickPatch((body?.patch ?? {}) as Record<string, unknown>);
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.curateEmployer(id, decision, patch);
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
