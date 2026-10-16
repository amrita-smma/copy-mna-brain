import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { CompanyNotFoundError } from '@/lib/services/companyContactDiscoveryService';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The company's CRM firm, that firm's contacts ranked by partnership role,
 * and the latest @crm_contact discovery run. The Contact Details card loads this on open and polls it
 * while `run.active` is true.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const db = createDb();
    const { companyContactDiscoveryService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );
    return NextResponse.json({ data: await companyContactDiscoveryService.getState(id) });
  } catch (err) {
    if (err instanceof CompanyNotFoundError) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Queue an @crm_contact run that finds this company's top partnership
 * contacts. Returns immediately with the run; an in-flight run is reported
 * back (`created: false`) rather than treated as a conflict.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const session = await auth();
    const db = createDb();
    const { companyContactDiscoveryService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );
    const { run, created } = await companyContactDiscoveryService.discover(id, {
      triggeredByUserId: session?.user?.id ?? null,
    });
    return NextResponse.json({ data: { ...run, created } });
  } catch (err) {
    if (err instanceof CompanyNotFoundError) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
