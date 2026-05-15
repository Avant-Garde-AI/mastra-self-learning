# Harness Integration

## What the Harness Is

Mastra's `Harness` class (shipped Feb 2026) is the core orchestration layer for agent-powered applications. It consolidates:

- **Modes**: Named configurations (chat, plan, execute, build) with different agents, models, and capabilities
- **Shared State**: Schema-validated state accessible across modes and agents
- **Built-in Tools**: `task_write`, `task_check` for structured task tracking
- **Subagents**: Spawnable specialized agents (explore, execute) managed as children
- **Memory**: Thread lifecycle management and message persistence
- **Events**: Event-driven runtime for UI updates and streaming

The Harness is the recommended integration point for production agent apps that need more than simple `agent.generate()` calls.

## Self-Learning + Harness

### Learn Mode

We export a `createSelfLearningMode()` that defines a Harness mode for explicit skill review:

```typescript
import { Harness } from '@mastra/core';
import { createSelfLearningMode } from '@avant-garde/mastra-self-learning/harness';

const harness = new Harness({
  modes: {
    chat: {
      agent: chatAgent,
      defaultModel: 'anthropic/claude-sonnet-4-20250514',
    },
    learn: createSelfLearningMode({
      agent: chatAgent,
      storage: store,
      defaultModel: 'anthropic/claude-sonnet-4-20250514',
    }),
  },
});
```

In learn mode, the agent receives augmented instructions that focus it on:

1. **Reviewing recent task completions** — scanning recent threads for extraction candidates
2. **Creating skills manually** — the user can describe a procedure and the agent formalizes it
3. **Refining existing skills** — reviewing usage feedback and updating skill content
4. **Curating facts** — adding, updating, or removing persistent facts
5. **Running quality assessments** — checking skill quality scores and suggesting improvements

### Switching Modes

```typescript
// Switch to learn mode for a skill review session
await harness.switchMode({ modeId: 'learn' });
await harness.sendMessage({
  content: 'Review my recent deployment tasks and create any missing skills',
});

// Switch back to chat
await harness.switchMode({ modeId: 'chat' });
```

### Task Tracking Integration

The Harness provides `task_write` and `task_check` as built-in tools. When the SelfLearningProcessor detects these in the tool call trace, they serve as strong extraction signals:

- **All tasks complete** (via `task_check`): Strong positive outcome signal
- **Task creation** (via `task_write`): Indicates structured, procedural work
- **Task count**: Proxy for task complexity

```
TaskTrajectory {
  toolCalls: [
    { name: 'task_write', input: { task: 'Deploy canary revision' } },
    { name: 'gcloud_run_deploy', ... },
    { name: 'gcloud_run_describe', ... },
    { name: 'task_check', input: { task: 'Deploy canary revision', status: 'complete' } },
    { name: 'task_write', input: { task: 'Split traffic to canary' } },
    ...
  ]
}
```

### Subagent Integration

For complex learning tasks, the learn mode can spawn subagents:

- **Explorer subagent**: Scans recent threads for extraction candidates
- **Reviewer subagent**: Evaluates skill quality against usage data

These use the Harness's native subagent spawning:

```typescript
createSelfLearningMode({
  agent: chatAgent,
  storage: store,
  subagents: {
    explorer: {
      id: 'skill-explorer',
      description: 'Scans recent task completions for skill extraction candidates',
      systemPrompt: '...',
      tools: [skill_list, skill_search, skill_create],
    },
    reviewer: {
      id: 'skill-reviewer',
      description: 'Reviews skill quality and suggests improvements',
      systemPrompt: '...',
      tools: [skill_view, skill_update, skill_feedback],
    },
  },
});
```

## Harness vs. Processors: When to Use What

| Scenario | Use Processors (Tier 2) | Use Harness (Tier 3) |
|---|---|---|
| Simple `agent.generate()` / `.stream()` | ✅ | Overkill |
| Agent-powered app with modes | ✅ (still add processors) | ✅ Add learn mode |
| Explicit skill review sessions | Not available | ✅ Learn mode |
| Task tracking integration | Partially (infer from tool calls) | ✅ Native `task_write`/`task_check` |
| Subagent-based learning | Not available | ✅ Explorer/reviewer subagents |
| Multi-user app | RuntimeContext scoping | ✅ Per-user threads + state |

For most use cases, Tier 2 (processors) is sufficient. Tier 3 adds explicit review workflows, task tracking integration, and subagent-based learning for production agent apps.

## HarnessRequestContext

The learn mode injects self-learning metadata into the `HarnessRequestContext`:

```typescript
interface SelfLearningContext {
  /** Skills created or updated in this session */
  skillsModified: string[];
  /** Facts persisted in this session */
  factsPersisted: number;
  /** Whether extraction is currently active */
  extractionActive: boolean;
}
```

This is available to tools and subagents via `requestContext.get('selfLearning')`.
