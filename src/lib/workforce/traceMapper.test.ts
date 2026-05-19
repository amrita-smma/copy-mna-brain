import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";
import type { HumanDecision } from "@/lib/db/schema";
import { buildTrace, type TraceActor } from "./traceMapper";

const ACTOR: TraceActor = {
  id: "u-1",
  name: "Ken H",
  initials: "KH",
  avatarTone: "indigo",
};

const STARTED = "2026-05-15T10:00:00Z";

function ai(content: string, toolCalls: Array<{ id: string; name: string; args: unknown }> = []) {
  return new AIMessage({ content, tool_calls: toolCalls });
}
function tool(content: string, toolCallId: string) {
  return new ToolMessage({ content, tool_call_id: toolCallId });
}

describe("buildTrace", () => {
  it("returns empty for no messages", () => {
    expect(
      buildTrace({
        messages: [],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      }),
    ).toEqual([]);
  });

  it("skips HumanMessages and emits one step per AIMessage", () => {
    const steps = buildTrace({
      messages: [new HumanMessage("hi"), ai("hello back")],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("done");
    expect(steps[0].stepNumber).toBe(1);
    expect(steps[0].title).toBe("Final response");
    expect(steps[0].description).toBe("hello back");
    expect(steps[0].toolCalls).toBeUndefined();
  });

  it("assigns sequential stepNumbers starting at 1", () => {
    const steps = buildTrace({
      messages: [ai("turn one"), ai("turn two"), ai("turn three")],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps.map((s) => s.stepNumber)).toEqual([1, 2, 3]);
  });

  it("marks a tool call without ToolMessage as running", () => {
    const steps = buildTrace({
      messages: [
        ai("calling tool", [{ id: "c-1", name: "promote_company", args: { id: "acme" } }]),
      ],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("active");
    expect(steps[0].toolCalls?.[0].running).toBe(true);
    expect(steps[0].toolCalls?.[0].output).toBeUndefined();
  });

  it("folds a matching ToolMessage into the tool call output", () => {
    const steps = buildTrace({
      messages: [
        ai("calling tool", [{ id: "c-1", name: "promote_company", args: { id: "acme" } }]),
        tool("Promoted Acme to L1", "c-1"),
      ],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("done");
    const call = steps[0].toolCalls?.[0];
    expect(call?.running).toBeUndefined();
    expect(call?.output?.rows?.[0]?.value).toBe("Promoted Acme to L1");
  });

  it("attaches a pending interrupt to the latest AIMessage", () => {
    const pendingWrites: CheckpointPendingWrite[] = [
      [
        "task-1",
        "__interrupt__",
        {
          value: {
            actionRequests: [
              {
                name: "promote_company",
                args: { id: "acme" },
                description: "Promote Acme to L1?",
              },
            ],
          },
        },
      ],
    ];
    const steps = buildTrace({
      messages: [
        ai("about to call", [{ id: "c-1", name: "promote_company", args: { id: "acme" } }]),
      ],
      pendingWrites,
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("intervention-waiting");
    expect(steps[0].intervention).toEqual({
      state: "waiting",
      question: "Promote Acme to L1?",
      tool_call_id: "c-1",
      tool_name: "promote_company",
    });
  });

  it("attaches a resolved approve decision to the matching AIMessage", () => {
    const decisions: HumanDecision[] = [
      {
        tool_call_id: "c-1",
        tool_name: "promote_company",
        decision: "approve",
        decided_at: "2026-05-15T10:01:30Z",
      },
    ];
    const steps = buildTrace({
      messages: [
        ai("calling tool", [{ id: "c-1", name: "promote_company", args: { id: "acme" } }]),
        tool("Promoted Acme to L1", "c-1"),
      ],
      pendingWrites: [],
      humanDecisions: decisions,
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].status).toBe("intervention-resolved");
    expect(steps[0].intervention).toMatchObject({
      state: "resolved",
      resolution: {
        actor: "Ken H",
        actorInitials: "KH",
        avatarTone: "indigo",
        decision: "approved",
        text: "Approved as proposed",
        timestamp: "10:01:30",
      },
    });
  });

  it("maps an edit decision to 'modified' with the edited args in text", () => {
    const decisions: HumanDecision[] = [
      {
        tool_call_id: "c-2",
        tool_name: "promote_company",
        decision: "edit",
        edited_args: { id: "acme", note: "weak EBITDA" },
        decided_at: "2026-05-15T10:02:00Z",
      },
    ];
    const steps = buildTrace({
      messages: [
        ai("calling tool", [{ id: "c-2", name: "promote_company", args: { id: "acme" } }]),
        tool("Promoted Acme to L1", "c-2"),
      ],
      pendingWrites: [],
      humanDecisions: decisions,
      actor: ACTOR,
      startedAt: STARTED,
    });
    const resolution = (steps[0].intervention as { resolution: { decision: string; text: string } })
      .resolution;
    expect(resolution.decision).toBe("modified");
    expect(resolution.text).toContain("weak EBITDA");
  });

  it("maps a reject decision to 'modified' with the rejection message", () => {
    const decisions: HumanDecision[] = [
      {
        tool_call_id: "c-3",
        tool_name: "promote_company",
        decision: "reject",
        rejection_message: "EBITDA too thin",
        decided_at: "2026-05-15T10:03:00Z",
      },
    ];
    const steps = buildTrace({
      messages: [ai("calling tool", [{ id: "c-3", name: "promote_company", args: {} }])],
      pendingWrites: [],
      humanDecisions: decisions,
      actor: ACTOR,
      startedAt: STARTED,
    });
    const resolution = (steps[0].intervention as { resolution: { decision: string; text: string } })
      .resolution;
    expect(resolution.decision).toBe("modified");
    expect(resolution.text).toBe("EBITDA too thin");
  });

  it("handles mixed: one resolved AIMessage and a later AIMessage with a pending interrupt", () => {
    const pendingWrites: CheckpointPendingWrite[] = [
      [
        "task-1",
        "__interrupt__",
        {
          actionRequests: [
            { name: "send_email", args: {}, description: "Send email to vendor?" },
          ],
        },
      ],
    ];
    const decisions: HumanDecision[] = [
      {
        tool_call_id: "c-1",
        tool_name: "promote_company",
        decision: "approve",
        decided_at: "2026-05-15T10:01:30Z",
      },
    ];
    const steps = buildTrace({
      messages: [
        ai("turn 1", [{ id: "c-1", name: "promote_company", args: {} }]),
        tool("done", "c-1"),
        ai("turn 2", [{ id: "c-2", name: "send_email", args: {} }]),
      ],
      pendingWrites,
      humanDecisions: decisions,
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].status).toBe("intervention-resolved");
    expect(steps[1].status).toBe("intervention-waiting");
    expect(steps[1].intervention).toEqual({
      state: "waiting",
      question: "Send email to vendor?",
      tool_call_id: "c-2",
      tool_name: "send_email",
    });
  });

  it("lifts narrate_step args into title/description and hides the tool row", () => {
    const steps = buildTrace({
      messages: [
        ai("thinking out loud", [
          {
            id: "n-1",
            name: "narrate_step",
            args: {
              title: "Verifying L0 stage",
              overview: "Checking Acme's current pipeline stage before promotion.",
            },
          },
          { id: "c-1", name: "get_company_details", args: { name: "Acme" } },
        ]),
        tool("found at L0", "c-1"),
      ],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps).toHaveLength(1);
    const s = steps[0];
    expect(s.title).toBe("Verifying L0 stage");
    expect(s.description).toBe(
      "Checking Acme's current pipeline stage before promotion.",
    );
    // narrate_step itself should be filtered from the rendered tool calls.
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls?.[0].name).toBe("get_company_details");
  });

  it("uses narrate_step args even when the tool hasn't run yet (HITL pause)", () => {
    // Simulates the case where the AIMessage has both narrate_step and a
    // gated tool, but HITL is pausing — no ToolMessages exist yet.
    const steps = buildTrace({
      messages: [
        ai("about to promote", [
          {
            id: "n-1",
            name: "narrate_step",
            args: {
              title: "Promoting Acme",
              overview: "Moving Acme from L0 to L1 with an EBITDA caveat note.",
            },
          },
          {
            id: "c-1",
            name: "promote_to_l1",
            args: { company_name: "Acme" },
          },
        ]),
      ],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].title).toBe("Promoting Acme");
    expect(steps[0].description).toContain("L0 to L1");
    // Real tool is still pending.
    expect(steps[0].status).toBe("active");
    expect(steps[0].toolCalls?.[0].running).toBe(true);
  });

  it("falls back to derived title when no narrate_step is present", () => {
    const steps = buildTrace({
      messages: [
        ai("calling tool", [{ id: "c-1", name: "promote_to_l1", args: {} }]),
      ],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].title).toBe("Tool promote_to_l1");
  });

  describe("final-report fallback parsing", () => {
    it('lifts "✓ Done:" outcome into the title and first bullet into overview', () => {
      const steps = buildTrace({
        messages: [
          ai(
            [
              "✓ Done: Promoted Acme Corp from L0 to L1",
              "- Action: promote_to_l1(company_name=\"Acme Corp\")",
              "- Result: success",
              "- Notes: (none)",
            ].join("\n"),
          ),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps).toHaveLength(1);
      expect(steps[0].title).toBe("✓ Promoted Acme Corp from L0 to L1");
      expect(steps[0].description).toContain("promote_to_l1");
    });

    it('lifts "✗ Could not complete:" reason as a failure title', () => {
      const steps = buildTrace({
        messages: [
          ai(
            [
              "✗ Could not complete: company not found",
              "- Attempted: get_company_details on Blue Harbor Logistics",
              "- Blocker: no row in DB and web_search returned nothing useful",
            ].join("\n"),
          ),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].title).toBe("✗ company not found");
      expect(steps[0].description).toContain("get_company_details");
    });

    it("prefers narrate_step over the fallback when both are present", () => {
      const steps = buildTrace({
        messages: [
          ai("✓ Done: Promoted Acme", [
            {
              id: "n-1",
              name: "narrate_step",
              args: {
                title: "Promoted Acme to L1",
                overview: "Pipeline stage moved L0 → L1 with EBITDA caveat.",
              },
            },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].title).toBe("Promoted Acme to L1");
      expect(steps[0].description).toBe(
        "Pipeline stage moved L0 → L1 with EBITDA caveat.",
      );
    });

    it("falls back to 'Final response' when neither narrate_step nor the report format is present", () => {
      const steps = buildTrace({
        messages: [ai("Plain freeform reply with no headers.")],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].title).toBe("Final response");
      expect(steps[0].description).toBe(
        "Plain freeform reply with no headers.",
      );
    });
  });

  describe("status badge derivation", () => {
    it("emits 'promoted' with pass tone for a successful promote_to_l1", () => {
      const steps = buildTrace({
        messages: [
          ai("doing it", [{ id: "c-1", name: "promote_to_l1", args: {} }]),
          tool('Promoted "Acme" from L0 to L1.', "c-1"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].status).toBe("promoted");
      expect(steps[0].toolCalls?.[0].tone).toBe("pass");
    });

    it("emits 'refused' with fail tone when promote_to_l1 rejects due to stage mismatch", () => {
      const steps = buildTrace({
        messages: [
          ai("doing it", [{ id: "c-1", name: "promote_to_l1", args: {} }]),
          tool(
            'Cannot promote "Acme" to L1: current pipeline stage is L2, expected L0.',
            "c-1",
          ),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].status).toBe("refused");
      expect(steps[0].toolCalls?.[0].tone).toBe("fail");
    });

    it("emits 'N matches' with pass tone for query_companies success", () => {
      const steps = buildTrace({
        messages: [
          ai("querying", [{ id: "c-1", name: "query_companies", args: {} }]),
          tool(
            "**Query Results (5 companies):**\n\nAcme | semiconductors | KR | ...",
            "c-1",
          ),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].status).toBe("5 matches");
      expect(steps[0].toolCalls?.[0].tone).toBe("pass");
    });

    it("emits '1 match' (singular) for a single hit", () => {
      const steps = buildTrace({
        messages: [
          ai("querying", [{ id: "c-1", name: "query_companies", args: {} }]),
          tool("**Query Results (1 companies):**\n\nAcme | ...", "c-1"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].status).toBe("1 match");
    });

    it("emits 'no matches' with warn tone when query_companies returns zero rows", () => {
      const steps = buildTrace({
        messages: [
          ai("querying", [{ id: "c-1", name: "query_companies", args: {} }]),
          tool("No companies found matching the filter.", "c-1"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].status).toBe("no matches");
      expect(steps[0].toolCalls?.[0].tone).toBe("warn");
    });

    it("emits 'error' with fail tone for a tool that returned a **Error:** prefix", () => {
      const steps = buildTrace({
        messages: [
          ai("querying", [{ id: "c-1", name: "query_companies", args: {} }]),
          tool("**Error:** DB timed out", "c-1"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].status).toBe("error");
      expect(steps[0].toolCalls?.[0].tone).toBe("fail");
    });

    it("does not emit a status for tools we don't recognize", () => {
      const steps = buildTrace({
        messages: [
          ai("calling", [{ id: "c-1", name: "some_unknown_tool", args: {} }]),
          tool("arbitrary output", "c-1"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].status).toBeUndefined();
      expect(steps[0].toolCalls?.[0].tone).toBeUndefined();
    });

    it("emits no status while the tool is still running", () => {
      const steps = buildTrace({
        messages: [
          ai("calling", [{ id: "c-1", name: "promote_to_l1", args: {} }]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].running).toBe(true);
      expect(steps[0].toolCalls?.[0].status).toBeUndefined();
      expect(steps[0].toolCalls?.[0].tone).toBeUndefined();
    });
  });

  describe("outcome chips", () => {
    it("emits an outcome chip per resolved, toned tool call", () => {
      const steps = buildTrace({
        messages: [
          ai("doing it", [
            { id: "c-1", name: "promote_to_l1", args: {} },
            { id: "c-2", name: "query_companies", args: {} },
          ]),
          tool('Promoted "Acme" to L1.', "c-1"),
          tool("**Query Results (3 companies):**\n\n...", "c-2"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].outcomeChips).toEqual([
        { label: "promoted", tone: "pass" },
        { label: "3 matches", tone: "pass" },
      ]);
    });

    it("omits outcomeChips when nothing has resolved yet", () => {
      const steps = buildTrace({
        messages: [
          ai("calling", [{ id: "c-1", name: "promote_to_l1", args: {} }]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].outcomeChips).toBeUndefined();
    });
  });

  describe("plan-driven pending placeholders", () => {
    const planArgs = (plan: string[]) => ({
      title: "Verifying L0 stage",
      overview: "Looking up Acme.",
      plan,
    });

    it("appends pending steps for unrendered plan entries", () => {
      const steps = buildTrace({
        messages: [
          ai("thinking", [
            { id: "n-1", name: "narrate_step", args: planArgs(["Verify", "Promote", "Report"]) },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps).toHaveLength(3);
      expect(steps[0].stepNumber).toBe(1);
      expect(steps[0].status).toBe("done");
      expect(steps[1].status).toBe("pending");
      expect(steps[1].stepNumber).toBe(2);
      expect(steps[1].title).toBe("Promote");
      expect(steps[2].status).toBe("pending");
      expect(steps[2].stepNumber).toBe(3);
      expect(steps[2].title).toBe("Report");
    });

    it("uses the most recent plan when the agent revises it", () => {
      const steps = buildTrace({
        messages: [
          ai("turn 1", [
            { id: "n-1", name: "narrate_step", args: planArgs(["A", "B", "C"]) },
          ]),
          ai("turn 2", [
            { id: "n-2", name: "narrate_step", args: planArgs(["A", "B-revised", "D", "E"]) },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      // 2 executed + 2 pending from the revised plan.
      expect(steps).toHaveLength(4);
      expect(steps[2].title).toBe("D");
      expect(steps[3].title).toBe("E");
    });

    it("suppresses pending placeholders when terminal=true", () => {
      const steps = buildTrace({
        messages: [
          ai("done early", [
            { id: "n-1", name: "narrate_step", args: planArgs(["A", "B", "C"]) },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
        terminal: true,
      });
      expect(steps).toHaveLength(1);
      expect(steps[0].status).toBe("done");
    });

    it("ignores malformed plan args", () => {
      const steps = buildTrace({
        messages: [
          ai("turn", [
            {
              id: "n-1",
              name: "narrate_step",
              args: { title: "x", overview: "y", plan: [42, "ok"] },
            },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps).toHaveLength(1);
    });
  });
});
