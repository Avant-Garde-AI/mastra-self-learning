# Processor Integration

## How Mastra Processors Work

Mastra's processor system is the primary mechanism for intercepting and transforming data flowing through the agent loop. Two types:

**Input Processors** — run before the LLM sees the messages:
- Transform, filter, or augment the message list
- Inject context (skills, facts, identity) into the system prompt
- Can abort the request entirely

**Output Processors** — run after each step in the agentic loop:
- `processOutputStream`: receives each streaming chunk with accumulated state
- `processOutputResult`: receives the final message list after the loop completes
- Can transform, filter, or block outputs
- Have access to `ProcessorState` for cross-chunk accumulation

```typescript
interface Processor {
  readonly name: string;

  processInput?(args: {
    messages: MastraMessageV2[];
    abort: (reason?: string) => never;
    tracingContext?: TracingContext;
  }): Promise<MastraMessageV2[]> | MastraMessageV2[];

  processOutputStream?(args: {
    part: ChunkType;
    streamParts: ChunkType[];
    state: Record<string, any>;
    abort: (reason?: string) => never;
  }): ChunkType | null | undefined;

  processOutputResult?(args: {
    messages: MastraMessageV2[];
  }): Promise<MastraMessageV2[]> | MastraMessageV2[];
}
```

## SelfLearningProcessor (Output)

The core of the learning loop. This output processor observes the agent's execution without modifying it, accumulating state that drives extraction decisions.

### What It Observes

During the agent loop, `processOutputStream` accumulates:

| State Field | Source | Purpose |
|---|---|---|
| `toolCalls` | `tool-call` chunk type | Full trace of tools invoked |
| `toolResults` | `tool-result` chunk type | Outputs from tool executions |
| `turnCount` | Message boundaries | Conversation complexity signal |
| `skillUsed` | `skill_view` / `skill_list` tool calls | Whether an existing skill guided execution |
| `taskTrackingSignals` | `task_write` / `task_check` tool calls | Harness task completion signals |

### When It Fires Extraction

After the agent loop completes, `processOutputResult` evaluates the accumulated `TaskTrajectory` against the `ExtractionPolicy`:

```
                 minToolCalls >= threshold?
                         │
                    ┌────┴────┐
                    │ Yes     │ No → skip
                    ▼         │
              minTurns >= threshold?
                    │
               ┌────┴────┐
               │ Yes     │ No → skip
               ▼         │
         positiveOutcome?
               │
          ┌────┴────┐
          │ Yes     │ No → skip (if required)
          ▼         │
      cooldown elapsed?
               │
          ┌────┴────┐
          │ Yes     │ No → skip
          ▼         │
    generalizabilityCheck passes?
               │
          ┌────┴────┐
          │ Yes     │ No → skip
          ▼         │
    deduplication check (< threshold)?
               │
          ┌────┴────┐
          │ New     │ Similar → route to SkillRefiner
          ▼         │
    SkillExtractor.synthesize()
               │
          ┌────┴────┐
          │         │
    securityScan()  │
          │         │
     store skill    update existing skill
```

### Configuration

```typescript
createSelfLearningProcessor({
  storage: store,
  auxiliaryModel: 'anthropic/claude-sonnet-4-20250514',
  extraction: {
    minToolCalls: 5,          // Minimum tool calls to qualify
    minTurns: 3,              // Minimum turns to qualify
    requirePositiveOutcome: true,
    cooldownMs: 300_000,      // 5 min between extractions
    deduplicationThreshold: 0.85,
    requireApproval: false,   // If true, skills start as draft
    useGeneralizabilityCheck: true,
  },
});
```

### Streaming Behavior

The processor is fully streaming-aware. It never blocks or delays chunks — it observes and passes through. Extraction is triggered asynchronously after the stream completes, so the user never waits for skill creation.

## SkillContextProcessor (Input)

Injects layered context into the system prompt before the LLM sees the messages.

### Prompt Layer Ordering

The processor prepends context in this order (top = most stable = best for prompt caching):

```
┌────────────────────────────────────┐
│ 1. Identity Layer (SOUL)           │  ← Rarely changes
│    Personality, expertise, guards  │
├────────────────────────────────────┤
│ 2. Fact Layer (MEMORY)             │  ← Changes occasionally
│    Cross-thread persistent facts   │
├────────────────────────────────────┤
│ 3. Skill Index (L0)               │  ← Changes when skills created/updated
│    Skill names + descriptions      │
├────────────────────────────────────┤
│ 4. Observational Memory            │  ← Mastra handles this (not us)
│    Compressed conversation context │
├────────────────────────────────────┤
│ 5. Recent Messages                 │  ← Mastra handles this (not us)
│    Active conversation             │
└────────────────────────────────────┘
```

This ordering maximizes prompt cache hit rates because the stable layers at the top form a consistent prefix across requests.

### Configuration

```typescript
createSkillContextProcessor({
  storage: store,
  identity: {
    personality: 'You are a DevOps automation expert...',
    expertise: ['gcp', 'kubernetes', 'terraform'],
    formatting: { defaultLength: 'concise', codeStyle: 'documented' },
    guardrails: ['Never delete production resources without confirmation'],
  },
  factLayer: { enabled: true, nudgeInterval: 10 },
  skillRouter: {
    indexBudget: 3000,
    activeBudget: 8000,
    overflowStrategy: 'relevant',
  },
});
```

## Composition with Observational Memory

Mastra's Observational Memory (OM) uses background Observer/Reflector agents to compress old messages into dense observations. Our processors compose alongside OM without conflict:

- **SkillContextProcessor** runs as an input processor, prepending context before OM's observations
- **SelfLearningProcessor** runs as an output processor, observing after OM has done its compression
- Neither modifies the other's data — they operate on different message types

If you use both OM and self-learning, the system prompt stack becomes:

```
Identity (ours) → Facts (ours) → Skill Index (ours) → Observations (OM) → Messages (Mastra)
```

## Dynamic Processor Resolution

Both processors support Mastra's function-based dynamic resolution:

```typescript
const agent = new Agent({
  outputProcessors: ({ runtimeContext }) => {
    // Only enable learning for specific users/tenants
    const tenantConfig = runtimeContext.get('tenantConfig');
    if (tenantConfig.selfLearningEnabled) {
      return [createSelfLearningProcessor({ storage, ...tenantConfig })];
    }
    return [];
  },
});
```
