import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { FL_DOMAIN_ERRORS } from '@/lib/services';

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
    let description: string | undefined = undefined;
    let eventDate: string | undefined = undefined;

    try {
      const body = await req.json();
      description = body?.description ?? undefined;
      eventDate = body?.event_date ?? body?.eventDate ?? undefined;
    } catch {
      // Body may be empty or not provided
    }

    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flLedgerService } = createContainer(db, workspaceId);

    // Internal-only deterministic IDs (business_event_id) are intentionally omitted:
    // API routes must never forward caller-supplied internal IDs
    // and must build service inputs field-by-field rather than spreading request JSON.
    const data = await flLedgerService.reverseEvent(workspaceId, id, {
      description,
      event_date: eventDate,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
