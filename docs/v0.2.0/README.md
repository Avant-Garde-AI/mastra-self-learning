# v0.2.0 Plan

The consolidated, dependency-ordered plan for the post-MVP backlog. Every item
here was a conscious v0.1.0 deferral (see repo-root `LIMITATIONS.md`).

Read in order:

1. **[00-overview.md](./00-overview.md)** — thesis, goals, non-goals, the
   12-point release gate, phase map.
2. **[01-requirements.md](./01-requirements.md)** — R1–R15, each with
   acceptance criteria, priority (MUST/SHOULD/MAY), and traceability back to
   the v0.1.0 item it closes.
3. **[02-phased-plan.md](./02-phased-plan.md)** — six dependency-ordered
   phases, per-phase tasks/exit/estimates, sequencing rules, alpha cadence.
4. **[03-phase1-semantic-search.md](./03-phase1-semantic-search.md)** —
   implementation-ready design for the kickoff item (semantic search; closes
   risk R7; unblocks Phases 2 & 3).

Status: planning complete; v0.1.0 remains shippable and unchanged. Phase 1 is
next — the only thing blocking code is the embedding-provider decision
(`03-phase1-semantic-search.md` Task 1.0).
