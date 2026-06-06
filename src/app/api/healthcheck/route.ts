import { NextResponse } from 'next/server';

// Publicly-accessible liveness probe. Returns 200 if the app is serving
// requests. Intentionally does not touch the DB or any service so it stays
// fast and dependency-free.
export async function GET() {
  return NextResponse.json({ data: { status: 'ok' } }, { status: 200 });
}
