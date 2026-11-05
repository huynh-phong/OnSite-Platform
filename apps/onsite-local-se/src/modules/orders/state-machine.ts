import { AppError } from '../../errors.js';

export const ORDER_STATUSES = [
  'SUBMITTED',
  'ALLOCATING',
  'AWAITING_APPROVAL',
  'NEEDS_REVIEW',
  'NEEDS_REALLOCATION',
  'APPROVED',
  'DISPATCHING',
  'DISPATCHED',
  'DELIVERED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TASK_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'DISPATCHED',
  'DELIVERED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  SUBMITTED: ['ALLOCATING', 'CANCELLED'],
  ALLOCATING: ['AWAITING_APPROVAL', 'NEEDS_REVIEW', 'CANCELLED'],
  AWAITING_APPROVAL: ['APPROVED', 'NEEDS_REALLOCATION', 'EXPIRED', 'CANCELLED'],
  // ALLOCATING only when the customer accepts the quantity that can be supplied now.
  NEEDS_REVIEW: ['ALLOCATING', 'CANCELLED'],
  NEEDS_REALLOCATION: ['ALLOCATING', 'CANCELLED'],
  // Cancelling after approval is limited to admins by the order service.
  APPROVED: ['DISPATCHING', 'CANCELLED'],
  DISPATCHING: ['DISPATCHED'],
  DISPATCHED: ['DELIVERED'],
  DELIVERED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  // An approved task is closed with its order if a sibling node never approves in time, or on cancel.
  APPROVED: ['DISPATCHED', 'EXPIRED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED'],
  DELIVERED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const canTransitionOrder = (from: OrderStatus, to: OrderStatus) => ORDER_TRANSITIONS[from].includes(to);
export const canTransitionTask = (from: TaskStatus, to: TaskStatus) => TASK_TRANSITIONS[from].includes(to);

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new AppError(409, 'INVALID_TRANSITION', `Order cannot go from ${from} to ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new AppError(409, 'INVALID_TRANSITION', `Task cannot go from ${from} to ${to}`);
  }
}

/** Tasks that still count toward fulfilling the order. */
export const LIVE_TASK_STATUSES: readonly TaskStatus[] = ['PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'DELIVERED'];
