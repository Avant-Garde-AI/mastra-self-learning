import matter from 'gray-matter';
import type { SkillFrontmatter } from './types.js';

/**
 * Parse a SKILL.md file into frontmatter and body.
 *
 * Supports the agentskills.io open standard format used by
 * Hermes Agent, Claude Code, OpenClaw, and other compatible agents.
 */
export function parseSkillDocument(markdown: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const { data, content } = matter(markdown);

  const frontmatter: SkillFrontmatter = {
    name: data.name ?? 'unnamed-skill',
    description: data.description ?? '',
    version: data.version,
    created: data.created,
    updated: data.updated,
    author: data.author,
    trust: data.trust,
    tags: data.tags,
    platforms: data.platforms,
    complexity: data.complexity,
    metadata: data.metadata,
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
 * or "Pitfalls" section instead of the full document.
 */
export function extractSection(body: string, sectionName: string): string | null {
  const regex = new RegExp(`^##\\s+${escapeRegex(sectionName)}\\s*$`, 'im');
  const match = body.match(regex);
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  const nextHeading = body.indexOf('\n## ', start);
  const end = nextHeading === -1 ? body.length : nextHeading;

  return body.slice(start, end).trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
