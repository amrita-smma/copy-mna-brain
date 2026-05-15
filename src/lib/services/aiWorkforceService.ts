import type {
  AiWorkforceQueueRepository,
  DbClient,
  WorkforceQueueRow,
} from '@/lib/repositories';
import { enqueueAgentRun } from '@/lib/workforce';

export interface ChatHandoffInput {
  agent_name: string;
  title: string;
  instruction: string;
  conversation_id?: string;
  tool_call_id?: string;
  user_id?: string;
  priority?: number;
}

export class AiWorkforceService {
  constructor(
    private readonly queueRepo: AiWorkforceQueueRepository,
    private readonly db: DbClient,
  ) {}

  /**
   * Enqueue a run spawned from the AI CoPilot chat. The agent_name is the
   * routing target (e.g. "outbound_pipeline_writer"); input carries the
   * instruction and any chat context the worker will need.
   */
  listQueue(opts: { limit?: number } = {}): Promise<WorkforceQueueRow[]> {
    return this.queueRepo.list(opts);
  }

  findByToolCallId(toolCallId: string): Promise<WorkforceQueueRow | null> {
    return this.queueRepo.findByToolCallId(toolCallId);
  }

  findById(id: string): Promise<WorkforceQueueRow | null> {
    return this.queueRepo.findById(id);
  }

  /**
   * Enqueue a chat handoff. Goes through enqueueAgentRun() so we get:
   *   - idempotency on tool_call_id (set as idempotency_key — same handoff
   *     approved twice = one row, not two)
   *   - fire-and-forget dispatcher trigger via Next.js after() so the
   *     workflow starts within ms instead of waiting up to 60s for cron
   *   - automatic Haiku title generation from input.prompt (we mirror
   *     the instruction into input.prompt so the generator + runAgent
   *     can both read it)
   *   - triggered_by_user_id populated for owner attribution
   */
  async enqueueFromChat(data: ChatHandoffInput): Promise<WorkforceQueueRow> {
    const { runId } = await enqueueAgentRun(this.db, {
      agentName: data.agent_name,
      triggerSource: 'chat',
      triggerMeta: {
        conversation_id: data.conversation_id ?? null,
        tool_call_id: data.tool_call_id ?? null,
        user_id: data.user_id ?? null,
      },
      // Mirror the instruction into both fields. runAgent prefers `prompt`
      // when present; the explicit `instruction` is preserved for any
      // downstream consumer that still keys off Dicki's original shape.
      input: {
        title: data.title,
        instruction: data.instruction,
        prompt: data.instruction,
      },
      priority: data.priority ?? 0,
      triggeredByUserId: data.user_id ?? null,
      idempotencyKey: data.tool_call_id ?? null,
    });

    const row = await this.queueRepo.findById(runId);
    if (!row) {
      throw new Error(
        `enqueueFromChat: row ${runId} was inserted but findById returned null`,
      );
    }
    return row;
  }
}
