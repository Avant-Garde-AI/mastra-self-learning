# Implementation Plan

This document is the primary reference for a coding agent implementing the package. It describes a phased build order, key dependencies per phase, critical integration points with Mastra internals, testing strategy, and known risks.

## Phase Overview

| Phase | Scope | Estimated Effort | Dependencies |
|---|---|---|---|
| **Phase 1** | Skill storage, tools, parser, scanner, router, FTS search | 2-3 weeks | `@mastra/core` SkillsStorage API |
| **Phase 2** | Learning loop: output processor, extractor, refiner | 2-3 weeks | Phase 1 + auxiliary LLM integration |
| **Phase 3** | Memory layers, input processor, Harness integration | 2-3 weeks | Phase 2 + `@mastra/memory` OM API |
| **Phase 4** | Gardening workflows, semantic search, CLI | 1-2 weeks | Phase 3 + embedding model |
| **Phase 5** | Eval scorers, observability, documentation polish | 1-2 weeks | Phase 4 |

Total: ~8-14 weeks for a single developer, or ~4-6 weeks with parallel tracks.

---

## Phase 1: Foundation — Storage, Tools, Parser

### Goal
A working skill system where agents can create, store, search, and retrieve skills via tools. No automatic extraction yet — skills are created manually or imported.

### Tasks

#### 1.1: Inspect Mastra's SkillsStorage API
- **Critical**: Read `@mastra/core` source to understand the exact `SkillsStorage` domain interface
- Key questions:
  - What tables/columns does `SkillsStorage` already create?
  - What CRUD methods are available?
  - How does the BlobStore integration work?
  - What's the versioning model?
  - How do we extend the domain with custom columns (usage counts, trust tiers)?
- Output: API compatibility notes in a `MASTRA_API_NOTES.md` file

#### 1.2: Implement `SkillStorageExtension`
- Extend Mastra's `SkillsStorage` domain with learning-loop metadata
- `ensureSchema()`: Create additional tables (`skill_versions`, `skill_usage`) or add columns to existing
- Implement all CRUD methods that delegate to Mastra's storage + add our metadata
- Test against Postgres (primary) and LibSQL (secondary)
- **Files**: `src/skills/storage-extension.ts`

#### 1.3: Implement `parseSkillDocument` / `serializeSkillDocument`
- Already partially implemented — validate against edge cases
- Test with real Hermes Agent skill files
- Handle missing frontmatter gracefully
- **Files**: `src/skills/parser.ts` (already exists, needs tests)

#### 1.4: Implement `scanSkillContent`
- Regex patterns already implemented
- Add test coverage for all pattern categories
- Test false positive rates against real skill content
- **Files**: `src/skills/scanner.ts` (already exists, needs tests)

#### 1.5: Implement `SkillRouter`
- `buildIndex()`: List skills, format as L0 index, enforce token budget
- Token estimation: use a simple heuristic (chars / 4) or integrate a tokenizer
- Overflow strategies: implement `recent`, `frequent`, `relevant` (relevant deferred to Phase 4)
- `loadSkill()`: Fetch by name, optionally extract section (L2)
- **Files**: `src/skills/router.ts`

#### 1.6: Implement `SkillSearch` (FTS only)
- Full-text search against skill name, description, tags, body
- Implementation depends on storage backend:
  - Postgres: `tsvector` / `tsquery`
  - LibSQL: FTS5
  - MongoDB: text index
- **Files**: `src/skills/search.ts`

#### 1.7: Implement `createSelfLearningTools`
- Create all 8 tools via Mastra's `createTool()`:
  - `skill_list`, `skill_view`, `skill_search`, `skill_create`, `skill_update`, `skill_feedback`
  - `memory_persist`, `memory_recall` (stubs in Phase 1, implemented in Phase 3)
- Each tool needs:
  - Descriptive `description` for LLM tool selection
  - Zod `inputSchema` and `outputSchema`
  - `execute` function calling storage extension
- **Files**: `src/tools/skill-tools.ts`

#### 1.8: Write tests
- Unit tests for parser, scanner, router
- Integration tests for storage extension (against test Postgres)
- Tool contract tests (input/output schema validation)

### Phase 1 Exit Criteria
- [ ] Agent can call `skill_list` and see stored skills
- [ ] Agent can call `skill_create` with SKILL.md content
- [ ] Agent can call `skill_view` to load L1/L2 content
- [ ] Agent can call `skill_search` to find skills by keyword
- [ ] Security scanner catches all 6 pattern categories
- [ ] Works with Postgres storage backend

---

## Phase 2: Learning Loop — Extraction & Refinement

### Goal
The agent automatically creates skills from complex task completions and refines existing skills based on usage.

### Tasks

#### 2.1: Implement `SelfLearningProcessor`
- **Critical**: Must implement the `Processor` interface from `@mastra/core`
  ```typescript
  interface Processor {
    name: string;
    processOutputStream?(args: { part, streamParts, state, abort }): ChunkType | null;
    processOutputResult?(args: { messages }): Promise<MastraMessageV2[]>;
  }
  ```
