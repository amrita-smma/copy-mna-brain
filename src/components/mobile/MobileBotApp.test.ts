import { describe, it, expect } from 'vitest';
import { MOBILE_BOT_QUERY_PARAM, botIdFromSearch } from './MobileBotApp';

describe('botIdFromSearch', () => {
  it('reads the bot id from ?bot=', () => {
    expect(botIdFromSearch(`?${MOBILE_BOT_QUERY_PARAM}=abc-123`)).toBe('abc-123');
  });

  it('returns null when the param is absent', () => {
    expect(botIdFromSearch('')).toBeNull();
    expect(botIdFromSearch('?other=1')).toBeNull();
  });
});
