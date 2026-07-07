import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { rewriteStaleFileBlocks } from "./rewriteFileReferences";

describe("rewriteStaleFileBlocks", () => {
  it("repoints a stale file block at the fresh upload id, preserving text and message id", () => {
    const messages = [
      new HumanMessage({
        id: "u1",
        content: [
          { type: "text", text: "look at this" },
          { type: "file", fileId: "old_file" },
        ],
      }),
    ];
    const out = rewriteStaleFileBlocks(messages, ["new_file"]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("u1");
    expect(out[0].content).toEqual([
      { type: "text", text: "look at this" },
      { type: "file", fileId: "new_file" },
    ]);
  });

  it("replaces a stale file block with a placeholder when nothing is attached anymore", () => {
    const messages = [
      new HumanMessage({ id: "u1", content: [{ type: "file", fileId: "old_file" }] }),
    ];
    const out = rewriteStaleFileBlocks(messages, []);
    expect(out[0].content).toEqual([{ type: "text", text: "[attachment removed]" }]);
  });

  it("maps multiple file blocks round-robin across the fresh ids", () => {
    const messages = [
      new HumanMessage({
        id: "u1",
        content: [
          { type: "file", fileId: "a" },
          { type: "file", fileId: "b" },
          { type: "file", fileId: "c" },
        ],
      }),
    ];
    const out = rewriteStaleFileBlocks(messages, ["x", "y"]);
    expect(out[0].content).toEqual([
      { type: "file", fileId: "x" },
      { type: "file", fileId: "y" },
      { type: "file", fileId: "x" },
    ]);
  });

  it("returns nothing to rewrite for messages without file blocks", () => {
    const messages = [
      new HumanMessage({ id: "u1", content: "plain text" }),
      new HumanMessage({ id: "u2", content: [{ type: "text", text: "no files" }] }),
      new AIMessage({ id: "a1", content: [{ type: "text", text: "hi" }] }),
    ];
    expect(rewriteStaleFileBlocks(messages, ["new_file"])).toEqual([]);
  });

  it("ignores non-human messages and messages missing an id", () => {
    const messages = [
      new AIMessage({ id: "a1", content: [{ type: "file", fileId: "old" }] }),
      new HumanMessage({ content: [{ type: "file", fileId: "old" }] }),
    ];
    expect(rewriteStaleFileBlocks(messages, ["new_file"])).toEqual([]);
  });
});
