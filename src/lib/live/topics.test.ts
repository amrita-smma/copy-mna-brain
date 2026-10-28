import { describe, it, expect } from 'vitest';
import { ALL_LIVE_TOPICS, isLiveEvent, isLiveTopic, LIVE_TOPICS } from './topics';

describe('isLiveTopic', () => {
  it('accepts every declared topic and nothing else', () => {
    for (const topic of ALL_LIVE_TOPICS) expect(isLiveTopic(topic)).toBe(true);
    expect(isLiveTopic('bots')).toBe(false);
    expect(isLiveTopic(undefined)).toBe(false);
    expect(isLiveTopic(1)).toBe(false);
  });
});

describe('isLiveEvent', () => {
  it('accepts a resync frame and an invalidate frame with or without ids', () => {
    expect(isLiveEvent({ type: 'resync' })).toBe(true);
    expect(isLiveEvent({ type: 'invalidate', topic: LIVE_TOPICS.screenings })).toBe(true);
    expect(isLiveEvent({ type: 'invalidate', topic: LIVE_TOPICS.workforce, ids: ['r1', 'r2'] })).toBe(true);
  });

  it('rejects an unknown type, an unknown topic, non-string ids and non-objects', () => {
    expect(isLiveEvent({ type: 'snapshot' })).toBe(false);
    expect(isLiveEvent({ type: 'invalidate', topic: 'nope' })).toBe(false);
    expect(isLiveEvent({ type: 'invalidate', topic: LIVE_TOPICS.sourcing, ids: [1] })).toBe(false);
    expect(isLiveEvent({ type: 'invalidate', topic: LIVE_TOPICS.sourcing, ids: 'c1' })).toBe(false);
    expect(isLiveEvent(null)).toBe(false);
    expect(isLiveEvent('resync')).toBe(false);
  });
});
