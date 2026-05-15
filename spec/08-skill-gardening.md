# Skill Gardening

## Why Gardening Matters

Without maintenance, a skill library degrades over time:
- **Duplicates accumulate** as extraction creates overlapping skills
- **Stale skills** reference outdated tools, APIs, or procedures
- **Quality variance** increases as some skills get refined and others don't
- **Facts decay** without reinforcement, accumulating noise
- **Identity drifts** as the agent adapts to different users/contexts

Gardening workflows run on a schedule to keep the library healthy.

## Workflow Definitions

### Deduplication

**Schedule**: Weekly (Sunday)
**What it does**: Identifies semantically similar skills and proposes merges.

```
For each skill pair with similarity > 0.8:
  1. Compare frontmatter (tags, platforms, complexity)
  2. Compare body structure (section overlap)
  3. If substantial overlap:
     a. Merge into the skill with more usage/higher success rate
     b. Archive the other
     c. Create a version entry documenting the merge
```

### Decay

**Schedule**: Weekly (Monday)
**What it does**: Applies confidence decay to facts and archives stale skills.

```
For each fact:
  1. Calculate weeks since last reinforcement
  2. Apply decay: confidence *= (1 - decayRate)^weeks
  3. If confidence < 0.1: archive the fact

For each skill:
  1. If last_used > 90 days AND successCount < 3: mark as deprecated
  2. If last_used > 180 days AND status == deprecated: archive
```

### Quality Scoring

**Schedule**: Weekly (Wednesday)
**What it does**: Recalculates skill quality scores from recent usage data.

```
For each active skill:
  1. Compute success_rate = successCount / (successCount + failCount)
  2. Compute trend = success_rate(last_30d) - success_rate(prev_30d)
  3. If success_rate < 0.3 over 10+ uses: flag for review
  4. If trend < -0.2: flag for refinement
  5. Update quality_score metadata
```

### Drift Detection

**Schedule**: Monthly
**What it does**: Compares current Identity Layer against seed values.

```
For each agent with IdentityLayer enabled:
  1. Fetch current calibrated identity
  2. Compare against seed identity via embedding similarity
  3. If drift > driftThreshold: alert developer
  4. Log drift score and changed dimensions
```

## Registration

```typescript
import { Mastra } from '@mastra/core';
import { createGardeningWorkflows } from '@avant-garde/mastra-self-learning/workflows';

const workflows = createGardeningWorkflows({
  storage: store,
  auxiliaryModel: 'anthropic/claude-sonnet-4-20250514',
});

const mastra = new Mastra({
  workflows: {
    ...workflows,
  },
});
```

## Manual Triggers

Gardening workflows can also be triggered manually via the CLI or learn mode:

```bash
# Via CLI
npx @avant-garde/mastra-self-learning-cli gardening --task=dedup

# Via learn mode (conversational)
"Run deduplication on all my skills"
```

## CAS Safety

Mastra's WorkflowScheduler uses Compare-and-Swap (CAS) for concurrent safety. This ensures gardening workflows don't conflict with real-time skill creation or refinement happening in parallel agent sessions.
