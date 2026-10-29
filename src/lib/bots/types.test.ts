import { describe, it, expect } from 'vitest';
import {
  BOT_EYE_STYLES,
  BOT_MOODS,
  BOT_SHAPES,
  DEFAULT_BOT_AVATAR,
  colorToHue,
  isBotVisibility,
  randomBotAvatar,
  resolveBotAvatar,
  BRAIN_BOT_AVATAR,
  BRAIN_BOT_PERSONA,
  primaryBotName,
  botGreeting,
} from './types';

describe('resolveBotAvatar', () => {
  it('fills every field from the defaults when the avatar is empty or missing', () => {
    expect(resolveBotAvatar(null)).toEqual(DEFAULT_BOT_AVATAR);
    expect(resolveBotAvatar({})).toEqual(DEFAULT_BOT_AVATAR);
  });

  it('wraps the hue into 0–359', () => {
    expect(resolveBotAvatar({ hue: 400 }).hue).toBe(40);
    expect(resolveBotAvatar({ hue: -30 }).hue).toBe(330);
  });

  it("keeps Brain Bot's apex body, which the shape picker does not offer", () => {
    expect(resolveBotAvatar(BRAIN_BOT_AVATAR)).toEqual(BRAIN_BOT_AVATAR);
    expect(BOT_SHAPES).not.toContain('apex');
  });

  it('ignores eye styles, moods and shapes this build does not know', () => {
    const avatar = resolveBotAvatar({
      eyes: 'laser' as never,
      mood: 'angry' as never,
      shape: 'dragon' as never,
    });
    expect(avatar.eyes).toBe(DEFAULT_BOT_AVATAR.eyes);
    expect(avatar.mood).toBe(DEFAULT_BOT_AVATAR.mood);
    expect(avatar.shape).toBe(DEFAULT_BOT_AVATAR.shape);
  });

  it('maps a body from before the redesign to its closest new one', () => {
    expect(resolveBotAvatar({ shape: 'robot' as never }).shape).toBe('pixel');
    expect(resolveBotAvatar({ shape: 'capsule' as never }).shape).toBe('nova');
    expect(resolveBotAvatar({ shape: 'blob' as never }).shape).toBe('nimbo');
    expect(resolveBotAvatar({ shape: 'cat' as never }).shape).toBe('orbit');
    expect(resolveBotAvatar({ shape: 'ghost' as never }).shape).toBe('hexa');
  });

  it('keeps known values', () => {
    expect(resolveBotAvatar({ hue: 12, eyes: 'mono', mood: 'calm', shape: 'hexa' })).toEqual({
      hue: 12,
      eyes: 'mono',
      mood: 'calm',
      shape: 'hexa',
    });
  });
});

describe('randomBotAvatar', () => {
  it('only produces values resolveBotAvatar keeps', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.9999]) {
      const avatar = randomBotAvatar(() => r);
      expect(resolveBotAvatar(avatar)).toEqual(avatar);
      expect(BOT_EYE_STYLES).toContain(avatar.eyes);
      expect(BOT_MOODS).toContain(avatar.mood);
      expect(BOT_SHAPES).toContain(avatar.shape);
    }
  });
});

describe('isBotVisibility', () => {
  it('accepts catalogue values only', () => {
    expect(isBotVisibility('workspace')).toBe(true);
    expect(isBotVisibility('public')).toBe(false);
  });
});

describe('botGreeting', () => {
  it("introduces the new bot by name and asks the user who it is", () => {
    expect(botGreeting(' Deal Scout ')).toBe("Hi there! I'm Deal Scout. Tell me who I am and what I do!");
  });
});

describe('colorToHue', () => {
  it('maps colour words and hues, wrapping hues into 0–359', () => {
    expect(colorToHue('Blue')).toBe(222);
    expect(colorToHue(' pink ')).toBe(330);
    expect(colorToHue(400)).toBe(40);
    expect(colorToHue('120')).toBe(120);
  });

  it('returns null for anything else', () => {
    expect(colorToHue('plaid')).toBeNull();
    expect(colorToHue('')).toBeNull();
    expect(colorToHue(Number.NaN)).toBeNull();
  });
});

describe('primaryBotName', () => {
  it("names the bot after the user's first name", () => {
    expect(primaryBotName({ name: 'Nico Alimin' })).toBe("Nico's bot");
    expect(primaryBotName({ name: '  test  ' })).toBe("Test's bot");
  });

  it("falls back to the email's first word, then to a plain name", () => {
    expect(primaryBotName({ name: '', email: 'jane.doe@example.com' })).toBe("Jane's bot");
    expect(primaryBotName({ name: null, email: null })).toBe('My bot');
    expect(primaryBotName(null)).toBe('My bot');
  });
});

describe('BRAIN_BOT_PERSONA', () => {
  it('has the primary bot look up the bots before it starts non-trivial work', () => {
    expect(BRAIN_BOT_PERSONA).toContain('**Route before you work.**');
    expect(BRAIN_BOT_PERSONA).toContain('call lookup_bot first');
    expect(BRAIN_BOT_PERSONA).toContain('do not start the work yourself first');
  });

  it('sends research to a research bot and offers to build one when none exists', () => {
    expect(BRAIN_BOT_PERSONA).toContain('**Research goes to a research bot.**');
    expect(BRAIN_BOT_PERSONA).toContain('propose_create_bot');
  });

  it('limits what the primary bot does itself, and no longer tells it to finish everything', () => {
    expect(BRAIN_BOT_PERSONA).toContain('**Do it yourself only when it is yours.**');
    expect(BRAIN_BOT_PERSONA).not.toContain('Take on anything the user asks');
    expect(BRAIN_BOT_PERSONA).not.toContain('rather than handing it back');
  });
});
