/**
 * Smoke test CLI for the AI Workforce queue (Tier 1 + Tier 2).
 *
 * Usage:
 *   pnpm tsx scripts/test-workforce.ts enqueue [agent_name]
 *   pnpm tsx scripts/test-workforce.ts dispatch     (Tier 2: needs dev server)
 *   pnpm tsx scripts/test-workforce.ts claim        (Tier 2: claim only, no start)
 *   pnpm tsx scripts/test-workforce.ts reap [stalenessSeconds]
 *   pnpm tsx scripts/test-workforce.ts list
 *
 * Notes:
 *   - enqueue skips after() (only works in request contexts) so the dispatcher
 *     does NOT auto-fire. Run `dispatch` or `claim` after.
 *   - `dispatch` in Tier 2 calls triggerWorkflowForRun which uses workflow/api
 *     start(). That needs the WDK runtime, which is set up by withWorkflow()
 *     in next.config.ts only when running under `next dev`. From a standalone
 *     tsx script, start() will likely fail. Use `claim` for direct testing,
 *     or use curl http://localhost:3000/api/cron/dispatch for the full flow.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { createDb } from '@/lib/server/db';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { dispatcherTick, reapStuckRuns } from '@/lib/workforce';

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const db = createDb();

  switch (cmd) {
    case 'enqueue': {
      const agentName = rest[0] ?? 'test_agent';
      const repo = new AiWorkforceQueueRepository(db);
      const { row, created } = await repo.createOrGetByIdempotencyKey({
        agent_name: agentName,
        trigger_source: 'api',
        input: { source: 'smoke_test', at: new Date().toISOString() },
        priority: 0,
      } as never);
      console.log(JSON.stringify({ runId: row.id, created, status: row.status }, null, 2));
      break;
    }
    case 'dispatch': {
      const result = await dispatcherTick(db);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'claim': {
      // Tier 2: bypass workflow trigger. Just claim a row so you can verify
      // the atomic-claim SQL without needing the WDK runtime.
      const repo = new AiWorkforceQueueRepository(db);
      const claimed = await repo.claimNextRunnable();
      console.log(JSON.stringify(claimed, null, 2));
      break;
    }
    case 'reap': {
      const stalenessSeconds = Number(rest[0] ?? 300);
      const result = await reapStuckRuns(db, { stalenessSeconds });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'list': {
      const rows = await db.execute(sql`
        SELECT id, agent_name, status, started_at, last_heartbeat_at, ended_at, error
        FROM ai_workforce_queue
        ORDER BY created_at DESC
        LIMIT 10
      `);
      console.log(JSON.stringify(rows, null, 2));
      break;
    }
    default:
      console.error('usage: pnpm tsx scripts/test-workforce.ts <enqueue|dispatch|reap|list> [args]');
      process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
