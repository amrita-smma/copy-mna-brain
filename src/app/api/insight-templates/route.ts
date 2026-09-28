import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId, getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';
import { insightTemplateErrorResponse } from '@/app/api/insight-templates/errorResponse';

export async function GET(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    if (!workspaceId) {
      return NextResponse.json({ data: [] });
    }
    const db = createDb();
    const { insightTemplateService } = createContainer(db, workspaceId);
    // ?deleted=true lists Recently deleted instead of the live library.
    const deleted = req.nextUrl.searchParams.get('deleted') === 'true';
    const data = deleted
      ? await insightTemplateService.listDeleted()
      : await insightTemplateService.list();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightTemplateErrorResponse(error, '[GET /api/insight-templates]');
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightTemplateService } = createContainer(db, workspaceId);

    const body = await req.json();
    const { name, description, icon, html } = body ?? {};
    const userId = session.user.id;

    const data = await insightTemplateService.create({
      name,
      description,
      icon,
      html,
      userId,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    return insightTemplateErrorResponse(error, '[POST /api/insight-templates]');
  }
}
