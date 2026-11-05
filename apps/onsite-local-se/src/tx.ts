import type pg from 'pg';
import type { Db } from './db.js';
import { withTransaction } from './db.js';
import type { Notification, NotificationHub } from './modules/notifications/hub.js';

/** A business transaction. Notifications are held back and only sent after a successful commit. */
export interface Tx {
  client: pg.PoolClient;
  notify: (notification: Notification) => void;
  /** Runs after a successful commit. Failures are logged by the caller's own handling. */
  afterCommit: (work: () => Promise<void>) => void;
}

export async function inTx<T>(pool: Db, hub: NotificationHub, work: (tx: Tx) => Promise<T>): Promise<T> {
  const notifications: Notification[] = [];
  const postCommit: (() => Promise<void>)[] = [];
  const result = await withTransaction(pool, (client) =>
    work({
      client,
      notify: (notification) => notifications.push(notification),
      afterCommit: (task) => postCommit.push(task),
    }),
  );
  for (const notification of notifications) hub.publish(notification);
  for (const task of postCommit) await task();
  return result;
}
