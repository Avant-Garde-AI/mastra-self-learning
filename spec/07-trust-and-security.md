# Trust & Security

## Trust Tiers

Every skill has a trust tier that determines how it's treated by the system:

| Tier | Source | Review Required | Auto-load in L0 | Can Execute Destructive |
|---|---|---|---|---|
| `builtin` | Developer-authored, shipped with the app | No | Yes | Yes |
| `official` | Installed from skills.sh registry | Scan only | Yes | Configurable |
| `community` | Shared by other users/agents | Scan + review | Configurable | No |
| `agent-created` | Extracted by the learning loop | Scan | Yes (after approval if required) | No |

### Trust Promotion

Skills can be promoted up the trust ladder:

```
agent-created → community → official → builtin
```

Promotion requires:
1. **agent-created → community**: 5+ successful uses, 0 failures, passes security scan
2. **community → official**: Human review + approval
3. **official → builtin**: Developer adds to application code

### Trust Demotion

Skills are demoted on:
- Security scan failure on re-scan
- Success rate drops below 50% over 10+ uses
- Manual demotion by developer

## Security Scanner

### Phase 1: Regex Pattern Matching

The scanner checks for dangerous patterns in skill content:

| Pattern Category | Examples | Severity |
|---|---|---|
| Destructive commands | `rm -rf /`, `DROP TABLE`, `kubectl delete --all` | Critical |
| Data exfiltration | `curl ... \| sh`, `wget` piping to eval | High |
| Credential exposure | Hardcoded API keys, passwords, tokens | High |
| Prompt injection | "Ignore previous instructions", role overrides | High |
| Guardrail bypass | "You are now freed/unfiltered/jailbroken" | Critical |

### Phase 2: LLM-Based Semantic Analysis

A secondary scan using the auxiliary model to catch patterns that regex misses:

- Obfuscated destructive commands (base64-encoded, variable indirection)
- Social engineering patterns disguised as procedures
- Privilege escalation sequences
- Subtle data exfiltration via DNS or encoding

### Scan Results

```typescript
interface ScanResult {
  safe: boolean;
  findings: Array<{
    type: 'prompt-injection' | 'data-exfiltration' | 'destructive-command'
          | 'credential-exposure' | 'guardrail-bypass';
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    line?: number;
  }>;
}
```

### Scan Triggers

Scans run:
1. On skill creation (extractor output)
2. On skill refinement (refiner output)
3. On skill import (CLI import command)
4. During gardening (periodic re-scan of all skills)

## Approval Workflows

When `requireApproval` is enabled in the ExtractionPolicy:

1. Extracted skills are stored with `status: 'draft'`
2. Draft skills appear in the Studio UI for review
3. A human reviews the content and approves/rejects
4. Approved skills are promoted to `status: 'active'`

For Harness-based apps, the learn mode provides a conversational approval flow:

```
Agent: I extracted a new skill "gcp-cloud-run-deploy" from your last session.
       Here's what it covers: [summary]
       Should I activate it, modify it, or discard it?

User: Activate it, but add a note about cold start latency.

Agent: Done. Skill "gcp-cloud-run-deploy" is now active with the cold start
       pitfall documented.
```

## Content Isolation

Skills are scoped to prevent cross-contamination:

- **Agent-scoped skills**: Visible only to the creating agent (default for agent-created)
- **Global skills**: Visible to all agents in the application
- **User-scoped skills**: Visible only in threads owned by a specific user (requires RuntimeContext)

Scope is determined by the `agentId` field on the skill record:
- `agentId = 'ops-agent'` → only `ops-agent` sees it
- `agentId = null` → all agents see it

## Rate Limiting

The extraction system has built-in rate limiting:
- `cooldownMs`: Minimum time between extractions (default 5 min)
- Maximum 10 extractions per hour per agent (hard limit)
- Maximum 50 refinements per day per agent (hard limit)

These prevent runaway extraction in high-volume agent deployments.
