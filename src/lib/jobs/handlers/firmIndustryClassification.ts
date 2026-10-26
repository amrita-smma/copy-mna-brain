import { z } from 'zod';
import type { DbClient, FirmIndustryEvidence } from '@/lib/repositories';
import { EmployerRepository, JobRepository } from '@/lib/repositories';
import {
  invokeStructuredOutput,
  type LLMClientOverride,
} from '@/lib/agents/fund_update_processing/structuredOutput';
import { decodeHtmlEntities } from '@/lib/crm/displayText';
import { FIRM_INDUSTRIES, toFirmIndustry } from '@/lib/crm/firmIndustry';

// Haiku: a label pick from a name, a domain and a few titles, many firms a call.
export const FIRM_INDUSTRY_MODEL = 'claude-haiku-5-5';

/** Firms per model call. */
export const FIRM_INDUSTRY_CHUNK = 20;

export const firmIndustryOutputSchema = z.object({
  firms: z
    .array(
      z.object({
        ref: z.string().describe('The firm ref from the prompt, e.g. "F1".'),
        // A string, not z.enum: one off-list label would otherwise fail the
        // whole chunk. Each answer is canonicalized by `toFirmIndustry`, and
        // one that is not on the list is dropped for that firm alone.
        industry: z
          .string()
          .nullable()
          .describe(
            `Exactly one of: ${FIRM_INDUSTRIES.join(' | ')}; null when the evidence does not settle it.`,
          ),
      }),
    )
    .describe('One entry per firm ref in the prompt.'),
});

const SYSTEM_PROMPT =
  'You label the industry of firms in the CRM of an M&A and investment team. The firms are the banks, funds, ' +
  'advisers and companies the team emails. For each firm pick exactly one label from the allowed list. ' +
  'Use the firm name, its email domains, the titles and focus of its contacts, and contact bios. You may also use ' +
  'what you reliably know about a well-known firm or domain (e.g. kpmg.com is an audit and accounting firm). ' +
  'Label the firm, not the contact: an in-house lawyer at a bank is still a bank. Pick the most specific label ' +
  'that fits — a private-credit manager is Private Credit, not Asset Management. ' +
  'Return null when the evidence does not clearly settle it — an unfamiliar name with no titles, or a generic ' +
  'domain. A wrong label is worse than none, because the team filters on it.';

export function buildFirmIndustryPrompt(firms: Array<{ ref: string; firm: FirmIndustryEvidence }>): string {
  const blocks = firms.map(({ ref, firm }) => {
    const lines = [`[${ref}] ${decodeHtmlEntities(firm.name)}`];
    if (firm.domains.length > 0) lines.push(`  Domains: ${firm.domains.join(', ')}`);
    for (const c of firm.contacts) {
      const parts = [
        c.title ? `title: ${decodeHtmlEntities(c.title)}` : null,
        c.specialization ? `focus: ${decodeHtmlEntities(c.specialization)}` : null,
        c.bio ? `bio: ${decodeHtmlEntities(c.bio).replace(/\s+/g, ' ')}` : null,
      ].filter(Boolean);
      if (parts.length > 0) lines.push(`  Contact — ${parts.join('; ')}`);
    }
    return lines.join('\n');
  });
  return [
    `Allowed labels: ${FIRM_INDUSTRIES.join(' | ')}`,
    '',
    '## Firms',
    blocks.join('\n\n'),
    '',
    'Return one entry per firm ref: its label, or null.',
  ].join('\n');
}

export interface FirmIndustryClassificationPayload {
  employerIds: string[];
  /** The workspace whose view of the firms' contacts is the evidence. */
  workspaceId: string;
  jobId?: string;
}

export interface FirmIndustryClassificationDeps {
  db: DbClient;
  llmOverride?: LLMClientOverride;
}

export interface FirmIndustryClassificationResult {
  classified: number;
  unresolved: number;
  failedChunks: number;
}

/**
 * Label each claimed firm's industry. One model call per
 * {@link FIRM_INDUSTRY_CHUNK} firms. A firm the model answers null for keeps
 * its claim stamp and waits out the retry window; a chunk whose call fails is
 * logged and its claims released, so the next sweep retries it. Throws only
 * when every chunk failed.
 */
export async function runFirmIndustryClassification(
  payload: FirmIndustryClassificationPayload,
  deps: FirmIndustryClassificationDeps,
): Promise<FirmIndustryClassificationResult> {
  const { employerIds, workspaceId, jobId } = payload;
  const employerRepo = new EmployerRepository(deps.db);
  const jobRepo = new JobRepository(deps.db);
  const log = async (message: string, metadata: Record<string, unknown>) => {
    if (!jobId) return;
    try {
      await jobRepo.appendLog(jobId, { message, metadata });
    } catch (logErr) {
      console.error('[firmIndustryClassification] Failed to append log:', logErr);
    }
  };

  const evidence = await employerRepo.findIndustryEvidence(workspaceId, employerIds);
  const result: FirmIndustryClassificationResult = { classified: 0, unresolved: 0, failedChunks: 0 };
  let chunks = 0;
  let lastError: unknown = null;

  for (let i = 0; i < evidence.length; i += FIRM_INDUSTRY_CHUNK) {
    chunks += 1;
    const chunk = evidence
      .slice(i, i + FIRM_INDUSTRY_CHUNK)
      .map((firm, j) => ({ ref: `F${j + 1}`, firm }));
    try {
      const output = await invokeStructuredOutput({
        schema: firmIndustryOutputSchema,
        systemPrompt: SYSTEM_PROMPT,
        prompt: buildFirmIndustryPrompt(chunk),
        model: FIRM_INDUSTRY_MODEL,
        effort: 'low',
        // Adaptive thinking spends from this budget too.
        maxTokens: 4000 + 60 * chunk.length,
        toolName: 'label_firm_industries',
        llmOverride: deps.llmOverride,
      });
      const idByRef = new Map(chunk.map(({ ref, firm }) => [ref, firm.id]));
      const labels = new Map<string, string>();
      for (const f of output.firms) {
        const id = idByRef.get(f.ref.trim());
        const industry = toFirmIndustry(f.industry);
        if (id && industry && !labels.has(id)) labels.set(id, industry);
      }
      const written = await employerRepo.fillIndustries(
        [...labels].map(([id, industry]) => ({ id, industry })),
      );
      result.classified += written.length;
      result.unresolved += chunk.length - written.length;
      await log('Firm industries labelled', {
        firms: chunk.length,
        labelled: written.length,
      });
    } catch (err) {
      lastError = err;
      result.failedChunks += 1;
      const ids = chunk.map(({ firm }) => firm.id);
      await log(err instanceof Error ? err.message : String(err), { error: true, employerIds: ids });
      // A failed call is not an answer: let the next sweep retry these firms.
      try {
        await employerRepo.releaseIndustryClaims(ids);
      } catch (releaseErr) {
        console.error('[firmIndustryClassification] Failed to release claims:', releaseErr);
      }
    }
  }

  if (chunks > 0 && result.failedChunks === chunks) throw lastError;
  return result;
}
