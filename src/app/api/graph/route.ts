import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createNeo4jDriver } from '@/lib/neo4j';
import { CompanyRelationRepository } from '@/lib/repositories/companyRelationRepository';
import { CompanyGraphService } from '@/lib/services/companyGraphService';

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const driver = createNeo4jDriver();
    const repo = new CompanyRelationRepository(driver);
    const service = new CompanyGraphService(repo);
    const data = await service.getGraphData();

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
