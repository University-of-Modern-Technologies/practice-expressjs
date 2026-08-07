import { describe, expect, it } from '@jest/globals';

import { dealState } from './state.js';
import { allowedDealStageTransitions } from './transition.js';
import { dealStages } from './types.js';

// The historical table, kept here only as a fixed point to compare the
// single-source-of-truth states against.
const historicalTransitions: Readonly<Record<string, readonly string[]>> = {
  LEAD: ['QUALIFIED'],
  QUALIFIED: ['PROPOSAL'],
  PROPOSAL: ['WON', 'LOST'],
  WON: [],
  LOST: [],
};

describe('deal state registry', () => {
  it('has exactly one state per stage', () => {
    for (const stage of dealStages) {
      expect(dealState(stage).stage).toBe(stage);
    }
  });

  it('carries the same transitions as the historical table, for every stage', () => {
    for (const stage of dealStages) {
      expect(dealState(stage).allowedTransitions).toEqual(historicalTransitions[stage]);
      expect(allowedDealStageTransitions[stage]).toEqual(historicalTransitions[stage]);
    }
  });

  it('accepts exactly 100 for WON and rejects every other value', () => {
    for (const probability of [0, 1, 50, 99, 100]) {
      expect(dealState('WON').isValidProbability(probability)).toBe(probability === 100);
    }
  });

  it('accepts exactly 0 for LOST and rejects every other value', () => {
    for (const probability of [0, 1, 50, 99, 100]) {
      expect(dealState('LOST').isValidProbability(probability)).toBe(probability === 0);
    }
  });

  it('rejects 100 for every open stage', () => {
    for (const stage of ['LEAD', 'QUALIFIED', 'PROPOSAL'] as const) {
      expect(dealState(stage).isValidProbability(100)).toBe(false);
      for (const probability of [0, 1, 50, 99]) {
        expect(dealState(stage).isValidProbability(probability)).toBe(true);
      }
    }
  });
});
