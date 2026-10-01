import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';

function optionalText(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Creates an insight from an uploaded HTML file (MB-635): multipart form-data
 * with `file`, and optional `name` and `description`. Multipart, not JSON:
 * JSON-escaping a document near the 4 MB cap would push the body past
 * Vercel's 4.5 MB request limit. → `201 { data: InsightDetail }`.
 */
export async function POST(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceIdOrThrow();

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { error: 'Expected a multipart form with an HTML file' },
        { status: 400 },
      );
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing required field: file' }, { status: 400 });
    }

    const session = await auth();
    const db = createDb();
    const { insightService } = createContainer(db, workspaceId);
    const data = await insightService.uploadDocument({
      workspaceId,
      fileName: file.name,
      html: await file.text(),
      name: optionalText(form.get('name')),
      description: optionalText(form.get('description')),
      userId: session?.user?.id ?? null,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[POST /api/insights/upload]');
  }
}
