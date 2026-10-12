/**
 * The gate in front of mem0: what, if anything, a finished chat turn is allowed
 * to contribute to a user's long-term memory.
 *
 * mem0's own extraction is deliberately maximalist — its prompt says "every
 * piece of memorable information must be captured", and it mines the
 * assistant's messages as hard as the user's, turning recommendations into
 * "User was recommended X". That is the wrong default for this app: memory here
 * is sensitive, it follows a person across every workspace they belong to, and
 * an answer the CoPilot happened to give is not a fact about the person who
 * asked.
 *
 * So extraction happens here first, under criteria we own, and mem0 is only
 * asked to de-duplicate whatever survives. This is the same division of labour
 * the import path already uses (the `@memory_import` agent extracts, mem0
 * de-duplicates).
 *
 * The criteria are the five-layer model in `./layers.ts`: Personality,
 * Instructions, Context, Memory and Knowledge base. Only the Memory layer is
 * written here, and the routing rules there are what keep Context (this
 * session's working set) and the Knowledge base (facts about the world) out of
 * it.
 *
 * It is also cheaper on the common turn. Most turns yield nothing, and a turn
 * that yields nothing now costs one Haiku call and stops — where before it cost
 * an embedding, a vector search and an extraction call inside mem0.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { DISABLED_THINKING } from '@/lib/ai/thinking';
import { modelSupportsTemperature } from '@/lib/ai/modelParams';
import { MEMORY_LAYER_BRIEF, MEMORY_LAYER_ROUTING } from './layers';

const EXTRACTION_MODEL = 'claude-haiku-5-5';
const EXTRACTION_MAX_TOKENS = 400;

/** Facts one turn may contribute. A turn that seems to yield more is a turn being mined. */
export const MAX_FACTS_PER_TURN = 3;

/** Longest single fact. Anything longer is a summary, not a fact. */
export const MAX_FACT_CHARS = 200;

/** What the model says when the turn contributes nothing — the expected answer. */
const NONE_SENTINEL = 'NONE';

/**
 * How much of the assistant's reply is shown as context. Enough to resolve what
 * a bare "yes, do that" refers to; not so much that a long analysis becomes a
 * field to mine. The reply is context only — see the prompt.
 */
const ASSISTANT_CONTEXT_CHARS = 2_000;

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = [
  'You decide what a copilot should remember about the person using it, long after this',
  'conversation is over. You are reading one exchange from an M&A / investment research',
  'copilot.',
  '',
  MEMORY_LAYER_BRIEF,
  '',
  '## How to route what you see',
  '',
  MEMORY_LAYER_ROUTING,
  '',
  '## Only the user is a source',
  '',
  'A Memory may come only from something the user stated, instructed, or explicitly',
  'confirmed in their own words.',
  '',
  "The assistant's reply is shown to you as CONTEXT ONLY — so you can tell what a short",
  'answer like "yes", "do that", or "the second one" refers to. Never write a Memory',
  'whose only source is the assistant. What the copilot suggested, recommended, found, or',
  'concluded is not a fact about the user, however useful it sounds.',
  '',
  'And never write one you inferred. If they did not say it, it is not a Memory — no',
  'reading a job title out of an email domain, no guessing a mandate from a question, no',
  'turning a tone into a preference.',
  '',
  '## Durable, not momentary',
  '',
  'A Memory has to still be true and still be useful in three months. Most of what is',
  'said in a session is Context wearing a Memory\'s clothes:',
  '',
  '- "Make this a table" is a request for this turn. "Always give me tables" is how this',
  '  person likes to be answered.',
  '- "Is looking at Acme this week" passes. "Covers Indonesian coal and nickel" does not.',
  '',
  'Almost every exchange yields nothing. That is the normal, correct outcome. You are not',
  'summarising the conversation and you are not capturing what was discussed; you are',
  'looking for the rare durable fact about this person that would change how they should',
  'be answered next month.',
  '',
  '## Confidential detail stays out',
  '',
  'Memory is read back into unrelated conversations, about other companies and other',
  'mandates. Keep the durable working context, never the sensitive particulars:',
  '"Covers mid-market Indonesian mining" is a Memory; "Is bidding $420m for Acme" is not.',
  'Never record a price, valuation, bid, counterparty position, or anything said in',
  'confidence about a live deal — those are Context and Knowledge base, and they expire.',
  '',
  '## Output',
  '',
  `Return at most ${MAX_FACTS_PER_TURN} lines, each one Memory, each starting with "- ".`,
  'Write in the third person about the user, present tense, self-contained — it will be',
  'read months later with none of this conversation around it. One sentence, under',
  `${MAX_FACT_CHARS} characters.`,
  '',
  `If the exchange yields no Memory — which is usually the case — return exactly ${NONE_SENTINEL}`,
  'and nothing else. Returning NONE is never wrong when you are unsure.',
].join('\n');

