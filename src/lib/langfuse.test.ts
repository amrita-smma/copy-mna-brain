import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLangfuseEnabled,
  langfuseEnvironment,
  resetLangfuseHandlerForTests,
  withLangfuseCallbacks,
} from "./langfuse";
import {
  getLangfuseUserId,
  getLangfuseWorkspaceSlug,
  runWithLangfuseUser,
  runWithLangfuseWorkspace,
} from "./langfuseUser";

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

describe("runWithLangfuseUser", () => {
  it("exposes the user to everything inside the callback", () => {
    runWithLangfuseUser("user-1", () => {
      expect(getLangfuseUserId()).toBe("user-1");
    });
  });

  it("survives async hops, which is the whole point of the store", async () => {
    await runWithLangfuseUser("user-1", async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getLangfuseUserId()).toBe("user-1");
    });
  });

  it("leaves no user set outside the callback", () => {
    runWithLangfuseUser("user-1", () => {});
    expect(getLangfuseUserId()).toBeUndefined();
  });

  it("nests, so an inner run can re-attribute its own work", () => {
    runWithLangfuseUser("outer", () => {
      runWithLangfuseUser("inner", () => {
        expect(getLangfuseUserId()).toBe("inner");
      });
      expect(getLangfuseUserId()).toBe("outer");
    });
  });

  it("is a no-op for an absent id rather than inventing an empty user", () => {
    // A cron-triggered routine and an internal pipeline upload both land here;
    // an empty-string userId would show up in Langfuse as a real user named "".
    for (const id of [null, undefined, "", "   "]) {
      runWithLangfuseUser(id, () => {
        expect(getLangfuseUserId()).toBeUndefined();
      });
    }
  });

  it("trims, so a padded id does not become a second Langfuse user", () => {
    runWithLangfuseUser("  user-1  ", () => {
      expect(getLangfuseUserId()).toBe("user-1");
    });
  });

  it("returns whatever the callback returns", () => {
    expect(runWithLangfuseUser("user-1", () => 42)).toBe(42);
    expect(runWithLangfuseUser(null, () => 42)).toBe(42);
  });
});

describe("withLangfuseCallbacks user attribution", () => {
  const stubKeys = () => {
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  };

  it("stamps the ambient user as langfuseUserId, the key the handler reads", () => {
    stubKeys();

    const merged = runWithLangfuseUser("user-1", () =>
      withLangfuseCallbacks({ runName: "chat.title" }),
    ) as { runName: string; metadata: Record<string, unknown> };

    expect(merged.runName).toBe("chat.title");
    expect(merged.metadata.langfuseUserId).toBe("user-1");
  });

  it("merges into metadata the caller already set instead of replacing it", () => {
    // The agent runtime stamps its effort tier here; losing it would make
    // "which tier ran this turn?" unanswerable from a trace.
    stubKeys();

    const merged = runWithLangfuseUser("user-1", () =>
      withLangfuseCallbacks({ metadata: { effort_tier: "medium" } }),
    ) as { metadata: Record<string, unknown> };

    expect(merged.metadata).toEqual({
      effort_tier: "medium",
      langfuseUserId: "user-1",
    });
  });

  it("lets an explicit langfuseUserId from the call site win", () => {
    stubKeys();

    const merged = runWithLangfuseUser("ambient", () =>
      withLangfuseCallbacks({ metadata: { langfuseUserId: "explicit" } }),
    ) as { metadata: Record<string, unknown> };

    expect(merged.metadata.langfuseUserId).toBe("explicit");
  });

  it("adds no metadata key when no user is in context", () => {
    stubKeys();

    const merged = withLangfuseCallbacks({ runName: "cron.daily_pulse" }) as {
      metadata?: Record<string, unknown>;
    };

    expect(merged.metadata).toBeUndefined();
  });

  it("does not mutate the caller's metadata object", () => {
    stubKeys();
    const metadata: Record<string, unknown> = { effort_tier: "medium" };

    runWithLangfuseUser("user-1", () => withLangfuseCallbacks({ metadata }));

    expect(metadata).toEqual({ effort_tier: "medium" });
  });

  it("stamps nothing when tracing is off — there is no trace to attribute", () => {
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    const config = { runName: "chat.title" };

    expect(runWithLangfuseUser("user-1", () => withLangfuseCallbacks(config))).toBe(
      config,
    );
  });
});

describe("runWithLangfuseWorkspace", () => {
  it("exposes the slug to everything inside the callback, across async hops", async () => {
    const seen = await runWithLangfuseWorkspace("acme", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getLangfuseWorkspaceSlug();
    });

    expect(seen).toBe("acme");
    expect(getLangfuseWorkspaceSlug()).toBeUndefined();
  });

  it("is a no-op for an absent or blank slug", () => {
    expect(runWithLangfuseWorkspace(null, () => getLangfuseWorkspaceSlug())).toBeUndefined();
    expect(runWithLangfuseWorkspace("  ", () => getLangfuseWorkspaceSlug())).toBeUndefined();
  });

  it("trims the slug", () => {
    expect(runWithLangfuseWorkspace(" acme ", () => getLangfuseWorkspaceSlug())).toBe("acme");
  });
});

describe("withLangfuseCallbacks workspace attribution", () => {
  const stubKeys = () => {
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  };

  it("stamps the ambient workspace slug as workspace_slug", () => {
    stubKeys();

    const merged = runWithLangfuseWorkspace("acme", () =>
      withLangfuseCallbacks({ runName: "chat.copilot" }),
    ) as unknown as { metadata: Record<string, unknown> };

    expect(merged.metadata).toEqual({ workspace_slug: "acme" });
  });

  it("stamps the user and the workspace together, keeping the caller's metadata", () => {
    stubKeys();

    const merged = runWithLangfuseUser("user-1", () =>
      runWithLangfuseWorkspace("acme", () =>
        withLangfuseCallbacks({ metadata: { effort_tier: "medium" } }),
      ),
    ) as { metadata: Record<string, unknown> };

    expect(merged.metadata).toEqual({
      effort_tier: "medium",
      langfuseUserId: "user-1",
      workspace_slug: "acme",
    });
  });

  it("lets an explicit workspace_slug from the call site win", () => {
    stubKeys();

    const merged = runWithLangfuseWorkspace("ambient", () =>
      withLangfuseCallbacks({ metadata: { workspace_slug: "explicit" } }),
    ) as { metadata: Record<string, unknown> };

    expect(merged.metadata.workspace_slug).toBe("explicit");
  });
});
