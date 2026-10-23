import type { ContactDealLink } from "@/lib/api/contactDeals";

export interface BrainShortcut {
  key: string;
  label: string;
  /** What lands in the chat composer; "" opens it empty. */
  question: string;
}

/**
 * The Conversation modal's "Ask Brain Bot" pills (prototype v2.4). The two
 * deal-specific pills name a real linked deal: an active one for "X's view
 * on …" and a dropped one for "Why X passed on …"; without one they fall back
 * to questions that need no deal.
 */
export function buildBrainShortcuts(
  firstName: string,
  deals: ContactDealLink[],
): BrainShortcut[] {
  const first = firstName.trim() || "this contact";
  const active = deals.find((d) => !d.isDropped);
  const passed = deals.find((d) => d.isDropped);

  return [
    {
      key: "summarise",
      label: "Summarise relationship",
      question: `Summarise our relationship with ${first}`,
    },
    {
      key: "follow_up",
      label: "Draft follow-up email",
      question: `Draft a follow-up email to ${first}`,
    },
    active
      ? {
          key: "deal_view",
          label: `${first}'s view on ${active.companyName}`,
          question: `What is ${first}'s latest view on ${active.companyName}?`,
        }
      : {
          key: "open_questions",
          label: `Open questions for ${first}`,
          question: `What open questions do we have for ${first}?`,
        },
    passed
      ? {
          key: "deal_passed",
          label: `Why ${first} passed on ${passed.companyName}`,
          question: `Why did ${first} pass on ${passed.companyName}, and could they revisit?`,
        }
      : {
          key: "intro_paths",
          label: `Intro paths via ${first}`,
          question: `Who can ${first} introduce us to?`,
        },
    { key: "other", label: "Ask something else", question: "" },
  ];
}
