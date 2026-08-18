import { describe, expect, it } from "vitest";
import { isLangfuseEnabled } from "./langfuse";

describe("isLangfuseEnabled", () => {
  it("enables tracing in local development when a secret key is configured", () => {
    expect(
      isLangfuseEnabled({
        NODE_ENV: "development",
        LANGFUSE_SECRET_KEY: "secret",
      }),
    ).toBe(true);
  });

  it("enables tracing in Vercel Preview even though NODE_ENV is production", () => {
    expect(
      isLangfuseEnabled({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        LANGFUSE_SECRET_KEY: "secret",
      }),
    ).toBe(true);
  });

  it("keeps production tracing disabled by default", () => {
    expect(
      isLangfuseEnabled({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        LANGFUSE_SECRET_KEY: "secret",
      }),
    ).toBe(false);
  });

  it("requires the Langfuse secret key in supported environments", () => {
    expect(
      isLangfuseEnabled({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      }),
    ).toBe(false);
  });
});
