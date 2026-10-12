import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLangfuseEnabled,
  langfuseEnvironment,
  resetLangfuseHandlerForTests,
  withLangfuseCallbacks,
} from "./langfuse";

afterEach(() => {
  resetLangfuseHandlerForTests();
  vi.unstubAllEnvs();
});

describe("isLangfuseEnabled", () => {
  const KEYS = {
    LANGFUSE_SECRET_KEY: "secret",
    LANGFUSE_PUBLIC_KEY: "public",
  };

  it("enables tracing in local development when the keys are configured", () => {
    expect(isLangfuseEnabled({ NODE_ENV: "development", ...KEYS })).toBe(true);
  });

  it("enables tracing in Vercel Preview", () => {
    expect(
      isLangfuseEnabled({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        ...KEYS,
      }),
    ).toBe(true);
  });

  it("enables tracing in production, which is the point of the self-hosted instance", () => {
    expect(
      isLangfuseEnabled({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        ...KEYS,
      }),
    ).toBe(true);
  });

  it("stays off wherever no keys are configured", () => {
    expect(
      isLangfuseEnabled({ NODE_ENV: "production", VERCEL_ENV: "production" }),
    ).toBe(false);
    expect(isLangfuseEnabled({ NODE_ENV: "development" })).toBe(false);
  });

  it("stays off when only one of the two keys is set", () => {
    // Langfuse authenticates ingestion with the pair, so a half-configured
    // environment would emit traces that are rejected with nothing failing
    // locally to say so.
    expect(isLangfuseEnabled({ LANGFUSE_SECRET_KEY: "secret" })).toBe(false);
    expect(isLangfuseEnabled({ LANGFUSE_PUBLIC_KEY: "public" })).toBe(false);
  });

  it("honours the kill switch even with both keys present", () => {
    expect(
      isLangfuseEnabled({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        ...KEYS,
        LANGFUSE_TRACING_DISABLED: "true",
      }),
    ).toBe(false);
  });

  it("only treats the exact string 'true' as the kill switch", () => {
    expect(
      isLangfuseEnabled({ ...KEYS, LANGFUSE_TRACING_DISABLED: "false" }),
    ).toBe(true);
  });
});

describe("langfuseEnvironment", () => {
  it("prefers VERCEL_ENV over NODE_ENV so preview and production are distinguishable", () => {
    expect(
      langfuseEnvironment({ NODE_ENV: "production", VERCEL_ENV: "preview" }),
    ).toBe("preview");
  });

  it("falls back to NODE_ENV off Vercel", () => {
    expect(langfuseEnvironment({ NODE_ENV: "development" })).toBe("development");
  });

  it("returns 'default' when neither is set", () => {
    expect(langfuseEnvironment({})).toBe("default");
  });

  it("lowercases the value Langfuse is given", () => {
    expect(langfuseEnvironment({ NODE_ENV: "Production" })).toBe("production");
  });

  it("degrades to 'default' rather than sending a name Langfuse rejects", () => {
    // Langfuse 400s the whole ingestion batch on an invalid environment, so a
    // junk value must not be forwarded.
    expect(langfuseEnvironment({ NODE_ENV: "my env!" })).toBe("default");
    expect(langfuseEnvironment({ NODE_ENV: "langfuse-internal" })).toBe(
      "default",
    );
  });
});

describe("withLangfuseCallbacks", () => {
  const stubKeys = () => {
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  };

  it("returns the config untouched when tracing is off", () => {
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    const config = { timeout: 5 };
    expect(withLangfuseCallbacks(config)).toBe(config);
  });

  it("tolerates no config at all when tracing is off", () => {
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    expect(withLangfuseCallbacks()).toEqual({});
  });

  it("appends the handler while preserving the caller's other config keys", () => {
    stubKeys();

    const merged = withLangfuseCallbacks({ timeout: 5, runName: "x" }) as {
      timeout: number;
      runName: string;
      callbacks: unknown[];
    };

    expect(merged.timeout).toBe(5);
    expect(merged.runName).toBe("x");
    expect(merged.callbacks).toHaveLength(1);
  });

  it("keeps callbacks the caller already passed as an array", () => {
    stubKeys();
    const existing = { name: "caller" };

    const merged = withLangfuseCallbacks({ callbacks: [existing] }) as {
      callbacks: unknown[];
    };

    expect(merged.callbacks).toHaveLength(2);
    expect(merged.callbacks[0]).toBe(existing);
  });

  it("promotes a single non-array callback instead of dropping it", () => {
    // LangChain accepts `callbacks` as one handler, and the hand-rolled
    // `[...(config.callbacks || [])]` spread this helper replaced would have
    // thrown on that shape.
    stubKeys();
    const existing = { name: "caller" };

    const merged = withLangfuseCallbacks({ callbacks: existing }) as {
      callbacks: unknown[];
    };

    expect(merged.callbacks).toHaveLength(2);
    expect(merged.callbacks[0]).toBe(existing);
  });

  it("merges into a CallbackManager via addHandler rather than wrapping it", () => {
    // LangChain types `callbacks` as `CallbackManager | BaseCallbackHandler[]`,
    // so an array containing a manager is neither and would break tracing.
    stubKeys();
    const added: unknown[] = [];
    const copy = {
      copy: () => copy,
      addHandler: (h: unknown) => added.push(h),
    };
    const manager = { copy: () => copy, addHandler: () => {} };

    const merged = withLangfuseCallbacks({ callbacks: manager }) as {
      callbacks: unknown;
    };

    expect(Array.isArray(merged.callbacks)).toBe(false);
    expect(merged.callbacks).toBe(copy);
    expect(added).toHaveLength(1);
  });

  it("does not mutate the config it was given", () => {
    stubKeys();
    const config: Record<string, unknown> = { timeout: 5 };

    withLangfuseCallbacks(config);

    expect(config.callbacks).toBeUndefined();
  });
});
