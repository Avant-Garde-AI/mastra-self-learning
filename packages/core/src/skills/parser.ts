import matter from 'gray-matter';
import type { SkillFrontmatter } from './types.js';

/** Thrown when a SKILL.md document cannot be parsed (typically malformed YAML). */
export class SkillParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SkillParseError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Parse a SKILL.md file into frontmatter and body.
 *
 * Supports the agentskills.io open standard format used by
 * Hermes Agent, Claude Code, OpenClaw, and other compatible agents.
 *
 * Behavior:
 * - Missing or empty frontmatter → `name` defaults to `'unnamed-skill'`, `description` to ''
 * - Missing `name` field → same default
 * - Unknown fields are preserved on the returned frontmatter via `metadata`
 * - Malformed YAML → throws `SkillParseError`
 */
export function parseSkillDocument(markdown: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(markdown);
  } catch (err) {
    throw new SkillParseError(
      `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const { data, content } = parsed;

  const frontmatter: SkillFrontmatter = {
    name: typeof data.name === 'string' && data.name.length > 0 ? data.name : 'unnamed-skill',
    description: typeof data.description === 'string' ? data.description : '',
    version: typeof data.version === 'string' ? data.version : undefined,
    created: typeof data.created === 'string' ? data.created : undefined,
    updated: typeof data.updated === 'string' ? data.updated : undefined,
    author: typeof data.author === 'string' ? data.author : undefined,
    trust: data.trust,
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : undefined,
    platforms: Array.isArray(data.platforms) ? (data.platforms as string[]) : undefined,
    complexity: typeof data.complexity === 'number' ? data.complexity : undefined,
    metadata: typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : undefined,
  };

  return { frontmatter, body: content.trim() };
}

/**
 * Serialize a skill back to SKILL.md format with YAML frontmatter.
 */
export function serializeSkillDocument(frontmatter: SkillFrontmatter, body: string): string {
  // Filter out undefined values for clean YAML
  const cleanFrontmatter = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== undefined),
  );

  return matter.stringify(body, cleanFrontmatter);
}

/**
 * Extract a specific named section from a skill body.
 *
 * Used for L2 progressive disclosure — loading only the "Procedure"
 * or "Pitfalls" section instead of the full document. Returns `null`
 * when the section is not found. Section name match is case-insensitive.
 */
export function extractSection(body: string, sectionName: string): string | null {
  const regex = new RegExp(`^##\\s+${escapeRegex(sectionName)}\\s*$`, 'im');
  const match = body.match(regex);
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  // Find next H2 heading (allowing trailing section to be last in doc)
  const remainder = body.slice(start);
  const nextHeadingMatch = remainder.match(/\n##\s+/);
  const end = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? start + nextHeadingMatch.index
    : body.length;

  return body.slice(start, end).trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
