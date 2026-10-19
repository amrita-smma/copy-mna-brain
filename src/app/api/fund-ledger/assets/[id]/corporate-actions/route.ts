import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { corporateActionsEnabled } from '@/lib/flags';
import { createContainer } from '@/lib/services/container';
import {
  FL_DOMAIN_ERRORS,
  type OwnershipChangeRequest,
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
  console.error(error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Builds participant inputs field-by-field; never spreads request JSON into the service. */
function parseParticipants(raw: unknown): OwnershipChangeRequest[] {
  if (!Array.isArray(raw)) return raw as OwnershipChangeRequest[];
  return raw.map((p: Record<string, unknown>) => ({
    position_id: p?.position_id as string,
    pct_before: p?.pct_before as string,
    follow_on_amount: (p?.follow_on_amount as string | null | undefined) ?? null,
    pct_override: (p?.pct_override as string | null | undefined) ?? null,
    override_remark: (p?.override_remark as string | null | undefined) ?? null,
    pct_after: (p?.pct_after as string | null | undefined) ?? null,
  }));
}

/** GET — our positions in the company (with their current stake) and its ownership history. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await corporateActionsEnabled())) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flCorporateActionService } = createContainer(db, workspaceId);

    const data = await flCorporateActionService.getContext(workspaceId, id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

/** POST — record a corporate action on the company and each participating position's stake before and after. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await corporateActionsEnabled())) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flCorporateActionService } = createContainer(db, workspaceId);
    const body = await req.json();

    // Amounts pass through as given so invalid numeric JSON reaches, and is
    // rejected by, the service's validation.
    const data = await flCorporateActionService.record(workspaceId, {
      asset_id: id,
      action_type: body.action_type ?? 'funding_round',
      action_date: body.action_date,
      label: body.label ?? null,
      currency: body.currency,
      pre_money: body.pre_money,
      round_size: body.round_size,
      notes: body.notes ?? null,
      participants: parseParticipants(body.participants),
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
