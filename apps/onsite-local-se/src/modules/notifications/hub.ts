export type NotificationType = 'task.assigned' | 'task.updated' | 'order.updated' | 'order.at_risk' | 'review.created';

/** Who may receive the event. Admins receive everything. */
export interface NotificationScope {
  nodeIds?: string[];
  customerId?: string;
  allStaff?: boolean;
}

export interface Notification {
  type: NotificationType;
  scope: NotificationScope;
  data: Record<string, unknown>;
}

export interface Subscriber {
  role: string;
  storeId?: string | undefined;
  customerId?: string | undefined;
  send: (event: { type: NotificationType; data: Record<string, unknown> }) => void;
  close: () => void;
}

export function isInScope(subscriber: Pick<Subscriber, 'role' | 'storeId' | 'customerId'>, scope: NotificationScope) {
  if (subscriber.role === 'admin') return true;
  if (subscriber.role === 'staff') {
    return Boolean(scope.allStaff) || Boolean(subscriber.storeId && scope.nodeIds?.includes(subscriber.storeId));
  }
  return subscriber.role === 'customer' && Boolean(subscriber.customerId) && scope.customerId === subscriber.customerId;
}

/** In-process fan-out for SSE. A hint only: clients always read the actual data over REST. */
export class NotificationHub {
  private readonly subscribers = new Set<Subscriber>();

  publish(notification: Notification): void {
    for (const subscriber of this.subscribers) {
      if (isInScope(subscriber, notification.scope)) {
        subscriber.send({ type: notification.type, data: notification.data });
      }
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  closeAll(): void {
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }

  get size(): number {
    return this.subscribers.size;
  }
}
