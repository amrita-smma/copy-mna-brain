/**
 * Mint an API key for an external authorized application.
 *
 * Prints the raw token EXACTLY ONCE — it is never stored and cannot be
 * recovered. Hand it to the client over a secure channel.
 *
 * Usage:
 *   pnpm tsx scripts/issue-api-key.ts "<client name>" [scope,scope,...]
 *
 * Examples:
 *   pnpm tsx scripts/issue-api-key.ts "Acme Integration"
 *   pnpm tsx scripts/issue-api-key.ts "Read-only bot" chat:read
 */
import { config } from 'dotenv';
// Load env before importing db.ts (its client is created at module load).
config({ path: '.env.local' });
config();

async function main() {
  const [, , name, scopesArg] = process.argv;
  if (!name) {
    console.error('Usage: pnpm tsx scripts/issue-api-key.ts "<client name>" [scope,scope,...]');
    process.exit(1);
  }

  const { createDb } = await import('../src/lib/server/db');
  const { createContainer } = await import('../src/lib/services');

  const scopes = scopesArg
    ? scopesArg.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const db = createDb();
  const { apiKeyService } = createContainer(db);

  const { token, key } = await apiKeyService.issue({ name, scopes });

  console.log('✓ API key issued');
  console.log(`  id:     ${key.id}`);
  console.log(`  name:   ${key.name}`);
  console.log(`  scopes: ${key.scopes.join(', ')}`);
  console.log('');
  console.log('  Token (shown once — store it securely now):');
  console.log(`  ${token}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✗ failed to issue API key');
    console.error(err);
    process.exit(1);
  });
