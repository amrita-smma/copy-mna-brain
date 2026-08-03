import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    invoke = invoke;
  },
}));

import {
  generateChatTitle,
  looksLikeAssistantReply,
  normalizeChatTitle,
} from './title';

describe('looksLikeAssistantReply', () => {
  it('flags capability refusals that used to become chat titles', () => {
    expect(
      looksLikeAssistantReply(
        "I can't create or send files, but I can help you plan the presentation.",
      ),
    ).toBe(true);
  });

  it('accepts short topic titles', () => {
    expect(looksLikeAssistantReply('Bank Mandiri deck')).toBe(false);
    expect(looksLikeAssistantReply('Email SWOT summary')).toBe(false);
  });
});

describe('normalizeChatTitle', () => {
  it('returns a cleaned short title', () => {
    expect(normalizeChatTitle('  "Bank Mandiri deck."  ', 'ignored')).toBe(
      'Bank Mandiri deck',
    );
  });

  it('falls back to the user message when Haiku answers instead of titling', () => {
    expect(
      normalizeChatTitle(
        "I can't create or send files, but I can help you plan the presentation.",
        'Email me a PowerPoint about Bank Mandiri peers',
      ),
    ).toBe('Email me a PowerPoint about Bank');
  });

  it('returns null for empty input and empty source', () => {
    expect(normalizeChatTitle('   ', '   ')).toBeNull();
  });
});

describe('generateChatTitle', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  afterEach(() => {
    invoke.mockReset();
  });

  it('returns the normalized model title', async () => {
    invoke.mockResolvedValueOnce({ content: '  Bank Mandiri deck  ' });
    await expect(
      generateChatTitle('Email me a Mandiri deck', 'test-key'),
    ).resolves.toBe('Bank Mandiri deck');
  });

  it('falls back when the model refuses', async () => {
    invoke.mockResolvedValueOnce({
      content:
        "I can't create or send files, but I can help you plan the presentation.",
    });
    await expect(
      generateChatTitle(
        'Email me a PowerPoint about Bank Mandiri peers',
        'test-key',
      ),
    ).resolves.toBe('Email me a PowerPoint about Bank');
  });
});
