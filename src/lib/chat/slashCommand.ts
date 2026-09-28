/**
 * Generic slash-command detection for the chat composer, parameterized over
 * `trigger` so any future command (not just `/insight-template`) can reuse
 * this without a new parser. A command is only recognized as the leading
 * token of the composer's first line — never mid-sentence — which is what
 * distinguishes a "/" command from an inline "@" reference.
 */

function splitFirstLine(input: string): { firstLine: string; trailing: string } {
  const leadingWsLen = input.length - input.replace(/^\s+/, '').length;
  const trimmed = input.slice(leadingWsLen);
  const newlineIdx = trimmed.indexOf('\n');
  if (newlineIdx === -1) {
    return { firstLine: trimmed, trailing: '' };
  }
  return { firstLine: trimmed.slice(0, newlineIdx), trailing: trimmed.slice(newlineIdx + 1) };
}

export interface SlashCommandMatch {
  /** Whether `trigger` (fully or partially, while still being typed) leads the input. */
  active: boolean;
  /** Text after the trigger and its separating whitespace, on the same line. */
  query: string;
}

/**
 * Active when the trimmed input's first line is a prefix of `trigger` while
 * still being typed ("/", "/i", "/insight-templat"), or the full trigger
 * optionally followed by a query on the same line ("/insight-template mar").
 * Never active when the token appears after other text.
 */
export function parseSlashCommand(input: string, trigger: string): SlashCommandMatch {
  const { firstLine } = splitFirstLine(input);
  const lowerFirstLine = firstLine.toLowerCase();
  const lowerTrigger = trigger.toLowerCase();

  if (lowerFirstLine.startsWith(lowerTrigger)) {
    const rest = firstLine.slice(trigger.length);
    if (rest.length === 0) {
      return { active: true, query: '' };
    }
    if (/^\s/.test(rest)) {
      return { active: true, query: rest.replace(/^\s+/, '') };
    }
    // Trigger is a strict prefix of a longer, different word — not a match.
    return { active: false, query: '' };
  }

  if (firstLine.length > 0 && lowerTrigger.startsWith(lowerFirstLine)) {
    return { active: true, query: '' };
  }

  return { active: false, query: '' };
}

/**
 * Removes exactly the matched trigger token (+ same-line query) from the
 * input, preserving any text on subsequent lines. Returns the input
 * unchanged if it doesn't match `trigger` (fully or as a partial prefix).
 */
export function stripSlashCommand(input: string, trigger: string): string {
  const { firstLine, trailing } = splitFirstLine(input);
  const lowerFirstLine = firstLine.toLowerCase();
  const lowerTrigger = trigger.toLowerCase();

  const matchesFull =
    lowerFirstLine.startsWith(lowerTrigger) &&
    (firstLine.length === trigger.length || /^\s/.test(firstLine.slice(trigger.length)));
  const matchesPartial = firstLine.length > 0 && lowerTrigger.startsWith(lowerFirstLine);

  if (matchesFull || matchesPartial) {
    return trailing;
  }
  return input;
}

/** A registrable slash command: its trigger token and a human-readable label. */
export interface SlashCommandDefinition {
  trigger: string;
  label: string;
}

export type SlashCommandState =
  | { stage: 'closed' }
  | { stage: 'palette'; query: string }
  | { stage: 'command'; command: SlashCommandDefinition; query: string };

/**
 * Two-level resolution over a registry of commands: while the leading "/"
 * token doesn't yet fully match any registered command's trigger, this is the
 * command palette (`query` is whatever follows "/", for filtering command
 * names). Once it fully matches one — typed out or completed via a palette
 * selection — this resolves straight to that command's own content, with
 * `query` holding same-line text after the trigger. Never active when the
 * token appears after other text.
 */
export function resolveSlashCommandState(
  input: string,
  commands: SlashCommandDefinition[],
): SlashCommandState {
  const { firstLine } = splitFirstLine(input);
  if (!firstLine.startsWith('/')) {
    return { stage: 'closed' };
  }
  const lowerFirstLine = firstLine.toLowerCase();
  for (const command of commands) {
    const lowerTrigger = command.trigger.toLowerCase();
    if (!lowerFirstLine.startsWith(lowerTrigger)) continue;
    const rest = firstLine.slice(command.trigger.length);
    if (rest.length === 0) {
      return { stage: 'command', command, query: '' };
    }
    if (/^\s/.test(rest)) {
      return { stage: 'command', command, query: rest.replace(/^\s+/, '') };
    }
    // Trigger is a strict prefix of a longer, different word — not this command.
  }
  return { stage: 'palette', query: firstLine.slice(1) };
}

/** Case-insensitive substring match on a command's label or trigger. */
export function filterSlashCommands(
  commands: SlashCommandDefinition[],
  query: string,
): SlashCommandDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) => c.label.toLowerCase().includes(q) || c.trigger.toLowerCase().includes(q),
  );
}

/**
 * Replaces whatever partial "/…" token led the input with the full
 * `trigger` (+ a trailing space, ready for the user's own text), preserving
 * any text on subsequent lines. Used when a palette row is selected.
 */
export function completeSlashCommand(input: string, trigger: string): string {
  const { trailing } = splitFirstLine(input);
  return trailing ? `${trigger} \n${trailing}` : `${trigger} `;
}
