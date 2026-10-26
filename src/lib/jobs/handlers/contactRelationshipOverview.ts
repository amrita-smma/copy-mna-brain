import { z } from 'zod';
import type { DbClient } from '@/lib/repositories';
import {
  ContactConversationRepository,
  CorrespondentRepository,
  EmployerRepository,
  JobRepository,
} from '@/lib/repositories';
import {
  invokeStructuredOutput,
  type LLMClientOverride,
} from '@/lib/agents/fund_update_processing/structuredOutput';
import { decodeHtmlEntities } from '@/lib/crm/displayText';
import { overviewInputHash } from '@/lib/crm/overviewInputHash';
import type { OverviewDealNote } from '@/lib/repositories';

// Haiku: the input is already-paraphrased notes, and a post-ingest refresh runs
// one call per touched contact.
export const CONTACT_RELATIONSHIP_OVERVIEW_MODEL = 'claude-haiku-5-5';

// Adaptive thinking draws on the same max_tokens as the tool call, so the
// budget has to cover both: at 1500 a contact with a long note history spent
// it thinking and returned empty or cut-off JSON. Low effort keeps the thinking
// short; the output itself is a few sentences plus one line per deal.
const OVERVIEW_BASE_MAX_TOKENS = 4000;
const OVERVIEW_MAX_TOKENS_PER_DEAL = 120;

function overviewMaxTokens(dealCount: number): number {
  return OVERVIEW_BASE_MAX_TOKENS + OVERVIEW_MAX_TOKENS_PER_DEAL * dealCount;
}

export const overviewOutputSchema = z.object({
  overview: z
    .string()
    .describe(
      '2–4 sentences, plain prose, paraphrase only, ends with "Best next move: …"',
    ),
  dealNotes: z
    .array(
      z.object({
        ref: z.string().describe('The deal ref from the prompt, e.g. "D1".'),
        note: z
          .string()
          .nullable()
          .describe(
            "One sentence on the contact's part in this deal, from the notes tagged with its ref; null when no note says anything about it.",
          ),
      }),
    )
    .default([])
    .describe('One entry per linked deal ref listed in the prompt; empty when none are listed.'),
  roleSummary: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "One sentence on the contact's role in investment across all their emails, starting with their first name; null when no note shows it.",
    ),
  inferredIndustryFocus: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'The sector or product the contact most often works on across these notes, as a short tag of 1–4 words (e.g. "Private credit", "Real estate", "Healthcare"); null when the notes do not show a pattern.',
    ),
  inferredAreaFocus: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'The geography of the companies and deals the contact works on across these notes, as a short tag (e.g. "Indonesia", "Southeast Asia"); null when the notes do not show one. Not where they are based.',
    ),
});

export type OverviewOutput = z.infer<typeof overviewOutputSchema>;

export interface ContactRelationshipOverviewPayload {
  correspondentId: string;
  workspaceId: string;
  jobId?: string;
}

export interface ContactRelationshipOverviewDeps {
  db: DbClient;
  llmOverride?: LLMClientOverride;
}

const SYSTEM_PROMPT =
  'You are an executive relationship analyst at an M&A and investment advisory firm. ' +
  'You are summarizing the ongoing relationship between our team and an external CRM contact into an executive overview. ' +
  'Work ONLY from the provided derived email notes, interaction statistics, role signals, and deal links. ' +
  'Write in plain, direct prose using derived and paraphrased text only — NEVER include verbatim quotes or subjects from emails. ' +
  'Your summary must be exactly 2 to 4 sentences, and MUST end with a sentence starting with "Best next move: ". ' +
  'For each linked deal, also write one short sentence on what the contact did or said on that deal ' +
  '(their stance, ask, or part in it), taken only from the notes tagged with that deal ref. ' +
  'When no tagged note says anything about the deal, return null for it — never restate its stage or role, and never guess. ' +
  'Also write one sentence on the contact\'s role in investment: the pattern across their emails, not one email — what they ' +
  'most often raise with us, the kind of capital or advice they bring, and who they pull in. Start with their first name and ' +
  'refer to them by name or "they", never by a guessed gender. Name no specific deal, target, price or term. ' +
  'Return null for it when neither the role signals nor the notes show their role. ' +
  'Finally, infer two short tags from the pattern across the notes: the sector or product the contact most often works ' +
  'on with us (their industry focus), and the geography of the companies and deals they work on (their area focus) — ' +
  'not where they are based. Return null for either when the notes do not show a clear pattern; one email is not a pattern.';

