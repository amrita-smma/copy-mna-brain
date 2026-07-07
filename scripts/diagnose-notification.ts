/**
 * Diagnose why a workforce-run notification didn't send — WITHOUT re-running a
 * task and WITHOUT actually sending email (the enqueue is faked).
 *
 * It exercises the real gate + run lookup + recipient resolution and prints the
 * reason via EmailNotificationService's logging.
 *
 * Usage:
 *   npx tsx /tmp/diagnose-notification.ts            # uses the most recent run
 *   npx tsx /tmp/diagnose-notification.ts <run-id>   # a specific run
 */
import { config } from 'dotenv';
// Load env exactly like the repo's scripts do, before importing db.ts.
config({ path: '.env.local' });
config({ path: '.env.vercel' }); // queue OIDC, if present
config();

async function main() {
  const runIdArg = process.argv[2];
  const { createDb } = await import('@/lib/server/db');
  const {
    AiWorkforceQueueRepository,
    RoutinesRepository,
    UserRepository,
    WorkspaceRepository,
  } = await import('@/lib/repositories');
  const { EmailNotificationService } = await import(
    '@/lib/services/emailNotificationService'
  );
  const { getActiveWorkspaceId } = await import('@/lib/workspace');

  const db = createDb();
  const wf = new AiWorkforceQueueRepository(db, await getActiveWorkspaceId());

  console.log('TASK_NOTIFICATIONS_ENABLED =', JSON.stringify(process.env.TASK_NOTIFICATIONS_ENABLED));
  console.log('APP_URL =', JSON.stringify(process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? ''));

  const run = runIdArg
    ? await wf.findById(runIdArg)
    : (await wf.list({ limit: 1 }))[0];
  if (!run) {
    console.log('No run found. Pass a run id or create a task first.');
    return;
  }

  console.log('\n── run ──');
  console.log({
    id: run.id,
    status: run.status,
    trigger_source: run.trigger_source,
    triggered_by_user_id: run.triggered_by_user_id,
    origin_routine_id: run.origin_routine_id,
    title: run.title,
  });

  if (run.triggered_by_user_id) {
    const userRepo = new UserRepository(db);
    const [u] = await userRepo.findByIds([run.triggered_by_user_id]);
    console.log('triggering user =', u ? { id: u.id, name: u.name, email: u.email } : 'NOT FOUND');
  }

  // Fake enqueue so nothing is actually sent — we only want the decision + logs.
  const fakeEnqueue = async (payload: unknown) => {
    console.log('\n✅ WOULD ENQUEUE:', JSON.stringify(payload, null, 2));
    return { messageId: 'fake-diagnostic' };
  };

  const svc = new EmailNotificationService({
    workforceRepo: wf,
    routinesRepo: new RoutinesRepository(db, await getActiveWorkspaceId()),
    userRepo: new UserRepository(db),
    workspaceRepo: new WorkspaceRepository(db),
    enqueue: fakeEnqueue,
  });

  console.log('\n── notifyTaskWaitingApproval (recipient probe) ──');
  const sent = await svc.notifyTaskWaitingApproval(run.id, {
    action: 'DIAGNOSTIC probe',
  });
  console.log('result (would-have-sent) =', sent);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
