import { describe, it, expect } from 'vitest';
import { runtimeViewer } from './runtimeViewer';

describe('runtimeViewer', () => {
  it("reads the chat's signed-in user", () => {
    expect(runtimeViewer({ configurable: { userId: 'u-chat' } })).toEqual({
      workforce: false,
      userId: 'u-chat',
    });
  });

  it('reads a Workforce run and the user who started it', () => {
    expect(
      runtimeViewer({ configurable: { agentRole: 'workforce', triggered_by_user_id: 'u-run' } }),
    ).toEqual({ workforce: true, userId: 'u-run' });
  });

  it('prefers the chat user over the triggering user', () => {
    expect(
      runtimeViewer({ configurable: { userId: 'u-chat', triggered_by_user_id: 'u-run' } }).userId,
    ).toBe('u-chat');
  });

  it('trims the id', () => {
    expect(runtimeViewer({ configurable: { userId: '  u-chat ' } }).userId).toBe('u-chat');
  });

  it('has no user without a config, with a blank id or with a non-string id', () => {
    expect(runtimeViewer()).toEqual({ workforce: false, userId: null });
    expect(runtimeViewer({ configurable: {} }).userId).toBeNull();
    expect(runtimeViewer({ configurable: { userId: '   ' } }).userId).toBeNull();
    expect(runtimeViewer({ configurable: { triggered_by_user_id: null } }).userId).toBeNull();
    expect(runtimeViewer({ configurable: { userId: 42 } }).userId).toBeNull();
  });

  it('is never a Workforce run without agentRole workforce', () => {
    expect(runtimeViewer({ configurable: { agentRole: 'chat', userId: 'u' } }).workforce).toBe(false);
  });
});
