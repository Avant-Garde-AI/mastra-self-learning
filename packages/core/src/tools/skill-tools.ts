import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import {
  SkillRouterConfigSchema,
  type TrustTier,
} from '../config.js';
import {
  SkillStorageExtension,
  type MastraPostgresLike,
} from '../skills/storage-extension.js';
import { SkillSearch } from '../skills/search.js';
import { SkillRouter } from '../skills/router.js';
import type { EmbedText } from '../skills/embedding.js';
import { FactLayer } from '../memory/fact-layer.js';
import { FactLayerConfigSchema } from '../config.js';
import { parseSkillDocument } from '../skills/parser.js';
import { scanSkillContent } from '../skills/scanner.js';
import { bumpPatch, unifiedDiff } from '../skills/version-utils.js';

const TRUST_TIERS = ['builtin', 'official', 'community', 'agent-created'] as const;
const FACT_CATEGORIES = [
  'preference',
  'context',
  'project',
  'credential',
  'constraint',
  'relationship',
] as const;
const USAGE_OUTCOMES = ['success', 'failure', 'partial', 'abandoned'] as const;

/**
 * Options for creating the self-learning toolset.
 */
export interface SelfLearningToolsOptions {
  /** Mastra storage instance (a `PostgresStore`) or an already-constructed extension. */
  storage: MastraPostgresLike | SkillStorageExtension;
  /** Scope tools to a specific agent. Pass `null` for global-only. */
  agentId?: string | null;
  /**
   * Optional embedder for semantic skill_search (v0.2.0). Ignored when
   * `storage` is an already-constructed extension (it carries its own).
   */
  embed?: EmbedText;
}

/**
 * Create the skill management tools that get registered on a Mastra agent.
 *
 * Returns 8 typed tools (use object spread into your Agent's `tools` config):
 *   - skill_list, skill_view, skill_search       — L0/L1/L2 discovery
 *   - skill_create, skill_update                  — manual creation/refinement
 *   - skill_feedback                               — outcome tracking
 *   - memory_persist, memory_recall (Phase 4 stubs) — cross-thread facts
 *
 * The tools share a single `SkillStorageExtension` / `SkillSearch` / `SkillRouter`
 * triple under the hood; they are constructed once when this factory runs and
 * closed over by each tool's `execute` function.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   tools: {
 *     ...createSelfLearningTools({ storage, agentId: 'ops-agent' }),
 *     ...myOtherTools,
 *   },
 * });
 * ```
 *
 * @see docs/03-skill-system.md
 */
