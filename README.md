# @avant-garde/mastra-self-learning

**Self-learning extension for [Mastra](https://mastra.ai)** — closed learning loops, autonomous skill extraction, and layered memory inspired by [Hermes Agent](https://github.com/NousResearch/hermes-agent).

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@avant-garde/mastra-self-learning)](https://www.npmjs.com/package/@avant-garde/mastra-self-learning)

---

## What this does

Any Mastra agent can **learn from experience**. After completing complex tasks, the agent autonomously creates reusable **skill documents** — step-by-step procedures it can reference next time a similar task appears. Skills self-improve through use, and the agent accumulates persistent facts and maintains a stable identity across sessions.

This is the **closed learning loop** from Hermes Agent, rebuilt as composable Mastra primitives (processors, tools, storage extensions, Harness modes) that drop into your existing Mastra app.

### Core Principles (from Hermes Agent → Mastra)

| Hermes Agent | This Package |
|---|---|
| Closed learning loop (task → skill → reuse → refine) | `SelfLearningProcessor` output processor with auto-extraction |
| Layered memory (MEMORY.md + skills + SOUL.md) | Fact Layer + Procedural Layer + Identity Layer composing with Mastra's Observational Memory |
| Progressive skill disclosure (L0 index → L1 full → L2 reference) | Token-aware `SkillRouter` via Mastra tool interface |
| agentskills.io open standard | Full SKILL.md parse/serialize + import/export |
| Skill self-improvement during use | `SkillRefiner` with diff-based versioning |
| Trust tiers (builtin > official > community) | `SkillTrustPolicy` with configurable approval gates |

## Quick Start

```bash
npm install @avant-garde/mastra-self-learning
```

### Tier 1: Tools Only (5 min)

```typescript
import { Agent } from '@mastra/core';
import { createSelfLearningTools } from '@avant-garde/mastra-self-learning';

const agent = new Agent({
  name: 'my-agent',
  model: 'anthropic/claude-sonnet-4-20250514',
  tools: {
    ...createSelfLearningTools({ storage }),
  },
});
```

### Tier 2: Tools + Processors (recommended)

```typescript
import {
  createSelfLearningTools,
  createSelfLearningProcessor,
  createSkillContextProcessor,
} from '@avant-garde/mastra-self-learning';

const agent = new Agent({
  name: 'my-agent',
  model: 'anthropic/claude-sonnet-4-20250514',
  tools: { ...createSelfLearningTools({ storage }) },
  inputProcessors: [createSkillContextProcessor({ storage, identity, factLayer })],
  outputProcessors: [createSelfLearningProcessor({ storage, extraction })],
});
```

### Tier 3: Full Harness Integration

```typescript
import { Harness } from '@mastra/core';
import {
  createSelfLearningMode,
  createSelfLearningTools,
  createSelfLearningProcessor,
  createSkillContextProcessor,
} from '@avant-garde/mastra-self-learning';

const harness = new Harness({
  modes: {
    chat: { agent, defaultModel: 'anthropic/claude-sonnet-4-20250514' },
    learn: createSelfLearningMode({ agent, storage }),
  },
  tools: { ...createSelfLearningTools({ storage }) },
});
```

## Documentation

See the [docs/](./docs) directory for full architecture and implementation guides:

- [Getting Started](./docs/00-getting-started.md)
- [Architecture Overview](./docs/01-architecture.md)
- [Processor Integration](./docs/02-processors.md)
- [Skill System](./docs/03-skill-system.md)
- [Learning Loop](./docs/04-learning-loop.md)
- [Memory Layers](./docs/05-memory-layers.md)
- [Harness Integration](./docs/06-harness-integration.md)
- [Trust & Security](./docs/07-trust-and-security.md)
- [Skill Gardening](./docs/08-skill-gardening.md)
- [Evaluation & Metrics](./docs/09-evaluation.md)
- [Hermes Migration](./docs/10-hermes-migration.md)
- [Implementation Plan](./docs/11-implementation-plan.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and contribution guidelines.

## License

MIT — see [LICENSE](./LICENSE).
