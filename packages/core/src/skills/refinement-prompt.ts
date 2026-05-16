import type { SkillRecord, RefinementSignals } from './types.js';
import type { TaskTrajectory } from './extractor.js';

/**
 * Build the prompt that asks the auxiliary LLM to refine an existing skill in
 * light of a new (problematic) usage.
 *
 * The contract is intentionally conservative: the LLM may *add* a pitfall,
 * clarify a step, or add a verification, but it must NOT change the skill's
 * name/purpose or remove hard-won knowledge.
 */
export function buildRefinementPrompt(
  skill: SkillRecord,
  trajectory: TaskTrajectory,
  signals: RefinementSignals,
  proposedVersion: string,
  finalUserMessage?: string,
  isRetry = false,
): string {
  const reason = describeSignals(signals);
  const toolSummary = summarizeToolCalls(trajectory);
  const correction =
    signals.userCorrection && finalUserMessage
      ? `\nUser correction: "${truncate(finalUserMessage, 400)}"`
      : '';
  const retryPreamble = isRetry
    ? `Your previous attempt produced unparseable output. Output ONLY the SKILL.md content, starting with "---". No code fences, no commentary.\n\n`
    : '';

  return `${retryPreamble}You are refining an existing skill based on new usage feedback.

CURRENT SKILL:

${skill.content}

NEW USAGE OBSERVATIONS:
- Outcome: ${reason}
- Tools used during the attempt: ${toolSummary}${correction}

YOUR JOB:

Produce a refined SKILL.md that addresses the observed problem. You MAY:
- Add a new entry to the Pitfalls section
- Clarify or correct a step in the Procedure
- Add a Verification step
- Tighten Prerequisites

You MUST NOT:
- Change the skill's "name" or fundamental purpose
- Remove existing pitfalls or verification steps (they capture hard-won knowledge)
- Introduce instance-specific details (project IDs, hostnames, etc.) — keep placeholders generic

Set the frontmatter "version" to exactly "${proposedVersion}".

Output ONLY the refined SKILL.md content. Start the response directly with the
literal characters \`---\` on its own line. No commentary before or after.`;
}

export function describeSignals(signals: RefinementSignals): string {
  const active: string[] = [];
  if (signals.failure) active.push('execution failure');
  if (signals.userCorrection) active.push('user correction');
  if (signals.deviation) active.push('procedure deviation');
  if (signals.newPitfall) active.push('new pitfall discovered');
  if (signals.unnecessaryStep) active.push('unnecessary step');
  return active.length > 0 ? active.join(', ') : 'no active signals';
}

function summarizeToolCalls(trajectory: TaskTrajectory): string {
  if (trajectory.toolCalls.length === 0) return '(none)';
  const counts = new Map<string, number>();
  for (const c of trajectory.toolCalls) {
    counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
    .join(', ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
