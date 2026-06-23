import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import type { InsightsSettings } from '@/lib/services/dashboardInsightsService';

export async function GET() {
  try {
    const db = createDb();
    const { dashboardInsightsService } = createContainer(db);
    const data = await dashboardInsightsService.getSettingsWithMeta();
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as Partial<InsightsSettings>;

    if (
      !body ||
      typeof body.funnelTargets !== 'object' ||
      body.funnelTargets === null ||
      typeof body.l0l1Conversion !== 'object' ||
      body.l0l1Conversion === null
    ) {
      return NextResponse.json(
        { error: 'funnelTargets and l0l1Conversion are required' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { dashboardInsightsService } = createContainer(db);
    const data = await dashboardInsightsService.saveSettings(
      body as InsightsSettings,
      session.user.id,
    );
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
