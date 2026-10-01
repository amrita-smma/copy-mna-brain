import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { FileCompanyNameRequiredError } from '@/lib/services/fileService';
import { UserRepository } from '@/lib/repositories/userRepository';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Mint a company from a Smart File and link it to that file. Works for every
 * file type — unlike upload-time auto-ingest, which only mints companies for
 * deal-target documents. `name` is the (optional) name the user typed in the
 * matched-company chip's search box; without it the service falls back to
 * whatever the agent extracted.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    const { name: rawName } = (await request.json().catch(() => ({}))) as { name?: unknown };
    if (rawName != null && typeof rawName !== 'string') {
      return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
    }
    const name = typeof rawName === 'string' ? rawName : undefined;

    // `entered_by` is a UUID foreign key, so resolve the session to the
    // current database user rather than passing the display name — same
    // pattern as the approve route.
    const session = await auth();
    const db = createDb();
    const currentUser = session?.user?.email
      ? await new UserRepository(db).findByEmail(session.user.email)
      : null;

    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fileService.createCompanyFromFile(id, {
      name,
      enteredBy: currentUser?.id ?? null,
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof FileCompanyNameRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error('Create company from file error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to create company from file' },
      { status: 500 },
    );
  }
}
