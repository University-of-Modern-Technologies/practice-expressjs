import { AppError } from '../../common/errors/index.js';
import { dealState } from './state.js';
import { dealStages, type DealStage } from './types.js';

/**
 * The pipeline, derived from `dealState` rather than written out again, so
 * this table and the one baked into each state can never drift apart.
 */
export const allowedDealStageTransitions: Readonly<Record<DealStage, readonly DealStage[]>> =
  Object.fromEntries(
    dealStages.map((stage) => [stage, dealState(stage).allowedTransitions]),
  ) as Readonly<Record<DealStage, readonly DealStage[]>>;

export const canTransitionDealStage = (from: DealStage, to: DealStage): boolean =>
  dealState(from).allowedTransitions.includes(to);

export const assertDealStageTransition = (from: DealStage, to: DealStage): void => {
  if (!canTransitionDealStage(from, to)) {
    throw new AppError(
      `Deal stage cannot transition from ${from} to ${to}`,
      409,
      'INVALID_DEAL_STAGE_TRANSITION',
      { from, to, allowed: dealState(from).allowedTransitions },
    );
  }
};

/**
 * A stage the pipeline never leaves. Derived from the transition table rather
 * than listed, so a stage that gains a way out stops being final by itself.
 */
export const isFinalDealStage = (stage: DealStage): boolean =>
  dealState(stage).allowedTransitions.length === 0;

/**
 * A closed deal is a record of what happened, not an estimate any more: its
 * amount, currency and dates are what the reports already counted. Editing it
 * would rewrite history, so the fields are frozen once the deal is won or lost.
 */
export const assertDealEditable = (stage: DealStage): void => {
  if (!isFinalDealStage(stage)) return;
  throw new AppError('A closed deal cannot be edited', 409, 'DEAL_CLOSED', { stage });
};

export const assertDealProbability = (stage: DealStage, probability: number): void => {
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    throw new AppError(
      'Probability must be an integer from 0 to 100',
      400,
      'INVALID_DEAL_PROBABILITY',
    );
  }
  if (dealState(stage).isValidProbability(probability)) return;
  if (stage === 'WON') {
    throw new AppError('Won deals must have 100 probability', 400, 'INVALID_DEAL_PROBABILITY');
  }
  if (stage === 'LOST') {
    throw new AppError('Lost deals must have 0 probability', 400, 'INVALID_DEAL_PROBABILITY');
  }
  throw new AppError('Only won deals may have 100 probability', 400, 'INVALID_DEAL_PROBABILITY');
};
