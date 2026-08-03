import { CallbackHandler } from "langfuse-langchain";

/**
 * Returns a Langfuse CallbackHandler array if the environment is development
 * and the Langfuse secret key is provided. Otherwise, returns an empty array.
 *
 * This should be passed to the `callbacks` array in LangChain/LangGraph invocations.
 */
let langfuseHandler: CallbackHandler | null = null;

export function getLangfuseCallbacks() {
  if (process.env.NODE_ENV === "development" && process.env.LANGFUSE_SECRET_KEY) {
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
