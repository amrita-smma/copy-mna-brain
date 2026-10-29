import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

interface Ctx {
  params: Promise<{ id: string }>;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * One page of a firm's contacts. `q` searches name / email server-side;
 * `limit` (≤ MAX_LIMIT) and `offset` page the result. Returns
 * `{ data, total, inferred_focus }`, where `total` counts every contact
 * matching `q` and `inferred_focus` covers this page's contacts.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(
      Math.max(Number(sp.get('limit')) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = Math.max(Number(sp.get('offset')) || 0, 0);
    const search = sp.get('q')?.trim() || undefined;
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const { data, total, inferred_focus } = await crmService.listContactsPage(id, {
      search,
      limit,
      offset,
    });
    return NextResponse.json({ data, total, inferred_focus });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    if (!body?.name) {
      return NextResponse.json(
        { error: 'name is required' },
        { status: 400 },
      );
    }
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.createContact({
      employerId: id,
      name: body.name,
      email: body.email,
      phone: body.phone,
      title: body.title,
      type: body.type,
      department: body.department,
      specialization: body.specialization,
      seniority: body.seniority,
      coverageRegion: body.coverage_region,
      linkedinUrl: body.linkedin_url,
      bio: body.bio,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
