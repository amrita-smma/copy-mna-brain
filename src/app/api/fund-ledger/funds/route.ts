import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  FL_DOMAIN_ERRORS,
  type CreateFundInput,
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
    const data = await flMasterDataService.listFunds(workspaceId);
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
    // Financial/rate fields pass through directly without coercion so invalid numeric JSON
    // is preserved and rejected by domain validation in Phase 3.
    const data = await flMasterDataService.createFund(workspaceId, {
      name: body.name,
      legal_name: body.legal_name ?? null,
      english_name: body.english_name ?? null,
      registration_no: body.registration_no ?? null,
      managed: body.managed ?? false,
      ownership_basis: body.ownership_basis,
      base_currency: body.base_currency ?? 'USD',
      vintage_year: body.vintage_year ?? null,
      fund_life_years: body.fund_life_years ?? null,
      status: body.status ?? 'investing',
      mgmt_fee_rate: body.mgmt_fee_rate ?? null,
      carry_rate: body.carry_rate ?? null,
      preferred_return_rate: body.preferred_return_rate ?? null,
      description: body.description ?? null,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