/**
 * The exchange as the extractor sees it: the user's words in full, the
 * assistant's reply clipped and clearly labelled as context.
 */
export function buildExtractionPrompt(userText: string, assistantText: string): string {
  const reply = assistantText.trim();
  const clipped =
    reply.length > ASSISTANT_CONTEXT_CHARS
      ? `${reply.slice(0, ASSISTANT_CONTEXT_CHARS).trimEnd()}…`
      : reply;

  return [
    'USER SAID (the only thing you may extract from):',
    userText.trim() || '(nothing)',
    '',
    'ASSISTANT REPLIED (context only — never a source):',
    clipped || '(nothing)',
  ].join('\n');
}

/**
 * A line that is the model declining rather than answering. Haiku rarely
 * returns a bare `NONE`; it returns `NONE.`, `None — nothing to store`, or a
 * sentence saying there is nothing. All of those must mean nothing, because the
 * alternative is storing the refusal itself as a memory about the user.
 */
const DECLINED_LINE =
  /^(none\b|no\s+(durable|memorable|new|relevant|lasting)\b|nothing\s+(to|durable|memorable|worth)\b|there\s+(is|are)\s+no\b|n\/a\b)/i;

/**
 * A line that is prose about the task rather than a fact about the user: a
 * heading, a question, or the model narrating what it did.
 */
const NOT_A_FACT = /^(here|the\s+(user'?s\s+)?(exchange|conversation|turn|message)\b|output\b|memories\b|facts\b|i\s)/i;

/**
 * Parse the model's lines into facts. Tolerant of the shapes a small model
 * reaches for — bullets, numbering, quotes — and deliberately strict about what
 * it lets through: anything that reads as the model declining, or as prose
 * about the task, drops the whole result rather than becoming a memory.
 *
 * Erring towards `[]` is the right bias here. A missed fact costs a little
 * personalization; a junk fact is stored indefinitely, read back into unrelated
 * conversations, and has to be noticed and deleted by hand.
 */
export function parseExtractedFacts(raw: string): string[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];

  const facts: string[] = [];
  for (const line of text.split('\n')) {
    const cleaned = line
      .trim()
      // "- ", "* ", "1. ", "1) "
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();

    if (!cleaned) continue;
    // The model said there is nothing — whatever else it wrote beside it.
    if (DECLINED_LINE.test(cleaned)) return [];
    // A heading, a question, or the model talking about itself.
    if (cleaned.endsWith(':') || cleaned.endsWith('?')) continue;
    if (NOT_A_FACT.test(cleaned)) continue;
    // Too short to be a self-contained sentence about anyone.
    if (cleaned.length < 10) continue;

    facts.push(
      cleaned.length > MAX_FACT_CHARS
        ? `${cleaned.slice(0, MAX_FACT_CHARS).trimEnd()}…`
        : cleaned,
    );
    if (facts.length === MAX_FACTS_PER_TURN) break;
  }
  return facts;
}

export interface ExtractUserFactsInput {
  userText: string;
  assistantText: string;
  apiKey: string;
}

/** The signature `UserMemoryService` depends on, so a test can inject its own. */
export type UserFactExtractor = (input: ExtractUserFactsInput) => Promise<string[]>;

/**
 * One Haiku call deciding what this turn contributes. Returns `[]` for the vast
 * majority of turns, which is the point.
 *
 * Deterministic where the model allows it: this is a judgement that should not
 * vary between two identical turns, and a creative extractor is an extractor
 * that invents. The current model families reject an explicit `temperature`
 * outright, so it is only sent where it is still accepted.
 */
export const extractUserFacts: UserFactExtractor = async ({
  userText,
  assistantText,
  apiKey,
}) => {
  if (!userText.trim()) return [];

  const llm = new ChatAnthropic({
    model: EXTRACTION_MODEL,
    anthropicApiKey: apiKey,
    maxTokens: EXTRACTION_MAX_TOKENS,
    // Haiku 5.5 and the other current families 400 on an explicit
    // `temperature` ("`temperature` is deprecated for this model"), so the
    // field is omitted entirely for them. Where it is still accepted, 0 keeps
    // the same turn from deciding two different ways.
    ...(modelSupportsTemperature(EXTRACTION_MODEL) ? { temperature: 0 } : {}),
    // Routing a statement to a layer needs no reasoning, and this matches how
    // the other one-shot Haiku calls in the app are configured.
    thinking: DISABLED_THINKING,
    outputConfig: { effort: 'low' },
  });
  const res = await llm.invoke([
    { role: 'system', content: MEMORY_EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: buildExtractionPrompt(userText, assistantText) },
  ]);
  return parseExtractedFacts(String(res.content));
};
