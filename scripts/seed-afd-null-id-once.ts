/**
 * One-shot local insert for an awaiting_review AFD file whose matched_companies
 * entry has id: null (name-only). For testing HITL create-from-AI.
 *
 * Usage: pnpm exec tsx scripts/seed-afd-null-id-once.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

async function main() {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { eq } = await import('drizzle-orm');
  const { files } = await import('../src/lib/db/schema');
  const { MNA_WORKSPACE_ID } = await import('../src/lib/constants');
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');

  const client = createPostgresClientFromEnv({ prepare: false });
  const db = drizzle(client);

  const fileName = 'Seed AFD - Null Id Match Teaser.pdf';
  const matchedCompanies = [
    { id: null, name: 'Phantom Null Co', type: 'company', similarity: 1 },
  ];
  const structuredNotes = {
    file_type: 'prospectus',
    summary:
      'Seed awaiting-review prospectus with a null-id matched_companies entry for HITL create-from-AI testing.',
    prospectus_summary: {
      company_name: 'Phantom Null Co',
      project_name: 'Project Phantom Null',
      segment: 'Industrial Services',
      geography: 'Indonesia',
      company_focus: 'Seed fixture for null-id matched company review',
      website: 'https://phantom-null.example',
    },
    tags: ['seed', 'prospectus', 'null-id-match'],
    matched_companies: matchedCompanies,
    file_date: '2026-06-22',
  };

  await db.delete(files).where(eq(files.file_name, fileName));
  const [row] = await db
    .insert(files)
    .values({
      file_name: fileName,
      file_link: 'seed/afd/null-id-match-teaser.pdf',
      raw_notes:
        'Teaser for Phantom Null Co — detected by AI but not matched to any existing company (id is null).',
      structured_notes: JSON.stringify(structuredNotes, null, 2),
      tags: ['seed', 'prospectus', 'null-id-match'],
      processing_status: 'awaiting_review',
      matched_companies: matchedCompanies,
      file_date: '2026-06-22',
      file_type: 'prospectus',
      origin_email: false,
      workspace_id: MNA_WORKSPACE_ID,
    })
    .returning({
      id: files.id,
      file_name: files.file_name,
      processing_status: files.processing_status,
      matched_companies: files.matched_companies,
    });

  console.log(JSON.stringify(row, null, 2));
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
