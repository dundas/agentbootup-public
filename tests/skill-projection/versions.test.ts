/**
 * versions.js — pure function unit tests (red phase)
 */

import { describe, test, expect } from 'bun:test';
import { nextVersionNum, trimVersions, buildVersionEntry } from '../../lib/skill-projection/versions.js';

describe('nextVersionNum', () => {
  test('returns 1 when versions array is empty', () => {
    expect(nextVersionNum([])).toBe(1);
  });

  test('returns MAX + 1 for an ordered list', () => {
    expect(nextVersionNum([{ versionNum: 1 }, { versionNum: 2 }, { versionNum: 3 }])).toBe(4);
  });

  test('returns MAX + 1 when versions are out of order', () => {
    expect(nextVersionNum([{ versionNum: 1 }, { versionNum: 3 }, { versionNum: 2 }])).toBe(4);
  });

  test('handles a single version', () => {
    expect(nextVersionNum([{ versionNum: 5 }])).toBe(6);
  });
});

describe('trimVersions', () => {
  test('keeps all versions when count is less than or equal to 20', () => {
    const versions = Array.from({ length: 15 }, (_, i) => ({ versionNum: i + 1 }));
    expect(trimVersions(versions)).toHaveLength(15);
  });

  test('keeps all 20 versions when count equals 20', () => {
    const versions = Array.from({ length: 20 }, (_, i) => ({ versionNum: i + 1 }));
    expect(trimVersions(versions)).toHaveLength(20);
  });

  test('trims to 20 most recent when given 25 versions', () => {
    const versions = Array.from({ length: 25 }, (_, i) => ({ versionNum: i + 1 }));
    const result = trimVersions(versions);
    expect(result).toHaveLength(20);
    // Oldest 5 (versionNums 1-5) should be removed
    const nums = result.map((v: { versionNum: number }) => v.versionNum);
    expect(nums).not.toContain(1);
    expect(nums).not.toContain(5);
    expect(nums).toContain(6);
    expect(nums).toContain(25);
  });

  test('returns sorted descending by versionNum', () => {
    const versions = [{ versionNum: 3 }, { versionNum: 1 }, { versionNum: 2 }];
    const result = trimVersions(versions);
    const nums = result.map((v: { versionNum: number }) => v.versionNum);
    expect(nums).toEqual([3, 2, 1]);
  });

  test('respects custom keep parameter', () => {
    const versions = Array.from({ length: 10 }, (_, i) => ({ versionNum: i + 1 }));
    const result = trimVersions(versions, 3);
    expect(result).toHaveLength(3);
    const nums = result.map((v: { versionNum: number }) => v.versionNum);
    expect(nums).toEqual([10, 9, 8]);
  });

  test('does not mutate the input array', () => {
    const versions = [{ versionNum: 3 }, { versionNum: 1 }, { versionNum: 2 }];
    const originalOrder = versions.map(v => v.versionNum);
    trimVersions(versions);
    expect(versions.map(v => v.versionNum)).toEqual(originalOrder);
  });
});

describe('buildVersionEntry', () => {
  test('returns an object with the expected shape', () => {
    const entry = buildVersionEntry('skill-1', 'my-skill', '# content', 'agent-x');
    expect(entry).toMatchObject({
      skillId: 'skill-1',
      name: 'my-skill',
      content: '# content',
      savedBy: 'agent-x',
      note: null,
      versionNum: null,
    });
    expect(typeof entry.id).toBe('string');
    expect(typeof entry.createdAt).toBe('string');
  });

  test('note defaults to null when not provided', () => {
    const entry = buildVersionEntry('skill-1', 'my-skill', '# content', 'agent-x');
    expect(entry.note).toBeNull();
  });

  test('note is set when provided', () => {
    const entry = buildVersionEntry('skill-1', 'my-skill', '# content', 'agent-x', 'Replaced by restore of v3');
    expect(entry.note).toBe('Replaced by restore of v3');
  });

  test('generates unique ids across multiple calls', () => {
    const a = buildVersionEntry('skill-1', 'name', 'content', 'agent');
    const b = buildVersionEntry('skill-1', 'name', 'content', 'agent');
    expect(a.id).not.toBe(b.id);
  });

  test('versionNum is null (caller sets before persisting)', () => {
    const entry = buildVersionEntry('skill-2', 'other', 'body', 'user-1');
    expect(entry.versionNum).toBeNull();
  });
});
