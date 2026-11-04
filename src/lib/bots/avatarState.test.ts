import { describe, it, expect } from 'vitest';
import { deriveAvatarState, streamActivity } from './avatarState';

describe('deriveAvatarState', () => {
  it('is idle when ready with nothing typed', () => {
    expect(deriveAvatarState({ status: 'ready' })).toBe('idle');
  });

  it('listens while the composer holds a draft', () => {
    expect(deriveAvatarState({ status: 'ready', composerHasText: true })).toBe('listening');
  });

  it('is happy right after a turn finishes, even with a new draft', () => {
    expect(deriveAvatarState({ status: 'ready', justFinished: true, composerHasText: true })).toBe('happy');
  });

  it('thinks while the request is submitted', () => {
    expect(deriveAvatarState({ status: 'submitted' })).toBe('thinking');
  });

  it('thinks while a reasoning part streams', () => {
    expect(
      deriveAvatarState({ status: 'streaming', lastAssistantParts: [{ type: 'reasoning', state: 'streaming' }] }),
    ).toBe('thinking');
  });

  it('works while any tool part has no output yet', () => {
    expect(
      deriveAvatarState({
        status: 'streaming',
        lastAssistantParts: [
          { type: 'text', state: 'done' },
          { type: 'dynamic-tool', state: 'input-available' },
        ],
      }),
    ).toBe('working');
  });

  it('talks while text streams after its tools finished', () => {
    expect(
      deriveAvatarState({
        status: 'streaming',
        lastAssistantParts: [
          { type: 'dynamic-tool', state: 'output-available' },
          { type: 'text', state: 'streaming' },
        ],
      }),
    ).toBe('talking');
  });

  it('thinks when streaming has started but no part has arrived', () => {
    expect(deriveAvatarState({ status: 'streaming', lastAssistantParts: null })).toBe('thinking');
  });

  it('droops on an error', () => {
    expect(deriveAvatarState({ status: 'error', justFinished: true })).toBe('error');
  });
});

describe('streamActivity', () => {
  it('is thinking with no parts yet', () => {
    expect(streamActivity(null)).toBe('thinking');
    expect(streamActivity([])).toBe('thinking');
  });

  it('is working while any tool part has no output', () => {
    expect(
      streamActivity([
        { type: 'text' },
        { type: 'dynamic-tool', state: 'input-available' },
      ]),
    ).toBe('working');
  });

  it('is talking once the last part is text and every tool has answered', () => {
    expect(
      streamActivity([{ type: 'tool-search', state: 'output-available' }, { type: 'text' }]),
    ).toBe('talking');
  });

  it('is what deriveAvatarState reads when given, instead of the parts', () => {
    expect(
      deriveAvatarState({ status: 'streaming', activity: 'working', lastAssistantParts: [{ type: 'text' }] }),
    ).toBe('working');
    // Only a streaming turn has an activity; other statuses ignore it.
    expect(deriveAvatarState({ status: 'ready', activity: 'talking' })).toBe('idle');
  });
});
