import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer, FL_DOMAIN_ERRORS } from '@/lib/services';

function handleRouteError(error: unknown) {
  if (
    FL_DOMAIN_ERRORS.some(
      (cls) =>
        error instanceof cls ||
        (error instanceof Error && error.name === cls.name),
    )
  ) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message, error_name: err.name },
      { status: 422 },
    );
  }
  const message =
    error instanceof Error ? error.message : 'Internal server error';
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    let closedAt: string | undefined = undefined;

    try {
      const body = await req.json();
      closedAt = body?.closed_at ?? body?.closedAt ?? undefined;
    } catch {
      // Body may be empty or not provided
    }

    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flPositionService } = createContainer(db, workspaceId);

    const data = await flPositionService.closePosition(
      workspaceId,
      id,
      closedAt,
    );

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
