import { Command } from 'commander';

export const exportCommand = new Command('export')
  .description('Export skills to agentskills.io format')
  .option('-d, --dir <path>', 'Output directory', './exported-skills')
  .option('--agent <id>', 'Export skills for a specific agent')
  .option('--strip-mastra', 'Remove Mastra-specific metadata from frontmatter')
  .action(async (options) => {
    // TODO: Phase 4
    // 1. List skills from storage
    // 2. Serialize each with serializeSkillDocument()
    // 3. Optionally strip metadata.mastra
    // 4. Write to --dir as individual .md files
    console.log('Export command — not yet implemented (Phase 4)');
    console.log('Options:', options);
  });
