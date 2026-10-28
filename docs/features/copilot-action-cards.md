# Copilot action cards and their decisions

Some Copilot replies end in a card that waits on the user: an approval
(`propose_bulk_drop_companies`, `propose_bulk_promote_companies`,
`propose_insight_create` / `_edit` / `_refresh`, `propose_report_plan`,
`propose_create_bot`, `update_bot`, `propose_create_routine`), a set of choices
(`offer_options`) or a Workforce hand-off (`propose_workforce_handoff`). Every
card and the user's decision on it is stored in `copilot_chat_cards`, so the
decision:

- survives a reload and follows the user to another device, and
- reaches the agent on the chat's next turns, including approvals that send
  no chat message.

## The card's life

1. **Offered.** The tool writes the card's payload into its output as a marker
   comment, with its own id (`approval_id`, `card_id` or `handoff_id`).
   `ChatMessageBubble` renders the card from that marker.
2. **Registered.** When the turn is stored (`ChatHistoryService.persistTurn`,
   for interactive and background turns alike, and the one-time checkpoint
   import), `findActionCards` (`src/lib/chat/actionCards.ts`) finds each card in
   the reply's tool parts and `CopilotChatCardRepository.registerMany` inserts
   it as `pending`, keyed `(chat_id, card_id)`, with the reply's row and a
   one-line summary. Best-effort: a failure is logged and the turn still stands.
3. **Decided.** The card carries out the action first (its own API call — drop,
   promote, publish, schedule, queue…), then `useApprovalResolution`
   (`ApprovalCardShell.tsx`) posts the decision to
   `POST /api/copilot/chats/[id]/cards/[cardId]/decision`:
   `{ toolName, status: 'accepted' | 'declined', resolutionText, data }`.
   `data` is the structured detail — the companies dropped, the options picked,
   the insight or routine or queue row created. A card decided mid-stream,
   before its turn was stored, is inserted by the decision itself; the later
   registration fills in the reply facts but never touches the decision.
4. **Shown.** `GET /api/copilot/chats/[id]/messages` lays each decided card's
   decision onto the reply that offered it (`metadata.cardDecisions`, one query
   per page). `ActionCardDecisionsProvider` in the bubble hands it to the
   card's hook, which opens the card already resolved.
5. **Told to the agent.** Each turn's system context (the chat route and
   `runBotTurn`) carries `CopilotChatCardService.promptContext`: the chat's ten
   most recent cards that a stored reply offered (a row with no `message_id` —
   a card id no stored reply carried — is never reported), newest first, each pending, accepted or declined, with
   the resolution text and detail. It is per-turn context, never written into
   the thread, so it always reflects the current decisions.

## Rules

- **The first decision stands.** The repository only updates a `pending` row;
  a second device deciding later gets the standing decision back
  (`alreadyDecided: true`) and shows it.
- The card shows its decision as soon as the user acts; the write follows. A
  failed write leaves a warning toast.
- Only the chat's owner can decide its cards (`CopilotChatForbiddenError`
  otherwise).
- `resolutionText` is at most 1,000 characters and `data` at most 8,000 as
  JSON; `toolName` must be one of the card tools in `ACTION_CARD_SPECS`.
- A new card tool must be added to `ACTION_CARD_SPECS` (marker, encoding, id
  field, summary) and its card must use `useApprovalResolution`, or its
  decisions will not be stored.

## Known gaps

- The action and the decision are two requests. If the decision write fails
  after the action succeeded, the card shows a warning toast and stays pending
  on other devices and for the agent.
- A card open on two devices is not live-synced: the other device picks up the
  decision on its next history load. Acting on both before either reloads runs
  the action twice (the second decision write is refused).
- Cards decided before this table existed kept their decision only in that
  browser's `localStorage`. The hook still reads those keys (never writes
  them), so such a card stays resolved in that browser, but the agent and other
  devices never learn of it. Workforce hand-offs still restore from
  `ai_workforce_queue` when they have no stored decision.
