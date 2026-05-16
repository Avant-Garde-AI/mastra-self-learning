import type { TaskTrajectory } from './extractor.js';

/**
 * Identifier patterns we replace with placeholders before showing a trajectory
 * to the synthesis LLM. The LLM is also instructed to generalize, but this
 * pre-processing reduces leakage when the LLM gets lazy.
 */
const PLACEHOLDER_PATTERNS: Array<{ regex: RegExp; placeholder: string }> = [
  // GCP project IDs (lower-case, dashes, contains digits — heuristic)
  { regex: /\b[a-z][a-z0-9-]{4,30}-\d{4,}\b/g, placeholder: '<PROJECT_ID>' },
  // Email addresses
  { regex: /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/gi, placeholder: '<EMAIL>' },
  // UUIDs
  {
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    placeholder: '<UUID>',
  },
  // ULIDs (Crockford base32, 26 chars)
  { regex: /\b[0-9A-HJKMNP-TV-Z]{26}\b/g, placeholder: '<ULID>' },
  // IPv4
  { regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, placeholder: '<IP_ADDRESS>' },
  // Bearer tokens / generic API keys (long alphanumeric)
  { regex: /\b(?:sk|pk|api|key|token)[-_][a-z0-9]{16,}\b/gi, placeholder: '<API_KEY>' },
];

/**
 * Build a compact serialized view of a trajectory for the synthesis prompt.
 *
 * - Tool outputs are truncated to 200 characters (signal usually lives in the
 *   tool name and inputs, not the full output blob).
 * - Identifier patterns are replaced with `<PLACEHOLDER>` strings.
 * - JSON inputs are stringified flat for token efficiency.
 */
export function serializeTrajectoryForPrompt(trajectory: TaskTrajectory): string {
  const lines: string[] = [];
  lines.push(`Tool calls (${trajectory.toolCalls.length}):`);
  trajectory.toolCalls.forEach((c, i) => {
    const args = JSON.stringify(c.input ?? {});
    const argsLine = scrub(args).slice(0, 240);
    lines.push(`  ${i + 1}. ${c.name}(${argsLine})`);
    if (c.output !== undefined) {
      const outStr = typeof c.output === 'string' ? c.output : JSON.stringify(c.output);
      const truncated = scrub(outStr).slice(0, 200);
      lines.push(`     → ${truncated}${outStr.length > 200 ? '…' : ''}`);
    }
  });
  lines.push('');
  lines.push(`Turn count: ${trajectory.turnCount}`);
  lines.push(`Positive outcome detected: ${trajectory.positiveOutcome ? 'yes' : 'no'}`);
  if (trajectory.conversationSummary) {
    lines.push('');
    lines.push('Conversation summary:');
    lines.push(scrub(trajectory.conversationSummary));
  }
  return lines.join('\n');
}

export function buildGeneralizabilityPrompt(trajectory: TaskTrajectory): string {
  const summary = summarizeToolCalls(trajectory);
  return `You are evaluating whether a recent agent task represents a reusable procedure
worth documenting as a skill.

Task summary:
- ${trajectory.toolCalls.length} tool calls
- ${trajectory.turnCount} turns
- Tool sequence: ${summary}

Answer with a single token: YES or NO.

Choose NO if any of these apply:
- The task involved one-off data entry, lookups, or content generation
- The work is too instance-specific to generalize (no transferable steps)
- The "procedure" is "call one tool with these specific arguments"
- The work was primarily reasoning or writing, not procedural

Choose YES if:
- The agent followed a multi-step process that could apply to similar future tasks
- The steps involved planning, verification, or recovery from intermediate state
- Another instance of this kind of task would benefit from these steps

Answer (YES or NO):`;
}

export function buildSynthesisPrompt(trajectory: TaskTrajectory, isRetry = false): string {
  const serialized = serializeTrajectoryForPrompt(trajectory);
  const retryPreamble = isRetry
    ? `Your previous attempt produced unparseable output. Output ONLY the SKILL.md content, starting with "---" (the frontmatter delimiter). No code fences, no commentary, no preamble.\n\n`
    : '';
  return `${retryPreamble}You are a skill documentation expert. Given the following task trajectory,
generate a reusable SKILL.md document.

Hard rules:
1. Replace all instance-specific values (project IDs, service names, dates,
   hostnames, regions, repo names) with generic placeholders like PROJECT_ID,
   SERVICE_NAME, REGION, REPO_NAME.
2. Strip all credentials, tokens, or API keys completely — never include
   placeholders for them in code blocks; document them as "Prerequisites".
3. Output valid agentskills.io SKILL.md with YAML frontmatter.

The frontmatter MUST include:
  name:        kebab-case slug, descriptive but concise (<= 60 chars)
  description: one-line description (<= 100 chars) used for the L0 index
  version:     "1.0.0"
  author:      "agent"
  trust:       "agent-created"
  tags:        array of 3-7 relevant tags
  complexity:  integer 1-5

The body MUST include these sections, in order, using level-2 (\`##\`) headings:
  ## When to Use      — When this procedure applies (helps future retrieval)
  ## Prerequisites    — What must be true before starting (tools, permissions, state)
  ## Procedure        — Step-by-step instructions, with code blocks where applicable
  ## Verification     — How to confirm success
  ## Pitfalls         — Known failure modes (omit only if none apply)

Task trajectory:

${serialized}

Output ONLY the SKILL.md content. No commentary before or after.
Start the response directly with the literal characters \`---\` on its own line.`;
}

/**
 * Strip common LLM output noise to expose the SKILL.md content underneath.
 *
 * Patterns we remove:
 *   - Leading/trailing whitespace
 *   - Leading code fence (```markdown / ``` / ```skill)
 *   - Trailing closing code fence
 *   - Conversational preambles like "Here is the SKILL.md:"
 */
export function normalizeSynthesisOutput(raw: string): string {
  let out = raw.trim();

  // Strip leading conversational preamble up to the first \`---\` line.
  const dashIdx = out.indexOf('---');
  if (dashIdx > 0) {
    // Look at what comes before; if it's prose / "here is...", strip it.
    const prefix = out.slice(0, dashIdx);
    if (
      /^(here[\s'’]?s|here is|below is|sure|certainly|i[\s'’]?ll|of course|here[\s'’]?s the|the (skill|skill\.md) (is|content)[\s:.])/i.test(
        prefix.trim(),
      )
    ) {
      out = out.slice(dashIdx);
    }
  }

  // Strip a leading code fence (with optional language tag).
  if (/^```[a-zA-Z]*\s*\n/.test(out)) {
    out = out.replace(/^```[a-zA-Z]*\s*\n/, '');
  }

  // Strip a trailing closing fence.
  if (/\n```\s*$/.test(out)) {
    out = out.replace(/\n```\s*$/, '');
  }

  return out.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeToolCalls(trajectory: TaskTrajectory): string {
  const names = trajectory.toolCalls.map((c) => c.name);
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(', ');
}

function scrub(text: string): string {
  let out = text;
  for (const { regex, placeholder } of PLACEHOLDER_PATTERNS) {
    out = out.replace(regex, placeholder);
  }
  return out;
}
