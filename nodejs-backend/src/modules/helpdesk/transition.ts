import { AppError } from '../../common/errors/index.js';
import { ticketState } from './state.js';
import { ticketStatuses, type TicketStatus } from './types.js';

/**
 * The lifecycle, derived from `ticketState` rather than written out again, so
 * this table and the one baked into each state can never drift apart.
 */
export const allowedTicketStatusTransitions: Readonly<
  Record<TicketStatus, readonly TicketStatus[]>
> = Object.fromEntries(
  ticketStatuses.map((status) => [status, ticketState(status).allowedTransitions]),
) as Readonly<Record<TicketStatus, readonly TicketStatus[]>>;

export const canTransitionTicketStatus = (from: TicketStatus, to: TicketStatus): boolean =>
  ticketState(from).allowedTransitions.includes(to);

export const assertTicketStatusTransition = (from: TicketStatus, to: TicketStatus): void => {
  if (!canTransitionTicketStatus(from, to)) {
    throw new AppError(
      `Ticket cannot transition from ${from} to ${to}`,
      422,
      'TICKET_TRANSITION_NOT_ALLOWED',
      { from, to, allowed: ticketState(from).allowedTransitions },
    );
  }
};

/**
 * What to write into `resolvedAt` for a ticket that has just reached
 * `status`: the moment it was resolved, `null` once it is back in somebody's
 * hands, and `undefined` when the status has no opinion, which tells the
 * caller to leave the column out of the write altogether. The third case is
 * the whole point and not a missing one: closing must not erase a resolution
 * time it did not set, nor invent one the ticket never had.
 */
export const resolutionFor = (status: TicketStatus, now: Date): Date | null | undefined => {
  const { resolutionEffect } = ticketState(status);
  if (resolutionEffect === 'stamp') return now;
  return resolutionEffect === 'clear' ? null : undefined;
};
