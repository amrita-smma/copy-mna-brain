import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callTool, describeTool, enabled } = vi.hoisted(() => ({
  callTool: vi.fn(),
  describeTool: vi.fn(),
  enabled: vi.fn(async () => true),
}));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/flags', () => ({ meetingIntelligenceEnabled: () => enabled() }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({ meetingIntelligenceService: { callTool, describeTool } })),
}));

import { meetingIntelligence, MEETING_INTELLIGENCE_MAX_RESULT_CHARS } from './meeting_intelligence';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';
import { McpHttpError, McpRpcError } from '@/lib/meetingIntelligence';
import {
  MeetingIntelligenceNotConnectedError,
  MeetingIntelligenceRefreshPendingError,
} from '@/lib/services/meetingIntelligenceService';

const invoke = (input: Record<string, unknown>, config: unknown = BOT_TOOL_CONFIG) =>
  meetingIntelligence.invoke(input as never, config as never) as Promise<string>;

describe('meeting_intelligence', () => {
  beforeEach(() => {
    callTool.mockReset();
    describeTool.mockReset();
    enabled.mockReset();
    enabled.mockResolvedValue(true);
  });

  it('calls the Meeting Intelligence tool as the chatting user and returns its JSON', async () => {
    callTool.mockResolvedValue({ structuredContent: { items: [{ task: 'Send IM' }] }, text: '', isError: false });

    const out = await invoke({ tool: 'get_my_action_items', arguments: { status: 'delayed' } });

    expect(callTool).toHaveBeenCalledWith('u1', 'get_my_action_items', { status: 'delayed' });
    expect(out).toContain('Meeting Intelligence — get_my_action_items');
    expect(out).toContain('"task": "Send IM"');
  });

  it('defaults to no arguments and falls back to the text copy', async () => {
    callTool.mockResolvedValue({ structuredContent: null, text: 'Nico (PM)', isError: false });
    const out = await invoke({ tool: 'whoami' });
    expect(callTool).toHaveBeenCalledWith('u1', 'whoami', {});
    expect(out).toContain('Nico (PM)');
  });

  it('truncates an oversized result', async () => {
    callTool.mockResolvedValue({
      structuredContent: null,
      text: 'x'.repeat(MEETING_INTELLIGENCE_MAX_RESULT_CHARS + 500),
      isError: false,
    });
    expect(await invoke({ tool: 'list_meetings' })).toContain('[truncated');
  });

  it('refuses when the workspace has not enabled the integration', async () => {
    enabled.mockResolvedValue(false);
    expect(await invoke({ tool: 'whoami' })).toContain('not enabled for this workspace');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('only runs for a signed-in user', async () => {
    expect(await invoke({ tool: 'whoami' }, { configurable: {} })).toContain('only runs inside a Copilot bot chat');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('tells the model how the user connects when they have not', async () => {
    callTool.mockRejectedValue(new MeetingIntelligenceNotConnectedError('not_connected'));
    const out = await invoke({ tool: 'whoami' });
    expect(out).toContain("hasn't connected");
    expect(out).toContain('press Connect');
    expect(out).toContain('Connect Apps');
    expect(out).toContain('MoM Intelligent');
  });

  it('explains an expired connection', async () => {
    callTool.mockRejectedValue(new MeetingIntelligenceNotConnectedError('expired'));
    expect(await invoke({ tool: 'whoami' })).toContain('expired or was revoked');
  });

  it('asks for one retry while another refresh is in flight', async () => {
    callTool.mockRejectedValue(new MeetingIntelligenceRefreshPendingError());
    expect(await invoke({ tool: 'whoami' })).toContain('Call the tool again once');
  });

  it('appends the input schema when the arguments were wrong', async () => {
    callTool.mockRejectedValue(new McpRpcError(-32602, 'Invalid params: from'));
    describeTool.mockResolvedValue({ name: 'list_meetings', inputSchema: { properties: { startDate: {} } } });
    const out = await invoke({ tool: 'list_meetings', arguments: { from: '2026-10-01' } });
    expect(out).toContain('Invalid params: from');
    expect(out).toContain('"startDate"');
  });

  it('appends the input schema on a tool-reported error', async () => {
    callTool.mockResolvedValue({ structuredContent: null, text: 'meetingId or date required', isError: true });
    describeTool.mockResolvedValue({ name: 'get_meeting', inputSchema: { required: ['meetingId'] } });
    const out = await invoke({ tool: 'get_meeting' });
    expect(out).toContain('meetingId or date required');
    expect(out).toContain('Input schema for get_meeting');
  });

  it('reports rate limiting with the retry delay', async () => {
    callTool.mockRejectedValue(new McpHttpError(429, 'rate limited', 20));
    expect(await invoke({ tool: 'whoami' })).toContain('Try again in 20s');
  });

  it('reports the integration being off on their side', async () => {
    callTool.mockRejectedValue(new McpHttpError(404, 'the Meeting Intelligence integration is turned off on their side'));
    expect(await invoke({ tool: 'whoami' })).toContain('turned off on their side');
  });

  it('rejects an unknown tool name at the schema', async () => {
    await expect(invoke({ tool: 'delete_meeting' })).rejects.toThrow();
  });
});
