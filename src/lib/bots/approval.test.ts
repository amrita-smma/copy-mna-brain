import { describe, it, expect } from 'vitest';
import { isBotChangeApprovalPayload, isBotMessagePayload, isBotRoutineApprovalPayload } from './approval';

const fields = {
  name: 'Scout',
  avatar: { hue: 1, eyes: 'round', mood: 'calm', shape: 'pixel' },
  persona_md: '',
  visibility: 'private',
};

describe('isBotChangeApprovalPayload', () => {
  it('accepts a create, and an update that names its bot', () => {
    expect(isBotChangeApprovalPayload({ approval_id: 'a', action: 'create', after: fields, input: fields })).toBe(true);
    expect(
      isBotChangeApprovalPayload({ approval_id: 'a', action: 'update', bot_id: 'b', after: fields, input: { name: 'x' } }),
    ).toBe(true);
  });

  it('accepts a create that carries routines, and rejects malformed ones', () => {
    const routine = {
      label: 'Daily at 08:00',
      input: { title: 't', prompt: 'p', schedule_kind: 'daily', schedule_spec: { time: '08:00' }, timezone: '' },
    };
    expect(isBotChangeApprovalPayload({ approval_id: 'a', action: 'create', after: fields, input: fields, routines: [routine] })).toBe(true);
    expect(isBotChangeApprovalPayload({ approval_id: 'a', action: 'create', after: fields, input: fields, routines: [] })).toBe(true);
    expect(isBotChangeApprovalPayload({ approval_id: 'a', action: 'create', after: fields, input: fields, routines: [{ label: 'x' }] })).toBe(false);
    expect(isBotChangeApprovalPayload({ approval_id: 'a', action: 'create', after: fields, input: fields, routines: 'nope' })).toBe(false);
  });

  it('rejects an update with no bot, an unknown action, or junk', () => {
    expect(isBotChangeApprovalPayload({ approval_id: 'a', action: 'update', after: fields, input: {} })).toBe(false);
    expect(isBotChangeApprovalPayload({ approval_id: 'a', action: 'delete', after: fields, input: {} })).toBe(false);
    expect(isBotChangeApprovalPayload(null)).toBe(false);
  });
});

describe('isBotMessagePayload', () => {
  it('needs the target bot, its name and avatar, and the message', () => {
    expect(isBotMessagePayload({ bot_id: 'b', name: 'Scout', avatar: fields.avatar, message: 'hi' })).toBe(true);
    expect(isBotMessagePayload({ bot_id: 'b', name: 'Scout', message: 'hi' })).toBe(false);
  });
});

describe('isBotRoutineApprovalPayload', () => {
  const payload = {
    approval_id: 'a1',
    bot_id: 'b1',
    bot_name: 'Scout',
    shared: true,
    schedule_label: 'Weekdays at 09:00',
    input: {
      title: 'Morning pipeline',
      prompt: 'Summarise the pipeline',
      schedule_kind: 'weekly',
      schedule_spec: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
      timezone: 'UTC',
    },
  };

  it('accepts a complete routine proposal and rejects a partial one', () => {
    expect(isBotRoutineApprovalPayload(payload)).toBe(true);
    expect(isBotRoutineApprovalPayload({ ...payload, input: { ...payload.input, prompt: undefined } })).toBe(false);
    expect(isBotRoutineApprovalPayload({ ...payload, bot_id: undefined })).toBe(false);
  });
});
