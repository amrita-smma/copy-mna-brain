# Insight editing by section (chat)

## Why

A CoPilot edit used to move the whole insight through the model twice: `get_insight` returned the full
document, and `propose_insight_edit` took the full edited document back. For a 20k-character insight
that is ~10k input tokens and ~10k output tokens per edit, a minute of generation, and a thread history
that carries the document twice on every later turn. Anything over `CHAT_INLINE_DOCUMENT_MAX_CHARS`
could not be edited in chat at all and went to a full AI Workforce run.

Insights are already authored with every major block keyed (`data-section="kebab-key"`), and the
Workforce already writes one block at a time (`edit_insight_section`). Chat now does the same.

## The flow

1. `read_page_context` names the open insight and the block(s) the user selected. The open insight's
   outline in the system prompt lists every key.
2. `get_insight` with `section: "<key>"` returns **only that block's outer HTML**
   (`extractInsightSection`, `src/lib/insights/sectionEdit.ts`). It works on an insight of any size:
   the document is never inlined. A section that is itself over the chat cap comes back as an outline
   with a Workforce handoff instruction naming the section.
3. `propose_insight_edit` with the same `section` and **only the replacement fragment** as `html`.
   Before a card is offered the tool (`validateInsightSectionEdit`, `src/lib/insights/toolValidation.ts`):
   - render-checks the fragment (truncation) — before any database read;
   - reads the current version and trial-splices the fragment over the block;
   - runs every whole-document check on the result (size, placeholder, nesting, the report contract);
   - requires the block to still carry its `data-section` key, exactly once, so it stays addressable;
   - checks the fragment's markers, then the spliced document's (a `[S1]` must resolve to a Sources
     entry somewhere in the document).
   A refusal always says what to fix in the fragment and to resend **only the fragment** — never to
   regenerate the document.
4. The approval card's payload carries `section` and the fragment, nothing else. The card fetches the
   current version, splices the fragment in client-side (`editCandidate`, `src/lib/insights/editReview.ts`)
   to preview and diff, and says "Section “key” will be replaced; the rest of the document is unchanged."
   If a version landed meanwhile and the section is gone, approve is disabled with the reason.
5. Approve sends `{ section, html: fragment, baseVersionNo }` to `POST /api/insights/[id]`, which calls
   `InsightService.publishSectionEdit`. Under the insight's row lock the service re-reads the current
   version, refuses a stale base (409, the card re-diffs), splices, re-runs the structural and marker
   checks, and appends the version. The client never sends the document.

Whole-document edits are unchanged: omit `section`, and `html` is the complete document. The guides
(`INSIGHT_AUTHORING_GUIDE`, `INSIGHT_EDIT_AUTHORING_RULES`) tell the model to prefer a section edit
whenever the change fits in one block, and to use a whole-document edit for several blocks, a
restructure, or a document with no keys. Only an edit wider than one block on an insight over the chat
cap still goes to the Workforce.

## Cost

| | Before | After (one-block edit) |
|---|---|---|
| Model input per edit | whole document | one block |
| Model output per edit | whole document | one block |
| Thread history afterwards | document ×2 | block ×2 |
| Insight over the chat cap | Workforce run | edited in chat |
| Failed check | agent rewrote the whole document | agent resends the one fragment |

## Pointers

- Splice/extract primitives: `src/lib/insights/sectionEdit.ts` (`findInsightSection`,
  `extractInsightSection`, `replaceInsightSection`, `listInsightSectionKeys`) — pure, client-safe.
- Refusal wording for a bad fragment: audience `edit-section-proposal` in
  `src/lib/insights/structuralCheck.ts`.
- Large-insight instructions: `largeInsightEditHandoffInstruction` and
  `formatLargeInsightSectionForChat` in `src/lib/insights/largeDocument.ts`.
