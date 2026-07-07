import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET(request: NextRequest) {
  try {
    const companyId = new URL(request.url).searchParams.get('companyId');
    if (!companyId) {
      return NextResponse.json(
        { error: 'Missing required query parameter: companyId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { slideService } = createContainer(db, await getActiveWorkspaceId());
    const slides = await slideService.findByCompanyId(companyId);
    return NextResponse.json({ slides });
  } catch (error) {
    console.error('GET company-slides error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId, title, html, sort_order } = body;
    if (!companyId) {
      return NextResponse.json({ error: 'Missing required field: companyId' }, { status: 400 });
    }

    const db = createDb();
    const { slideService } = createContainer(db, await getActiveWorkspaceId());
    const slide = await slideService.create({
      company_id: companyId,
      title: title || 'Untitled',
      html: html || '',
      sort_order: sort_order ?? 0,
    });
    return NextResponse.json({ slide });
  } catch (error) {
    console.error('POST company-slides error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, title, html, sort_order } = body;
    if (!id) {
      return NextResponse.json({ error: 'Missing required field: id' }, { status: 400 });
    }

    const updates: { title?: string; html?: string; sort_order?: number } = {};
    if (title !== undefined) updates.title = title;
    if (html !== undefined) updates.html = html;
    if (sort_order !== undefined) updates.sort_order = sort_order;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const db = createDb();
    const { slideService } = createContainer(db, await getActiveWorkspaceId());
    const slide = await slideService.update(id, updates);
    return NextResponse.json({ slide });
  } catch (error) {
    console.error('PUT company-slides error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing required query parameter: id' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { slideService } = createContainer(db, await getActiveWorkspaceId());
    await slideService.delete(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE company-slides error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
