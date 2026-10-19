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
  console.error(error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flInvestmentTypeService } = createContainer(db, workspaceId);
    const data = await flInvestmentTypeService.list(workspaceId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flInvestmentTypeService } = createContainer(db, workspaceId);
    const body = await req.json();
    if (typeof body?.name !== 'string') {
      return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
    }
    const data = await flInvestmentTypeService.create(workspaceId, body.name);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
