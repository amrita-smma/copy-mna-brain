import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get("q");

    const db = createDb();
    const { crmService } = createContainer(db);

    const data = query
      ? await crmService.searchContacts(query)
      : await crmService.findAllContacts();

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Fetch contacts error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to fetch contacts" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, email, phone, company, title, type, notes } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 },
      );
    }

    const db = createDb();
    const { crmService } = createContainer(db);

    const data = await crmService.createContact({
      name,
      email,
      phone,
      company,
      title,
      type,
      notes,
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Create contact error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to create contact" },
      { status: 500 },
    );
  }
}
