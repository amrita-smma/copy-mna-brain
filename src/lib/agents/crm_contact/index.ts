/**
 * @crm_contact — fills in a CRM contact's missing profile details from the
 * public web, and writes them to the `correspondent_curation` override table.
 *
 * A separate agent, not a tool on the analysis agent, because its job argues
 * for a different shape: one person, one record, a handful of fields, and a
 * prompt whose weight is on *when not to write*. The general Workforce agent's
 * system prompt is an M&A pipeline operator's — a hundred lines about intake
 * stages, promotions and insight authoring that a name-and-firm lookup has to
 * read past, alongside a tool catalogue it must be told to ignore. Here the
 * tool list is six entries and the prompt is about identity evidence.
 *
 * It still runs *on* the AI Workforce: the button enqueues an
 * `ai_workforce_queue` row with `agent_name = 'crm_contact'`
 * (`CrmContactEnrichmentService`), the dispatcher claims it, and
 * `workforce/runAgent.ts` routes that agent_name to the graph below instead of
 * the general workforce graph. So the run gets the queue's heartbeating,
 * retries, cancellation, trace panel and task list for free, and a user can
 * watch it from the AI Workforce page like anything else.
 *
 * Built on the shared runtime (`buildAgentGraph` → `AgentGraph` →
 * `createLocalAgent` → langchain `createAgent`) and streamed, like every other
 * agent here. Checkpointed, because a workforce row can be resumed or reopened
 * and `ai_workforce_queue.id` is its LangGraph thread_id.
 *
 * No HITL middleware: there is no gated tool in the list to interrupt on. The
 * write is bounded to one correspondent's overlay columns, it cannot touch the
 * name or email, and it fills empty fields rather than replacing filled ones
 * — so the approval a gated `move_stage` needs would be ceremony here.
 */
import {
  buildAgentGraph,
  onResetAgent,
  type AgentGraph,
  type EffortChoice,
} from '@/lib/agents/analysis';
import { CRM_COMPANY_CONTACTS_SYSTEM_PROMPT } from './companyContactsPrompt';
import { CRM_CONTACT_SYSTEM_PROMPT } from './prompt';
import { CRM_COMPANY_CONTACTS_TOOLS, CRM_CONTACT_TOOLS } from './tools';

export {
  CRM_COMPANY_CONTACTS_AGENT_NAME,
  CRM_CONTACT_AGENT_NAME,
  CRM_CONTACT_WRITABLE_FIELDS,
  MAX_COMPANY_CONTACTS,
  isCrmCompanyContactsAgent,
  isCrmContactAgent,
  missingProfileFields,
  type CrmContactWritableField,
} from './constants';
export {
  CRM_CONTACT_SYSTEM_PROMPT,
  buildContactEnrichmentPrompt,
  buildContactEnrichmentTitle,
} from './prompt';
export {
  CRM_COMPANY_CONTACTS_SYSTEM_PROMPT,
  buildCompanyContactsPrompt,
  buildCompanyContactsTitle,
} from './companyContactsPrompt';
export { CRM_COMPANY_CONTACTS_TOOLS, CRM_CONTACT_TOOLS } from './tools';

/**
 * Cached per effort tier, like the workforce graphs — the graph holds no
 * per-run state, only the model config, tool list and prompt. `resetAgent()`
 * clears this too, via the listener below.
 */
const crmContactGraphs = new Map<EffortChoice, AgentGraph>();
const crmCompanyContactsGraphs = new Map<EffortChoice, AgentGraph>();
onResetAgent(() => {
  crmContactGraphs.clear();
  crmCompanyContactsGraphs.clear();
});

/**
 * The agent's graph at one effort tier.
 *
 * `low` is the default for a direct caller, because the task is "search for a
 * name, read a staff page, copy nine short fields" — the reasoning budget a
 * deal verdict needs buys nothing here. A workforce run does not get that
 * choice: `asWorkforceEffort` floors every queued row at `medium`, so a run
 * fired from the CRM button builds the `medium` graph. Both are cached
 * separately; neither is wrong.
 */
export async function getCrmContactAgentGraph(
  effort: EffortChoice = 'low',
): Promise<AgentGraph | null> {
  const cached = crmContactGraphs.get(effort);
  if (cached) return cached;

  const graph = await buildAgentGraph(
    CRM_CONTACT_TOOLS as never,
    CRM_CONTACT_SYSTEM_PROMPT,
    [],
    // Checkpointed: the queue row's id is the thread_id, and a reopened or
    // resumed run must see its own history.
    true,
    effort,
  );
  if (graph) crmContactGraphs.set(effort, graph);
  return graph;
}

/**
 * The company-contacts task's graph at one effort tier: find the partnership
 * contacts (CEO, head of BD, BD manager) AT a pipeline company. Same runtime,
 * caching and checkpointing as {@link getCrmContactAgentGraph}; only the
 * prompt and tool list differ. A run fired from the company dialog's "Find
 * contacts" button is floored at `medium` by the workforce, like the CRM one.
 */
export async function getCrmCompanyContactsAgentGraph(
  effort: EffortChoice = 'low',
): Promise<AgentGraph | null> {
  const cached = crmCompanyContactsGraphs.get(effort);
  if (cached) return cached;

  const graph = await buildAgentGraph(
    CRM_COMPANY_CONTACTS_TOOLS as never,
    CRM_COMPANY_CONTACTS_SYSTEM_PROMPT,
    [],
    true,
    effort,
  );
  if (graph) crmCompanyContactsGraphs.set(effort, graph);
  return graph;
}
