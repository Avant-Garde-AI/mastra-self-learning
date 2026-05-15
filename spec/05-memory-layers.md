# Memory Layers

## Three-Layer Memory Architecture

The self-learning system uses three memory layers that compose alongside Mastra's built-in memory (conversation history + Observational Memory):

```
┌─────────────────────────────────────────────────┐
│                Memory Stack                      │
├─────────────────────────────────────────────────┤
│ Layer 1: Identity (SOUL)                        │
│   Personality, expertise, formatting, guardrails │
│   Scope: per-agent, very stable                  │
│   Changes: rarely (drift detection alerts)       │
├─────────────────────────────────────────────────┤
│ Layer 2: Facts (MEMORY)                         │
│   Cross-thread persistent facts                  │
│   Scope: per-agent, moderately stable            │
│   Changes: as facts learned/reinforced/decay     │
├─────────────────────────────────────────────────┤
│ Layer 3: Procedural (Skills)                    │
│   Reusable task procedures                       │
│   Scope: per-agent or global                     │
│   Changes: on extraction, refinement, gardening  │
├─────────────────────────────────────────────────┤
│ Mastra OM: Observations                         │
│   Compressed conversation context (Mastra-owned) │
│   Scope: per-thread                              │
│   Changes: on every message (Observer/Reflector) │
├─────────────────────────────────────────────────┤
│ Mastra Memory: Messages                         │
│   Raw conversation history (Mastra-owned)        │
│   Scope: per-thread                              │
│   Changes: every message                         │
└─────────────────────────────────────────────────┘
```

## Layer 1: Identity (SOUL)

The Identity layer prevents personality and tone drift over extended agent usage. It mirrors Hermes Agent's `SOUL.md` concept.

### Configuration

```typescript
const identity: Identity = {
  personality: `You are a senior DevOps engineer specializing in GCP infrastructure.
You communicate in a direct, technical style. You always verify before
executing destructive operations. You prefer Terraform over ClickOps.`,

  expertise: ['gcp', 'kubernetes', 'terraform', 'ci-cd', 'monitoring'],

  formatting: {
    defaultLength: 'concise',
    codeStyle: 'documented',
    listPreference: 'bullets',
  },

  guardrails: [
    'Never delete production resources without explicit user confirmation',
    'Always suggest a dry-run before applying infrastructure changes',
    'Escalate billing-impacting changes > $100/month',
  ],
};
```

### Drift Detection

Over time, the agent may develop habits that diverge from the seed identity. The `IdentityLayer` periodically compares the agent's current behavioral patterns against the seed, computing a drift score (0-1).

If drift exceeds `driftThreshold` (default 0.3), the system can:
- Alert the developer
- Reset specific calibration values to seed
- Log drift events for analysis

### Calibration vs. Drift

Not all change is drift. The identity layer distinguishes:
- **Calibration**: Learning the user's preferences within the identity bounds (e.g., user prefers Terraform modules over monolithic configs)
- **Drift**: Departing from the identity's core values (e.g., stopping verification before destructive operations)

Calibration is stored as updates; drift triggers alerts.

## Layer 2: Facts (MEMORY)

Cross-thread persistent facts that the agent learns about the user, their environment, projects, and preferences.

### Fact Categories

| Category | Example | Typical Lifespan |
|---|---|---|
| `preference` | "User prefers YAML over JSON for config files" | Long (until contradicted) |
| `context` | "Running GKE 1.28 in us-central1" | Medium (may change) |
| `project` | "Project Atlas is the Q3 migration initiative" | Medium |
| `credential` | "GCP project ID is atlas-prod-2026" | Long |
| `constraint` | "Budget ceiling is $2000/month for Cloud Run" | Medium |
| `relationship` | "Spence handles frontend, Yale handles data" | Long |

### Confidence and Decay

Each fact has a confidence score (0-1) that decays over time unless reinforced:

```
confidence(t) = confidence(t₀) × (1 - decayRate)^weeks_since_last_reinforcement
```

Default `decayRate` is 0.05 (5% per week). A fact stated in conversation reinforces to full confidence. Facts below a threshold (e.g., 0.1) are archived during gardening.

### Nudge Mechanism

Every `nudgeInterval` turns (default 10), the SkillContextProcessor appends a gentle system message:

```
[Self-Learning Note: If the user has shared any new facts about their
environment, preferences, or projects, consider persisting them
via the memory_persist tool.]
```

This nudges the agent to persist facts without requiring explicit user instructions.

### Fact Layer vs. Observational Memory

| Aspect | Fact Layer (ours) | Observational Memory (Mastra) |
|---|---|---|
| Scope | Cross-thread | Per-thread |
| Content | Explicit facts | Compressed observations |
| Persistence | Until decayed/archived | Thread lifetime |
| Update mechanism | Agent tool calls | Background Observer/Reflector |
| Format | Structured (category, confidence) | Unstructured observations |

They complement each other: OM handles "what happened in this conversation," while the Fact Layer handles "what do I know about this user/environment across all conversations."

## Layer 3: Procedural (Skills)

Covered in detail in [03-skill-system.md](./03-skill-system.md). Skills are the procedural memory layer — reusable step-by-step procedures extracted from successful task completions.

## Composition Rules

### Token Budget Allocation

In a context window of ~200K tokens, the self-learning layers target:

| Layer | Budget | Rationale |
|---|---|---|
| Identity | ~500 tokens | Static block, rarely changes |
| Facts | ~1000 tokens | Most relevant facts for this agent |
| Skill Index (L0) | ~3000 tokens | Up to ~60 skills at ~50 tokens each |
| Active Skills (L1) | ~8000 tokens | Up to 3 fully-loaded skills |
| **Total (ours)** | **~12,500 tokens** | ~6% of a 200K context window |

The remaining context is for OM, messages, tool schemas, and the agent's instructions.

### Ordering for Cache Efficiency

System prompt components are ordered from most-stable to least-stable, maximizing prompt cache hit rates with providers that support prefix caching:

1. Agent instructions (developer-defined, static)
2. Identity block (changes ~never)
3. Fact block (changes occasionally)
4. Skill index (changes on skill CRUD)
5. OM observations (changes per-thread)
6. Recent messages (changes every turn)
