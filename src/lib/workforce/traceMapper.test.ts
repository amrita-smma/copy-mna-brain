import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";
import type { HumanDecision } from "@/lib/db/schema";
import type { CheckpointMessageWrite } from "@/lib/repositories";
import {
  PRIVATE_OUTPUT_PLACEHOLDER,
  buildTrace,
  matchMessageTimestamps,
  type TraceActor,
} from "./traceMapper";

const ACTOR: TraceActor = {
  id: "u-1",
  name: "Ken H",
  initials: "KH",
  avatarTone: "indigo",
};

const STARTED = "2026-05-15T10:00:00Z";

function ai(content: string | unknown[], toolCalls: Array<{ id: string; name: string; args: unknown }> = []) {
  return new AIMessage({ content: content as string, tool_calls: toolCalls });
}
function tool(content: string, toolCallId: string) {
  return new ToolMessage({ content, tool_call_id: toolCallId });
}
type TraceInput = Parameters<typeof buildTrace>[0];
function trace(messages: TraceInput["messages"], extra: Partial<TraceInput> = {}) {
  return buildTrace({ messages, pendingWrites: [], humanDecisions: [], actor: ACTOR, startedAt: STARTED, ...extra });
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

  // Email notes are private to the people on each email; a Workforce run may
  // read them, but the trace (open to the whole workspace) never shows them.
  it.each(["read_contact_emails", "crm_banker_insights"])(
    "never puts %s output on the trace, and keeps every other tool's",
    (privateTool) => {
      const secret = "Sally said the seller accepts the escrow split if we sign before month end.";
      const steps = trace([
        ai("", [
          { id: "t1", name: privateTool, args: { correspondent_id: "c1" } },
          { id: "t2", name: "web_search", args: { query: "Sally Bubbles JP Organ" } },
        ]),
        tool(secret, "t1"),
        tool("JP Organ team page", "t2"),
        ai("✓ Done: Sally Bubbles at JP Organ, 2 fields filled"),
      ]);
      const calls = steps[0].toolCalls ?? [];
      expect(JSON.stringify(steps)).not.toContain("escrow split");
      expect(calls.find((c) => c.name === privateTool)?.output?.rows[0].value).toBe(PRIVATE_OUTPUT_PLACEHOLDER);
      expect(calls.find((c) => c.name === "web_search")?.output?.rows[0].value).toBe("JP Organ team page");
    },
  );

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

  it("exposes the full untruncated report on a text-only step", () => {
    // Longer than DESCRIPTION_MAX (280) so description is truncated but
    // fullReport keeps the whole markdown for the popup.
    const report = "# Company Card\n\n" + "Lots of detail. ".repeat(40);
    const steps = buildTrace({
      messages: [ai(report)],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].fullReport).toBe(report);
    expect(steps[0].description.length).toBeLessThan(report.length);
  });

  it("does not set fullReport on a tool-call step", () => {
    const steps = buildTrace({
      messages: [
        ai("calling tool", [
          { id: "c-1", name: "promote_company", args: { id: "acme" } },
        ]),
      ],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].fullReport).toBeUndefined();
  });

  it("does not set fullReport on an empty text step", () => {
    const steps = buildTrace({
      messages: [ai("   ")],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].fullReport).toBeUndefined();
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

  it("surfaces move_stage.reason as intervention.proposal on a pending interrupt", () => {
    const pendingWrites: CheckpointPendingWrite[] = [
      [
        "task-1",
        "__interrupt__",
        {
          value: {
            actionRequests: [
              {
                name: "move_stage",
                args: {
                  company_name: "Acme",
                  reason: "Revenue $42M FY2024, EBITDA margin 18%; thesis fit.",
                },
                description: "Promote Acme from L0 to L1?",
              },
            ],
          },
        },
      ],
    ];
    const steps = buildTrace({
      messages: [
        ai("about to call", [
          {
            id: "c-1",
            name: "move_stage",
            args: { company_name: "Acme" },
          },
        ]),
      ],
      pendingWrites,
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].intervention).toEqual({
      state: "waiting",
      question: "Promote Acme from L0 to L1?",
      proposal: "Revenue $42M FY2024, EBITDA margin 18%; thesis fit.",
      tool_call_id: "c-1",
      tool_name: "move_stage",
    });
  });

  it("appends move_stage.note after the reason in intervention.proposal", () => {
    const pendingWrites: CheckpointPendingWrite[] = [
      [
        "task-1",
        "__interrupt__",
        {
          value: {
            actionRequests: [
              {
                name: "move_stage",
                args: {
                  company_name: "Cinder Foods",
                  reason: "Strong revenue growth.",
                  note: "User acknowledged weak FY2023 EBITDA.",
                },
                description: "Promote Cinder Foods from L0 to L1?",
              },
            ],
          },
        },
      ],
    ];
    const steps = buildTrace({
      messages: [
        ai("about to call", [
          {
            id: "c-1",
            name: "move_stage",
            args: { company_name: "Cinder Foods" },
          },
        ]),
      ],
      pendingWrites,
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].intervention).toMatchObject({
      state: "waiting",
      proposal:
        "Strong revenue growth.\n\nNote: User acknowledged weak FY2023 EBITDA.",
    });
  });

  it("neutralizes in-flight tools and skips pending interrupts when terminal=true", () => {
    // Repro for MB-95: cancelling a HITL-paused task flips the row to
    // terminal but the LangGraph checkpoint still carries the unresolved
    // tool call + pending interrupt. The mapper must render the step as
    // 'done' with a 'cancelled' tool badge, not 'intervention-waiting' with
    // a live spinner + Approve/Reject buttons.
    const pendingWrites: CheckpointPendingWrite[] = [
      [
        "task-1",
        "__interrupt__",
        {
          value: {
            actionRequests: [
              {
                name: "move_stage",
                args: { id: "halcyon" },
                description: "Promote Halcyon Media to L1?",
              },
            ],
          },
        },
      ],
    ];
    const steps = buildTrace({
      messages: [
        ai("about to call", [
          { id: "c-1", name: "move_stage", args: { id: "halcyon" } },
        ]),
      ],
      pendingWrites,
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
      terminal: true,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("done");
    expect(steps[0].intervention).toBeUndefined();
    const call = steps[0].toolCalls?.[0];
    expect(call?.running).toBeUndefined();
    expect(call?.status).toBe("cancelled");
    expect(call?.tone).toBe("default");
  });

  describe("ask_owner interventions (MB-561)", () => {
    const ASK_ARGS = {
      question: "The Q3 report is gone. Use Q2?",
      recommendation: "Use Q2 and flag the gap",
      rationale: "Q2 is the latest audited set",
      options: ["Use Q2", "Drop the section"],
    };
    const OWNER: TraceActor = {
      id: "owner-1",
      name: "Insight Owner",
      initials: "IO",
      avatarTone: "rose",
    };

    it("renders the question, recommendation, rationale, options and who is asked", () => {
      const pendingWrites: CheckpointPendingWrite[] = [
        [
          "task-1",
          "__interrupt__",
          {
            value: {
              actionRequests: [
                { name: "ask_owner", args: ASK_ARGS, description: ASK_ARGS.question },
              ],
            },
          },
        ],
      ];
      const steps = trace([ai("", [{ id: "c-ask", name: "ask_owner", args: ASK_ARGS }])], {
        pendingWrites,
        waitingFor: "Insight Owner",
      });
      expect(steps[0].status).toBe("intervention-waiting");
      expect(steps[0].intervention).toEqual({
        state: "waiting",
        question: ASK_ARGS.question,
        ask: {
          recommendation: ASK_ARGS.recommendation,
          rationale: ASK_ARGS.rationale,
          options: ASK_ARGS.options,
        },
        waitingFor: "Insight Owner",
        tool_call_id: "c-ask",
        tool_name: "ask_owner",
      });
    });

    it.each([
      [
        { decision: "approve" as const, answer: ASK_ARGS.recommendation },
        "approved",
        `Accepted the recommendation: ${ASK_ARGS.recommendation}`,
      ],
      [{ decision: "edit" as const, answer: "Drop the section" }, "answered", "Answered: Drop the section"],
      [
        { decision: "reject" as const, rejection_message: "wait for Q3" },
        "rejected",
        "Declined: wait for Q3",
      ],
    ])("labels a resolved %o with the question and the person who decided", (fields, label, text) => {
      const decisions: HumanDecision[] = [
        {
          tool_call_id: "c-ask",
          tool_name: "ask_owner",
          decided_at: "2026-05-15T10:01:30Z",
          decided_by_user_id: "owner-1",
          question: ASK_ARGS.question,
          ...fields,
        },
      ];
      const steps = trace(
        [ai("", [{ id: "c-ask", name: "ask_owner", args: ASK_ARGS }]), tool("The owner answered", "c-ask")],
        { humanDecisions: decisions, deciders: { "owner-1": OWNER } },
      );
      expect(steps[0].status).toBe("intervention-resolved");
      expect(steps[0].intervention).toMatchObject({
        state: "resolved",
        question: ASK_ARGS.question,
        resolution: { actor: "Insight Owner", decision: label, text },
      });
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
            name: "move_stage",
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
        ai("calling tool", [{ id: "c-1", name: "move_stage", args: {} }]),
      ],
      pendingWrites: [],
      humanDecisions: [],
      actor: ACTOR,
      startedAt: STARTED,
    });
    expect(steps[0].title).toBe("Tool move_stage");
  });

  describe("final-report fallback parsing", () => {
    it('lifts "✓ Done:" outcome into the title and first bullet into overview', () => {
      const steps = buildTrace({
        messages: [
          ai(
            [
              "✓ Done: Promoted Acme Corp from L0 to L1",
              "- Action: move_stage(company_name=\"Acme Corp\")",
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
      expect(steps[0].description).toContain("move_stage");
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
    it("emits 'moved' with pass tone for a successful move_stage", () => {
      const steps = buildTrace({
        messages: [
          ai("doing it", [{ id: "c-1", name: "move_stage", args: {} }]),
          tool('Moved "Acme" from L0 to L1.', "c-1"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls?.[0].status).toBe("moved");
      expect(steps[0].toolCalls?.[0].tone).toBe("pass");
    });

    it("emits 'refused' with fail tone when move_stage rejects due to stage mismatch", () => {
      const steps = buildTrace({
        messages: [
          ai("doing it", [{ id: "c-1", name: "move_stage", args: {} }]),
          tool(
            'Cannot move "Acme": it is at L2 (key "L2"), not "L0". Call lookup_pipeline_stage again and use the stage it reports.',
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

    it.each([
      ["create_insight", "Created insight **Sector Brief** — [open it](/insight/123)", "created", "pass"],
      ["create_insight", "Rejection: An insight name is required.", "refused", "fail"],
      [
        "edit_insight_section",
        'Updated section "summary" of insight **Sector Brief** (version 2) — [open it](/insight/123)',
        "updated",
        "pass",
      ],
      ["edit_insight_section", 'Rejection: Section "missing" not found in document.', "refused", "fail"],
      [
        "replace_insight_document",
        "Replaced the document of insight **Sector Brief** (version 2) — [open it](/insight/123)",
        "updated",
        "pass",
      ],
      [
        "replace_insight_document",
        "Replaced the document of insight **Sector Brief** in this refresh run's draft (based on version 2). Nothing is published until the run completes.",
        "updated",
        "pass",
      ],
      [
        "replace_insight_document",
        "Rejection: This run is a scheduled refresh of insight 123; it can only write to that insight.",
        "refused",
        "fail",
      ],
      ["get_insight", "Insight: Sector Brief (id 123, version 2)\nKind: document\n\nCurrent document:\n<p>x</p>", "found", "pass"],
      ["get_insight", 'Insight "123" not found in this workspace.', "not found", "warn"],
    ])("emits the %s status for result %j", (name, result, status, tone) => {
      const steps = trace([ai("working", [{ id: "c-1", name, args: {} }]), tool(result, "c-1")]);
      expect(steps[0].toolCalls?.[0]).toMatchObject({ status, tone });
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
          ai("calling", [{ id: "c-1", name: "move_stage", args: {} }]),
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

  describe("company chips", () => {
    const manifest = (rows: Array<{ id: string; name: string }>) =>
      `<!-- COMPANY_MENTIONS_JSON:${JSON.stringify(rows)} -->`;

    it("chips the companies a step acts on, from the tool's manifest", () => {
      const steps = trace([
        ai("", [{ id: "c-1", name: "lookup_pipeline_stage", args: { company_name: "Acme Corp" } }]),
        tool(`**Acme Corp** — current stage: L0\n${manifest([{ id: "co-1", name: "Acme Corp" }])}`, "c-1"),
      ]);
      expect(steps[0].companies).toEqual([{ id: "co-1", name: "Acme Corp" }]);
    });

    it("keeps the manifest out of the rendered tool output", () => {
      const steps = trace([
        ai("", [{ id: "c-1", name: "get_company_details", args: { company_name: "Acme Corp" } }]),
        tool(`details\n${manifest([{ id: "co-1", name: "Acme Corp" }])}`, "c-1"),
      ]);
      expect(steps[0].toolCalls?.[0].output?.rows[0].value).toBe("details");
    });

    it("only chips the rows of a large result that the step actually names", () => {
      const steps = trace([
        ai("", [{ id: "c-1", name: "query_companies", args: { stage: "L0" } }]),
        tool(
          `**Query Results (2 companies):**\n${manifest([
            { id: "co-1", name: "Acme Corp" },
            { id: "co-2", name: "Toyo Materials" },
          ])}`,
          "c-1",
        ),
        ai("Toyo Materials is the strongest fit.", []),
      ]);
      expect(steps[0].companies).toBeUndefined();
      expect(steps[1].companies).toEqual([{ id: "co-2", name: "Toyo Materials" }]);
    });

    it("leaves steps that name no known company without chips", () => {
      const steps = trace([ai("Thinking about the market.", [])]);
      expect(steps[0].companies).toBeUndefined();
    });
  });

  describe("outcome chips", () => {
    it("emits an outcome chip per resolved, toned tool call", () => {
      const steps = buildTrace({
        messages: [
          ai("doing it", [
            { id: "c-1", name: "move_stage", args: {} },
            { id: "c-2", name: "query_companies", args: {} },
          ]),
          tool('Moved "Acme" from L0 to L1.', "c-1"),
          tool("**Query Results (3 companies):**\n\n...", "c-2"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].outcomeChips).toEqual([
        { label: "moved", tone: "pass" },
        { label: "3 matches", tone: "pass" },
      ]);
    });

    it("omits outcomeChips when nothing has resolved yet", () => {
      const steps = buildTrace({
        messages: [
          ai("calling", [{ id: "c-1", name: "move_stage", args: {} }]),
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

    it("suppresses pending placeholders when terminal=true (non-cancelled)", () => {
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

    it("emits trailing plan entries as 'skipped' when terminal+cancelled", () => {
      // User-cancelled a run with a 3-step plan after step 1 finished —
      // steps 2 and 3 should still render so the user can see what they
      // cut off, but as muted 'skipped' rather than active 'pending'.
      const steps = buildTrace({
        messages: [
          ai("done step 1", [
            { id: "n-1", name: "narrate_step", args: planArgs(["A", "B", "C"]) },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
        terminal: true,
        cancelled: true,
      });
      expect(steps).toHaveLength(3);
      expect(steps[0].status).toBe("done");
      expect(steps[1]).toMatchObject({ status: "skipped", stepNumber: 2, title: "B" });
      expect(steps[2]).toMatchObject({ status: "skipped", stepNumber: 3, title: "C" });
    });

    it("ignores cancelled=true when terminal=false (still emits pending)", () => {
      const steps = buildTrace({
        messages: [
          ai("turn 1", [
            { id: "n-1", name: "narrate_step", args: planArgs(["A", "B"]) },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
        terminal: false,
        cancelled: true,
      });
      expect(steps).toHaveLength(2);
      expect(steps[1].status).toBe("pending");
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

  describe("report_progress live rows", () => {
    it("attaches valid items as liveRows on the step", () => {
      const steps = buildTrace({
        messages: [
          ai("scanning", [
            {
              id: "r-1",
              name: "report_progress",
              args: {
                items: [
                  { label: "NovaSpec", status: "done", detail: "CMP match" },
                  { label: "Atlas", status: "checking" },
                  { label: "SiC Korea", status: "pending" },
                ],
              },
            },
            { id: "c-1", name: "query_companies", args: { name: "Acme" } },
          ]),
          tool("**Query Results (3 companies):**\n\n...", "c-1"),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps).toHaveLength(1);
      expect(steps[0].liveRows).toEqual([
        { label: "NovaSpec", status: "done", detail: "CMP match" },
        { label: "Atlas", status: "checking" },
        { label: "SiC Korea", status: "pending" },
      ]);
    });

    it("filters report_progress from the rendered tool calls", () => {
      const steps = buildTrace({
        messages: [
          ai("scanning", [
            {
              id: "r-1",
              name: "report_progress",
              args: { items: [{ label: "x", status: "pending" }] },
            },
            { id: "c-1", name: "query_companies", args: {} },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].toolCalls).toHaveLength(1);
      expect(steps[0].toolCalls?.[0].name).toBe("query_companies");
    });

    it("drops items missing a label or with an unknown status", () => {
      const steps = buildTrace({
        messages: [
          ai("scanning", [
            {
              id: "r-1",
              name: "report_progress",
              args: {
                items: [
                  { label: "ok", status: "done" },
                  { label: "", status: "done" },
                  { label: "weird", status: "weird" },
                  { status: "done" },
                ],
              },
            },
          ]),
        ],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].liveRows).toEqual([{ label: "ok", status: "done" }]);
    });

    it("omits liveRows when no report_progress was called", () => {
      const steps = buildTrace({
        messages: [ai("plain turn")],
        pendingWrites: [],
        humanDecisions: [],
        actor: ACTOR,
        startedAt: STARTED,
      });
      expect(steps[0].liveRows).toBeUndefined();
    });
  });

  describe("empty-content handling in coerceContent", () => {
    it.each([
      [
        "a thinking-only message, never leaking its signature",
        [{ type: "thinking", thinking: "private thought", signature: "sig_secret", encrypted_content: "enc_blob" }],
        "(no content)",
      ],
      [
        "a server_tool_use block with no text",
        [{ type: "server_tool_use", id: "stu-1", name: "query_database", input: { filter: "all" } }],
        "(no content)",
      ],
      [
        "only the text next to a thinking block",
        [
          { type: "thinking", thinking: "evaluating options...", signature: "sig-abc" },
          { type: "text", text: "Here is the final report analysis." },
        ],
        "Here is the final report analysis.",
      ],
    ])("describes %s", (_label, blocks, description) => {
      expect(trace([ai(blocks)])[0].description).toBe(description);
    });
  });

  describe("messageTimestamps handling", () => {
    it("shows each supplied timestamp on its step", () => {
      const steps = trace(
        [
          new AIMessage({ content: "step 1", id: "step-1" }),
          new HumanMessage("follow-up instruction"),
          new AIMessage({ content: "step 2", id: "step-2" }),
        ],
        { messageTimestamps: ["2026-05-15T10:02:15Z", "2026-05-15T10:05:30Z", "2026-05-15T10:08:45Z"] },
      );
      expect(steps.map((s) => s.timestamp)).toEqual(["10:02:15", "10:05:30", "10:08:45"]);
    });

    it("falls back to startedAt for a null entry or a short array", () => {
      const steps = trace(
        [new AIMessage({ content: "step 1", id: "step-1" }), new AIMessage({ content: "step 2", id: "step-2" })],
        { messageTimestamps: [null] },
      );
      expect(steps.map((s) => s.timestamp)).toEqual(["10:00:00", "10:00:00"]);
    });
  });
});

describe("matchMessageTimestamps", () => {
  it("matches AI messages by id, tool messages by tool_call_id and human messages by order, first occurrence winning", () => {
    const writes: CheckpointMessageWrite[] = [
      { ts: "2026-05-15T10:00:00Z", kind: "human", id: null, toolCallId: null },
      { ts: "2026-05-15T10:01:00Z", kind: "ai", id: "msg-ai-1", toolCallId: null },
      { ts: "2026-05-15T10:03:00Z", kind: "tool", id: null, toolCallId: "tc-1" },
      { ts: "2026-05-15T10:09:00Z", kind: "ai", id: "msg-ai-1", toolCallId: null },
      { ts: "2026-05-15T10:10:00Z", kind: "human", id: null, toolCallId: null },
    ];
    const messages = [
      new HumanMessage("First prompt"),
      new AIMessage({ content: "hello", id: "msg-ai-1" }),
      new ToolMessage({ content: "res1", tool_call_id: "tc-1" }),
      new HumanMessage("Second prompt"),
    ];
    expect(matchMessageTimestamps(messages, writes)).toEqual([
      "2026-05-15T10:00:00Z",
      "2026-05-15T10:01:00Z",
      "2026-05-15T10:03:00Z",
      "2026-05-15T10:10:00Z",
    ]);
  });

  it("returns null for every message without a matching write", () => {
    const writes: CheckpointMessageWrite[] = [
      { ts: "2026-05-15T10:00:00Z", kind: "human", id: null, toolCallId: null },
    ];
    const messages = [
      new AIMessage({ content: "hi", id: "unknown-id" }),
      new ToolMessage({ content: "res", tool_call_id: "unknown-call" }),
      new HumanMessage("Third"),
      new HumanMessage("Fourth"),
    ];
    expect(matchMessageTimestamps(messages, writes)).toEqual([null, null, "2026-05-15T10:00:00Z", null]);
  });
});
