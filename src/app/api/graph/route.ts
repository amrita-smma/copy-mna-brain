import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = createDb();
    const { companyService, companyGraphService } = createContainer(db, await getActiveWorkspaceId());

    const [ownCompanies, fullData] = await Promise.all([
      companyService.list({}),
      companyGraphService.getGraphData(),
    ]);

    // Company nodes in Neo4j carry no workspace_id (RFC Story 6, still open)
    // — every workspace's companies live in the same shared graph. Filter
    // down to this workspace's own companies here so a user never sees
    // another tenant's graph, even though the nodes aren't isolated at the
    // DB level.
    const ownIds = new Set(ownCompanies.map((c) => c.id));
    const data = {
      nodes: fullData.nodes.filter((n) => ownIds.has(n.id)),
      links: fullData.links.filter((l) => ownIds.has(l.source) && ownIds.has(l.target)),
    };

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
