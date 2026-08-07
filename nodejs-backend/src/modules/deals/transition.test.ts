import { describe, expect, it } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import {
  allowedDealStageTransitions,
  assertDealProbability,
  assertDealStageTransition,
  canTransitionDealStage,
} from './transition.js';
import { dealStages } from './types.js';

describe('deal stage transition matrix', () => {
  it('matches the canonical transition graph exactly', () => {
    expect(allowedDealStageTransitions).toEqual({
      LEAD: ['QUALIFIED'],
      QUALIFIED: ['PROPOSAL'],
      PROPOSAL: ['WON', 'LOST'],
      WON: [],
      LOST: [],
    });

    for (const from of dealStages) {
      for (const to of dealStages) {
        expect(canTransitionDealStage(from, to)).toBe(
          allowedDealStageTransitions[from].includes(to),
        );
      }
    }
  });

  it('keeps terminal stages terminal', () => {
    expect(allowedDealStageTransitions.WON).toEqual([]);
    expect(allowedDealStageTransitions.LOST).toEqual([]);
  });

  it('throws a domain conflict for an invalid transition', () => {
    expect(() => assertDealStageTransition('LEAD', 'WON')).toThrow(AppError);
    try {
      assertDealStageTransition('LEAD', 'WON');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: 'INVALID_DEAL_STAGE_TRANSITION' });
    }
  });
});

describe('deal probability rules', () => {
  it('accepts ordinary, won and lost probabilities', () => {
    expect(() => assertDealProbability('LEAD', 10)).not.toThrow();
    expect(() => assertDealProbability('WON', 100)).not.toThrow();
    expect(() => assertDealProbability('LOST', 0)).not.toThrow();
  });

  it.each([
    ['LEAD', 100],
    ['WON', 90],
    ['LOST', 10],
    ['QUALIFIED', -1],
    ['QUALIFIED', 101],
    ['QUALIFIED', 12.5],
  ] as const)('rejects %s with probability %s', (stage, probability) => {
    expect(() => assertDealProbability(stage, probability)).toThrow(AppError);
  });
});
