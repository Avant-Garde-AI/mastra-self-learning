# Phase 5 — Refinement + Final Integration

## Goal

After this phase, when an agent uses an existing skill and signals a problem (`outcome: 'failure'` or a user correction mid-task), the `SkillRefiner` produces a refined version of the skill, stores it in `skill_versions` with a unified diff, and bumps the skill's version. Combined with Phases 1–4, the package now delivers the **full closed loop**: detect → extract → retrieve → refine. A single end-to-end integration test validates the entire MVP user story.

This phase is intentionally minimal in scope. The refiner is not the *core value* of the MVP — extraction is. Refinement is the proof that the loop *closes*, so we ship a deliberately small version: signal detection on two clear triggers, patch-level version bumps, single-shot LLM refinement, no quality-trend evaluation.

## Prerequisites

- Phases 1–4 fully complete.
- Vision criteria #1–9, #11, #12 already pass.
- Auxiliary LLM invocation pattern (Phase 3.0 decision) reused here.

## Task Breakdown

### 5.1 — Detect refinement signals in the output processor

**File:** `packages/core/src/processors/self-learning-processor.ts` (modify existing)

The processor's `processOutputStream` already accumulates `state.skillUsed` when `skill_view` is called (Phase 3.1). We now need additional state to detect refinement triggers.

**New state fields:**

```ts
interface SelfLearningProcessorState {
  // ... existing fields from Phase 3.1
  skillFeedbackCalls: Array<{
    name: string;
    outcome: 'success' | 'failure' | 'partial' | 'abandoned';
    feedback?: string;
  }>;
  userCorrectionDetected: boolean;
}
```

**Detection logic in `processOutputStream`:**

```ts
// New: detect skill_feedback tool calls
if (part.type === 'tool-call' && part.toolName === 'skill_feedback') {
  state.skillFeedbackCalls = state.skillFeedbackCalls ?? [];
  state.skillFeedbackCalls.push({
    name: part.args.name,
    outcome: part.args.outcome,
    feedback: part.args.feedback,
  });
}
```

**User correction detection** is harder to do from chunks alone — it's a property of the conversation, not the tool stream. Implement in `processOutputResult` instead:

```ts
function detectUserCorrection(messages): boolean {
  // Look for user messages with correction signals after the assistant
  // started a skill-guided task. Cheap heuristic: regex on the last user message.
  const lastUser = messages.findLast(m => m.role === 'user')?.content ?? '';
  return /\b(no,|wait,|actually,|that's wrong|don't|stop|incorrect)\b/i.test(lastUser);
}
```

