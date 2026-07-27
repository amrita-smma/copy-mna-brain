import { NextResponse } from 'next/server';

/**
 * Legacy in-app Vault → AdmZip → body_text path is retired.
 * Mailbox sync runs via the data-pipeline EventBridge Lambdas only.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        'Vault export via this path is retired. Mailbox sync runs through the ephemeral email pipeline.',
    },
    { status: 410 },
  );
}
