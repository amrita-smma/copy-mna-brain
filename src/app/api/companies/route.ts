import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";

function parseBool(value: string | null) {
  return value === "true" || value === "1";
}

export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { companyService } = createContainer(db);
    const params = req.nextUrl.searchParams;

    const id = params.get("id") ?? undefined;
    const stage = params.get("stage") ?? undefined;
    const stageIn = params.get("stageIn")
      ? params.get("stageIn")!.split(",").filter(Boolean)
      : undefined;
    const excludeStage = params.get("excludeStage") ?? undefined;
    const stageNotNull = parseBool(params.get("stageNotNull"));
    const excludeDropped = parseBool(params.get("excludeDropped"));
    const createdAfter = params.get("createdAfter") ?? undefined;
    const orderBy = params.get("orderBy") ?? "updated_at";
    const orderDir = (params.get("orderDir") ?? "desc") as "asc" | "desc";
    const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
    const offset = params.get("offset")
      ? Number(params.get("offset"))
      : undefined;
    const countOnly = parseBool(params.get("countOnly"));
    const lite = parseBool(params.get("lite"));
    const q = params.get("q")?.trim() || undefined;

    if (countOnly) {
      const count = await companyService.count({
        id,
        stage,
        stageIn,
        excludeStage,
        stageNotNull,
        excludeDropped,
        createdAfter,
      });
      return NextResponse.json({ data: { count } });
    }

    if (id) {
      const data = await companyService.findByIdDTO(id);
      return NextResponse.json({ data });
    }

    if (lite) {
      // Lightweight paginated lookup for combobox use: returns only
      // `id` + `target`, supports server-side ILIKE search via `q`,
      // offset/limit pagination. Skips DTO joins entirely so each call
      // is cheap. The page size is clamped so a misbehaving caller can't
      // pull the entire `companies` table in one go.
      const liteLimit = Math.min(Math.max(limit ?? 50, 1), 100);
      const data = await companyService.listIdAndTargetPage({
        limit: liteLimit,
        offset,
        targetSearch: q,
      });
      return NextResponse.json({ data });
    }

    const data = await companyService.listDTO({
      stage,
      stageIn,
      excludeStage,
      stageNotNull,
      excludeDropped,
      createdAfter,
      orderBy,
      orderDir,
      limit,
      offset,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch companies";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const db = createDb();
    const { companyService } = createContainer(db);
    const { company, logAction } = await req.json();
    // `company` is a flat CompanyDTOInput — split across companies +
    // company_financials + company_fx_adjustments + company_screening_derived.
    const data = await companyService.createFromDTO(company, logAction);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.cause : undefined;
    console.error('[POST /api/companies]', cause ?? error);
    // Surface the underlying DB error (drizzle wraps the real Postgres message
    // in `.cause`) so callers/tests see the actual failure, not just
    // "Failed query: ...".
    const message =
      cause instanceof Error
        ? cause.message
        : error instanceof Error
          ? error.message
          : "Failed to create company";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const db = createDb();
    const { companyService } = createContainer(db);
    const { id, ids, updates, logAction } = await req.json();

    if (!updates || (!id && (!Array.isArray(ids) || ids.length === 0))) {
      return NextResponse.json(
        { error: "Missing id/ids or updates" },
        { status: 400 },
      );
    }

    if (id) {
      // Single-target patch accepts a flat CompanyDTOInput and splits writes.
      const data = await companyService.updateFromDTO(id, updates, logAction);
      return NextResponse.json({ data });
    }
    // Bulk patches only touch the slim `companies` row (wide-column bulk edits
    // haven't been used by the FE). Extend if a caller needs bulk DTO writes.
    const data = await companyService.updateMany(ids, updates, logAction);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to update company";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id)
      return NextResponse.json(
        { error: "Missing company id" },
        { status: 400 },
      );

    const db = createDb();
    const { companyService } = createContainer(db);
    await companyService.delete(id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to delete company";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
