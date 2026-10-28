import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect }));

import { redirectUnlessRecordExists } from './recordRedirect';

const ID = '3f2b8c1e-5d4a-4f6b-9c7e-1a2b3c4d5e6f';

describe('redirectUnlessRecordExists', () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it('returns without redirecting when the record exists', async () => {
    const exists = vi.fn().mockResolvedValue(true);
    await expect(redirectUnlessRecordExists(ID, exists, '/w/acme/companies')).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledWith(ID);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects to the fallback when the record does not exist', async () => {
    const exists = vi.fn().mockResolvedValue(false);
    await expect(redirectUnlessRecordExists(ID, exists, '/w/acme/companies')).rejects.toThrow(
      'NEXT_REDIRECT /w/acme/companies',
    );
  });

  it('redirects without querying when the id is not a UUID', async () => {
    const exists = vi.fn();
    await expect(redirectUnlessRecordExists('not-a-uuid', exists, '/w/acme/pipeline')).rejects.toThrow(
      'NEXT_REDIRECT /w/acme/pipeline',
    );
    expect(exists).not.toHaveBeenCalled();
  });
});