This is a heuristic. False positives are harmless (we just don't refine). False negatives mean we miss refinement opportunities — acceptable for MVP.

---

### 5.2 — Wire refinement evaluation in `processOutputResult`

**File:** Same as 5.1.

After the existing extraction call:

```ts
async processOutputResult({ messages, runtimeContext, state }) {
  const trajectory = buildTrajectory(state, messages, runtimeContext);

  // Existing: extraction
  void runExtraction(trajectory, extractor).catch(/* ... */);

  // New: refinement
  if (state.skillUsed) {
    const signals = buildRefinementSignals(state, messages);
    if (signalsActive(signals)) {
      void runRefinement(state.skillUsed.name, trajectory, signals, refiner)
        .catch(err => console.error('[self-learning] refinement error:', err));
    }
  }

  return messages;
}
```

**`buildRefinementSignals(state, messages)`:**

```ts
function buildRefinementSignals(state, messages): RefinementSignals {
  const feedback = state.skillFeedbackCalls?.[0];
  return {
    deviation: false, // MVP: detect only on explicit signals, no procedure-diff in MVP
    newPitfall: false, // MVP: defer
    unnecessaryStep: false, // MVP: defer
    userCorrection: detectUserCorrection(messages),
    failure: feedback?.outcome === 'failure',
  };
}

function signalsActive(signals: RefinementSignals): boolean {
  return signals.failure || signals.userCorrection;
}
```

**MVP scope reduction:** the spec lists 5 signals. We implement only `failure` and `userCorrection` in the MVP. The other three (`deviation`, `newPitfall`, `unnecessaryStep`) require diffing the actual execution against the skill's documented procedure — that's significant work, and the MVP doesn't need it to prove "refinement happens." Deferred to v0.2.0 with clear seam.

---

### 5.3 — Implement `SkillRefiner.evaluate`

**File:** `packages/core/src/skills/refiner.ts`

```ts
async evaluate(
  skill: SkillRecord,
  trajectory: TaskTrajectory,
  signals: RefinementSignals,
): Promise<{ shouldRefine: boolean; reason?: string; proposedVersion?: string }> {
  if (!signalsActive(signals)) {
    return { shouldRefine: false, reason: 'no active signals' };
  }

  // Rate limiting: per-skill cooldown (don't refine the same skill on every failure)
  const recentVersions = await this.storage.listVersions(skill.id);
  const lastRefinement = recentVersions[0]?.createdAt;
  if (lastRefinement && Date.now() - new Date(lastRefinement).getTime() < 60_000) {
    return { shouldRefine: false, reason: 'recent refinement cooldown' };
  }

  // Version bump determination: MVP uses patch-level only.
  // Major/minor bumps require structural diffing (deferred).
  const proposedVersion = bumpPatch(skill.version);
  const reason = signals.failure
    ? 'execution failure signal'
    : 'user correction signal';
  return { shouldRefine: true, reason, proposedVersion };
}
```

---

### 5.4 — Implement `SkillRefiner.refine`

**File:** Same.

```ts
async refine(
  skill: SkillRecord,
  trajectory: TaskTrajectory,
  signals: RefinementSignals,
): Promise<SkillRecord> {
  const decision = await this.evaluate(skill, trajectory, signals);
  if (!decision.shouldRefine) {
    throw new Error(`refine called but evaluate said no: ${decision.reason}`);
  }

  // Build refinement prompt
  const prompt = buildRefinementPrompt(skill, trajectory, signals);
  const rawNewContent = await this.aux.generate(prompt, {
    maxTokens: 2500,
    temperature: 0.2,
  });
  const newContent = normalizeSynthesisOutput(rawNewContent); // reuse Phase 3.4 helper

  // Validate
  try {
    parseSkillDocument(newContent);
  } catch (err) {
    throw new Error(`refinement produced unparseable content: ${(err as Error).message}`);
  }

  // Security scan
  const scan = scanSkillContent(newContent);
  if (!scan.safe) {
    // Don't propagate insecure refinements. Log, abort.
    console.warn('[self-learning] refinement failed security scan, skipping', scan.findings);
    throw new Error('refinement failed security scan');
  }

  // Compute diff
  const diff = unifiedDiff(skill.content, newContent);

  // Persist new version + update parent skill atomically
  // (Two writes; storage doesn't yet expose a transaction wrapper. For MVP,
  //  use the underlying pg client directly via storage.db.tx(...). Acceptable
  //  bit of internal access; document in MASTRA_API_NOTES.)
  const newVersion = decision.proposedVersion!;
  const updatedSkill = await this.storage.updateSkill(skill.id, {
    content: newContent,
    version: newVersion,
    frontmatter: parseSkillDocument(newContent).frontmatter,
  });
  await this.storage.createVersion({
    skillId: skill.id,
    version: newVersion,
    content: newContent,
    diff,
    reason: signals.failure ? 'execution failure' : 'user correction',
  });

  return updatedSkill;
}
```

**`buildRefinementPrompt`:**

```
You are refining an existing skill based on new usage feedback.

CURRENT SKILL:

{skill.content}

NEW USAGE OBSERVATIONS:
- Outcome: {signals.failure ? 'FAILURE' : 'USER CORRECTION'}
- Tool calls during attempt: {summarize tool calls}
- {if signals.failure: include any feedback string}
- {if signals.userCorrection: include the last user message}

YOUR JOB:

Produce a refined SKILL.md that addresses the observed failure mode. You may:
- Add a new pitfall to the Pitfalls section
- Clarify or correct a step in the Procedure
- Add a verification step
- Adjust prerequisites

You may NOT:
- Change the skill's `name` or fundamental purpose
- Remove existing pitfalls or verifications (these capture hard-won knowledge)
- Add instance-specific details (project IDs, hostnames, etc.) — keep placeholders generic

Update the frontmatter `version` to {decision.proposedVersion}.
Update the frontmatter `updated` to the current ISO timestamp.

Output ONLY the refined SKILL.md content. Start with `---` (the frontmatter delimiter).
```

`temperature: 0.2` keeps refinements conservative.

---

### 5.5 — `runRefinement` wrapper for the processor

**File:** `packages/core/src/processors/self-learning-processor.ts`

```ts
async function runRefinement(
  skillName: string,
  trajectory: TaskTrajectory,
  signals: RefinementSignals,
  refiner: SkillRefiner,
  storage: SkillStorageExtension,
) {
  const skill = await storage.getSkillByName(skillName, trajectory.agentId);
  if (!skill) return; // skill deleted between use and processor result; no-op
  const decision = await refiner.evaluate(skill, trajectory, signals);
  if (!decision.shouldRefine) return;
  await refiner.refine(skill, trajectory, signals);
}
```

---

### 5.6 — End-to-end MVP integration test

**File:** `packages/core/test/e2e-mvp.test.ts` (new top-level test file)

This is the single test that walks the entire MVP user story. **If this passes, we ship.**

**Setup:**
- Fresh Testcontainers Postgres.
- `ensureSchema()` called.
- Mock LLM with a scripted multi-turn conversation.
- Real Mastra `Agent` with both processors and the tool set.

**Test plan:**

```
1. Pre-condition: 0 skills in storage.

2. ACT 1 — Initial complex task (extraction happens):
   - User: "Deploy our service to Cloud Run with canary traffic splitting"
   - Mock LLM: 6 tool calls simulating a deployment workflow
     (gcloud_run_deploy, gcloud_run_describe, gcloud_run_services_update_traffic, etc.)
   - 4 turns
   - User: "perfect, thanks"

3. Wait for fire-and-forget extraction to settle.

4. Assert:
   - 1 skill exists in storage
   - trust_tier = 'agent-created', status = 'active'
   - frontmatter.tags contains 'gcp' or 'cloud-run'
   - skill content includes "## Procedure" and "## Verification"

5. ACT 2 — New thread, same agent (retrieval happens):
   - New thread ID
   - User: "Need to deploy the API service to Cloud Run safely"
   - Capture: system message sent to LLM

6. Assert:
   - System message contains "## Available Skills"
   - The previously extracted skill name appears in the index

7. ACT 3 — Agent follows the skill:
   - Mock LLM calls skill_view({ name: <extracted> })
   - Mock LLM produces matching tool calls
   - At end: skill_feedback({ name: <extracted>, outcome: 'success' })
   - User: "great, works"

8. Assert:
   - skills.success_count for that skill = 1
   - 1 row in skill_usage with outcome = 'success'

9. ACT 4 — Refinement on failure:
   - New thread
   - User: "Same as before, deploy to Cloud Run"
   - Mock LLM calls skill_view, follows procedure, hits a snag
   - Mock LLM calls skill_feedback({ outcome: 'failure', feedback: 'IAM propagation delay broke step 3' })
   - User: "no, that won't work because we just granted permissions and they haven't propagated"

10. Wait for fire-and-forget refinement.

11. Assert:
    - 1 row in skill_versions for the skill (version 1.0.1)
    - skill_versions[0].diff is non-empty
    - The skill's `content` now contains "IAM propagation" somewhere (refiner added the pitfall)
    - skill.version = "1.0.1"
    - skill.fail_count = 1
```

This test is the **MVP exit gate**. It must pass deterministically (via mocked aux LLM responses) on every CI run before tagging v0.1.0.

---

### 5.7 — Verify all 13 vision criteria

**File:** `docs/mvp/vision-criteria-report.md` (new — generated after 5.6 passes)

Walk through each criterion in `00-vision.md` and produce a `[PASS] / [FAIL]` line with a reference to the test that proves it. Generate as part of the MVP release process.

```
[1]  Storage schema idempotency — PASS (storage-extension.test.ts:42)
[2]  Tool surface — PASS (skill-tools.test.ts:18)
...
[13] End-to-end integration test — PASS (e2e-mvp.test.ts)
```

If any criterion is `[FAIL]`, the MVP is not done.

---

### 5.8 — Document known limitations (v0.1.0 LIMITATIONS.md)

**File:** `LIMITATIONS.md` at repo root.

A short, honest document listing what v0.1.0 does and does not do. Reference the non-goals section of `00-vision.md`. The intent is to set expectations for users discovering the package: "This is alpha. The closed loop works for one user story. Here's what's coming."

Sections:
- What works today (the user story from 00-vision.md)
- What's not implemented (the non-goals list, with planned-version targets)
- Known issues (FTS dedup is coarser than semantic; placeholder substitution depends on LLM compliance; etc.)
- How to provide feedback

---

## Critical Integration Points

1. **Storage transaction wrapping in `refine`.** Updating the skill *and* writing the version row should be atomic. If `SkillStorageExtension` doesn't expose a `transaction(fn)` method by this phase, add one as a small refactor (use `pg`'s `BEGIN/COMMIT`).

