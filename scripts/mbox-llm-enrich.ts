/**
 * LLM enrichment for llm_queue.jsonl. Three backends:
 *
 *   ollama        Run a local model via Ollama HTTP. Parallel via a semaphore.
 *   batch-submit  Submit the queue to Anthropic's Messages Batches API (50% off).
 *   batch-fetch   Download results from a previously-submitted Anthropic batch.
 *
 * Output: enriched.jsonl (one JSON record per processed email).
 *
 * Usage:
 *   pnpm mbox:llm-enrich ollama [--queue PATH] [--output PATH] [--model NAME] [--base-url URL] [--concurrency N] [--limit N]
 *   pnpm mbox:llm-enrich batch-submit [--queue PATH] [--meta PATH] [--model NAME] [--limit N]
 *   pnpm mbox:llm-enrich batch-fetch [--meta PATH] [--output PATH]
 *
 * Examples:
 *   pnpm mbox:llm-enrich ollama --model qwen2.5:7b --limit 10
 *   pnpm mbox:llm-enrich batch-submit --model claude-haiku-4-5
 *   pnpm mbox:llm-enrich batch-fetch
 */
import { openSync, writeSync, closeSync, writeFileSync, readFileSync, readFileSync as _r } from 'node:fs';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';

// Load .env.local then .env so ANTHROPIC_API_KEY (and any other config) is
// available for the batch-submit/batch-fetch paths. Harmless for ollama.
loadEnv({ path: '.env.local' });
loadEnv();

import {
  EMAIL_EXTRACTION_SCHEMA,
  SYSTEM_PROMPT,
  buildUserPrompt,
  mergePeopleWithCandidates,
  readQueue,
  safeCustomId,
  type EnrichedRecord,
  type LlmExtraction,
  type LlmPerson,
  type QueueEntry,
} from '../src/lib/services/mboxParser';

// ─── arg parsing ─────────────────────────────────────────────────────────────

type Cmd = 'ollama' | 'batch-submit' | 'batch-fetch';

interface OllamaArgs {
  cmd: 'ollama';
  queue: string;
  output: string;
  model: string;
  baseUrl: string;
  concurrency: number;
  limit: number;
}

interface BatchSubmitArgs {
  cmd: 'batch-submit';
  queue: string;
  meta: string;
  model: string;
  limit: number;
}

interface BatchFetchArgs {
  cmd: 'batch-fetch';
  meta: string;
  output: string;
}

type CliArgs = OllamaArgs | BatchSubmitArgs | BatchFetchArgs;

function takeValue(argv: string[], i: number, flag: string): [string, number] {
  const eq = argv[i].indexOf('=');
  if (eq !== -1) return [argv[i].slice(eq + 1), i];
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`${flag} requires a value`);
  return [v, i + 1];
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const cmd = argv[0] as Cmd;
  const rest = argv.slice(1);

  if (cmd === 'ollama') {
    const args: OllamaArgs = {
      cmd: 'ollama',
      queue: 'llm_queue.jsonl',
      output: 'enriched.jsonl',
      model: 'qwen2.5:7b',
      baseUrl: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
      concurrency: 4,
      limit: 0,
    };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      switch (key) {
        case '--queue': { const [v, ni] = takeValue(rest, i, '--queue'); args.queue = v; i = ni; break; }
        case '--output': { const [v, ni] = takeValue(rest, i, '--output'); args.output = v; i = ni; break; }
        case '--model': { const [v, ni] = takeValue(rest, i, '--model'); args.model = v; i = ni; break; }
        case '--base-url': { const [v, ni] = takeValue(rest, i, '--base-url'); args.baseUrl = v; i = ni; break; }
        case '--concurrency': { const [v, ni] = takeValue(rest, i, '--concurrency'); args.concurrency = parseInt(v, 10); i = ni; break; }
        case '--limit': { const [v, ni] = takeValue(rest, i, '--limit'); args.limit = parseInt(v, 10); i = ni; break; }
        default: throw new Error(`Unknown flag for ollama: ${a}`);
      }
    }
    return args;
  }

  if (cmd === 'batch-submit') {
    const args: BatchSubmitArgs = {
      cmd: 'batch-submit',
      queue: 'llm_queue.jsonl',
      meta: 'batch_meta.json',
      model: 'claude-haiku-4-5',
      limit: 0,
    };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      switch (key) {
        case '--queue': { const [v, ni] = takeValue(rest, i, '--queue'); args.queue = v; i = ni; break; }
        case '--meta': { const [v, ni] = takeValue(rest, i, '--meta'); args.meta = v; i = ni; break; }
        case '--model': { const [v, ni] = takeValue(rest, i, '--model'); args.model = v; i = ni; break; }
        case '--limit': { const [v, ni] = takeValue(rest, i, '--limit'); args.limit = parseInt(v, 10); i = ni; break; }
        default: throw new Error(`Unknown flag for batch-submit: ${a}`);
      }
    }
    return args;
  }

  if (cmd === 'batch-fetch') {
    const args: BatchFetchArgs = {
      cmd: 'batch-fetch',
      meta: 'batch_meta.json',
      output: 'enriched.jsonl',
    };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      switch (key) {
        case '--meta': { const [v, ni] = takeValue(rest, i, '--meta'); args.meta = v; i = ni; break; }
        case '--output': { const [v, ni] = takeValue(rest, i, '--output'); args.output = v; i = ni; break; }
        default: throw new Error(`Unknown flag for batch-fetch: ${a}`);
      }
    }
    return args;
  }

  throw new Error(`Unknown subcommand: ${cmd}`);
}

