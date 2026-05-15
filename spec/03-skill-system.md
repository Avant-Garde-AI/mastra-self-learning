# Skill System

## Skill Format: agentskills.io Compatible

Skills are stored as Markdown documents with YAML frontmatter, following the [agentskills.io](https://agentskills.io) open standard used by Hermes Agent, Claude Code, and other compatible agents.

### Example SKILL.md

```markdown
---
name: gcp-cloud-run-deploy
description: Deploy a containerized service to Google Cloud Run with traffic splitting
version: "1.2.0"
author: agent
trust: agent-created
tags: [gcp, cloud-run, deployment, containers]
platforms: [gcp]
complexity: 3
created: "2026-05-15T10:00:00Z"
updated: "2026-05-15T14:30:00Z"
metadata:
  mastra:
    agentId: ops-agent
    threadOrigin: thread_abc123
    extractionTrigger: auto
---

## When to Use

Use this skill when you need to deploy a containerized service to Cloud Run,
especially when traffic splitting between revisions is required.

## Prerequisites

- `gcloud` CLI authenticated with a project that has Cloud Run API enabled
- Docker image already built and pushed to Artifact Registry
- IAM permissions: `roles/run.admin`, `roles/iam.serviceAccountUser`

## Procedure

1. Verify the Docker image exists in Artifact Registry:
   ```bash
   gcloud artifacts docker images list REGION-docker.pkg.dev/PROJECT/REPO --filter="package=IMAGE"
   ```

2. Deploy the new revision with zero traffic:
   ```bash
   gcloud run deploy SERVICE_NAME \
     --image=REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG \
     --region=REGION \
     --no-traffic \
     --tag=canary
   ```

3. Verify the canary revision is healthy:
   ```bash
   gcloud run services describe SERVICE_NAME --region=REGION --format='value(status.conditions)'
   ```

4. Split traffic gradually:
   ```bash
   gcloud run services update-traffic SERVICE_NAME \
     --region=REGION \
     --to-tags=canary=10
   ```

5. Monitor for errors, then increase to 100% if healthy.

## Verification

- `gcloud run services describe SERVICE_NAME` shows expected traffic split
- No 5xx errors in Cloud Run logs for 10 minutes after split

## Pitfalls

- **Cold start latency**: New revisions may have high p99 latency on first request. Set `--min-instances=1` for latency-sensitive services.
- **IAM propagation delay**: If you just granted roles, wait 60 seconds before deploying.
- **Image tag immutability**: Artifact Registry enforces tag immutability by default. Use unique tags per build.
```

### Frontmatter Schema

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Unique skill identifier (kebab-case) |
| `description` | string | Yes | One-line description for L0 index |
| `version` | string | No | Semver string |
| `author` | string | No | `agent`, `human`, `hub`, or custom |
| `trust` | enum | No | `builtin`, `official`, `community`, `agent-created` |
| `tags` | string[] | No | Searchable tags |
| `platforms` | string[] | No | Platform scoping |
| `complexity` | number | No | 1-5 complexity rating |
| `created` | string | No | ISO timestamp |
| `updated` | string | No | ISO timestamp |
| `metadata.mastra` | object | No | Mastra-specific metadata |

### Body Sections

| Section | Purpose | Required |
|---|---|---|
| When to Use | Helps the router match tasks to skills | Recommended |
| Prerequisites | What must be true before starting | Recommended |
| Procedure | Step-by-step instructions | Required |
| Verification | How to confirm success | Recommended |
| Pitfalls | Known failure modes and workarounds | Optional |

## Storage: Extending Mastra's SkillsStorage

Mastra (Feb 2026) ships a first-class `SkillsStorage` domain with:
- CRUD + versioning across Postgres, LibSQL, MongoDB
- Draft → publish workflow via content-addressable `BlobStore`
- S3 support via `S3BlobStore`
- Studio UI integration (browse, install, remove)
- `skills.sh` registry endpoints

We extend this with `SkillStorageExtension`, which adds learning-loop metadata:

### Extended Schema

```
skills (extends Mastra's existing table)
├── id              ULID primary key
├── name            VARCHAR unique per agent scope
├── version         SEMVER string
├── content         TEXT (full SKILL.md)
├── agent_id        VARCHAR nullable (null = global)
├── trust_tier      ENUM (builtin, official, community, agent-created)
├── status          ENUM (active, draft, deprecated, archived)
├── success_count   INT default 0          ← added by extension
├── fail_count      INT default 0          ← added by extension
├── last_used       TIMESTAMP nullable     ← added by extension
├── embedding       VECTOR nullable        ← added by extension
├── created_at      TIMESTAMP
└── updated_at      TIMESTAMP

skill_versions                              ← added by extension
├── id              ULID primary key
├── skill_id        FK → skills
├── version         SEMVER string
├── content         TEXT (snapshot)
├── diff            TEXT nullable (unified diff from previous)
├── reason          TEXT (why this version was created)
└── created_at      TIMESTAMP

skill_usage                                 ← added by extension
├── id              ULID primary key
├── skill_id        FK → skills
├── thread_id       VARCHAR
├── agent_id        VARCHAR
├── outcome         ENUM (success, failure, partial, abandoned)
├── feedback        TEXT nullable
├── duration_ms     INT
├── tool_calls      INT
└── created_at      TIMESTAMP
```

## Progressive Disclosure: L0 / L1 / L2

Skills are loaded in three levels to manage token budgets:

### L0: Index (all skills, minimal tokens)

```
Available Skills:
- gcp-cloud-run-deploy: Deploy containerized service to Cloud Run with traffic splitting
- k8s-rollback: Rollback a Kubernetes deployment to a previous revision
- terraform-plan-review: Review and apply a Terraform plan safely
```

~50 tokens per skill. The full L0 index lives in the system prompt via the SkillContextProcessor.

### L1: Full Content (one skill, loaded on demand)

The entire SKILL.md body, loaded via the `skill_view` tool when the agent decides to follow a skill. Typically 200-2000 tokens.

### L2: Section Reference (specific section, loaded on demand)

A single section (e.g., just "Pitfalls" or just "Verification"), loaded via `skill_view` with a section parameter. 50-500 tokens.

### Token Budget Enforcement

The `SkillRouter` manages token budgets:

```typescript
{
  indexBudget: 3000,    // Max tokens for L0 in system prompt
  activeBudget: 8000,   // Max tokens for loaded L1/L2 content
  maxActiveSkills: 3,    // Simultaneous L1 skills
  overflowStrategy: 'relevant', // How to trim when over budget
}
```

When the L0 index exceeds `indexBudget`, the overflow strategy kicks in:
- `recent`: Keep most recently used skills
- `frequent`: Keep most frequently used skills
- `relevant`: Keep skills with highest semantic similarity to recent messages (requires embedding model)

## Skill Search

Two search modes, composable as hybrid:

**Full-Text Search (FTS)** — Phase 1:
- Searches skill names, descriptions, tags, and body text
- Uses the storage backend's native FTS (Postgres `tsvector`, LibSQL FTS5)

**Semantic Search** — Phase 4:
- Embeds the query via the configured embedding model
- Compares against pre-computed skill embeddings
- Better for intent-based matching ("I need to deploy something" → finds `gcp-cloud-run-deploy`)

**Hybrid** (default) — combines both with configurable weighting.

## Tool Definitions

The `createSelfLearningTools()` factory returns these tools:

| Tool ID | Description | Used For |
|---|---|---|
| `skill_list` | List all active skills (L0 index) | Discovering available skills |
| `skill_view` | Load skill content (L1 or L2) | Following a skill procedure |
| `skill_search` | Search skills by query | Finding relevant skills for a task |
| `skill_create` | Create a new skill document | Manual or extractor-driven creation |
| `skill_update` | Update an existing skill | Manual refinement |
| `skill_feedback` | Record usage outcome | Tracking success/failure metrics |
| `memory_persist` | Store a fact in the Fact Layer | Cross-thread memory |
| `memory_recall` | Query the Fact Layer | Retrieving persistent facts |
