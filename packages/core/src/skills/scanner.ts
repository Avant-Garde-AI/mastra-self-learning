/**
 * Security scanner for skill documents.
 *
 * Before a skill is promoted from draft to active, it passes through
 * a combination of regex pattern matching and LLM-based assessment.
 *
 * @see docs/07-trust-and-security.md
 */

export interface ScanResult {
  safe: boolean;
  findings: ScanFinding[];
}

export interface ScanFinding {
  type: 'prompt-injection' | 'data-exfiltration' | 'destructive-command' | 'credential-exposure' | 'guardrail-bypass';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  /** Line number in the SKILL.md where the finding was detected */
  line?: number;
}

/** Dangerous patterns to check via regex */
const PATTERNS: Array<{ type: ScanFinding['type']; regex: RegExp; severity: ScanFinding['severity']; description: string }> = [
  {
    type: 'destructive-command',
    regex: /rm\s+-rf\s+[\/~]/gi,
    severity: 'critical',
    description: 'Recursive forced deletion of system paths',
  },
  {
    type: 'destructive-command',
    regex: /DROP\s+(TABLE|DATABASE|SCHEMA)/gi,
    severity: 'critical',
    description: 'SQL destructive DDL command',
  },
  {
    type: 'data-exfiltration',
    regex: /curl\s+.*\|\s*sh/gi,
    severity: 'high',
    description: 'Piping remote content to shell',
  },
  {
    type: 'credential-exposure',
    regex: /(API_KEY|SECRET|PASSWORD|TOKEN)\s*[=:]\s*['"]\w{8,}/gi,
    severity: 'high',
    description: 'Hardcoded credential pattern',
  },
  {
    type: 'prompt-injection',
    regex: /ignore\s+(all\s+)?previous\s+instructions/gi,
    severity: 'high',
    description: 'Prompt injection pattern',
  },
  {
    type: 'guardrail-bypass',
    regex: /you\s+are\s+now\s+(freed?|unfiltered|jailbroken)/gi,
    severity: 'critical',
    description: 'Guardrail bypass / jailbreak pattern',
  },
];

/**
 * Scan a skill document for dangerous patterns.
 * Phase 1: regex only. Phase 2 adds LLM-based semantic analysis.
 */
export function scanSkillContent(content: string): ScanResult {
  const findings: ScanFinding[] = [];
  const lines = content.split('\n');

  for (const pattern of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.regex.test(lines[i]!)) {
        findings.push({
          type: pattern.type,
          severity: pattern.severity,
          description: pattern.description,
          line: i + 1,
        });
      }
      // Reset regex lastIndex for global patterns
      pattern.regex.lastIndex = 0;
    }
  }

  return {
    safe: findings.length === 0,
    findings,
  };
}
