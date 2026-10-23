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
      'read_contact_emails',
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
      'move_stage',
      'send_email',
      'create_insight',
      'report_progress',
      'ask_owner',
    ]) {
      expect(CRM_CONTACT_SYSTEM_PROMPT).not.toContain(absent);
    }
  });

  it('allows completing the name for the same person but never renaming or changing the email', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('complete or correct their full name');
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('may NOT rename them to someone else');
    expect(CRM_CONTACT_SYSTEM_PROMPT).toMatch(/may NOT change their \*\*email address\*\*/);
  });

  it('states the identity gate before writing anything from the web', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('Establish identity on the web before writing anything from it');
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('A near-miss is a miss');
  });

  it('reads our emails before the web and keeps the notes out of narrate_step', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('Read the emails.');
    expect(CRM_CONTACT_SYSTEM_PROMPT.indexOf('Read the emails.')).toBeLessThan(
      CRM_CONTACT_SYSTEM_PROMPT.indexOf('Establish identity on the web'),
    );
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('never quote or paraphrase them in narrate_step');
  });

  it('defines coverage region as the geography covered, not where the person is based', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain(
      'Coverage region is what they cover, not where they sit',
    );
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('Never fill coverage_region from a location alone');
    expect(PROFILE_FIELD_SENTENCE).toContain('not where they are based');
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

describe('CRM_CONTACT_SYSTEM_PROMPT refresh exception', () => {
  it('lets a refresh run overwrite the bio without relaxing the other fields', () => {
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('**Refresh runs.**');
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('pass `bio` in `overwrite`');
    expect(CRM_CONTACT_SYSTEM_PROMPT).toContain('Every other field keeps the rule above.');
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

  it('leaves the refresh instruction out of an ordinary fill', () => {
    expect(buildContactEnrichmentPrompt(base)).not.toContain('REFRESH');
  });

  it('on a refresh, rewrites the bio and keeps the stale-only rule for other fields', () => {
    const prompt = buildContactEnrichmentPrompt({ ...base, missingFields: [], refresh: true });
    expect(prompt).toMatch(/^Refresh the CRM profile for Jane Doe/);
    expect(prompt).toContain('pass "bio" in `overwrite`');
    expect(prompt).toContain('overwrite it only where a current source shows the stored value is stale');
    expect(prompt).not.toContain('there may be nothing to fill');
  });

  it('on a refresh, still fills the empty fields', () => {
    const prompt = buildContactEnrichmentPrompt({ ...base, refresh: true });
    expect(prompt).toContain('currently empty on this record are: title, department');
    expect(prompt).toContain('Fill any empty field as usual');
  });
});

describe('buildContactEnrichmentTitle', () => {
  it('names the person and the firm, for the AI Workforce task list', () => {
    expect(buildContactEnrichmentTitle('Jane Doe', 'Evercore')).toBe(
      'Fill CRM contact: Jane Doe (Evercore)',
    );
  });

  it('marks a refresh run so it reads differently in the task list', () => {
    expect(buildContactEnrichmentTitle('Jane Doe', 'Evercore', true)).toBe(
      'Refresh CRM contact: Jane Doe (Evercore)',
    );
  });
});
