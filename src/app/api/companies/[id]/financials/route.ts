import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import type { FinancialUpsertInput } from '@/lib/services/companyService';

const FinancialRow = z.object({
  fiscal_year: z.number().int().min(1990).max(2100),
  revenue_usd_mn: z.number().finite().nullable().optional(),
  ebitda_usd_mn: z.number().finite().nullable().optional(),
});

const Body = z
  .object({
    rows: z.array(FinancialRow).max(200),
    deletedYears: z.array(z.number().int().min(1990).max(2100)).max(200).optional(),
    logAction: z.string().optional(),
  })
  .superRefine((b, ctx) => {
    const seen = new Set<number>();
    for (const r of b.rows) {
      if (seen.has(r.fiscal_year)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate year ${r.fiscal_year} in rows` });
      }
      seen.add(r.fiscal_year);
    }
    const dels = new Set(b.deletedYears ?? []);
    for (const y of seen) {
      if (dels.has(y)) {
        ctx.addIssue({ code: 'custom', message: `Year ${y} cannot be both upserted and deleted` });
      }
    }
  });

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    }
    const db = createDb();
    const { companyService } = createContainer(db);
    const data = await companyService.updateFinancials(
      id,
      parsed.data.rows as FinancialUpsertInput[],
      parsed.data.deletedYears ?? [],
      parsed.data.logAction ?? 'UPDATED_FINANCIALS',
    );
    return NextResponse.json({ data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update financials';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
