import { describe, expect, it } from 'vitest';
import { botTurnTraceName, TRACE_NAMES, workforceTraceName } from './langfuseTraceNames';

describe('workforceTraceName', () => {
  it('names a dedicated Workforce task by its agent', () => {
    expect(workforceTraceName({ agentName: 'company_card' })).toBe('workforce.company_card');
    expect(workforceTraceName({ agentName: 'ai_screening' })).toBe('workforce.ai_screening');
    expect(workforceTraceName({ agentName: 'crm_company_contacts' })).toBe(
      'workforce.find_partnership_contacts',
    );
    expect(workforceTraceName({ agentName: 'crm_contact' })).toBe('workforce.crm_contact_enrichment');
  });

  it('prefers the task name over the routine that queued it', () => {
    expect(workforceTraceName({ agentName: 'ai_screening', originRoutineId: 'r-1' })).toBe(
      'workforce.ai_screening',
    );
  });

  it('names a general run by how it started', () => {
    expect(workforceTraceName({ agentName: 'analysis', refreshInsightId: 'i-1' })).toBe(
      'workforce.insight_refresh',
    );
    expect(workforceTraceName({ agentName: 'analysis', originRoutineId: 'r-1' })).toBe(
      'workforce.routine',
    );
  });

  it('falls back to ad hoc for a chat hand-off, a typed name, or no name', () => {
    expect(workforceTraceName({ agentName: 'chat_handoff' })).toBe('workforce.ad_hoc');
    expect(workforceTraceName({ agentName: 'my custom agent' })).toBe('workforce.ad_hoc');
    expect(workforceTraceName({ agentName: null })).toBe('workforce.ad_hoc');
  });
});

describe('botTurnTraceName', () => {
  it('tells a bot-to-bot hand-off apart from the other background turns', () => {
    expect(botTurnTraceName('bot_mention')).toBe('bots.bot_to_bot');
    expect(botTurnTraceName('bot_reply')).toBe('bots.bot_to_bot_reply');
    expect(botTurnTraceName('user_mention')).toBe('bots.user_mention');
    expect(botTurnTraceName('routine')).toBe('bots.routine');
  });
});

describe('TRACE_NAMES', () => {
  it('never reuses a name, so each surface filters on its own', () => {
    const names = Object.values(TRACE_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });
});