// The CRM shows a focus as one short tag; a longer answer is a sentence, not a tag.
const MAX_INFERRED_FOCUS_CHARS = 60;

function inferredFocusTag(raw: string | null | undefined): string | null {
  const v = raw?.trim().replace(/\.$/, '');
  return v && v.length <= MAX_INFERRED_FOCUS_CHARS ? v : null;
}

/** A linked deal as the prompt shows it; `ref` is what the model answers with. */
export interface OverviewPromptDeal {
  ref: string;
  companyId: string;
  line: string;
}

export function buildOverviewPrompt(data: {
  contactName: string;
  firmName: string;
  title: string | null;
  rolesSummary: string;
  interactionStats: string;
  dealsSummary: string;
  notesSummary: string;
  hasDeals: boolean;
}): string {
  const lines = [
    `Contact: ${data.contactName}${data.title ? ` (${data.title})` : ''} @ ${data.firmName}`,
    '',
    `## Role in investment`,
    data.rolesSummary,
    '',
    `## Interactions with our team`,
    data.interactionStats,
    '',
    `## Linked deals`,
    data.dealsSummary,
    '',
    `## Recent conversation notes (up to 30 newest; [D1] = about deal D1)`,
    data.notesSummary,
    '',
    'Write a concise 2–4 sentence executive relationship overview based strictly on the above. Do not quote. It must end with "Best next move: …".',
    `Then one sentence on ${data.contactName}'s role in investment across these emails (the pattern, not one email), or null.`,
    `Then ${data.contactName}'s industry focus and area focus as short tags inferred from the pattern across these notes, each or null.`,
  ];
  if (data.hasDeals) {
    lines.push(
      "Then, for every linked deal ref, one sentence on the contact's part in it from its tagged notes, or null.",
    );
  }
  return lines.join('\n');
}

