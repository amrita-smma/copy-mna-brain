import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const expected = process.env.ADMIN_SECRET;
  const provided = req.headers.get("x-api-secret");
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

// Admin routes live under /api/auth and are gated by the X-Api-Secret header
// (compared against ADMIN_SECRET above). Add new admin routes to this matcher.
export const config = {
  matcher: ["/api/auth/signup", "/api/auth/api-keys", "/api/auth/api-keys/:path*"],
};
