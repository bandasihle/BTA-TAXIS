// Taxi state machine. Pure functions only: no database, no clock.
//
//   OFF_DUTY ──checkIn──▶ QUEUED ◀──seat(-)── LOADING
//   ARRIVED  ──checkIn──▶ QUEUED ──seat(+)──▶ LOADING
//   QUEUED / LOADING ──depart──▶ EN_ROUTE ──arrive──▶ ARRIVED
//   QUEUED / LOADING ──remove──▶ ARRIVED
//   anything but EN_ROUTE / OFF_DUTY ──offDuty──▶ OFF_DUTY
//
// "Departed" is recorded as an event; the taxi's state while driving is EN_ROUTE.

export const STATUS = Object.freeze({
  OFF_DUTY: 'OFF_DUTY',
  ARRIVED: 'ARRIVED',
  QUEUED: 'QUEUED',
  LOADING: 'LOADING',
  EN_ROUTE: 'EN_ROUTE',
});

export class TransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransitionError';
    this.status = 409;
  }
}

const inQueue = (s) => s === STATUS.QUEUED || s === STATUS.LOADING;

/**
 * Validates an action against a taxi's current state and returns the next state.
 * Throws TransitionError with a message a marshal can act on when the move is not allowed.
 *
 * @param {string} action checkIn | seat | depart | arrive | remove | offDuty | move
 * @param {{status: string, plate: string, capacity: number, rank_id?: number|null}} taxi
 * @param {object} ctx action-specific context
 */
export function checkTransition(action, taxi, ctx = {}) {
  const { status, plate } = taxi;
  switch (action) {
    case 'checkIn': {
      if (status === STATUS.EN_ROUTE) {
        throw new TransitionError(`${plate} is still on the road. Mark it arrived before checking it in.`);
      }
      if (inQueue(status)) {
        throw new TransitionError(`${plate} is already in a queue${ctx.rankName ? ` at ${ctx.rankName}` : ''}.`);
      }
      if (status === STATUS.ARRIVED && taxi.rank_id != null && taxi.rank_id !== ctx.rankId) {
        throw new TransitionError(
          `${plate} is waiting at ${ctx.rankName ?? 'another rank'}. That marshal must queue it or take it off duty first.`,
        );
      }
      if (!ctx.route || ctx.route.from_rank_id !== ctx.rankId) {
        throw new TransitionError('That route does not leave from this rank.');
      }
      return STATUS.QUEUED;
    }
    case 'seat': {
      if (!inQueue(status)) throw new TransitionError(`Check ${plate} in before loading passengers.`);
      const seats = (ctx.seats ?? 0) + ctx.delta;
      if (seats < 0) throw new TransitionError(`${plate} has no passengers to remove.`);
      if (seats > taxi.capacity) throw new TransitionError(`${plate} is full (${taxi.capacity} seats).`);
      return seats > 0 ? STATUS.LOADING : STATUS.QUEUED;
    }
    case 'depart':
      if (status === STATUS.EN_ROUTE) throw new TransitionError(`${plate} has already departed.`);
      if (!inQueue(status)) throw new TransitionError(`Check ${plate} in before it departs.`);
      return STATUS.EN_ROUTE;
    case 'arrive':
      if (status !== STATUS.EN_ROUTE) throw new TransitionError(`${plate} is not on the road.`);
      return STATUS.ARRIVED;
    case 'remove':
      if (!inQueue(status)) throw new TransitionError(`${plate} is not in a queue.`);
      return STATUS.ARRIVED;
    case 'offDuty':
      if (status === STATUS.EN_ROUTE) throw new TransitionError(`${plate} is on the road. Mark it arrived first.`);
      if (status === STATUS.OFF_DUTY) throw new TransitionError(`${plate} is already off duty.`);
      return STATUS.OFF_DUTY;
    case 'move':
      if (!inQueue(status)) throw new TransitionError(`${plate} is not in a queue.`);
      return status;
    default:
      throw new TransitionError(`Unknown action "${action}".`);
  }
}