export async function runContactRelationshipOverview(
  payload: ContactRelationshipOverviewPayload,
  deps: ContactRelationshipOverviewDeps,
): Promise<{
  overview: string;
  dealNotes: OverviewDealNote[];
  roleSummary: string | null;
  inferredIndustryFocus: string | null;
  inferredAreaFocus: string | null;
}> {
  const { correspondentId, workspaceId, jobId } = payload;
  if (!correspondentId) throw new Error('contactRelationshipOverview: `correspondentId` is required');
  if (!workspaceId) throw new Error('contactRelationshipOverview: `workspaceId` is required');

  const contactConversationRepo = new ContactConversationRepository(deps.db);
  const correspondentRepo = new CorrespondentRepository(deps.db);
  const employerRepo = new EmployerRepository(deps.db);
  const jobRepo = new JobRepository(deps.db);

  try {
    const { createContainer } = await import('@/lib/services/container');
    const container = createContainer(deps.db, workspaceId);

    const contact = await correspondentRepo.findById(correspondentId, workspaceId);
    const firm = contact?.employer_id
      ? await employerRepo.findById(contact.employer_id, workspaceId)
      : null;

    // The overview is shared, so it reads every note and evidence (system reads).
    const [{ notes }, roles, hash, summaries, contactDeals] = await Promise.all([
      contactConversationRepo.listNotesForSystem(workspaceId, correspondentId, { limit: 30 }),
      contactConversationRepo.getRoleRollupForSystem(workspaceId, correspondentId),
      contactConversationRepo.getNoteInputHash(workspaceId, correspondentId),
      container.contactInsightsService.getInteractionSummaries([correspondentId]),
      container.dealContactService.listContactDeals(correspondentId),
    ]);

    // Short refs, so the model never has to echo a uuid back.
    const promptDeals: OverviewPromptDeal[] = contactDeals.deals.map((d, i) => ({
      ref: `D${i + 1}`,
      companyId: d.companyId,
      line: `${d.companyName} (${d.role === 'source' ? 'brought' : 'involved'}, current stage: ${d.stageLabel}${d.isDropped ? ', dropped' : ''})`,
    }));
    const evidence = await contactConversationRepo.listDealEvidenceEmails(
      workspaceId,
      correspondentId,
      promptDeals.map((d) => d.companyId),
    );
    const refByCompany = new Map(promptDeals.map((d) => [d.companyId, d.ref]));
    const refsByEmail = new Map<string, string[]>();
    for (const e of evidence) {
      const ref = refByCompany.get(e.companyId);
      if (!ref) continue;
      const refs = refsByEmail.get(e.emailId) ?? [];
      if (!refs.includes(ref)) refs.push(ref);
      refsByEmail.set(e.emailId, refs);
    }

    const contactName = decodeHtmlEntities(contact?.name ?? 'Contact');
    const firmName = decodeHtmlEntities(firm?.name ?? 'Unknown Firm');
    const title = decodeHtmlEntities(contact?.title ?? null);

    // Format roles
    const rolesSummary =
      roles.roles.length > 0
        ? roles.roles
            .map((r) => `${r.label} (${r.confidence} confidence, ${r.emailCount} emails)`)
            .join(', ') + (roles.evidence ? `\nEvidence: ${roles.evidence}` : '')
        : 'No role signals recorded.';

    // Format interaction stats (getInteractionSummaries has a row for every id)
    const stat = summaries.get(correspondentId)!;
    const interactionStats = `Total emails: ${stat.totalEmailsFromUs} from us, ${stat.totalEmailsFromThem} from them across ${stat.teamMemberCount} team member(s). Last contact: ${stat.lastContactAt ?? 'none'}.`;

    // Format deals
    const dealsSummary =
      promptDeals.length > 0
        ? promptDeals.map((d) => `- ${d.ref}: ${d.line}`).join('\n')
        : 'No linked deals recorded.';

    // Format notes
    const notesSummary =
      notes.length > 0
        ? notes
            .map((n) => {
              const members =
                n.teamMembers.length > 0
                  ? ` (team: ${n.teamMembers.map((m) => m.name).join(', ')})`
                  : '';
              const next = n.nextStep ? ` Next step: ${n.nextStep} (${n.nextStepStatus}).` : '';
              const refs = refsByEmail.get(n.emailId) ?? [];
              const tags = refs.length > 0 ? ` [${refs.join(', ')}]` : '';
              return `- [${n.sentAt.slice(0, 10)}] [${n.direction}]${tags}${members}: ${n.summary}.${next} Sentiment: ${n.sentiment}.`;
            })
            .join('\n')
        : 'No conversation notes available.';

    const prompt = buildOverviewPrompt({
      contactName,
      firmName,
      title,
      rolesSummary,
      interactionStats,
      dealsSummary,
      notesSummary,
      hasDeals: promptDeals.length > 0,
    });

    const result = await invokeStructuredOutput({
      schema: overviewOutputSchema,
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      model: CONTACT_RELATIONSHIP_OVERVIEW_MODEL,
      effort: 'low',
      maxTokens: overviewMaxTokens(promptDeals.length),
      toolName: 'generate_contact_relationship_overview',
      llmOverride: deps.llmOverride,
    });

    const overview = result.overview.trim();
    const roleSummary = result.roleSummary?.trim() || null;
    const inferredIndustryFocus = inferredFocusTag(result.inferredIndustryFocus);
    const inferredAreaFocus = inferredFocusTag(result.inferredAreaFocus);
    const companyByRef = new Map(promptDeals.map((d) => [d.ref, d.companyId]));
    const dealNotes: OverviewDealNote[] = [];
    for (const dn of result.dealNotes) {
      const companyId = companyByRef.get(dn.ref.trim());
      const note = dn.note?.trim();
      if (!companyId || !note || dealNotes.some((x) => x.companyId === companyId)) continue;
      dealNotes.push({ companyId, note });
    }

    // Hash the deals this run actually wrote lines for: listContactDeals
    // reconciles Smart Files links first, so it can see one the hash read missed.
    const currentHash = overviewInputHash({
      noteCount: hash.noteCount,
      latestEmailId: hash.latestEmailId,
      dealCompanyIds: promptDeals.map((d) => d.companyId),
    });
    await contactConversationRepo.saveOverviewReady(workspaceId, correspondentId, {
      text: overview,
      inputHash: currentHash,
      dealNotes,
      roleSummary,
      inferredIndustryFocus,
      inferredAreaFocus,
    });

    if (jobId) {
      try {
        await jobRepo.appendLog(jobId, {
          message: 'Contact relationship overview generated successfully',
          metadata: { correspondentId, dealNotes: dealNotes.length },
        });
      } catch (logErr) {
        console.error('[contactRelationshipOverview] Failed to append success log:', logErr);
      }
    }

    return { overview, dealNotes, roleSummary, inferredIndustryFocus, inferredAreaFocus };
  } catch (err) {
    try {
      await contactConversationRepo.markOverviewFailed(workspaceId, correspondentId);
      if (jobId) {
        await jobRepo.appendLog(jobId, {
          message: err instanceof Error ? err.message : String(err),
          metadata: { error: true, correspondentId },
        });
      }
    } catch (cleanupErr) {
      console.error('[contactRelationshipOverview] Failed to persist failed state:', cleanupErr);
    }
    throw err;
  }
}
