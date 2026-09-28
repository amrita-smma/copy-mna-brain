import { describe, it, expect } from 'vitest';
import {
  parseSlashCommand,
  stripSlashCommand,
  resolveSlashCommandState,
  filterSlashCommands,
  completeSlashCommand,
  type SlashCommandDefinition,
} from './slashCommand';

const TRIGGER = '/insight-template';

const INSIGHT_TEMPLATE_COMMAND: SlashCommandDefinition = {
  trigger: '/insight-template',
  label: 'Create an insight from a template',
};

const COMMANDS: SlashCommandDefinition[] = [INSIGHT_TEMPLATE_COMMAND];

describe('parseSlashCommand', () => {
  it.each([
    ['empty input', ''],
    ['unrelated text', 'hello there'],
    ['the token mid-sentence', 'please /insight-template'],
    ['a partial prefix that diverges', '/insigxyz'],
    ['the trigger as a strict prefix of a longer word', '/insight-templates'],
  ])('is inactive on %s', (_label, input) => {
    expect(parseSlashCommand(input, TRIGGER)).toEqual({ active: false, query: '' });
  });

  it.each([
    ['the bare trigger', '/insight-template', ''],
    ['trailing text on the same line', '/insight-template mar', 'mar'],
    ['multiple separating spaces', '/insight-template   quarterly review', 'quarterly review'],
    ['upper case', '/INSIGHT-TEMPLATE Mar', 'Mar'],
    ['leading whitespace', '   /insight-template', ''],
    ['a multi-line input (first line only)', '/insight-template mar\nmore notes', 'mar'],
    ...['/', '/i', '/insight', '/insight-templat'].map((p) => [`partial prefix ${p}`, p, '']),
  ])('is active on %s', (_label, input, query) => {
    expect(parseSlashCommand(input, TRIGGER)).toEqual({ active: true, query });
  });
});

describe('stripSlashCommand', () => {
  it.each([
    ['/insight-template', ''],
    ['/insight-template mar', ''],
    ['/insight-templat', ''],
    ['/insight-template mar\nAdditional notes here', 'Additional notes here'],
    ['hello there', 'hello there'],
    ['please /insight-template', 'please /insight-template'],
  ])('strips %j to %j', (input, expected) => {
    expect(stripSlashCommand(input, TRIGGER)).toBe(expected);
  });
});

describe('resolveSlashCommandState', () => {
  it.each(['', 'hello there', 'please /insight-template'])('is closed on %j', (input) => {
    expect(resolveSlashCommandState(input, COMMANDS)).toEqual({ stage: 'closed' });
  });

  it.each([
    ['/', ''],
    ['/insight', 'insight'],
    ['/insight-templates', 'insight-templates'],
  ])('is the palette on %j', (input, query) => {
    expect(resolveSlashCommandState(input, COMMANDS)).toEqual({ stage: 'palette', query });
  });

  it.each([
    ['/insight-template', ''],
    ['/insight-template mar', 'mar'],
    ['/INSIGHT-TEMPLATE Mar', 'Mar'],
  ])('resolves %j to the command', (input, query) => {
    expect(resolveSlashCommandState(input, COMMANDS)).toEqual({
      stage: 'command',
      command: INSIGHT_TEMPLATE_COMMAND,
      query,
    });
  });
});

describe('filterSlashCommands', () => {
  it.each(['', 'template', 'TEMPLATE', 'insight-temp'])(
    'matches %j against the label or trigger, case-insensitively',
    (query) => {
      expect(filterSlashCommands(COMMANDS, query)).toEqual(COMMANDS);
    },
  );

  it('returns an empty array when nothing matches', () => {
    expect(filterSlashCommands(COMMANDS, 'zzz')).toEqual([]);
  });
});

describe('completeSlashCommand', () => {
  it('replaces a partial token with the full trigger and a trailing space, keeping later lines', () => {
    expect(completeSlashCommand('/insig', TRIGGER)).toBe('/insight-template ');
    expect(completeSlashCommand('/insig\nAdditional notes', TRIGGER)).toBe(
      '/insight-template \nAdditional notes',
    );
  });
});