function printHelp(): void {
  const help = readFileSync(new URL(import.meta.url), 'utf-8')
    .split('\n')
    .filter((l) => l.startsWith(' *') || l.startsWith('/**'))
    .map((l) => l.replace(/^ \*\/?|^\/\*\*/g, '').replace(/^ ?/, ''))
    .join('\n')
    .trim();
  console.log(help);
}

// ─── ollama backend ──────────────────────────────────────────────────────────

interface OllamaStreamChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

// Stream Ollama's /api/chat response and accumulate the model's content into
// a single JSON document. Streaming is mandatory here: at stream:false, Node's
// undici fetch enforces a 5-min `headersTimeout` and bigger / slower models
// (e.g. qwen3.5:9b on a long prompt) don't return headers in time, so the
// request errors with `TypeError: fetch failed` before inference completes.
// With stream:true, HTTP 200 + the first NDJSON chunk arrive within ms, and
// undici only cares about gaps between chunks after that.
async function callOllama(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmExtraction> {
  const controller = new AbortController();
  // Per-request budget — aborts the streaming read if the model goes silent
  // mid-generation. Undici honors the signal during body reads, so this is
  // actually enforced (unlike when used with stream:false).
  const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
  if (!res.ok) {
    clearTimeout(timeout);
    throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
  }
  if (!res.body) {
    clearTimeout(timeout);
    throw new Error('ollama returned no response body');
  }

  // Ollama emits NDJSON (one JSON object per line) when stream:true.
  // Concatenate `message.content` from each chunk; the final chunk has done:true.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as OllamaStreamChunk;
        if (chunk.error) throw new Error(`ollama error: ${chunk.error}`);
        if (chunk.message?.content) content += chunk.message.content;
      }
    }
    // Handle a trailing chunk with no newline (rare but possible).
    const tail = buffer.trim();
    if (tail) {
      const chunk = JSON.parse(tail) as OllamaStreamChunk;
      if (chunk.error) throw new Error(`ollama error: ${chunk.error}`);
      if (chunk.message?.content) content += chunk.message.content;
    }
  } finally {
    clearTimeout(timeout);
  }

  const parsed = JSON.parse(content) as Partial<LlmExtraction>;
  return {
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    people: Array.isArray(parsed.people) ? (parsed.people as LlmPerson[]) : [],
  };
}

// Bounded concurrency without a dep — process entries in fixed-size waves.
async function runOllama(args: OllamaArgs): Promise<void> {
  const entries = await readQueue(args.queue, args.limit);
  console.log(
    `Running ${entries.length} entries through Ollama model '${args.model}' (concurrency=${args.concurrency})...`,
  );

  const outFd = openSync(args.output, 'w');
  const start = Date.now();
  let done = 0;

  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, async () => {
    while (cursor < entries.length) {
      const idx = cursor++;
      const entry = entries[idx];
      const userPrompt = buildUserPrompt(entry);
      let record: unknown;
      try {
        const result = await callOllama(args.baseUrl, args.model, SYSTEM_PROMPT, userPrompt);
        const enriched: EnrichedRecord = {
          message_id: entry.message_id,
          sender_email: entry.sender_email,
          domain_tag: entry.domain_tag,
          topics: result.topics,
          people: mergePeopleWithCandidates(result.people, entry.payload.candidates),
        };
        record = enriched;
      } catch (err) {
        record = {
          message_id: entry.message_id,
          error: `${(err as Error).name}: ${(err as Error).message}`,
        };
      }
      writeSync(outFd, JSON.stringify(record) + '\n');
      done++;
      if (done % 10 === 0 || done === entries.length) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = done / elapsed;
        const eta = rate > 0 ? (entries.length - done) / rate : 0;
        process.stderr.write(
          `  [${done}/${entries.length}] ${rate.toFixed(1)}/s  ETA ${(eta / 60).toFixed(1)}min\n`,
        );
      }
    }
  });

  try {
    await Promise.all(workers);
  } finally {
    closeSync(outFd);
  }

  const elapsedMin = (Date.now() - start) / 60000;
  console.log(`Wrote ${done} records to ${args.output} in ${elapsedMin.toFixed(1)} min`);
}