- `processOutputStream`: Accumulate tool call data in `state`
  - Track `state.toolCalls`, `state.turnCount`, `state.skillUsed`
  - Never block or transform — observe and pass through
- `processOutputResult`: Evaluate accumulated state for extraction
  - Build `TaskTrajectory` from accumulated state
  - Pass to `SkillExtractor.evaluate()`
  - If existing skill was used, pass to `SkillRefiner.evaluate()`
- **Files**: `src/processors/self-learning-processor.ts`

#### 2.2: Implement `SkillExtractor`
- `evaluate()`: Check trajectory against ExtractionPolicy thresholds
- Generalizability check: Auxiliary LLM call to assess if task is reusable
  - Need to figure out how to invoke an LLM from inside the package
  - Options: accept a `generateText` function, or use `@mastra/core`'s model resolution
- Deduplication check: FTS search against existing skills
- `synthesize()`: Generate SKILL.md from trajectory via auxiliary LLM
  - Prompt engineering for skill synthesis (see TRD Appendix)
  - Strip instance-specific details, add placeholders
  - Generate all standard sections
- Security scan synthesized content
- Store via `SkillStorageExtension`
- **Files**: `src/skills/extractor.ts`

#### 2.3: Implement `SkillRefiner`
- `evaluate()`: Detect refinement signals from execution vs. skill procedure
- Version bump logic (patch/minor/major)
- `refine()`: Generate updated SKILL.md via auxiliary LLM
  - Diff the actual execution against the skill procedure
  - Merge improvements
  - Create version record with unified diff
- **Files**: `src/skills/refiner.ts`

#### 2.4: Auxiliary LLM Integration
- Decide on the invocation pattern:
  - Option A: Accept a `generateText` callback in config
  - Option B: Resolve model via Mastra's model resolution (`mastra.getModel()`)
  - Option C: Accept an AI SDK `LanguageModel` instance
- Implement with whichever pattern best fits Mastra's architecture
- All LLM calls should be traced via OpenTelemetry spans

#### 2.5: Write tests
- Unit tests for extraction policy evaluation
- Unit tests for refinement signal detection
- Integration test: create agent → run complex task → verify skill extracted
- Mock LLM calls for deterministic testing

### Phase 2 Exit Criteria
- [ ] Output processor accumulates state correctly during streaming
- [ ] Extraction fires when policy thresholds are met
- [ ] Extraction does not fire for simple tasks
- [ ] Deduplication prevents near-duplicate skills
- [ ] Refinement detects deviation/pitfall/correction signals
- [ ] Version history tracks diffs between versions

---

## Phase 3: Memory & Harness

### Goal
Full memory stack (facts + identity) and Harness integration for agent-app developers.

### Tasks

#### 3.1: Implement `FactLayer`
- `persistFact()`: Store with category, confidence, source thread
- `getRelevantFacts()`: Query by context relevance (keyword match Phase 3, semantic Phase 4)
- `reinforceFact()`: Reset confidence to 1.0, update timestamp
- `applyDecay()`: Weekly decay calculation
- `buildFactsBlock()`: Format facts for system prompt injection
- Schema: `facts` table in storage extension
- **Files**: `src/memory/fact-layer.ts`

#### 3.2: Implement `IdentityLayer`
- `getCurrentIdentity()`: Fetch calibrated identity from storage
- `updateCalibration()`: Store preference updates
- `measureDrift()`: Compare current vs. seed (embedding similarity or LLM-based)
- `buildIdentityBlock()`: Already partially implemented, finalize
- Schema: `identity_calibrations` table
- **Files**: `src/memory/identity.ts`

