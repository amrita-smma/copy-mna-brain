import { describe, expect, it } from 'vitest';
import {
  WORKFORCE_HITL_INTERRUPT_ON,
  allowedApiDecisions,
  buildAskOwnerDeclinedMessage,
  buildResumeDecision,
  readAskOwnerArgs,
} from './hitl';

const ASK_ARGS = {
  question: 'The Q3 source report is gone. Use the Q2 figures?',
  recommendation: 'Use Q2 and flag the gap in the header',
  rationale: 'Q2 is the latest audited set; dropping the section breaks the layout.',
  options: ['Use Q2', 'Drop the section'],
};

describe('WORKFORCE_HITL_INTERRUPT_ON', () => {
  it('keeps promote_to_l1 approve/reject only', () => {
    expect(WORKFORCE_HITL_INTERRUPT_ON.promote_to_l1.allowedDecisions).toEqual([
      'approve',
      'reject',
    ]);
    expect(
      WORKFORCE_HITL_INTERRUPT_ON.promote_to_l1.description({
        name: 'promote_to_l1',
        args: { company_name: 'Acme' },
      }),
    ).toBe('Promote Acme from L0 to the next stage?');
  });

  it('gates ask_owner with edit only (approve would run on agent-written args; reject orphans parallel calls)', () => {
    expect(WORKFORCE_HITL_INTERRUPT_ON.ask_owner.allowedDecisions).toEqual(['edit']);
  });

  it('uses the question as the ask_owner card headline', () => {
    expect(
      WORKFORCE_HITL_INTERRUPT_ON.ask_owner.description({ name: 'ask_owner', args: ASK_ARGS }),
    ).toBe(ASK_ARGS.question);
    expect(
      WORKFORCE_HITL_INTERRUPT_ON.ask_owner.description({ name: 'ask_owner', args: {} }),
    ).toBe('The agent has a question for you');
  });
});

describe('allowedApiDecisions', () => {
  it('allows accept/answer/reject for ask_owner and approve/reject otherwise', () => {
    expect(allowedApiDecisions('ask_owner')).toEqual(['approve', 'answer', 'reject']);
    expect(allowedApiDecisions('promote_to_l1')).toEqual(['approve', 'reject']);
    expect(allowedApiDecisions('something_else')).toEqual(['approve', 'reject']);
  });
});

describe('readAskOwnerArgs', () => {
  it('returns the agent-authored fields and drops owner_* fields', () => {
    expect(
      readAskOwnerArgs({ ...ASK_ARGS, owner_decision: 'answered', owner_answer: 'injected' }),
    ).toEqual(ASK_ARGS);
  });

  it('returns null without a question or a recommendation', () => {
    expect(readAskOwnerArgs({ question: 'Q?' })).toBeNull();
    expect(readAskOwnerArgs({ recommendation: 'A' })).toBeNull();
    expect(readAskOwnerArgs(null)).toBeNull();
  });

  it('omits empty options', () => {
    expect(readAskOwnerArgs({ ...ASK_ARGS, options: ['  ', 3] })).not.toHaveProperty('options');
  });
});

describe('buildAskOwnerDeclinedMessage', () => {
  it('tells the agent not to guess and names both ways to finish', () => {
    const msg = buildAskOwnerDeclinedMessage('Use Q2?', 'wait for Q3');
    expect(msg).toContain('declined to answer "Use Q2?"');
    expect(msg).toContain('Their note: "wait for Q3"');
    expect(msg).toContain('records the insight as unchanged');
    expect(msg).toContain('✗ Could not complete');
  });

  it('reads cleanly without a question or note', () => {
    expect(buildAskOwnerDeclinedMessage(undefined)).toMatch(/^The owner declined\. Do not guess/);
  });
});

describe('buildResumeDecision', () => {
  describe('promote_to_l1 (unchanged)', () => {
    it('maps approve to approve and reject to reject carrying the reviewer message', () => {
      expect(
        buildResumeDecision({ toolName: 'promote_to_l1', decision: 'approve', storedArgs: {} }),
      ).toEqual({ ok: true, decision: { type: 'approve' } });
      expect(
        buildResumeDecision({
          toolName: 'promote_to_l1',
          decision: 'reject',
          storedArgs: {},
          rejectionMessage: 'EBITDA too thin',
        }),
      ).toEqual({ ok: true, decision: { type: 'reject', message: 'EBITDA too thin' } });
    });

    it('refuses answer', () => {
      expect(
        buildResumeDecision({ toolName: 'promote_to_l1', decision: 'answer', storedArgs: {}, answer: 'yes' }).ok,
      ).toBe(false);
    });
  });

  describe('ask_owner', () => {
    it('accept → edit whose owner_answer is the recommendation', () => {
      expect(
        buildResumeDecision({ toolName: 'ask_owner', decision: 'approve', storedArgs: ASK_ARGS }),
      ).toEqual({
        ok: true,
        question: ASK_ARGS.question,
        answer: ASK_ARGS.recommendation,
        decision: {
          type: 'edit',
          editedAction: {
            name: 'ask_owner',
            args: {
              ...ASK_ARGS,
              owner_decision: 'accepted',
              owner_answer: ASK_ARGS.recommendation,
            },
          },
        },
      });
    });

    it('answer → edit carrying the owner text, overriding anything the agent put in owner_*', () => {
      const result = buildResumeDecision({
        toolName: 'ask_owner',
        decision: 'answer',
        storedArgs: { ...ASK_ARGS, owner_decision: 'accepted', owner_answer: 'agent guess' },
        answer: '  Drop the section  ',
      });
      expect(result).toMatchObject({
        ok: true,
        answer: 'Drop the section',
        decision: {
          type: 'edit',
          editedAction: {
            name: 'ask_owner',
            args: { owner_decision: 'answered', owner_answer: 'Drop the section' },
          },
        },
      });
    });

    it('answer without text is refused', () => {
      expect(
        buildResumeDecision({
          toolName: 'ask_owner',
          decision: 'answer',
          storedArgs: ASK_ARGS,
          answer: '   ',
        }),
      ).toEqual({ ok: false, error: 'answer is required' });
    });

    it('reject → edit with owner_decision declined and the owner note', () => {
      const result = buildResumeDecision({
        toolName: 'ask_owner',
        decision: 'reject',
        storedArgs: ASK_ARGS,
        rejectionMessage: ' not now ',
      });
      expect(result).toEqual({
        ok: true,
        question: ASK_ARGS.question,
        decision: {
          type: 'edit',
          editedAction: {
            name: 'ask_owner',
            args: { ...ASK_ARGS, owner_decision: 'declined', owner_answer: 'not now' },
          },
        },
      });
    });

    it('fills a missing rationale so the re-issued call passes the tool schema', () => {
      const { rationale: _omit, ...noRationale } = ASK_ARGS;
      const result = buildResumeDecision({
        toolName: 'ask_owner',
        decision: 'approve',
        storedArgs: noRationale,
      });
      expect(result).toMatchObject({
        decision: { editedAction: { args: { rationale: '(none given)' } } },
      });
    });

    it('a malformed paused call can still be declined but not accepted', () => {
      expect(
        buildResumeDecision({ toolName: 'ask_owner', decision: 'reject', storedArgs: {} }),
      ).toMatchObject({
        ok: true,
        decision: {
          type: 'edit',
          editedAction: { args: { question: '(unreadable question)', owner_decision: 'declined' } },
        },
      });
      expect(
        buildResumeDecision({ toolName: 'ask_owner', decision: 'approve', storedArgs: {} }).ok,
      ).toBe(false);
    });
  });
});
