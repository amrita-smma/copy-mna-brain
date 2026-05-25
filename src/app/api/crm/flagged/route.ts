import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export async function GET() {
  try {
    const db = createDb();
    const { crmService } = createContainer(db);
    const data = await crmService.listFlaggedEmployerDetails();
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
