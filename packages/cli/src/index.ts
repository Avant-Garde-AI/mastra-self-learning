#!/usr/bin/env node

import { Command } from 'commander';
import { importCommand } from './commands/import.js';
import { exportCommand } from './commands/export.js';
import { listCommand } from './commands/list.js';
import { analyticsCommand } from './commands/analytics.js';

const program = new Command();

program
  .name('mastra-sl')
  .description('CLI for managing @avant-garde/mastra-self-learning skills')
  .version('0.0.1');

program.addCommand(importCommand);
program.addCommand(exportCommand);
program.addCommand(listCommand);
program.addCommand(analyticsCommand);

program.parse();
