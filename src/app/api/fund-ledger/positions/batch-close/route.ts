import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  FL_DOMAIN_ERRORS,
  InvalidPositionShapeError,
} from '@/lib/services';

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

export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new InvalidPositionShapeError('Request body must be valid JSON');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new InvalidPositionShapeError('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;

    if (!('position_ids' in record)) {
      throw new InvalidPositionShapeError('Missing required field: position_ids');
    }

    const { position_ids, closed_at } = record;

    if (!Array.isArray(position_ids) || position_ids.length === 0) {
      throw new InvalidPositionShapeError('position_ids must be a non-empty array of position IDs');
    }

    const seen = new Set<string>();
    for (const id of position_ids) {
      if (typeof id !== 'string' || !id.trim()) {
        throw new InvalidPositionShapeError('position_ids must contain only non-empty string IDs');
      }
      if (seen.has(id)) {
        throw new InvalidPositionShapeError(`Duplicate position ID: ${id}`);
      }
      seen.add(id);
    }

    if (closed_at !== undefined && closed_at !== null && typeof closed_at !== 'string') {
      throw new InvalidPositionShapeError('closed_at must be a string if provided');
    }

    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flPositionService } = createContainer(db, workspaceId);

    const data = await flPositionService.closePositions(
      workspaceId,
      position_ids,
      (closed_at as string | undefined) ?? undefined,
    );

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
