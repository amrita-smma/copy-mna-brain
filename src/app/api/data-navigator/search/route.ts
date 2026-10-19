import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { RSS_CATEGORIES } from '@/lib/db/schema';
import type { RssCategory } from '@/lib/db/schema';

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const query = params.get('q')?.trim();
    if (!query) {
      return NextResponse.json({ error: 'q is required' }, { status: 400 });
    }

    const categoryParam = params.get('category');
    const categories = categoryParam
      ? (categoryParam
          .split(',')
          .map((c) => c.trim())
          .filter((c) => (RSS_CATEGORIES as readonly string[]).includes(c)) as RssCategory[])
      : undefined;

    const db = createDb();
    const { dataNavigatorService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dataNavigatorService.searchNews(query, {
      topK: params.get('topK') ? Number(params.get('topK')) : undefined,
      categories,
      from: params.get('from') ?? undefined,
      selectedOnly: params.get('selectedOnly') === 'true',
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
