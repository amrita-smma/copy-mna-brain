/**
 * The one-line summary a bot's task log keeps for each task: Haiku reads the
 * request, the start of the answer and the tools used, and writes what the
 * bot did — or SKIP for small talk, which logs nothing.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { DISABLED_THINKING } from '@/lib/ai/thinking';
import { flushLangfuse, withLangfuseCallbacks } from '@/lib/langfuse';

const SUMMARY_MODEL = 'claude-haiku-5-5';
const SUMMARY_MAX_TOKENS = 120;
/** The longest summary kept. */
export const TASK_SUMMARY_MAX_CHARS = 160;
/** How much of the request and the answer the summarizer reads. */
export const TASK_QUESTION_MAX_CHARS = 1500;
export const TASK_ANSWER_MAX_CHARS = 2500;

const SKIP = 'SKIP';

export const TASK_SUMMARY_SYSTEM_PROMPT = [
  "You keep a Copilot bot's task log. Given a request the bot was sent and its answer, write ONE line saying what the bot did, past tense, starting with a verb, at most 20 words.",
  'Name the concrete subject: companies, numbers, documents, people. No preamble, quotes or trailing period.',
  `If the exchange was not a task — a greeting, thanks, small talk, or the bot only asked a question back — reply exactly ${SKIP}.`,
  'Examples: "Screened 14 Indonesian fintech targets and shortlisted 3 for L1", "Summarised the week\'s pipeline moves for the Monday routine", "Drafted an email to PT Sinar about the Q3 data room".',
].join('\n');

export interface TaskSummaryInput {
  question: string;
  answer: string;
  toolNames: string[];
  /** Set for a routine run: its title, so the summary can say so. */
  routineTitle?: string | null;
}

/** The summarizer's user message: the exchange, clipped. */
export function taskSummaryPrompt(input: TaskSummaryInput): string {
  const lines = [
    input.routineTitle ? `Sent by the routine "${input.routineTitle}".` : null,
    `Request:\n${input.question.trim().slice(0, TASK_QUESTION_MAX_CHARS)}`,
    `Answer:\n${input.answer.trim().slice(0, TASK_ANSWER_MAX_CHARS)}`,
    input.toolNames.length > 0 ? `Tools used: ${input.toolNames.join(', ')}` : 'Tools used: none',
  ];
  return lines.filter(Boolean).join('\n\n');
}

/** The model's reply as a summary line, or null for SKIP / nothing. */
export function parseTaskSummary(raw: string): string | null {
  const line = raw
    .trim()
    .split('\n')[0]
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\.$/, '')
    .trim();
  if (!line || line.toUpperCase() === SKIP) return null;
  return line.length > TASK_SUMMARY_MAX_CHARS ? `${line.slice(0, TASK_SUMMARY_MAX_CHARS - 1)}…` : line;
}

/** Summarize one task with Haiku. Null when it was not a task, or no API key is set. */
export async function summarizeBotTask(input: TaskSummaryInput): Promise<string | null> {
  if (!input.answer.trim()) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[bot-task-log] summary skipped: ANTHROPIC_API_KEY unset');
    return null;
  }
  const llm = new ChatAnthropic({
    model: SUMMARY_MODEL,
    anthropicApiKey: apiKey,
    maxTokens: SUMMARY_MAX_TOKENS,
    thinking: DISABLED_THINKING,
    outputConfig: { effort: 'low' },
  });
  try {
    const res = await llm.invoke(
      [
        { role: 'system', content: TASK_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: taskSummaryPrompt(input) },
      ],
      withLangfuseCallbacks({ runName: 'bots.task_summary' }),
    );
    const text = typeof res.content === 'string' ? res.content : res.content.map((c) => ('text' in c ? c.text : '')).join('');
    return parseTaskSummary(text);
  } finally {
    await flushLangfuse();
  }
}
