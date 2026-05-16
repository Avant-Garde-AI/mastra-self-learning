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
  detectUserCorrection,
  buildTrajectory,
  buildRefinementSignals,
  type SelfLearningState,
} from './chunk-observer.js';
export {
  makeSafeEmitter,
  type SelfLearningEvent,
  type SelfLearningEventType,
  type SelfLearningEventHandler,
} from './events.js';

export {
  createSkillContextProcessor,
  type SkillContextProcessorOptions,
  type SkillContextProcessor,
  type ProcessInputArgsLike,
} from './skill-context-processor.js';
