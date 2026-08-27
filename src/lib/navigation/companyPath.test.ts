import { describe, expect, it } from 'vitest';
import { companyDetailPath, companyLinkId } from './companyPath';

describe('companyDetailPath', () => {
  it('points at the company route', () => {
    expect(companyDetailPath('8f2c-abc')).toBe('/companies/8f2c-abc');
  });

  it('encodes an id that would otherwise break the path', () => {
    expect(companyDetailPath('a/b?c')).toBe('/companies/a%2Fb%3Fc');
  });

  it('returns a workspace-relative path for useWorkspaceHref to prefix', () => {
    expect(companyDetailPath('x')).toMatch(/^\/[^/]/);
  });
});

describe('companyLinkId', () => {
  it('returns the id from a resolved company row', () => {
    expect(companyLinkId({ id: 'c-acme', target: 'Acme Corp' })).toBe('c-acme');
  });

  it('trims a padded id', () => {
    expect(companyLinkId({ id: '  c-acme  ' })).toBe('c-acme');
  });

  // A file's `matched_companies` can hold bare name strings, and the model can
  // name a company that isn't in the pipeline. Neither is linkable — rendering
  // those as links would produce `/pipeline/undefined`.
  it('returns null for a bare name string', () => {
    expect(companyLinkId('Acme Corp')).toBeNull();
  });

  it('returns null when the object carries no usable id', () => {
    expect(companyLinkId({ target: 'Acme Corp' })).toBeNull();
    expect(companyLinkId({ id: null })).toBeNull();
    expect(companyLinkId({ id: '' })).toBeNull();
    expect(companyLinkId({ id: '   ' })).toBeNull();
    expect(companyLinkId({ id: 42 })).toBeNull();
  });

  it.each([null, undefined, 0, false])('returns null for %p', (value) => {
    expect(companyLinkId(value)).toBeNull();
  });
});