export function createSelfLearningTools(options: SelfLearningToolsOptions) {
  const storage =
    options.storage instanceof SkillStorageExtension
      ? options.storage
      : new SkillStorageExtension(options.storage, { embed: options.embed });
  const search = new SkillSearch(storage, options.embed);
  const router = new SkillRouter(
    storage,
    SkillRouterConfigSchema.parse({}),
    options.agentId,
    undefined,
    undefined,
    options.embed,
  );
  const factLayer = new FactLayer(
    storage,
    FactLayerConfigSchema.parse({}),
    options.agentId ?? null,
  );
  const agentId = options.agentId;

  // -------------------------------------------------------------------------
  // skill_list
  // -------------------------------------------------------------------------
  const skill_list = createTool({
    id: 'skill_list',
    description:
      'List all available skills (the L0 index). Call this at the start of a complex task to discover what reusable procedures exist before reasoning from scratch.',
    inputSchema: z.object({
      tags: z.array(z.string()).optional().describe('Filter by tags (AND match against the skill\'s tag list)'),
      limit: z.number().int().min(1).max(100).optional().default(50),
    }),
    outputSchema: z.object({
      skills: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          version: z.string(),
          successCount: z.number(),
          failCount: z.number(),
          tags: z.array(z.string()),
        }),
      ),
    }),
    execute: async (inputData) => {
      const skills = await storage.listSkills({
        agentId: agentId === undefined ? undefined : agentId,
        status: 'active',
        limit: inputData.limit,
      });
      const tagFilter = inputData.tags;
      const filtered =
        tagFilter && tagFilter.length > 0
          ? skills.filter((s) => {
              const skillTags = s.frontmatter.tags ?? [];
              return tagFilter.every((t) => skillTags.includes(t));
            })
          : skills;
      return {
        skills: filtered.map((s) => ({
          name: s.name,
          description: s.frontmatter.description ?? '',
          version: s.version,
          successCount: s.successCount,
          failCount: s.failCount,
          tags: s.frontmatter.tags ?? [],
        })),
      };
    },
  });

  // -------------------------------------------------------------------------
  // skill_view
  // -------------------------------------------------------------------------
  const skill_view = createTool({
    id: 'skill_view',
    description:
      'Load the full content of a skill (L1) or a specific section (L2). Use this once you have decided to follow a skill listed by skill_list. Section names match section headings (e.g. "Procedure", "Pitfalls", "Verification") case-insensitively.',
    inputSchema: z.object({
      name: z.string(),
      section: z
        .string()
        .optional()
        .describe('Load only this section (e.g. "Procedure", "Pitfalls"). Omit for full content.'),
    }),
    outputSchema: z.object({
      content: z.string(),
      found: z.boolean(),
    }),
    execute: async (inputData) => {
      const content = await router.loadSkill(inputData.name, inputData.section);
      return { content: content ?? '', found: content !== null };
    },
  });

  // -------------------------------------------------------------------------
  // skill_search
  // -------------------------------------------------------------------------
  const skill_search = createTool({
    id: 'skill_search',
    description:
      'Search skills by keyword or phrase. Returns ranked matches. Use this when the L0 index does not contain an obvious match for your task.',
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional().default(5),
    }),
    outputSchema: z.object({
      results: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          score: z.number(),
        }),
      ),
    }),
    execute: async (inputData) => {
      const results = await search.search({
        query: inputData.query,
        mode: 'fts',
        limit: inputData.limit,
        agentId: agentId === undefined || agentId === null ? undefined : agentId,
      });
      return {
        results: results.map((r) => ({
          name: r.skill.name,
          description: r.skill.frontmatter.description ?? '',
          score: r.score,
        })),
      };
    },
  });

  // -------------------------------------------------------------------------
  // skill_create
  // -------------------------------------------------------------------------
  const skill_create = createTool({
    id: 'skill_create',
    description:
      'Create a new skill from a SKILL.md document (YAML frontmatter + markdown body). Most skills are created automatically by the learning loop — use this tool only when you have been explicitly asked to formalize a procedure. If the content fails the security scan, the skill is stored as a draft and the findings are returned.',
    inputSchema: z.object({
      content: z
        .string()
        .min(1)
        .describe('Full SKILL.md content including YAML frontmatter at the top'),
    }),
    outputSchema: z.object({
      skill: z.object({
        id: z.string(),
        name: z.string(),
        version: z.string(),
        status: z.string(),
      }),
      scanFindings: z.array(
        z.object({
          type: z.string(),
          severity: z.string(),
          description: z.string(),
          line: z.number().optional(),
        }),
      ),
    }),
    execute: async (inputData) => {
      const { frontmatter } = parseSkillDocument(inputData.content);
      const scan = scanSkillContent(inputData.content);
      const trustTier: TrustTier =
        (frontmatter.trust as TrustTier | undefined) ?? 'agent-created';
      const skill = await storage.createSkill({
        name: frontmatter.name,
        version: frontmatter.version ?? '1.0.0',
        content: inputData.content,
        frontmatter,
        trustTier,
        status: scan.safe ? 'active' : 'draft',
        successCount: 0,
        failCount: 0,
        agentId: agentId === undefined ? null : agentId,
      });
      router.invalidate();
      return {
        skill: {
          id: skill.id,
          name: skill.name,
          version: skill.version,
          status: skill.status,
        },
        scanFindings: scan.findings,
      };
    },
  });

  // -------------------------------------------------------------------------
  // skill_update
  // -------------------------------------------------------------------------
  const skill_update = createTool({
    id: 'skill_update',
    description:
      'Update an existing skill by name. Provide the new SKILL.md content. The previous version is preserved automatically with a unified diff.',
    inputSchema: z.object({
      name: z.string(),
      content: z.string().min(1),
      reason: z.string().describe('Why the update is being made (recorded in version history)'),
    }),
    outputSchema: z.object({
      skill: z.object({ id: z.string(), version: z.string() }),
    }),
    execute: async (inputData) => {
      const existing = await storage.getSkillByName(
        inputData.name,
        agentId === undefined || agentId === null ? undefined : agentId,
      );
      if (!existing) {
        throw new Error(`Skill not found: ${inputData.name}`);
      }
      const { frontmatter } = parseSkillDocument(inputData.content);
      // Auto-bump patch unless the caller explicitly provided a different (newer) version.
      const incoming = frontmatter.version;
      const newVersion =
        incoming && incoming !== existing.version ? incoming : bumpPatch(existing.version);
      const diff = unifiedDiff(existing.content, inputData.content);
      // Single authoritative versioning write (see updateSkill JSDoc): the
      // active version row carries the diff + reason; no separate
      // createVersion (that would orphan a non-active duplicate).
      const updated = await storage.updateSkill(
        existing.id,
        {
          content: inputData.content,
          frontmatter,
          version: newVersion,
        },
        { diff, reason: inputData.reason },
      );
      router.invalidate();
      return { skill: { id: updated.id, version: updated.version } };
    },
  });

  // -------------------------------------------------------------------------
  // skill_feedback
  // -------------------------------------------------------------------------
  const skill_feedback = createTool({
    id: 'skill_feedback',
    description:
      'Record the outcome after using a skill. Call this immediately after completing a task that was guided by a skill (whether the skill helped or not).',
    inputSchema: z.object({
      name: z.string(),
      outcome: z.enum(USAGE_OUTCOMES),
      feedback: z.string().optional(),
      durationMs: z.number().int().min(0).optional(),
      toolCalls: z.number().int().min(0).optional(),
    }),
    outputSchema: z.object({
      recorded: z.boolean(),
    }),
    execute: async (inputData, context) => {
      const lookupAgentId = agentId === undefined || agentId === null ? undefined : agentId;
      const skill = await storage.getSkillByName(inputData.name, lookupAgentId);
      if (!skill) {
        // Soft fail — don't crash the agent loop because of bookkeeping.
        return { recorded: false };
      }
      const threadId = context?.agent?.threadId ?? 'unknown';
      const effectiveAgentId = context?.agent?.agentId ?? agentId ?? 'unknown';
      await storage.recordUsage({
        skillId: skill.id,
        threadId,
        agentId: effectiveAgentId,
        outcome: inputData.outcome,
        feedback: inputData.feedback ?? null,
        durationMs: inputData.durationMs ?? 0,
        toolCalls: inputData.toolCalls ?? 0,
      });
      return { recorded: true };
    },
  });

  // -------------------------------------------------------------------------
  // memory_persist
  // -------------------------------------------------------------------------
  const memory_persist = createTool({
    id: 'memory_persist',
    description:
      'Store a fact in your persistent memory. Use this when the user shares a fact about themselves, their environment, projects, or preferences that should be remembered across conversations.',
    inputSchema: z.object({
      category: z.enum(FACT_CATEGORIES),
      content: z.string().min(1),
    }),
    outputSchema: z.object({
      id: z.string().optional(),
      persisted: z.boolean(),
    }),
    execute: async (inputData, context) => {
      const threadId = context?.agent?.threadId ?? 'unknown';
      try {
        const fact = await factLayer.persistFact({
          category: inputData.category,
          content: inputData.content,
          confidence: 1.0,
          sourceThreadId: threadId,
          agentId: agentId ?? null,
          ttl: null,
        });
        return { id: fact.id, persisted: true };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[mastra-self-learning] memory_persist failed; fact not stored.',
          err instanceof Error ? err.message : err,
        );
        return { persisted: false };
      }
    },
  });

  // -------------------------------------------------------------------------
  // memory_recall
  // -------------------------------------------------------------------------
  const memory_recall = createTool({
    id: 'memory_recall',
    description:
      'Retrieve facts stored in your persistent memory. Use this when you need to recall what you know about the user, their environment, or their projects.',
    inputSchema: z.object({
      query: z.string(),
      category: z.enum(FACT_CATEGORIES).optional(),
      limit: z.number().int().min(1).max(20).optional().default(5),
    }),
    outputSchema: z.object({
      facts: z.array(
        z.object({
          id: z.string(),
          category: z.string(),
          content: z.string(),
          confidence: z.number(),
        }),
      ),
    }),
    execute: async (inputData) => {
      try {
        const facts = await factLayer.getRelevantFacts(inputData.query, inputData.limit);
        const filtered = inputData.category
          ? facts.filter((f) => f.category === inputData.category)
          : facts;
        return {
          facts: filtered.map((f) => ({
            id: f.id,
            category: f.category,
            content: f.content,
            confidence: f.confidence,
          })),
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[mastra-self-learning] memory_recall failed; returning empty set.',
          err instanceof Error ? err.message : err,
        );
        return { facts: [] };
      }
    },
  });

  return {
    skill_list,
    skill_view,
    skill_search,
    skill_create,
    skill_update,
    skill_feedback,
    memory_persist,
    memory_recall,
  };
}

/** Trust tier sentinel for type inference downstream. */
export const _trustTiers = TRUST_TIERS;
