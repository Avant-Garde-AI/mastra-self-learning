import { createPatch } from 'diff';

/**
 * Semver helpers. We use a tolerant parser — `1.0.0`, `1.0`, `1`, and even
 * pre-release/build suffixes (`1.0.0-beta.1`) all bump by reasonable rules.
 * Non-numeric pieces are coerced to `0` so we never throw.
 */
export function bumpPatch(version: string): string {
  const [maj, min, pat] = parseSemverLenient(version);
  return `${maj}.${min}.${pat + 1}`;
}

export function bumpMinor(version: string): string {
  const [maj, min] = parseSemverLenient(version);
  return `${maj}.${min + 1}.0`;
}

export function bumpMajor(version: string): string {
  const [maj] = parseSemverLenient(version);
  return `${maj + 1}.0.0`;
}

function parseSemverLenient(version: string): [number, number, number] {
  // Strip pre-release / build suffix (everything from first '-' or '+')
  const core = version.split(/[-+]/, 1)[0] ?? '0.0.0';
  const parts = core.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  return [parts[0]!, parts[1]!, parts[2]!];
}

/**
 * Produce a unified diff between two strings.
 *
 * Used by `skill_update` and the refiner (Phase 5) to persist a human-readable
 * record of what changed between two versions of a SKILL.md document.
 *
 * Returns the diff body **without** the customary `--- a/...` / `+++ b/...`
 * header (we don't have meaningful filenames at this layer).
 */
export function unifiedDiff(before: string, after: string, fileName = 'skill.md'): string {
  // createPatch generates the full header + hunks. Strip the first 4 lines
  // (Index, ===, --- a/, +++ b/) to keep only the hunks for cleaner display.
  const patch = createPatch(fileName, before, after, '', '', { context: 3 });
  const lines = patch.split('\n');
  // The output of createPatch starts with `Index: ...\n===\n--- ...\n+++ ...\n`
  // Skip up to and including the +++ line.
  const startIdx = lines.findIndex((l) => l.startsWith('+++ '));
  return startIdx >= 0 ? lines.slice(startIdx + 1).join('\n').trim() : patch;
}
