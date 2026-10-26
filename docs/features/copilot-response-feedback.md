# Feedback on Copilot replies (MB-693)

Users rate a Copilot reply with thumbs up/down, pick what went wrong on a
thumbs-down, and can write a comment. Each vote is stored per user per turn and
copied to the turn's Langfuse trace as a score, so a bad answer can be opened
with its full prompt, tool calls and model. It does **not** file a Jira ticket
or email anyone — that is the general [in-app feedback](in-app-feedback.md)
form.

## What the user sees

`ResponseActions` (`src/components/chat/ResponseActions.tsx`) is the row under
every finished reply in the Copilot transcript:

- **Copy** and **Retry** on every reply. Retry sends the turn's question again
  as a new turn (`retryQuestionTexts`); it does not replace the old answer, and
  attached files are not re-sent. No Retry on a reply to another bot's or a
  routine's message.
- **Write a feedback**, 👍 and 👎 on the **latest** finished reply only
  (`isLatestReply` in `AICopilotPane`). The next reply takes them over.
- 👎 opens the reason chips (`RESPONSE_FEEDBACK_REASONS` in
  `src/lib/chat/responseFeedback.ts` — a closed list; "Did things I didn't ask"
  only when the reply used tools, "Hard to read or broken display" only when it
  had a table or a card) and **Ask Brain to Improve**, which sends the reasons
  and comment as a follow-up message.
- "Something else" and "Write a feedback" both edit the vote's one comment.

The thumb is saved on click; reasons and the comment on Submit. A vote is one
row, so each save sends the whole vote and replaces the last.

Submit is final for that reply: the form closes, its reasons and comment are
cleared, the thumbs lock on the chosen rating and "Write a feedback" becomes
"Thanks for your feedback!". A reloaded reply whose stored vote has reasons or
a comment opens in that state; a bare thumb (saved on click, never submitted)
can still be changed or followed by a written note.

## How a reply is keyed

A reply is keyed on its turn's **question row** — the `copilot_messages` row
(role `user`) the chat route writes when the turn starts
(`ChatHistoryService.persistQuestion`). It is the one id the live stream and a
reloaded history share:

- **Live:** the route sends `metadata.questionId` in the reply's
  `message-metadata` chunk.
- **Reload:** `ChatHistoryService.page` sets `metadata.questionId` on each
  reply to the nearest user row before it (a page never splits a turn) and lays
  the user's stored vote on it as `metadata.feedback`, in one batched query.

No `questionId` (the question failed to store, or a reply before any question)
means no feedback controls on that reply.

## What is stored

`copilot_response_feedback`: `workspace_id`, `user_id`, `chat_id`,
`message_id` (the question row), `bot_id`, `trace_id`, `model`,
`effort_tier`, `rating` (+1 / −1, or null for a comment alone), `reasons`,
`comment`. Unique on `(user_id, message_id)`; deleted with its chat or message.

`bot_id`, `model` and `effort_tier` are copied from the question row, never
taken from the client. The chat route stamps `model` and `effort_tier` on the
question row when the turn starts, so they are what that turn ran on even if
the thread's tier has since moved. Turns stored before MB-693, and background
bot turns, have neither.

## Langfuse

The chat route runs each turn with its question row's id as the root
`runId`; the Langfuse handler uses the root run id as the trace id, so the
trace id **is** the question id. `turnTraceId` relies on this: a question row
with a `model` was traced under its own id.

`PUT /api/copilot/chats/[id]/feedback` saves the vote, then — in `after()`,
never in the request — `scoreInLangfuse` sends a `user_feedback` score
(value ±1, comment, reasons and turn facts in metadata) through
`sendLangfuseScore` (`src/lib/langfuseScore.ts`). The score's id is the
feedback row's id: Langfuse upserts scores on id, so a changed vote replaces
the score instead of adding one. A comment with no rating, or a turn with no
trace, sends nothing. Langfuse being down or unconfigured never fails the vote.
