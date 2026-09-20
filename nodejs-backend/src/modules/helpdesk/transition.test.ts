import { describe, expect, it } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import {
  allowedTicketStatusTransitions,
  assertTicketStatusTransition,
  canTransitionTicketStatus,
  resolutionFor,
} from './transition.js';
import { ticketStatuses } from './types.js';

const now = new Date('2026-03-01T10:00:00Z');

describe('ticket status transition matrix', () => {
  it('matches the canonical transition graph exactly', () => {
    expect(allowedTicketStatusTransitions).toEqual({
      NEW: ['OPEN', 'CLOSED'],
      OPEN: ['PENDING', 'RESOLVED', 'CLOSED'],
      PENDING: ['OPEN', 'RESOLVED', 'CLOSED'],
      RESOLVED: ['CLOSED', 'OPEN'],
      CLOSED: [],
    });

    for (const from of ticketStatuses) {
      for (const to of ticketStatuses) {
        expect(canTransitionTicketStatus(from, to)).toBe(
          allowedTicketStatusTransitions[from].includes(to),
        );
      }
    }
  });

  it('never allows a status to transition to itself', () => {
    for (const status of ticketStatuses) {
      expect(canTransitionTicketStatus(status, status)).toBe(false);
    }
  });

  it('lets a closed ticket go nowhere', () => {
    for (const to of ticketStatuses) {
      expect(canTransitionTicketStatus('CLOSED', to)).toBe(false);
    }
  });

  it('throws an unprocessable entity for a transition outside the table', () => {
    expect(() => assertTicketStatusTransition('NEW', 'RESOLVED')).toThrow(AppError);
    try {
      assertTicketStatusTransition('NEW', 'RESOLVED');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 422, code: 'TICKET_TRANSITION_NOT_ALLOWED' });
    }
  });

  it('passes every transition the table does list', () => {
    for (const from of ticketStatuses) {
      for (const to of allowedTicketStatusTransitions[from]) {
        expect(() => assertTicketStatusTransition(from, to)).not.toThrow();
      }
    }
  });
});

describe('ticket resolution timestamp', () => {
  it('stamps the resolved status', () => {
    expect(resolutionFor('RESOLVED', now)).toEqual(now);
  });

  it('clears the timestamp for every status that puts the ticket back in progress', () => {
    for (const status of ['NEW', 'OPEN', 'PENDING'] as const) {
      expect(resolutionFor(status, now)).toBeNull();
    }
  });

  it('leaves the timestamp untouched when the ticket is closed', () => {
    // `undefined` is the instruction to leave the column alone, and it is
    // distinct from `null`, which would erase a resolution time that closing
    // had no business erasing.
    expect(resolutionFor('CLOSED', now)).toBeUndefined();
  });

  it('answers for every status in the vocabulary', () => {
    for (const status of ticketStatuses) {
      expect(() => resolutionFor(status, now)).not.toThrow();
    }
  });
});