#### 3.3: Implement `SkillContextProcessor`
- **Critical**: Must implement `Processor.processInput` from `@mastra/core`
- Assembly order: Identity → Facts → Skill Index
- Handle case where OM is also active (don't duplicate context)
- Token budget awareness: leave room for OM + messages
- **Files**: `src/processors/skill-context-processor.ts`

#### 3.4: Implement `memory_persist` and `memory_recall` tools
- Fill in the stub implementations from Phase 1
- `memory_persist`: Creates a fact entry with the FactLayer
- `memory_recall`: Queries the FactLayer by context/category
- **Files**: `src/tools/skill-tools.ts` (update existing)

#### 3.5: Implement Harness Integration
- `createSelfLearningMode()`: Harness mode with learn-focused instructions
- `createHarnessTools()`: Tools optimized for Harness context
- Task tracking integration: detect `task_write`/`task_check` in tool trace
- Optional: explorer/reviewer subagent definitions
- **Files**: `src/harness/index.ts`

#### 3.6: Composition Testing
- Test SkillContextProcessor + OM running together
- Test SelfLearningProcessor with Harness task tracking
- Test fact persistence across multiple threads

### Phase 3 Exit Criteria
- [ ] Facts persist across threads and show in system prompt
- [ ] Identity block appears in system prompt
- [ ] Skill index appears in system prompt
- [ ] Learn mode works in Harness
- [ ] OM and self-learning compose without conflict

---

## Phase 4: Gardening & Advanced Search

### Goal
Automated skill maintenance and semantic search capabilities.

### Tasks

#### 4.1: Implement Gardening Workflows
- Use Mastra's `createWorkflow()` for each task
- `deduplication`: Pairwise similarity check, merge similar skills
- `decay`: Apply confidence decay, archive stale items
- `qualityScoring`: Recalculate quality metrics from usage data
- `driftDetection`: Compare identity against seed
- Register with `WorkflowScheduler` for cron execution
- **Files**: `src/workflows/index.ts`

#### 4.2: Implement Semantic Search
- Embedding integration: use configured `embeddingModel`
- Embed skills on creation/update, store vectors in `embedding` column
- Query: embed user query → cosine similarity against skill vectors
- Hybrid merging: combine FTS and semantic scores with configurable weighting
- **Files**: `src/skills/search.ts` (extend existing FTS implementation)

#### 4.3: Implement CLI
- `import`: Bulk import from Hermes / agentskills.io directories
- `export`: Export to agentskills.io format
- `list`: List all skills with stats
- `analytics`: Show skill usage metrics, quality trends
- `gardening`: Manual trigger for gardening tasks
- **Files**: `packages/cli/src/`

#### 4.4: Implement `relevant` Overflow Strategy
- Now that semantic search is available, implement the `relevant` strategy in SkillRouter
- On each request, embed recent messages → rank skills by relevance → trim L0 index

### Phase 4 Exit Criteria
- [ ] Deduplication workflow merges similar skills
- [ ] Decay workflow archives stale facts and skills
- [ ] Semantic search returns relevant skills for intent-based queries
- [ ] CLI can import/export Hermes skills
- [ ] `relevant` overflow strategy uses semantic similarity

---

## Phase 5: Evaluation & Polish

### Goal
Measurable learning effectiveness and production readiness.

### Tasks

#### 5.1: Implement Eval Scorers
- `skillUtilizationScorer`: Uses Mastra's `createScorer()` interface
- `skillQualityScorer`: Queries version history and usage data
- `identityDriftScorer`: Embedding comparison
- **Files**: `src/evals/index.ts`

#### 5.2: Observability Integration
- Add OpenTelemetry spans to all learning loop events
- Use Mastra's `TracingContext` from processor args
- Custom span attributes: `self-learning.extraction.reason`, `self-learning.skill.name`, etc.

#### 5.3: Examples
- `examples/basic-agent/`: Minimal Tier 1 setup
- `examples/with-harness/`: Full Tier 3 with learn mode
- `examples/with-observational-memory/`: Composing with OM

#### 5.4: Documentation Polish
- API reference generation from TSDoc
- Architecture diagrams (Mermaid)
- Troubleshooting guide
- Performance tuning guide

### Phase 5 Exit Criteria
- [ ] All three scorers return meaningful scores
- [ ] OTel traces visible in connected observability backend
- [ ] All examples run successfully
- [ ] README and docs are complete and accurate

---

## Key Risks & Open Questions

### Risk: Mastra SkillsStorage API Changes
- **Mitigation**: Pin to `@mastra/core` ^1.25.0, test against latest in CI
- **Action**: Phase 1.1 must thoroughly document the current API surface

### Risk: Auxiliary LLM Invocation Pattern
- How to invoke an LLM from inside a processor/tool without circular dependencies
- **Options**: Callback injection, model resolution via Mastra instance, AI SDK direct
- **Action**: Decide in Phase 2.4, document the pattern

### Risk: Token Budget Accuracy
- Simple `chars / 4` heuristic may be inaccurate for non-English text or code-heavy skills
- **Mitigation**: Make token estimation pluggable, default to heuristic
- **Future**: Integrate a proper tokenizer when available

### Risk: Extraction Noise
- The learning loop may create low-quality skills from tasks that seem complex but aren't generalizable
- **Mitigation**: Generalizability check + deduplication + approval gates
- **Action**: Tune thresholds with real usage data in Phase 2

### Risk: OM Composition Edge Cases
- Input processor ordering with OM may have unexpected interactions
- **Mitigation**: Test extensively in Phase 3.6
- **Action**: Document ordering requirements

### Open Question: Multi-Agent Skill Sharing
- When should skills created by one agent be visible to sibling agents?
- Current design: `agentId = null` makes skills global
- May need more sophisticated sharing policies (team scopes, permission inheritance)
- **Action**: Defer to post-v1, document as future enhancement

### Open Question: Skill Conflict Resolution
- What happens when two agents create skills for the same procedure?
- Deduplication catches exact matches, but what about partial overlaps?
- **Action**: Defer to gardening workflow improvements post-v1
