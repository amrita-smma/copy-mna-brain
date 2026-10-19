import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { insightTemplateErrorResponse } from '@/app/api/insight-templates/errorResponse';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightTemplateService } = createContainer(db, workspaceId);

    const html = await insightTemplateService.getHtml(id);
    return NextResponse.json({ data: { html } });
  } catch (error: unknown) {
    return insightTemplateErrorResponse(error, '[GET /api/insight-templates/[id]]');
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightTemplateService } = createContainer(db, workspaceId);

    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const data = await insightTemplateService.update(id, body);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightTemplateErrorResponse(
      error,
      '[PATCH /api/insight-templates/[id]]',
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightTemplateService } = createContainer(db, workspaceId);

    // A soft delete (to Recently deleted) unless ?permanent=true.
    const permanent = req.nextUrl.searchParams.get('permanent') === 'true';
    if (permanent) {
      await insightTemplateService.deletePermanently(id);
    } else {
      await insightTemplateService.delete(id);
    }
    return NextResponse.json({ data: { id } });
  } catch (error: unknown) {
    return insightTemplateErrorResponse(
      error,
      '[DELETE /api/insight-templates/[id]]',
    );
  }
}
