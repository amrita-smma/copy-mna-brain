import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEETING_INTELLIGENCE_BASE_URL, meetingIntelligenceEndpoints } from './config';

describe('meetingIntelligenceEndpoints', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to the production server', () => {
    vi.stubEnv('MEETING_INTELLIGENCE_BASE_URL', '');
    const e = meetingIntelligenceEndpoints();
    expect(e.serverUrl).toBe(DEFAULT_MEETING_INTELLIGENCE_BASE_URL);
    expect(e.mcp).toBe(`${DEFAULT_MEETING_INTELLIGENCE_BASE_URL}/api/mcp`);
  });

  it('honours MEETING_INTELLIGENCE_BASE_URL and strips trailing slashes', () => {
    vi.stubEnv('MEETING_INTELLIGENCE_BASE_URL', 'https://staging.mi.test//');
    expect(meetingIntelligenceEndpoints()).toEqual({
      serverUrl: 'https://staging.mi.test',
      mcp: 'https://staging.mi.test/api/mcp',
      register: 'https://staging.mi.test/api/oauth/register',
      authorize: 'https://staging.mi.test/api/oauth/authorize',
      token: 'https://staging.mi.test/api/oauth/token',
      revoke: 'https://staging.mi.test/api/oauth/revoke',
    });
  });
});