// ─── anthropic batch backend ────────────────────────────────────────────────

interface BatchMeta {
  batch_id: string;
  submitted_at: string;
  model: string;
  count: number;
  custom_id_to_message_id: Record<string, string>;
  candidates_by_custom_id: Record<string, QueueEntry['payload']['candidates']>;
}

async function submitAnthropicBatch(args: BatchSubmitArgs): Promise<void> {
  const entries = await readQueue(args.queue, args.limit);
  console.log(
    `Submitting ${entries.length} entries to Anthropic Batch API model '${args.model}'...`,
  );

  const client = new Anthropic();
  const requests = entries.map((entry) => ({
    custom_id: safeCustomId(entry.message_id),
    params: {
      model: args.model,
      max_tokens: 800,
      // Deterministic extraction: name/role/company come from explicit context,
      // topics are picked from a fixed vocabulary, output is schema-constrained.
      // Matching Ollama's temperature=0 so the A/B is apples-to-apples.
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: 'extract_email_info',
          description: 'Return structured info extracted from the email.',
          // SDK's InputSchema needs `type: 'object'` at the root; `Record<string, unknown>` erases it.
          input_schema: EMAIL_EXTRACTION_SCHEMA as unknown as { type: 'object'; [k: string]: unknown },
        },
      ],
      tool_choice: { type: 'tool' as const, name: 'extract_email_info' },
      messages: [{ role: 'user' as const, content: buildUserPrompt(entry) }],
    },
  }));

  const batch = await client.messages.batches.create({
    requests: requests as unknown as Parameters<typeof client.messages.batches.create>[0]['requests'],
  });

  const meta: BatchMeta = {
    batch_id: batch.id,
    submitted_at: new Date().toISOString(),
    model: args.model,
    count: requests.length,
    custom_id_to_message_id: Object.fromEntries(
      entries.map((e) => [safeCustomId(e.message_id), e.message_id]),
    ),
    candidates_by_custom_id: Object.fromEntries(
      entries.map((e) => [safeCustomId(e.message_id), e.payload.candidates]),
    ),
  };
  writeFileSync(args.meta, JSON.stringify(meta, null, 2));

  console.log(`Submitted batch ${batch.id} (${requests.length} requests) → metadata in ${args.meta}`);
  console.log(`Check status with: pnpm mbox:llm-enrich batch-fetch --meta ${args.meta}`);
}

async function fetchAnthropicBatch(args: BatchFetchArgs): Promise<void> {
  const meta = JSON.parse(readFileSync(args.meta, 'utf-8')) as BatchMeta;
  const client = new Anthropic();
  const batch = await client.messages.batches.retrieve(meta.batch_id);

  if (batch.processing_status !== 'ended') {
    console.log(`Batch ${batch.id} status: ${batch.processing_status}`);
    console.log(`Counts: ${JSON.stringify(batch.request_counts)}`);
    return;
  }

  const idMap = meta.custom_id_to_message_id;
  const candidatesById = meta.candidates_by_custom_id;
  let written = 0;
  let errors = 0;

  // SDK returns Promise<JSONLDecoder<...>>. Must await first, then async-iterate.
  const stream = await client.messages.batches.results(meta.batch_id);
  const outFd = openSync(args.output, 'w');
  try {
    for await (const result of stream) {
      const messageId = idMap[result.custom_id] ?? result.custom_id;
      if (result.result.type !== 'succeeded') {
        writeSync(outFd, JSON.stringify({ message_id: messageId, error: result.result.type }) + '\n');
        errors++;
        continue;
      }
      const msg = result.result.message;
      const toolUse = msg.content.find(
        (b): b is Extract<typeof msg.content[number], { type: 'tool_use' }> => b.type === 'tool_use',
      );
      if (!toolUse) {
        writeSync(outFd, JSON.stringify({ message_id: messageId, error: 'no_tool_use_in_response' }) + '\n');
        errors++;
        continue;
      }
      const parsed = toolUse.input as Partial<LlmExtraction>;
      const candidates = candidatesById[result.custom_id] ?? [];
      const enriched: EnrichedRecord = {
        message_id: messageId,
        topics: Array.isArray(parsed.topics) ? parsed.topics : [],
        people: mergePeopleWithCandidates(
          Array.isArray(parsed.people) ? (parsed.people as LlmPerson[]) : [],
          candidates,
        ),
      };
      writeSync(outFd, JSON.stringify(enriched) + '\n');
      written++;
    }
  } finally {
    closeSync(outFd);
  }

  console.log(`Wrote ${written} records (${errors} errors) to ${args.output}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }

  switch (args.cmd) {
    case 'ollama':
      await runOllama(args);
      break;
    case 'batch-submit':
      await submitAnthropicBatch(args);
      break;
    case 'batch-fetch':
      await fetchAnthropicBatch(args);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
