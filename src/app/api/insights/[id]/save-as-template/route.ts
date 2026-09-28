import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';
import { insightTemplateErrorResponse } from '@/app/api/insight-templates/errorResponse';
import {
  InsightTemplateNotFoundError,
  InsightTemplateTooLargeError,
  InsightTemplateValidationError,
} from '@/lib/services/insightTemplateService';

const TAG = '[POST /api/insights/[id]/save-as-template]';

export async function POST(
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
    const { insightService, insightTemplateService } = createContainer(db, workspaceId);

    const body = await req.json();
    const { name, description } = body ?? {};
    const userId = session.user.id;

    const insight = await insightService.get(workspaceId, id);
    const data = await insightTemplateService.createFromInsight({
      name,
      description,
      html: insight.html,
      userId,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    if (
      error instanceof InsightTemplateValidationError ||
      error instanceof InsightTemplateNotFoundError ||
      error instanceof InsightTemplateTooLargeError
    ) {
      return insightTemplateErrorResponse(error, TAG);
    }
    return insightErrorResponse(error, TAG);
  }
}
