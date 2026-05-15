# Getting Started

## Prerequisites

- Node.js >= 22.13.0
- A Mastra project (`@mastra/core` >= 1.25.0)
- A storage backend (`@mastra/pg`, `@mastra/libsql`, or `@mastra/mongodb`)

## Installation

```bash
npm install @avant-garde/mastra-self-learning
# or
pnpm add @avant-garde/mastra-self-learning
```

## Integration Tiers

The package supports three integration depths. Pick based on your needs:

### Tier 1: Tools Only (5 min)

Give your agent skill CRUD tools. No automatic learning — the agent can list, search, view, and manually create skills.

```typescript
import { Agent } from '@mastra/core';
import { createSelfLearningTools } from '@avant-garde/mastra-self-learning';
import { PostgresStore } from '@mastra/pg';

const storage = new PostgresStore({ connectionString: process.env.DATABASE_URL });

const agent = new Agent({
  name: 'my-agent',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a helpful assistant with access to learned skills...',
  tools: {
    ...createSelfLearningTools({ storage }),
  },
});
```

### Tier 2: Tools + Processors (recommended)

Adds the closed learning loop. The agent automatically extracts skills from complex task completions and injects skill context into its system prompt.

```typescript
import {
  createSelfLearningTools,
  createSelfLearningProcessor,
  createSkillContextProcessor,
} from '@avant-garde/mastra-self-learning';

const agent = new Agent({
  name: 'my-agent',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a helpful assistant...',
  tools: {
    ...createSelfLearningTools({ storage }),
  },
  inputProcessors: [
    createSkillContextProcessor({
      storage,
      identity: {
        personality: 'You are a DevOps automation expert.',
        expertise: ['gcp', 'kubernetes', 'terraform'],
      },
      factLayer: { enabled: true, nudgeInterval: 10 },
    }),
  ],
  outputProcessors: [
    createSelfLearningProcessor({
      storage,
      extraction: { minToolCalls: 5, requireApproval: false },
    }),
  ],
});
```

### Tier 3: Full Harness Integration

For agent-app developers using Mastra's Harness orchestration layer.

```typescript
import { Harness } from '@mastra/core';
import {
  createSelfLearningMode,
  createSelfLearningTools,
  createSelfLearningProcessor,
  createSkillContextProcessor,
  createGardeningWorkflows,
} from '@avant-garde/mastra-self-learning';

// Agent with processors (same as Tier 2)
const agent = new Agent({ /* ... */ });

// Harness with learn mode
const harness = new Harness({
  modes: {
    chat: { agent, defaultModel: 'anthropic/claude-sonnet-4-20250514' },
    learn: createSelfLearningMode({ agent, storage }),
  },
  tools: {
    ...createSelfLearningTools({ storage }),
  },
});

// Register gardening workflows
const mastra = new Mastra({
  agents: { myAgent: agent },
  workflows: {
    ...createGardeningWorkflows({ storage }),
  },
});
```

## Next Steps

- [Architecture Overview](./01-architecture.md) — understand the system design
- [Processor Integration](./02-processors.md) — how I/O processors work
- [Skill System](./03-skill-system.md) — skill format, storage, search
- [Learning Loop](./04-learning-loop.md) — extraction, refinement, feedback
