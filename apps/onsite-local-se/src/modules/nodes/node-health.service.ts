import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import type { SimulatorClient } from '../../connectors/simulator.js';
import type { Db } from '../../db.js';
import * as catalog from '../catalog/catalog.repository.js';
import type { TasksService } from '../tasks/tasks.service.js';

/**
 * The Round 1 circuit breaker. Each node's own server reports to the source; a node that has been silent
 * for longer than the timeout may be selling stock at the counter that nobody can see. Routing already
 * leaves such a node out. This moves work that is still waiting for its approval to other nodes.
 */
export class NodeHealthService {
  constructor(
    private readonly pool: Db,
    private readonly config: Config,
    private readonly simulator: SimulatorClient,
    private readonly tasks: TasksService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Reads heartbeats from the source. A failed read changes nothing: not hearing from the source is a source
   * outage, which the inventory freshness check already handles, not a sign that one node went quiet.
   */
  async refresh(): Promise<boolean> {
    if (!this.simulator.enabled) return false;
    try {
      const beats = await this.simulator.nodeHeartbeats();
      await catalog.recordHeartbeats(
        this.pool,
        beats.filter((beat) => typeof beat.last_heartbeat_at === 'string'),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Worker: refresh, then move unapproved tasks off every offline node. Returns how many were moved. */
  async tick(): Promise<number> {
    if (!(await this.refresh())) return 0;
    const offline = await catalog.listOfflineNodeIds(this.pool, this.config.nodes.heartbeatTimeoutSeconds);
    if (!offline.length) return 0;
    const { rows } = await this.pool.query<{ task_id: string; node_id: string; order_id: string }>(
      `SELECT t.task_id, t.node_id, t.order_id
         FROM fulfilment_tasks t JOIN orders o USING (order_id)
        WHERE t.status = 'PENDING_APPROVAL' AND o.status = 'AWAITING_APPROVAL' AND t.node_id = ANY($1)
        ORDER BY t.created_at`,
      [offline],
    );
    let moved = 0;
    for (const row of rows) {
      if (await this.tasks.rerouteFromOfflineNode(row.task_id)) {
        moved += 1;
        this.log.warn({ node_id: row.node_id, order_id: row.order_id }, 'node offline; task moved to another node');
      }
    }
    return moved;
  }
}
