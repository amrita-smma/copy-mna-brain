import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';

/**
 * The relationship neighbourhood of a single company — the company itself plus
 * every company directly connected to it. Backs the relationship-graph snippet
 * on the company detail page.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const companyId = req.nextUrl.searchParams.get('companyId');
    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    const db = createDb();
    const { companyService, companyGraphService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );

    // The focal company must belong to the caller's workspace — Company nodes in
    // Neo4j carry no workspace_id, so the ownership check happens in Postgres.
    const [ownId] = await companyService.findExistingIds([companyId]);
    if (!ownId) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    const data = await companyGraphService.getCompanyNeighbourhood(companyId, (ids) =>
      companyService.findExistingIds(ids),
    );

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
