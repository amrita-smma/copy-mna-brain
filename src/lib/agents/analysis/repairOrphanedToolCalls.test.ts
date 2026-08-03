import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
  ORPHANED_TOOL_CANCELLED_CONTENT,
  buildOrphanedToolRepairMessages,
  collectOrphanedToolCalls,
} from "./repairOrphanedToolCalls";

describe("collectOrphanedToolCalls", () => {
  it("returns empty when every tool_call has a ToolMessage", () => {
    const messages = [
      new HumanMessage("email me a deck"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "send_email", args: {} }],
      }),
      new ToolMessage({ content: "Sent.", tool_call_id: "c1", name: "send_email" }),
    ];
    expect(collectOrphanedToolCalls(messages)).toEqual([]);
  });

  it("finds tool_calls left open after a mid-tool abort", () => {
    const messages = [
      new HumanMessage("email me a deck"),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c1", name: "send_email", args: { presentation: { title: "T" } } },
        ],
      }),
    ];
    expect(collectOrphanedToolCalls(messages)).toEqual([
      { id: "c1", name: "send_email" },
    ]);
  });
});

describe("buildOrphanedToolRepairMessages", () => {
  it("builds cancelled ToolMessages for orphans", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "send_email", args: {} }],
      }),
    ];
    const repairs = buildOrphanedToolRepairMessages(messages);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toBeInstanceOf(ToolMessage);
    expect(repairs[0].tool_call_id).toBe("c1");
    expect(repairs[0].name).toBe("send_email");
    expect(repairs[0].content).toBe(ORPHANED_TOOL_CANCELLED_CONTENT);
  });
});
