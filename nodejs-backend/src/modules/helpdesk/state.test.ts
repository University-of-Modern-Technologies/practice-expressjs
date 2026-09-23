import { describe, expect, it } from '@jest/globals';

import { ticketState } from './state.js';
import { allowedTicketStatusTransitions } from './transition.js';
import { ticketStatuses } from './types.js';

// The specified table, kept here only as a fixed point to compare the
// single-source-of-truth states against.
const specifiedTransitions: Readonly<Record<string, readonly string[]>> = {
  NEW: ['OPEN', 'CLOSED'],
  OPEN: ['PENDING', 'RESOLVED', 'CLOSED'],
  PENDING: ['OPEN', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'OPEN'],
  CLOSED: [],
};

describe('ticket state registry', () => {
  it('has exactly one state per status', () => {
    for (const status of ticketStatuses) {
      expect(ticketState(status).status).toBe(status);
    }
  });

  it('carries the same transitions as the specified table, for every status', () => {
    for (const status of ticketStatuses) {
      expect(ticketState(status).allowedTransitions).toEqual(specifiedTransitions[status]);
      expect(allowedTicketStatusTransitions[status]).toEqual(specifiedTransitions[status]);
    }
  });

  it('gives every status exactly one effect on the resolution timestamp', () => {
    expect(
      Object.fromEntries(
        ticketStatuses.map((status) => [status, ticketState(status).resolutionEffect]),
      ),
    ).toEqual({
      NEW: 'clear',
      OPEN: 'clear',
      PENDING: 'clear',
      RESOLVED: 'stamp',
      CLOSED: 'keep',
    });
  });

  it('keeps the closed status terminal', () => {
    expect(ticketState('CLOSED').allowedTransitions).toEqual([]);
  });
});
