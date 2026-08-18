import { CallbackHandler } from "langfuse-langchain";

/**
 * Returns a Langfuse CallbackHandler array for local development and Vercel
 * Preview deployments when the Langfuse secret key is provided. Production
 * remains opt-out by default. Otherwise, returns an empty array.
 *
 * This should be passed to the `callbacks` array in LangChain/LangGraph invocations.
 */
let langfuseHandler: CallbackHandler | null = null;

export function isLangfuseEnabled(
  env: Partial<
    Record<"NODE_ENV" | "VERCEL_ENV" | "LANGFUSE_SECRET_KEY", string>
  > = process.env,
): boolean {
  const supportedEnvironment =
    env.NODE_ENV === "development" || env.VERCEL_ENV === "preview";
  return supportedEnvironment && Boolean(env.LANGFUSE_SECRET_KEY);
}

export function getLangfuseCallbacks() {
  if (isLangfuseEnabled()) {
    if (!langfuseHandler) {
      langfuseHandler = new CallbackHandler({
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL || "http://langfuse-web:3000",
        flushAt: 1, // Flush immediately in local dev so traces aren't lost
      });
    }
    return [langfuseHandler];
  }
  return [];
}

/** Drain the Langfuse queue — call after streamed chat turns so events aren't dropped. */
export async function flushLangfuse(): Promise<void> {
  if (!langfuseHandler) return;
  try {
    await langfuseHandler.flushAsync();
  } catch (err) {
    console.warn("[langfuse] flush failed", err);
  }
}
