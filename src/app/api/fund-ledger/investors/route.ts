import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  FL_DOMAIN_ERRORS,
  type CreateInvestorInput,
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

export async function GET() {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flMasterDataService } = createContainer(db, workspaceId);
    const data = await flMasterDataService.listInvestors(workspaceId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flMasterDataService } = createContainer(db, workspaceId);
    const body = await req.json();

    // Internal-only deterministic IDs (id) are intentionally omitted:
    // API routes must never forward caller-supplied internal IDs
    // and must build service inputs field-by-field rather than spreading request JSON.
    const data = await flMasterDataService.createInvestor(workspaceId, {
      name: body.name,
      legal_name: body.legal_name ?? null,
      english_name: body.english_name ?? null,
      investor_type: body.investor_type,
      country: body.country ?? null,
      parent_investor_id: body.parent_investor_id ?? null,
      notes: body.notes ?? null,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
