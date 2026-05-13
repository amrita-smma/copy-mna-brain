import type {
  AiWorkforceQueueRepository,
  WorkforceQueueInsert,
  WorkforceQueueRow,
} from '@/lib/repositories';

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
  constructor(private readonly queueRepo: AiWorkforceQueueRepository) {}

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

  enqueueFromChat(data: ChatHandoffInput): Promise<WorkforceQueueRow> {
    const insert: WorkforceQueueInsert = {
      agent_name: data.agent_name,
      trigger_source: 'chat',
      trigger_meta: {
        conversation_id: data.conversation_id ?? null,
        tool_call_id: data.tool_call_id ?? null,
        user_id: data.user_id ?? null,
      },
      input: {
        title: data.title,
        instruction: data.instruction,
      },
      priority: data.priority ?? 0,
    };
    return this.queueRepo.enqueue(insert);
  }
}
