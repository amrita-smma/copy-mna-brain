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

export async function GET(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const searchParams = req.nextUrl.searchParams;

    const positionIdsParam = searchParams.get('positionIds');
    const positionIds = positionIdsParam
      ? positionIdsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const limitParam = searchParams.get('limit');
    const limit =
      limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;

    const offsetParam = searchParams.get('offset');
    const offset =
      offsetParam !== null ? Number.parseInt(offsetParam, 10) : undefined;

    const db = createDb();
    const { flLedgerService } = createContainer(db, workspaceId);

    const { entries, total } = await flLedgerService.listEntriesByPositionIds(
      workspaceId,
      positionIds,
      {
        limit: limit !== undefined && !Number.isNaN(limit) ? limit : undefined,
        offset:
          offset !== undefined && !Number.isNaN(offset) ? offset : undefined,
      },
    );

    return NextResponse.json({ data: entries, total });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
