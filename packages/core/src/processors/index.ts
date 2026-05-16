export {
  createSelfLearningProcessor,
  type SelfLearningProcessorOptions,
  type SelfLearningProcessor,
  type ProcessOutputStreamArgsLike,
  type ProcessOutputResultArgsLike,
} from './self-learning-processor.js';
export {
  observeChunk,
  readState,
  detectPositiveOutcome,
  buildTrajectory,
  type SelfLearningState,
} from './chunk-observer.js';

export {
  createSkillContextProcessor,
  type SkillContextProcessorOptions,
  type SkillContextProcessor,
  type ProcessInputArgsLike,
} from './skill-context-processor.js';
