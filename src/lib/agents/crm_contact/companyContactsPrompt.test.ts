import { describe, expect, it } from 'vitest';
import {
  CRM_COMPANY_CONTACTS_SYSTEM_PROMPT,
  buildCompanyContactsPrompt,
  buildCompanyContactsTitle,
} from './companyContactsPrompt';

describe('CRM_COMPANY_CONTACTS_SYSTEM_PROMPT', () => {
  it('names every tool the company-contacts task has', () => {
    for (const toolName of [
      'get_company_for_contacts',
      'enrich_company_contact',
      'save_company_contacts',
      'web_search',
      'valyu_search',
      'narrate_step',
    ]) {
      expect(CRM_COMPANY_CONTACTS_SYSTEM_PROMPT).toContain(toolName);
    }
  });

  it('names none of the correspondent tools or pipeline tools it does not have', () => {
    for (const absent of [
      'get_crm_contact',
      'update_crm_contact',
      'enrich_crm_contact',
      'add_company',
      'send_email',
      'report_progress',
    ]) {
      expect(CRM_COMPANY_CONTACTS_SYSTEM_PROMPT).not.toContain(absent);
    }
  });

  it('prioritises the partnership roles and caps the list at five', () => {
    expect(CRM_COMPANY_CONTACTS_SYSTEM_PROMPT).toContain('CEO');
    expect(CRM_COMPANY_CONTACTS_SYSTEM_PROMPT).toContain('Head of Business Development');
    expect(CRM_COMPANY_CONTACTS_SYSTEM_PROMPT).toContain('Business Development Manager');
    expect(CRM_COMPANY_CONTACTS_SYSTEM_PROMPT).toContain('the best 5');
  });

  it('forbids guessed emails and keeps the existing list when nothing is found', () => {
    expect(CRM_COMPANY_CONTACTS_SYSTEM_PROMPT).toContain('Never guess an email address');
    expect(CRM_COMPANY_CONTACTS_SYSTEM_PROMPT).toContain('do not call save_company_contacts');
  });
});

describe('buildCompanyContactsPrompt', () => {
  it('names the company id and website', () => {
    const prompt = buildCompanyContactsPrompt({
      companyId: 'co-1',
      companyName: 'Acme Logistics',
      website: ' https://acme.co.id ',
    });
    expect(prompt).toContain('Acme Logistics (https://acme.co.id) (company_id: co-1)');
    expect(prompt).toContain('get_company_for_contacts with company_id "co-1"');
  });

  it('omits the website clause when none is on file', () => {
    const prompt = buildCompanyContactsPrompt({ companyId: 'co-1', companyName: 'Acme', website: null });
    expect(prompt).toContain('at Acme (company_id: co-1)');
  });
});

describe('buildCompanyContactsTitle', () => {
  it('names the company', () => {
    expect(buildCompanyContactsTitle('Acme')).toBe('Find partnership contacts: Acme');
  });
});
