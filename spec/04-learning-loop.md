# Learning Loop

## The Closed Learning Loop

The core value proposition: agents that get better at their job over time. The loop has four phases:

```
  ┌─────────┐     ┌────────────┐     ┌───────────┐     ┌────────────┐
  │ DETECT  │────▶│  EXTRACT   │────▶│ RETRIEVE  │────▶│  REFINE    │
  │         │     │            │     │           │     │            │
  │ Output  │     │ Synthesize │     │ Match &   │     │ Diff-based │
  │ proc    │     │ SKILL.md   │     │ inject    │     │ versioning │
  │ observes│     │ from task  │     │ at task   │     │ after use  │
  │ task    │     │ trajectory │     │ start     │     │            │
  └─────────┘     └────────────┘     └───────────┘     └────────────┘
       │                                                      │
       └──────────────────────────────────────────────────────┘
                        feedback loop
```

## Phase 1: Detection

The `SelfLearningProcessor` output processor observes the agent loop in real time. It accumulates a `TaskTrajectory`:

```typescript
interface TaskTrajectory {
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    output?: unknown;
    timestamp: string;
  }>;
  turnCount: number;
  positiveOutcome: boolean;
  threadId: string;
  agentId: string;
  conversationSummary?: string;
}
```

Detection is passive — it never modifies the agent's output.

### Positive Outcome Detection

The processor infers positive outcome from several signals:
1. The user explicitly thanks the agent or confirms success
2. The agent's final message contains completion language
3. If Harness task tracking is active: all tasks marked complete via `task_check`
4. No error signals in the last N turns

This is a heuristic, not a guarantee. The `requirePositiveOutcome` policy flag controls whether extraction requires this signal.

## Phase 2: Extraction

When the agent loop completes and the trajectory passes all `ExtractionPolicy` checks, the `SkillExtractor` fires asynchronously:

### Generalizability Check

An auxiliary LLM call that evaluates whether the task trajectory represents a reusable procedure:

```
Given this task trajectory:
- The agent configured a Cloud Run deployment with traffic splitting
- Tools used: gcloud_run_deploy, gcloud_artifacts_list, gcloud_run_describe
- 7 tool calls, 5 turns

Is this task generalizable into a reusable procedure that could help with similar future tasks?

Consider:
- Is this instance-specific (one-off data entry) or procedural (repeatable workflow)?
- Would the procedure transfer to different inputs/contexts?
- Is the procedure complex enough to be worth documenting?
```

### Deduplication

Before creating a new skill, the extractor checks for existing similar skills:

1. FTS search on key terms from the trajectory
2. (Phase 4) Semantic similarity against existing skill embeddings
3. If similarity exceeds `deduplicationThreshold` (default 0.85):
   - Route to the `SkillRefiner` to update the existing skill instead
   - The existing skill gets a version bump with the new learnings merged

### Synthesis

The auxiliary LLM synthesizes a SKILL.md from the trajectory:

```
You are a skill documentation expert. Given the following task trajectory,
create a reusable SKILL.md document.

Rules:
1. Strip all instance-specific details (project IDs, names, dates)
2. Replace with generic placeholders (PROJECT_ID, SERVICE_NAME, etc.)
3. Include a "When to Use" section for future retrieval matching
4. Document any pitfalls observed during execution
5. Add verification steps
6. Use the agentskills.io frontmatter format

Task trajectory:
[... serialized TaskTrajectory ...]
```

### Security Scan

Before storing, the synthesized skill passes through the security scanner:

1. **Regex patterns**: Checks for destructive commands, credential exposure, prompt injection
2. **(Phase 2) LLM scan**: Semantic analysis for subtle injection or unsafe patterns

If the scan fails, the skill is stored as `draft` status, requiring human review.

## Phase 3: Retrieval

When the agent starts a new task, the `SkillContextProcessor` makes skills available:

1. **L0 Index**: All skill names + descriptions injected into the system prompt
2. **Agent recognizes a relevant skill** from the index
3. **Agent calls `skill_view`** to load the full L1 content
4. **Agent follows the procedure**, potentially loading L2 sections for details

The agent also has `skill_search` for intent-based matching when the L0 index isn't sufficient.

## Phase 4: Refinement

After using a skill, the `SelfLearningProcessor` compares the actual execution against the skill's procedure, generating `RefinementSignals`:

```typescript
interface RefinementSignals {
  deviation: boolean;      // Agent deviated from procedure
  newPitfall: boolean;     // New failure mode discovered
  unnecessaryStep: boolean; // Agent skipped a step as unnecessary
  userCorrection: boolean;  // User corrected the agent mid-task
  failure: boolean;         // Skill-guided execution failed
}
```

If any signal fires, the `SkillRefiner` generates an updated version:

### Version Bumping

| Signal | Version Bump | Example |
|---|---|---|
| Wording improvement | Patch (1.0.0 → 1.0.1) | Clarified a step description |
| New pitfall added | Patch (1.0.0 → 1.0.1) | Added "Cold start latency" warning |
| Step added/removed | Minor (1.0.0 → 1.1.0) | Added a verification step |
| Prerequisites changed | Minor (1.0.0 → 1.1.0) | New IAM role required |
| Fundamental procedure change | Major (1.0.0 → 2.0.0) | Switched from gcloud to Terraform |

### Diff Storage

Every version stores a unified diff from its predecessor. This enables:
- Human review of what changed
- Rollback to previous versions
- Automated quality trending (do refinements improve success rates?)

## Extraction Policy Reference

```typescript
{
  // Minimum complexity thresholds
  minToolCalls: 5,              // Tasks with fewer tools are too simple
  minTurns: 3,                  // Single-turn tasks aren't procedural

  // Outcome requirements
  requirePositiveOutcome: true, // Only learn from successes

  // Rate limiting
  cooldownMs: 300_000,          // 5 min between extractions

  // Quality gates
  deduplicationThreshold: 0.85, // Cosine similarity for dedup
  useGeneralizabilityCheck: true, // LLM-based generalizability filter
  requireApproval: false,       // If true, skills start as draft
}
```

## Async Extraction Architecture

Extraction runs asynchronously after the agent stream completes. This means:

1. The user never waits for skill creation
2. Extraction failures don't impact the user-facing response
3. The auxiliary LLM call is fire-and-forget from the agent's perspective

For production deployments, extraction can be routed to a background job queue (e.g., via Mastra workflows) rather than running inline.
