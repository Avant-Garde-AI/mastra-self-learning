# Architecture Overview

## Design Philosophy

This package extends Mastra at the **framework primitive level** — it does not wrap or monkey-patch Mastra internals. Every integration point uses a documented, stable Mastra API: processors, tools, storage domains, Harness modes, workflows, and eval scorers.

The architecture is informed by three sources:

1. **Hermes Agent** (Nous Research) — the closed learning loop, progressive skill disclosure, layered memory, and agentskills.io standard
2. **Mastra's composition model** — packages extend Mastra by exporting composable primitives, not by registering as monolithic plugins
3. **NeuroGraph's production constraints** — GCP-native, multi-agent, cost-conscious, and designed for iterative refinement

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Developer's Mastra App                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                     Mastra Agent                      │   │
│  │                                                       │   │
│  │  inputProcessors:                                     │   │
│  │    ┌──────────────────────────────────────────┐      │   │
│  │    │ SkillContextProcessor (ours)             │      │   │
│  │    │ - Injects: Identity → Facts → Skill Index│      │   │
│  │    │ - Composes with OM (handled by Mastra)   │      │   │
│  │    └──────────────────────────────────────────┘      │   │
│  │                                                       │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │          Mastra Agentic Loop                 │     │   │
│  │  │  ┌───────────┐    ┌──────────────────────┐  │     │   │
│  │  │  │ LLM Step  │───▶│  Tool Call Steps     │  │     │   │
│  │  │  └───────────┘    │  (skill_list,        │  │     │   │
│  │  │       ▲           │   skill_view,        │  │     │   │
│  │  │       │           │   skill_search, ...) │  │     │   │
│  │  │       │           └──────────────────────┘  │     │   │
│  │  │       │                    │                 │     │   │
│  │  │       └────────────────────┘                 │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  │                       │                               │   │
│  │  outputProcessors:    ▼                               │   │
│  │    ┌──────────────────────────────────────────┐      │   │
│  │    │ SelfLearningProcessor (ours)             │      │   │
│  │    │ - Observes: tool calls, turn count       │      │   │
│  │    │ - Accumulates: TaskTrajectory via state  │      │   │
│  │    │ - Triggers: extraction on task completion│      │   │
│  │    └──────────────────────────────────────────┘      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌───────────────────────┐  ┌─────────────────────────┐    │
│  │   Harness (optional)  │  │  Gardening Workflows    │    │
│  │   - Learn mode        │  │  - Dedup, decay, scoring│    │
│  │   - Task tracking     │  │  - Scheduled via cron   │    │
│  │   - Subagents         │  └─────────────────────────┘    │
│  └───────────────────────┘                                  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                  Storage Layer                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Mastra SkillsStorage (built-in)                       │  │
│  │  + SkillStorageExtension (ours)                        │  │
│  │  ────────────────────────────────                      │  │
│  │  Tables: skills, skill_versions, skill_usage, facts    │  │
│  │  BlobStore: S3 / local for skill content blobs         │  │
│  │  Backends: Postgres, LibSQL, MongoDB                   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Module Map

| Module | Purpose | Mastra API Used | Phase |
|---|---|---|---|
| `processors/self-learning-processor` | Observes agent loop, triggers extraction | `processOutputStep`, `ProcessorState` | 2 |
| `processors/skill-context-processor` | Injects skills/facts/identity into prompt | `processInput` | 3 |
| `tools/skill-tools` | Skill CRUD + memory tools for the agent | `createTool()` | 1 |
| `skills/storage-extension` | Learning-loop metadata on Mastra's skills domain | `SkillsStorage` domain | 1 |
| `skills/router` | Token-aware progressive disclosure (L0/L1/L2) | Tool interface | 1 |
| `skills/extractor` | Creates skills from task trajectories | Auxiliary LLM call | 2 |
| `skills/refiner` | Improves skills based on usage feedback | Auxiliary LLM call | 2 |
| `skills/search` | Hybrid FTS + semantic skill search | Storage backend | 1/4 |
| `skills/scanner` | Security validation of skill content | Regex + LLM | 1/2 |
| `skills/parser` | agentskills.io SKILL.md parse/serialize | gray-matter | 1 |
| `memory/fact-layer` | Cross-thread persistent facts | Storage backend | 3 |
| `memory/identity` | Personality stability + drift detection | Storage backend | 3 |
| `harness/` | Learn mode + Harness-level tools | `Harness`, `HarnessMode` | 3 |
| `workflows/` | Scheduled gardening (dedup, decay, quality) | `WorkflowScheduler` | 4 |
| `evals/` | Skill utilization, quality, drift scorers | `createScorer()` | 5 |

## Data Flow

### Write Path (Learning)

```
User sends message
  → Agent loop begins
    → LLM generates response (may include tool calls)
    → SelfLearningProcessor.processOutputStream() accumulates state
    → Tool calls execute (including skill tools)
    → Loop continues until no more tool calls
  → SelfLearningProcessor.processOutputResult() fires
    → Evaluates TaskTrajectory against ExtractionPolicy
    → If triggered: SkillExtractor.evaluate() → synthesize() → store()
    → If existing skill was used: SkillRefiner.evaluate() → refine()
```

### Read Path (Using Skills)

```
User sends message
  → SkillContextProcessor.processInput() fires
    → IdentityLayer.buildIdentityBlock() → prepend
    → FactLayer.buildFactsBlock() → prepend
    → SkillRouter.buildIndex() → prepend (L0 index)
  → Agent sees skills in its system prompt
  → Agent calls skill_view tool → loads L1/L2 content
  → Agent follows skill procedure
  → Agent calls skill_feedback → records outcome
```

## Key Design Decisions

### Why Processors, Not Wrappers

The initial design proposed a `withSelfLearning(agent)` wrapper. This was rejected because:

1. Processors are Mastra's native extension point for the agent loop
2. `processOutputStep` runs after every step, giving per-step visibility
3. `ProcessorState` handles streaming accumulation natively
4. Processors compose with Observational Memory without ordering issues
5. The Processor interface is a stable, documented API

### Why Extend SkillsStorage, Not Build Parallel Storage

Mastra ships a full skills storage domain (Feb 2026) with versioning, BlobStore, draft→publish workflow, and Studio UI. Building a parallel storage system would:

1. Duplicate 60%+ of the functionality
2. Miss Studio UI integration
3. Create migration burdens when Mastra evolves their schema

Instead, we extend the existing domain with learning-loop columns (usage counts, trust tiers, extraction provenance).

### Why Token Budgets on Skills

Without budgets, skills can starve Observational Memory or the active conversation of context window space. The SkillRouter enforces:

- `indexBudget` (default 3000 tokens): max for the L0 skill index
- `activeBudget` (default 8000 tokens): max for loaded L1/L2 content
- `maxActiveSkills` (default 3): simultaneous L1 skills

These compose with Mastra's own memory token management.
