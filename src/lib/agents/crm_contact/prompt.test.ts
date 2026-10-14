import { describe, expect, it } from 'vitest';
import { CRM_CONTACT_WRITABLE_FIELDS } from './constants';
import {
  CRM_CONTACT_SYSTEM_PROMPT,
  PROFILE_FIELD_SENTENCE,
  buildContactEnrichmentPrompt,
  buildContactEnrichmentTitle,
} from './prompt';

describe('CRM_CONTACT_SYSTEM_PROMPT', () => {
  it('names every tool the agent actually has', () => {
    for (const toolName of [
      'get_crm_contact',
      'enrich_crm_contact',
      'update_crm_contact',
      'web_search',
      'valyu_search',
      'narrate_step',
    ]) {
      expect(CRM_CONTACT_SYSTEM_PROMPT).toContain(toolName);
    }
  });

  it('names no tool the agent does not have — a named absent tool invites a hallucinated call', () => {
    for (const absent of [
      'add_company',
      'promote_to_l1',
      'send_email',
      'create_insight',
      'report_progress',
      'ask_owner',
    ]) {
      expect(CRM_CONTACT_SYSTEM_PROMPT).not.toContain(absent);
    }
  });

  it('forbids editing the name and the email', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toMatch(/may NOT change their \*\*name\*\*/);
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('email address');
  });

  it('states the identity gate before any write', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('Establish identity before anything else');
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('A near-miss is a miss');
  });

  it('prefers an empty field to a guessed one', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('Leave it empty rather than guess');
  });

  it('offers both the success and the failure report shapes', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('✓ Done:');
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('✗ Could not complete:');
  });

  it('lists every writable field, so the model knows its whole remit', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain(PROFILE_FIELD_SENTENCE);
    expect(PROFILE_FIELD_SENTENCE.split(', ')).toHaveLength(
      CRM_CONTACT_WRITABLE_FIELDS.length,
    );
  });
});

describe('buildContactEnrichmentPrompt', () => {
  const base = {
    correspondentId: 'corr-1',
    contactName: 'Jane Doe',
    employerName: 'Evercore',
    missingFields: ['title', 'department'],
  };

  it('names the id so the agent never has to fuzzy-match the person', () => {
    const prompt = buildContactEnrichmentPrompt(base);
    expect(prompt).toContain('correspondent_id: corr-1');
    expect(prompt).toContain('get_crm_contact with correspondent_id "corr-1"');
    expect(prompt).toContain('enrich_crm_contact once');
  });

  it('states the gaps the run exists to fill', () => {
    expect(buildContactEnrichmentPrompt(base)).toContain(
      'currently empty on this record are: title, department',
    );
  });

  it('asks for identity confirmation against the firm', () => {
    const prompt = buildContactEnrichmentPrompt(base);
    expect(prompt).toContain('Confirm this is the right Jane Doe');
    expect(prompt).toContain('the one at Evercore');
  });

  it('tells a complete record there may be nothing to do', () => {
    const prompt = buildContactEnrichmentPrompt({ ...base, missingFields: [] });
    expect(prompt).toContain('already has a value');
    expect(prompt).not.toContain('currently empty on this record are');
  });
});

describe('buildContactEnrichmentTitle', () => {
  it('names the person and the firm, for the AI Workforce task list', () => {
    expect(buildContactEnrichmentTitle('Jane Doe', 'Evercore')).toBe(
      'Fill CRM contact: Jane Doe (Evercore)',
    );
  });
});
