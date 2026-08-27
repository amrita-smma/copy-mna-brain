import { describe, expect, it } from 'vitest';
import { FEATURE_CATALOG } from './catalog';

describe('FEATURE_CATALOG', () => {
  it('has no duplicate feature keys', () => {
    const keys = FEATURE_CATALOG.map((feature) => feature.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses SCREAMING_SNAKE_CASE keys so each doubles as an env-var name', () => {
    for (const feature of FEATURE_CATALOG) {
      expect(feature.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('gives every feature a non-empty label and description', () => {
    for (const feature of FEATURE_CATALOG) {
      expect(feature.label.trim()).not.toBe('');
      expect(feature.description.trim()).not.toBe('');
    }
  });

  it('registers Smart Files as a nav feature under SMART_FILES_ENABLED', () => {
    // Guards the "AI File Dump" → "Smart Files" rename: this key must stay in
    // sync with the `flag` field on SidebarPagesNav's Smart Files nav entry and
    // with the feature_flags rows migrated in
    // 20260810000000_rename_ai_file_dump_flag_to_smart_files.sql.
    const smartFiles = FEATURE_CATALOG.find((feature) => feature.key === 'SMART_FILES_ENABLED');
    expect(smartFiles).toBeDefined();
    expect(smartFiles?.label).toBe('Smart Files');
    expect(smartFiles?.navItem).toBe(true);
    expect(smartFiles?.defaultEnabled).toBe(true);
  });

  it('no longer exposes the pre-rename AI_FILE_DUMP_ENABLED key', () => {
    expect(FEATURE_CATALOG.some((feature) => feature.key === 'AI_FILE_DUMP_ENABLED')).toBe(false);
  });
});
