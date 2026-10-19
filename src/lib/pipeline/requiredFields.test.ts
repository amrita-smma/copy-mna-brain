import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS,
  InvalidPipelineRequiredFieldsError,
  PIPELINE_REQUIRED_FIELDS,
  getMissingPipelineFields,
  normalizePipelineRequiredFieldKeys,
  isDefaultPipelineRequiredFieldConfiguration,
  parsePipelineRequiredFieldsInput,
  type PipelineEntryCompanyInput,
} from './requiredFields';

const complete: PipelineEntryCompanyInput = {
  target: 'Acme Corp',
  entered_by: 'user-uuid',
  source: 'inbound',
  deal_type: 'majority',
  geography: 'Indonesia',
  segment: 'Technology',
  banker: 'Goldman Sachs',
};

describe('getMissingPipelineFields', () => {
  it('returns [] when every required field is present (inbound)', () => {
    expect(getMissingPipelineFields(complete)).toEqual([]);
  });

  it('accepts project_name in place of target for the name requirement', () => {
    const { target: _target, ...rest } = complete;
    expect(getMissingPipelineFields({ ...rest, project_name: 'Project Phoenix' })).toEqual([]);
  });

  it('does not require a banker for outbound deals', () => {
    expect(
      getMissingPipelineFields({
        ...complete,
        source: 'outbound',
        banker: null,
        banker_source: null,
      }),
    ).toEqual([]);
  });

  it('accepts banker_source as a fallback for the Banker requirement', () => {
    expect(
      getMissingPipelineFields({ ...complete, banker: null, banker_source: 'Some Desk' }),
    ).toEqual([]);
  });

  it('flags Banker for inbound without banker or banker_source', () => {
    expect(
      getMissingPipelineFields({ ...complete, banker: null, banker_source: null }),
    ).toContain('Banker');
  });

  it('flags Geo when geography is blank/whitespace', () => {
    expect(getMissingPipelineFields({ ...complete, geography: '   ' })).toContain('Geo');
  });

  it('flags Sector when segment is missing', () => {
    expect(getMissingPipelineFields({ ...complete, segment: null })).toContain('Sector');
  });

  it('collects all missing labels for an empty company', () => {
    expect(getMissingPipelineFields({})).toEqual([
      'Company Name / Project Name',
      'Entered By',
      'Deal Type: Inbound/Outbound',
      'Deal Type',
      'Geo',
      'Sector',
      'Banker',
    ]);
  });
});

describe('PIPELINE_REQUIRED_FIELDS', () => {
  it('has unique keys', () => {
    const keys = PIPELINE_REQUIRED_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('getMissingPipelineFields with a workspace configuration', () => {
  it('only reports the configured fields', () => {
    expect(getMissingPipelineFields({ target: 'Acme' }, ['name', 'geography'])).toEqual(['Geo']);
  });

  it('always enforces the company name, even when left out of the configuration', () => {
    expect(getMissingPipelineFields({}, ['segment'])).toEqual(['Company Name / Project Name', 'Sector']);
  });
});

describe('normalizePipelineRequiredFieldKeys', () => {
  it('treats null as the default: every field', () => {
    expect(normalizePipelineRequiredFieldKeys(null)).toEqual(DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS);
    expect(DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS).toEqual(PIPELINE_REQUIRED_FIELDS.map((f) => f.key));
  });

  it('orders canonically, dedupes, drops unknown keys and keeps the name', () => {
    expect(normalizePipelineRequiredFieldKeys(['banker', 'geography', 'banker', 'retired_field'])).toEqual([
      'name',
      'geography',
      'banker',
    ]);
  });

  it('reduces an empty configuration to just the name', () => {
    expect(normalizePipelineRequiredFieldKeys([])).toEqual(['name']);
  });

  it('recognises the full default configuration', () => {
    expect(isDefaultPipelineRequiredFieldConfiguration(DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS)).toBe(true);
    expect(isDefaultPipelineRequiredFieldConfiguration(['name', 'geography'])).toBe(false);
  });
});

describe('parsePipelineRequiredFieldsInput', () => {
  it('accepts a list of known keys', () => {
    expect(parsePipelineRequiredFieldsInput({ requiredFields: ['segment', 'source'] })).toEqual([
      'name',
      'source',
      'segment',
    ]);
  });

  it.each([null, 'x', {}, { requiredFields: 'name' }])('rejects a malformed body %#', (body) => {
    expect(() => parsePipelineRequiredFieldsInput(body)).toThrow(InvalidPipelineRequiredFieldsError);
  });

  it('rejects unknown keys rather than silently dropping them', () => {
    expect(() => parsePipelineRequiredFieldsInput({ requiredFields: ['name', 'revenue'] })).toThrow(
      /Unknown required field\(s\): revenue/,
    );
  });
});
