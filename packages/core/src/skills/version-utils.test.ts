import { describe, expect, it } from 'vitest';
import { bumpPatch, bumpMinor, bumpMajor, unifiedDiff } from './version-utils.js';

describe('semver bump helpers', () => {
  it('bumpPatch increments the third component', () => {
    expect(bumpPatch('1.0.0')).toBe('1.0.1');
    expect(bumpPatch('1.2.99')).toBe('1.2.100');
    expect(bumpPatch('0.0.0')).toBe('0.0.1');
  });

  it('bumpMinor resets patch', () => {
    expect(bumpMinor('1.0.5')).toBe('1.1.0');
    expect(bumpMinor('2.9.99')).toBe('2.10.0');
  });

  it('bumpMajor resets minor and patch', () => {
    expect(bumpMajor('1.4.7')).toBe('2.0.0');
    expect(bumpMajor('0.0.1')).toBe('1.0.0');
  });

  it('tolerates short versions', () => {
    expect(bumpPatch('1.0')).toBe('1.0.1');
    expect(bumpPatch('1')).toBe('1.0.1');
    expect(bumpMinor('2')).toBe('2.1.0');
  });

  it('tolerates pre-release suffixes by stripping them', () => {
    expect(bumpPatch('1.2.3-beta.1')).toBe('1.2.4');
    expect(bumpMinor('1.2.3+build.99')).toBe('1.3.0');
  });

  it('coerces non-numeric pieces to 0', () => {
    expect(bumpPatch('weird.x.y')).toBe('0.0.1');
  });
});

describe('unifiedDiff', () => {
  it('returns a diff body with added/removed lines', () => {
    const before = 'line 1\nline 2\nline 3\n';
    const after = 'line 1\nline 2 modified\nline 3\n';
    const diff = unifiedDiff(before, after);
    expect(diff).toContain('-line 2');
    expect(diff).toContain('+line 2 modified');
  });

  it('returns empty-ish diff for identical inputs', () => {
    const same = 'unchanged\n';
    const diff = unifiedDiff(same, same);
    expect(diff).not.toMatch(/[-+][^-+]/);
  });

  it('strips the file header lines', () => {
    const diff = unifiedDiff('a\n', 'b\n');
    expect(diff).not.toMatch(/^Index:/);
    expect(diff).not.toMatch(/^---/);
    expect(diff).not.toMatch(/^\+\+\+/);
  });
});
