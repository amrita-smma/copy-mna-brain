import { Langfuse } from 'langfuse';
import { isLangfuseEnabled, langfuseEnvironment } from '@/lib/langfuse';
import { getLangfuseUserId } from '@/lib/langfuseUser';

/**
 * Best-effort Langfuse tracing for the raw Anthropic SDK presentation jobs —
 * the pptx skill and single-slide generation. Those call the SDK directly, so
 * they cannot use LangChain callbacks and build spans by hand instead.
 * Failures must never break presentation generation.
 *
 * Shares the gate with getLangfuseCallbacks() (see @/lib/langfuse) so the raw
 * Anthropic SDK path is traced in exactly the environments the LangChain paths
 * are — it used to be development-only, which left every staging and production
 * presentation generation invisible.
 */

export type PptxTraceMeta = {
  workspaceId?: string;
  mode: 'agent_presentation' | 'agent_slide';
  title?: string;
};

type GenerationHandle = {
  end: (opts: {
    output?: string;
    level?: 'DEFAULT' | 'ERROR';
    statusMessage?: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

export type PptxTrace = {
  startGeneration: (opts: {
    name: string;
    model: string;
    input: string;
    metadata?: Record<string, unknown>;
  }) => GenerationHandle;
  update: (opts: { metadata?: Record<string, unknown>; output?: string }) => void;
  end: (opts?: { output?: string; level?: 'DEFAULT' | 'ERROR'; statusMessage?: string }) => void;
  flush: () => Promise<void>;
};

const NOOP_GENERATION: GenerationHandle = {
  end: () => {},
};

const NOOP_TRACE: PptxTrace = {
  startGeneration: () => NOOP_GENERATION,
  update: () => {},
  end: () => {},
  flush: async () => {},
};

function shouldTrace(): boolean {
  return isLangfuseEnabled();
}

export function createPptxTrace(name: string, meta: PptxTraceMeta): PptxTrace {
  if (!shouldTrace()) return NOOP_TRACE;

  try {
    const langfuse = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || 'http://langfuse-web:3000',
      environment: langfuseEnvironment(),
      release: process.env.VERCEL_GIT_COMMIT_SHA,
    });

    // The raw SDK takes `userId` on the trace directly — there is no
    // RunnableConfig here for `withLangfuseCallbacks` to stamp it onto. Read
    // from the ambient context so a deck generated inside a Workforce run or a
    // chat turn lands under the same Langfuse user as the rest of that run.
    const trace = langfuse.trace({
      name,
      userId: getLangfuseUserId(),
      metadata: { ...meta },
      tags: ['presentation', meta.mode],
    });

    return {
      startGeneration: (opts) => {
        try {
          const gen = trace.generation({
            name: opts.name,
            model: opts.model,
            input: String(opts.input ?? '').slice(0, 8_000),
            metadata: opts.metadata,
          });
          return {
            end: (endOpts) => {
              try {
                gen.end({
                  output: endOpts.output?.slice(0, 4_000),
                  level: endOpts.level,
                  statusMessage: endOpts.statusMessage,
                  metadata: endOpts.metadata,
                });
              } catch (err) {
                console.warn('[pptxLangfuse] generation.end failed', err);
              }
            },
          };
        } catch (err) {
          console.warn('[pptxLangfuse] startGeneration failed', err);
          return NOOP_GENERATION;
        }
      },
      update: (opts) => {
        try {
          trace.update(opts);
        } catch (err) {
          console.warn('[pptxLangfuse] trace.update failed', err);
        }
      },
      end: (opts) => {
        try {
          const metadata: Record<string, unknown> = {};
          if (opts?.level !== undefined) metadata.level = opts.level;
          if (opts?.statusMessage !== undefined) {
            metadata.statusMessage = opts.statusMessage;
          }
          trace.update({
            output: opts?.output,
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          });
        } catch (err) {
          console.warn('[pptxLangfuse] trace.end failed', err);
        }
      },
      flush: async () => {
        try {
          await langfuse.flushAsync();
        } catch (err) {
          console.warn('[pptxLangfuse] flush failed', err);
        }
      },
    };
  } catch (err) {
    console.warn('[pptxLangfuse] create trace failed', err);
    return NOOP_TRACE;
  }
}
