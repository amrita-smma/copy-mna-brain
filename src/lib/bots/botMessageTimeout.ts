/**
 * The budget of a bot's background turn: the answering turn plus up to a
 * minute waiting for the thread's lock. Lives in its own module so the route
 * that starts the turn (`startBotMessageRun`) can read it without importing
 * the handler — which pulls in the whole agent runtime, and on a cold start
 * that import alone ran `POST /api/internal/bot-messages` into its budget.
 */
export const BOT_MESSAGE_TIMEOUT_SECONDS = 600;
