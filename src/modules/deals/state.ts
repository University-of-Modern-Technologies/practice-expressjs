import type { DealStage } from './types.js';

/**
 * Everything the rest of the module needs to know about one stage, gathered
 * in one place so that adding a stage means adding one object here instead
 * of remembering every file that has an opinion about it.
 */
export interface DealState {
  readonly stage: DealStage;
  /** Stages reachable from here. */
  readonly allowedTransitions: readonly DealStage[];
  /**
   * Whether a probability is compatible with this stage. The generic
   * integer/0-100 check is stage-independent and lives in `transition.ts`;
   * this only encodes what a *closed* outcome demands: WON is certain to have
   * happened, LOST is certain not to have, and every open stage is merely an
   * estimate that must stop short of certainty.
   */
  isValidProbability(probability: number): boolean;
}

const open = (stage: DealStage, allowedTransitions: readonly DealStage[]): DealState => ({
  stage,
  allowedTransitions,
  // An open deal has not closed, so it may not claim the certainty a closed
  // one reports.
  isValidProbability: (probability) => probability !== 100,
});

const lead = open('LEAD', ['QUALIFIED']);
const qualified = open('QUALIFIED', ['PROPOSAL']);
const proposal = open('PROPOSAL', ['WON', 'LOST']);

/** Final: a won deal is certain to have happened. */
const won: DealState = {
  stage: 'WON',
  allowedTransitions: [],
  isValidProbability: (probability) => probability === 100,
};

/** Final: a lost deal is certain not to have happened. */
const lost: DealState = {
  stage: 'LOST',
  allowedTransitions: [],
  isValidProbability: (probability) => probability === 0,
};

const states: Readonly<Record<DealStage, DealState>> = {
  LEAD: lead,
  QUALIFIED: qualified,
  PROPOSAL: proposal,
  WON: won,
  LOST: lost,
};

export const dealState = (stage: DealStage): DealState => states[stage];