2. **Refinement does not re-trigger extraction.** Be sure that when refinement updates a skill, the next `processOutputResult` of the *same* agent loop (if any further turns happen) does not see this as a fresh extraction signal. The extractor's cooldown handles this naturally.

3. **Output processor races.** Extraction and refinement both run as fire-and-forget. If extraction creates skill X *and* refinement updates skill X in the same `processOutputResult` (rare but possible if the agent both used and exceeded a similar skill), version ordering matters. For MVP, accept the rare race; document it. Post-MVP: per-skill mutex.

## Exit Criteria

- [ ] `pnpm typecheck` clean.
- [ ] Refiner unit tests pass.
- [ ] All 13 vision criteria pass (see 5.7's report).
- [ ] End-to-end integration test (5.6) passes deterministically in CI.
- [ ] `LIMITATIONS.md` written.
- [ ] `pnpm build` produces a publishable `dist/` package.
- [ ] A consuming project can `pnpm link` to this package and Tier 2 setup works against a sandbox database.

## Estimated Scope

| Sub-task | Files touched | Complexity |
|---|---|---|
| 5.1 Signal detection in stream | `self-learning-processor.ts` | Low |
| 5.2 Refinement evaluation hook | `self-learning-processor.ts` | Low |
| 5.3 Refiner.evaluate | `refiner.ts` | Medium |
| 5.4 Refiner.refine | `refiner.ts`, new: `refinement-prompt.ts` | High |
| 5.5 Processor wrapper | `self-learning-processor.ts` | Low |
| 5.6 E2E integration test | New: `test/e2e-mvp.test.ts` | High — this is THE test |
| 5.7 Vision criteria report | New: `vision-criteria-report.md` | Low |
| 5.8 Limitations doc | New: `LIMITATIONS.md` | Low |

**Total:** 8 files written/modified. Estimated 1.5 weeks. Most of the time is in 5.6 (the E2E test that proves everything works together).

---

## v0.1.0 Release

Once 5.6 is green and 5.7's report shows 13 PASSes:

1. `pnpm changeset` to describe `@avant-garde/mastra-self-learning@0.1.0`.
2. Tag as `v0.1.0`.
3. Publish to npm.
4. Write a one-pager launch post referencing the user story from `00-vision.md`.

The MVP ships.
