/**
 * Ping the configured database. Prints which env vars resolved, then runs
 * `SELECT 1` and reports round-trip time. Use to verify connectivity, IAM
 * auth, SSL, and that DB_* env vars are loaded correctly.
 *
 * Usage: pnpm db:ping
 */
import { config } from 'dotenv';
// Must call config() before dynamically importing db.ts — static imports are
// hoisted in CJS output, so db.ts's module-level client creation would run
// before dotenv if we used a static import here.
config({ path: '.env.local' });
config();

async function main() {
  const { createPostgresClientFromEnv, rdsIamDbAuthFromEnv } = await import(
    '../src/lib/server/db'
  );

  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT ?? '5432';
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  const useIam = rdsIamDbAuthFromEnv();

  console.log(`host:     ${host}:${port}`);
  console.log(`database: ${database}`);
  console.log(`user:     ${user}`);
  console.log(`auth:     ${useIam ? 'RDS IAM token' : 'password'}`);
  console.log('');

  const started = Date.now();
  const client = createPostgresClientFromEnv({
    connect_timeout: 10,
    prepare: false,
  });

  try {
    const rows = await client<{ now: Date; version: string }[]>`
      SELECT now() AS now, version() AS version
    `;
    const elapsed = Date.now() - started;
    console.log(`✓ connected in ${elapsed}ms`);
    console.log(`  server time: ${rows[0]?.now.toISOString()}`);
    console.log(`  ${rows[0]?.version}`);
  } finally {
    await client.end();
  }
}

type PgErr = Error & {
  code?: string;
  errno?: string | number;
  severity?: string;
  detail?: string;
  hint?: string;
  where?: string;
  schema_name?: string;
  table_name?: string;
  column_name?: string;
  constraint_name?: string;
  routine?: string;
  address?: string;
  port?: number;
  syscall?: string;
};

function explain(code?: string): string | undefined {
  // Common SQLSTATE / Node syscall codes you actually hit when a connection
  // fails. Not exhaustive — full list at https://www.postgresql.org/docs/current/errcodes-appendix.html
  const map: Record<string, string> = {
    ECONNREFUSED: 'nothing is listening on host:port (wrong host, port closed, or DB down)',
    ETIMEDOUT: 'TCP timeout — security group / firewall / VPN likely blocking',
    ENOTFOUND: 'DNS lookup failed — DB_HOST hostname is wrong',
    EHOSTUNREACH: 'no route to host — network/VPN issue',
    CERT_HAS_EXPIRED: 'server TLS cert expired',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS cert not trusted',
    '28P01': 'invalid password / IAM token rejected',
    '28000': 'invalid authorization (user does not exist or pg_hba.conf rejects)',
    '3D000': 'database does not exist (check DB_NAME)',
    '3F000': 'schema does not exist',
    '42501': 'insufficient privilege (role lacks permission)',
    '42P01': 'relation does not exist',
    '53300': 'too many connections',
    '57P03': 'database is starting up / not yet accepting connections',
    '08006': 'connection failure (often SSL handshake or server-side drop)',
    '08001': 'unable to establish connection',
  };
  return code ? map[code] : undefined;
}

main().catch((err: PgErr) => {
  console.error('✗ ping failed');
  if (err.code) {
    const hint = explain(err.code);
    console.error(`  code:     ${err.code}${hint ? `  — ${hint}` : ''}`);
  }
  if (err.severity) console.error(`  severity: ${err.severity}`);
  console.error(`  message:  ${err.message}`);
  if (err.detail) console.error(`  detail:   ${err.detail}`);
  if (err.hint) console.error(`  hint:     ${err.hint}`);
  if (err.where) console.error(`  where:    ${err.where}`);
  if (err.routine) console.error(`  routine:  ${err.routine}`);
  if (err.address) console.error(`  address:  ${err.address}:${err.port ?? ''}`);
  if (err.syscall) console.error(`  syscall:  ${err.syscall}`);
  process.exit(1);
});
