# Evaluation & Metrics

## Eval Integration

This package provides three evaluation scorers designed for Mastra's eval system (Datasets + Experiments). They measure whether the learning loop is actually making the agent better.

## Scorers

### Skill Utilization

**Measures**: Does the agent use available skills rather than reasoning from scratch?

```
Score = (tasks where relevant skill existed AND was used) / (tasks where relevant skill existed)
```

Range: 0 (never uses skills) to 1 (always uses available skills).

Low score indicates:
- Skill names/descriptions don't match agent's task recognition
- L0 index is too large (agent can't find relevant skills)
- Skills are poorly written (agent doesn't trust them)

### Skill Quality Trend

**Measures**: Do skill refinements improve success rates over time?

```
Score = mean(success_rate(version_N) - success_rate(version_N-1)) across all skills with 2+ versions
```

Positive: Refinements are improving skills.
Negative: Refinements are degrading skills (possible overfitting to edge cases).
Near zero: Skills are stable but not improving.

### Identity Drift

**Measures**: How much has the agent's behavior diverged from its seed identity?

```
Score = cosine_similarity(embed(current_identity), embed(seed_identity))
```

Range: 0 (completely different) to 1 (identical to seed).

Low score indicates:
- The agent has drifted from its intended personality
- Calibration has overridden core identity values
- The identity definition may need updating

## Running Evaluations

```typescript
import { Agent } from '@mastra/core';
import {
  skillUtilizationScorer,
  skillQualityScorer,
  identityDriftScorer,
} from '@avant-garde/mastra-self-learning/evals';

// Create a dataset of test tasks
const dataset = await mastra.datasets.create({
  name: 'self-learning-eval',
  schema: {
    task: { type: 'string' },
    expectedSkill: { type: 'string' },
  },
  items: [
    { task: 'Deploy a Cloud Run service', expectedSkill: 'gcp-cloud-run-deploy' },
    { task: 'Rollback the Kubernetes deployment', expectedSkill: 'k8s-rollback' },
  ],
});

// Run experiment
const experiment = await dataset.runExperiment({
  agent: myAgent,
  scorers: [skillUtilizationScorer, skillQualityScorer, identityDriftScorer],
});

console.log(experiment.results);
```

## Success Metrics

The TRD defines these success criteria for the learning system:

| Metric | Target | Measurement |
|---|---|---|
| Skill reuse rate | > 40% of complex tasks guided by skills after 30 days | `skill_utilization` scorer |
| Skill quality | > 75% success rate across all active skills | Aggregated `skill_usage` data |
| Extraction precision | > 60% of extracted skills used at least twice | Storage query |
| Refinement effectiveness | Positive quality trend over 3+ versions | `skill_quality_trend` scorer |
| Identity stability | Drift score < 0.3 | `identity_drift` scorer |
| Fact persistence | > 80% of persisted facts still above confidence threshold after 30 days | Decay analysis |
| User satisfaction | No degradation in task completion time | External measurement |

## Observability

All learning loop events are traceable via Mastra's OpenTelemetry integration:

- `self-learning.extraction.triggered` — extraction evaluated
- `self-learning.extraction.completed` — skill created
- `self-learning.refinement.triggered` — refinement evaluated
- `self-learning.refinement.completed` — skill version created
- `self-learning.skill.used` — skill loaded by agent
- `self-learning.fact.persisted` — fact stored
- `self-learning.gardening.completed` — gardening workflow finished

These integrate with Langfuse, Braintrust, Arize, LangSmith, or any OTel-compatible backend.
