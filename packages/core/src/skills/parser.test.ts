import { describe, expect, it } from 'vitest';
import {
  parseSkillDocument,
  serializeSkillDocument,
  extractSection,
  SkillParseError,
} from './parser.js';

const FIXTURE_FULL = `---
name: gcp-cloud-run-deploy
description: Deploy a containerized service to Cloud Run with traffic splitting
version: "1.2.0"
author: agent
trust: agent-created
tags: [gcp, cloud-run, deployment]
platforms: [gcp]
complexity: 3
metadata:
  mastra:
    agentId: ops-agent
    threadOrigin: thread_abc
---

## When to Use

Use this when deploying to Cloud Run.

## Prerequisites

- gcloud installed
- Docker image pushed

## Procedure

1. Verify image exists.
2. Deploy.

## Verification

- Service is healthy.

## Pitfalls

- Cold start latency.
`;

describe('parseSkillDocument', () => {
  it('parses a complete valid SKILL.md', () => {
    const { frontmatter, body } = parseSkillDocument(FIXTURE_FULL);
    expect(frontmatter.name).toBe('gcp-cloud-run-deploy');
    expect(frontmatter.description).toMatch(/Cloud Run/);
    expect(frontmatter.version).toBe('1.2.0');
    expect(frontmatter.tags).toEqual(['gcp', 'cloud-run', 'deployment']);
    expect(frontmatter.complexity).toBe(3);
    expect(frontmatter.metadata?.mastra).toEqual({
      agentId: 'ops-agent',
      threadOrigin: 'thread_abc',
    });
    expect(body).toMatch(/^## When to Use/);
    expect(body).toMatch(/Pitfalls/);
  });

  it('returns default name when frontmatter omits it', () => {
    const md = `---\ndescription: hi\n---\nbody`;
    const { frontmatter } = parseSkillDocument(md);
    expect(frontmatter.name).toBe('unnamed-skill');
    expect(frontmatter.description).toBe('hi');
  });

  it('returns defaults when no frontmatter block at all', () => {
    const md = 'just some markdown content';
    const { frontmatter, body } = parseSkillDocument(md);
    expect(frontmatter.name).toBe('unnamed-skill');
    expect(frontmatter.description).toBe('');
    expect(body).toBe('just some markdown content');
  });

  it('preserves unknown metadata fields on round-trip', () => {
    const md = `---
name: test
description: ''
metadata:
  custom_key: custom_value
  nested:
    a: 1
---
body`;
    const { frontmatter } = parseSkillDocument(md);
    expect((frontmatter.metadata as Record<string, unknown>)?.custom_key).toBe('custom_value');
    const round = serializeSkillDocument(frontmatter, 'body');
    const reparsed = parseSkillDocument(round);
    expect((reparsed.frontmatter.metadata as Record<string, unknown>)?.custom_key).toBe(
      'custom_value',
    );
  });

  it('throws SkillParseError on malformed YAML', () => {
    const md = `---\nname: test\n  [invalid yaml: \n---\nbody`;
    expect(() => parseSkillDocument(md)).toThrow(SkillParseError);
  });

  it('handles empty document gracefully', () => {
    const { frontmatter, body } = parseSkillDocument('');
    expect(frontmatter.name).toBe('unnamed-skill');
    expect(body).toBe('');
  });
});

describe('serializeSkillDocument', () => {
  it('round-trips a parsed document with stable content', () => {
    const { frontmatter, body } = parseSkillDocument(FIXTURE_FULL);
    const re = serializeSkillDocument(frontmatter, body);
    const reparsed = parseSkillDocument(re);
    expect(reparsed.frontmatter.name).toBe(frontmatter.name);
    expect(reparsed.frontmatter.tags).toEqual(frontmatter.tags);
    expect(reparsed.body).toBe(body);
  });

  it('filters undefined fields from output', () => {
    const out = serializeSkillDocument(
      { name: 'x', description: 'y', version: undefined },
      'body',
    );
    expect(out).not.toMatch(/version:/);
  });
});

describe('extractSection', () => {
  const body = `## When to Use

Use here.

## Procedure

Step 1.
Step 2.

## Pitfalls

A pitfall.
`;

  it('returns content between headings', () => {
    expect(extractSection(body, 'Procedure')).toBe('Step 1.\nStep 2.');
  });

  it('returns last section when no following heading', () => {
    expect(extractSection(body, 'Pitfalls')).toBe('A pitfall.');
  });

  it('is case-insensitive', () => {
    expect(extractSection(body, 'procedure')).toBe('Step 1.\nStep 2.');
    expect(extractSection(body, 'PITFALLS')).toBe('A pitfall.');
  });

  it('returns null for non-existent section', () => {
    expect(extractSection(body, 'Nonexistent')).toBe(null);
  });

  it('escapes regex special characters in section name', () => {
    const safe = '## Section.with.dots\n\ncontent\n';
    expect(extractSection(safe, 'Section.with.dots')).toBe('content');
  });
});
