import type { TicketStatus } from './types.js';

/**
 * What reaching a status does to the resolution timestamp. Three outcomes,
 * not two: `keep` is a real answer and not a missing case, so it is spelled
 * out rather than left to a nullable value that reads like an oversight.
 */
export type TicketResolutionEffect = 'stamp' | 'clear' | 'keep';

/**
 * Everything the rest of the module needs to know about one status, gathered
 * in one place so that adding a status means adding one object here instead
 * of remembering every file that has an opinion about it.
 */
export interface TicketState {
  readonly status: TicketStatus;
  /** Statuses reachable from here. */
  readonly allowedTransitions: readonly TicketStatus[];
  /**
   * What arriving at this status does to `resolvedAt`. Deriving it from the
   * target status alone is what keeps the rule in one place: no call site has
   * to know where the ticket came from.
   */
  readonly resolutionEffect: TicketResolutionEffect;
}

/** Back in somebody's hands: whatever had been resolved no longer is. */
const inProgress = (
  status: TicketStatus,
  allowedTransitions: readonly TicketStatus[],
): TicketState => ({ status, allowedTransitions, resolutionEffect: 'clear' });

const newTicket = inProgress('NEW', ['OPEN', 'CLOSED']);
const open = inProgress('OPEN', ['PENDING', 'RESOLVED', 'CLOSED']);
const pending = inProgress('PENDING', ['OPEN', 'RESOLVED', 'CLOSED']);

/** The only status that demands a resolution; reopening is still allowed. */
const resolved: TicketState = {
  status: 'RESOLVED',
  allowedTransitions: ['CLOSED', 'OPEN'],
  resolutionEffect: 'stamp',
};

/**
 * Final: a closed ticket is not reopened, a new one is filed instead.
 *
 * Closing deliberately leaves `resolvedAt` alone. A ticket can be closed
 * without ever having been solved — spam, a duplicate, a reporter who went
 * quiet — and then there is no resolution time to record; one that was solved
 * and then closed keeps its own, because the report on time-to-resolution
 * would otherwise lose exactly the tickets that ran their course.
 */
const closed: TicketState = {
  status: 'CLOSED',
  allowedTransitions: [],
  resolutionEffect: 'keep',
};

const states: Readonly<Record<TicketStatus, TicketState>> = {
  NEW: newTicket,
  OPEN: open,
  PENDING: pending,
  RESOLVED: resolved,
  CLOSED: closed,
};

export const ticketState = (status: TicketStatus): TicketState => states[status];
