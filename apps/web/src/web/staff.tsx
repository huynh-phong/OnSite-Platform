import { useState } from 'react';
import { CircleCheck, Hourglass, Inbox, PackageCheck, Repeat, Sparkles, Truck, TriangleAlert } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatPercent, formatSek, formatTime, statusText } from '../shared/format';
import { Alert, Badge, Card, Empty, Kpi, Loading, PageHead } from '../shared/ui';
import { api, ApiError, explainError, type AiStats, type OrderDetail, type PickingList, type Review, type Task } from './api';
import { NotATaxInvoice, OrderDetailView, OrderStatus } from './customer';
import { SourceBadges, SystemBanner } from './Layout';
import { useLiveData, useSession } from './session';

function HealthBadge({ health }: { health: Task['reservation_health'] }) {
  if (health === 'LOST') return <Badge tone="danger">Reservation lost</Badge>;
  if (health === 'RENEWAL_FAILING') return <Badge tone="warn">Renewal failing</Badge>;
  return null;
}

function TaskTable({ tasks, showNode }: { tasks: Task[]; showNode?: boolean }) {
  const navigate = useNavigate();
  const base = showNode ? '/admin/tasks' : '/staff/tasks';
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            {showNode && <th>Node</th>}
            <th>Task</th>
            <th>Order status</th>
            <th className="num">Qty</th>
            <th>Requested</th>
            <th>Estimate</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.task_id} className="clickable" onClick={() => navigate(`${base}/${task.task_id}`)}>
              <td className="nowrap">
                <Link to={`${base}/${task.task_id}`}>{task.order_id}</Link>
              </td>
              {showNode && <td className="nowrap">{task.node_id}</td>}
              <td>
                <OrderStatus status={task.status} /> <HealthBadge health={task.reservation_health} />
              </td>
              <td className="small">{statusText(task.order_status)}</td>
              <td className="num">{task.allocated_qty}</td>
              <td className="nowrap small">{formatTime(task.requested_delivery_at)}</td>
              <td className="nowrap small">
                {formatTime(task.eta)} {task.at_risk && <Badge tone="danger">At risk</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function hasProblem(task: Task): boolean {
  return task.reservation_health === 'LOST' || task.reservation_health === 'RENEWAL_FAILING' || (task.at_risk && ['PENDING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(task.status));
}

export function StaffHome() {
  const { session } = useSession();
  const tasks = useLiveData(() => api<Task[]>('/staff/tasks'));
  const reviews = useLiveData(() => api<Review[]>('/staff/normalization-reviews?status=PENDING'));
  const list = tasks.data ?? [];
  const pending = list.filter((task) => task.status === 'PENDING_APPROVAL');
  const waiting = list.filter((task) => task.status === 'APPROVED' && task.order_status === 'AWAITING_APPROVAL');
  const ready = list.filter((task) => task.status === 'APPROVED' && task.order_status !== 'AWAITING_APPROVAL');
  const outForDelivery = list.filter((task) => task.status === 'DISPATCHED');
  const problems = list.filter(hasProblem);
  const manual = list.filter((task) => task.reservation_health === 'LOST' && task.order_status === 'DISPATCHING');
  return (
    <div className="stack">
      <PageHead title={`Tasks at ${session?.store_id ?? ''}`} subtitle="You see and act only on this node's tasks" actions={<SourceBadges />} />
      <SystemBanner audience="staff" />
      {manual.map((task) => (
        <Alert key={task.task_id} tone="danger" title={`Manual action needed: ${task.order_id}`}>
          Another node has already dispatched its part, and this node's reservation is gone. The system cannot recover this automatically. Check stock in the source system and coordinate with the customer.
        </Alert>
      ))}
      {(reviews.data?.length ?? 0) > 0 && (
        <Alert tone="info" title={`${reviews.data!.length} AI suggestions are waiting for a human decision`}>
          <Link to="/staff/reviews">Open the AI review queue</Link>
        </Alert>
      )}
      <div className="kpis">
        <Kpi icon={Inbox} label="To approve" value={pending.length} />
        <Kpi icon={Hourglass} label="Approved, others pending" value={waiting.length} />
        <Kpi icon={PackageCheck} label="Ready to dispatch" value={ready.length} />
        <Kpi icon={Truck} label="Out for delivery" value={outForDelivery.length} />
        <Kpi icon={TriangleAlert} label="With problems" value={problems.length} {...(problems.length ? { tone: 'danger' as const } : {})} />
        <Kpi icon={CircleCheck} label="Completed" value={list.filter((task) => task.status === 'DELIVERED').length} />
      </div>
      {tasks.loading && !tasks.data && <Loading what="Loading tasks" />}
      {Boolean(tasks.error) && <Alert tone="danger">{explainError(tasks.error)}</Alert>}
      {[
        ['To approve', pending],
        ['Ready to dispatch', ready],
        ['Out for delivery', outForDelivery],
        ['Approved, waiting for other nodes', waiting],
      ].map(([title, group]) =>
        (group as Task[]).length ? (
          <Card key={title as string} title={title as string}>
            <TaskTable tasks={group as Task[]} />
          </Card>
        ) : null,
      )}
      {!tasks.loading && !list.some((task) => ['PENDING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(task.status)) && (
        <Card>
          <Empty>No open tasks at this node. New ones appear here by themselves.</Empty>
        </Card>
      )}
    </div>
  );
}

export function StaffHistory() {
  const tasks = useLiveData(() => api<Task[]>('/staff/tasks'));
  const closed = (tasks.data ?? []).filter((task) => ['DELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED'].includes(task.status)).reverse();
  return (
    <div className="stack">
      <PageHead title="Fulfilment history" subtitle="Completed and closed tasks at this node" />
      <Card>{closed.length ? <TaskTable tasks={closed} /> : <Empty>Nothing yet.</Empty>}</Card>
    </div>
  );
}

function ApprovalProgress({ order, myTaskId }: { order: OrderDetail; myTaskId: string }) {
  const approved = order.shipments.filter((shipment) => shipment.status !== 'PENDING_APPROVAL').length;
  return (
    <Card title={`Approvals: ${approved} of ${order.shipments.length} nodes`}>
      <div className="card-body stack small">
        {order.shipments.map((shipment) => (
          <div key={shipment.task_id} className="spread">
            <span>
              {shipment.node_id} {shipment.task_id === myTaskId && <Badge tone="info">This task</Badge>}
            </span>
            <OrderStatus status={shipment.status} />
          </div>
        ))}
        <p className="muted">The order is approved only when every node has approved its own part.</p>
      </div>
    </Card>
  );
}

function PickingListView({ document }: { document: PickingList }) {
  return (
    <Card title={`Picking list · ${document.shipping_node.name}`} actions={<button type="button" className="btn small no-print" onClick={() => window.print()}>Print</button>}>
      <div className="card-body stack">
        <NotATaxInvoice />
        <div className="kpis small">
          <div><div className="muted">Order</div><strong>{document.order_id}</strong></div>
          <div><div className="muted">Task</div><span className="mono">{document.task_id.slice(0, 8)}</span></div>
          <div><div className="muted">Customer</div>{document.customer_company}</div>
          <div><div className="muted">Sales store</div>{document.sales_store.name}</div>
          <div><div className="muted">Requested</div>{formatTime(document.requested_delivery_at)}</div>
          <div><div className="muted">Estimate</div>{formatTime(document.eta)}</div>
          <div><div className="muted">Status</div>{statusText(document.status)}</div>
          <div><div className="muted">Approved by</div>{document.approver ?? '—'} {document.approved_at ? `· ${formatTime(document.approved_at)}` : ''}</div>
        </div>
        <div className="small"><span className="muted">Deliver to: </span>{document.site_address}</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>SKU</th><th>Product</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Line total</th></tr>
            </thead>
            <tbody>
              {document.lines.map((line) => (
                <tr key={line.sku_id}>
                  <td className="mono nowrap">{line.sku_id}</td>
                  <td>{line.name}</td>
                  <td className="num nowrap"><strong>{line.quantity} {line.unit}</strong></td>
                  <td className="num nowrap">{formatSek(line.unit_price_sek)}</td>
                  <td className="num nowrap">{formatSek(line.line_total_sek)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

export function TaskPage({ readOnly }: { readOnly?: boolean }) {
  const { id = '' } = useParams();
  const { session } = useSession();
  const tasks = useLiveData(() => api<Task[]>('/staff/tasks'));
  const picklist = useLiveData(() => api<PickingList>(`/staff/tasks/${id}/picklist`), [id]);
  const task = tasks.data?.find((candidate) => candidate.task_id === id);
  const orderId = task?.order_id;
  const order = useLiveData(() => (orderId ? api<OrderDetail>(`/orders/${orderId}`) : Promise.resolve(null)), [orderId]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [deliveredQty, setDeliveredQty] = useState<string | null>(null);
  const [note, setNote] = useState('');

  if (picklist.error instanceof ApiError && picklist.error.status === 403) {
    return <Alert tone="danger" title="This task belongs to another node">{explainError(picklist.error)}</Alert>;
  }
  if ((tasks.loading && !tasks.data) || (picklist.loading && !picklist.data)) return <Loading what="Loading the task" />;
  if (!task) return <Alert tone="danger" title="Task not found">It does not exist, or is not at your node.</Alert>;

  const reloadAll = async () => {
    await Promise.all([tasks.reload(), picklist.reload(), order.reload()]);
  };
  const act = async (action: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api<{ order_status: string }>(`/staff/tasks/${task.task_id}/${action}`, {
        method: 'POST',
        body: { version: task.version, ...body },
      });
      setSuccess(`${done} The order is now: ${statusText(result.order_status)}.`);
      setRejecting(false);
    } catch (failure) {
      setError(explainError(failure));
    }
    await reloadAll();
    setBusy(false);
  };

  const canAct = !readOnly && session?.role === 'staff' && session.store_id === task.node_id;
  const orderReady = ['APPROVED', 'DISPATCHING'].includes(task.order_status);
  const qtyText = deliveredQty ?? String(task.allocated_qty);
  const qty = Number(qtyText);
  const qtyValid = qtyText !== '' && Number.isInteger(qty) && qty >= 0 && qty <= task.allocated_qty;
  const back = readOnly ? '/admin/tasks' : '/staff';

  return (
    <div className="stack">
      <div className="no-print"><Link to={back}>← Tasks</Link></div>
      <PageHead title={`${task.order_id} at ${task.node_id}`} subtitle={<OrderStatus status={task.status} />} />
      <SystemBanner audience="staff" />
      {success && <Alert tone="ok">{success}</Alert>}
      {error && <Alert tone="danger" title="That did not go through">{error}</Alert>}
      {task.reservation_health === 'LOST' && (
        <Alert tone="danger" title="Reservation lost: dispatch is blocked">
          The source system no longer holds this stock.{' '}
          {task.order_status === 'DISPATCHING'
            ? 'Another node has already dispatched, so this order cannot be cancelled here. Manual action is needed: check the source system and contact the customer.'
            : 'A regional admin can cancel the order, and the customer can then place a new one.'}
        </Alert>
      )}
      {task.reservation_health === 'RENEWAL_FAILING' && (
        <Alert tone="warn" title="The reservation could not be renewed">
          The source system is not answering. The system keeps trying. Dispatch checks the stock with the source first, so it stays safe.
        </Alert>
      )}
      {task.at_risk && ['PENDING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(task.status) && (
        <Alert tone="warn" title="Delivery at risk">Estimated {formatTime(task.eta)}, requested {formatTime(task.requested_delivery_at)}.</Alert>
      )}
      {task.reject_reason && <Alert tone="info" title="Rejected">{task.reject_reason}</Alert>}

      <div className="grid grid-side">
        <div className="stack">
          {picklist.data && <PickingListView document={picklist.data} />}
        </div>
        <div className="stack">
          {order.data && <ApprovalProgress order={order.data} myTaskId={task.task_id} />}
          {canAct && (
            <Card title="Actions">
              <div className="card-body stack">
                {task.status === 'PENDING_APPROVAL' && !rejecting && (
                  <div className="row">
                    <button type="button" className="btn primary" disabled={busy} onClick={() => void act('approve', {}, 'Approved.')}>
                      Approve
                    </button>
                    <button type="button" className="btn danger" disabled={busy} onClick={() => setRejecting(true)}>
                      Reject
                    </button>
                  </div>
                )}
                {rejecting && (
                  <div className="stack">
                    <label className="field">
                      Why can this node not fulfil it?
                      <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                    </label>
                    <div className="row">
                      <button type="button" className="btn danger" disabled={busy || !reason.trim()} onClick={() => void act('reject', { reason: reason.trim() }, 'Rejected. The stock was released and another source was looked for.')}>
                        Confirm rejection
                      </button>
                      <button type="button" className="btn" onClick={() => setRejecting(false)}>Keep it</button>
                    </div>
                  </div>
                )}
                {task.status === 'APPROVED' && (
                  orderReady ? (
                    <button type="button" className="btn primary" disabled={busy || task.reservation_health === 'LOST'} onClick={() => void act('dispatch', {}, 'Dispatched, and the stock was taken out at the source.')}>
                      Dispatch
                    </button>
                  ) : (
                    <p className="small muted">Waiting for the other nodes to approve before anything can be dispatched.</p>
                  )
                )}
                {task.status === 'DISPATCHED' && (
                  <div className="stack">
                    <label className="field">
                      Quantity delivered (allocated: {task.allocated_qty})
                      <input type="number" min={0} max={task.allocated_qty} value={qtyText} onChange={(e) => setDeliveredQty(e.target.value)} />
                    </label>
                    <label className="field">
                      Note (optional)
                      <input value={note} onChange={(e) => setNote(e.target.value)} />
                    </label>
                    {qtyValid && qty < task.allocated_qty && <Alert tone="warn">This will mark the delivery as short.</Alert>}
                    <button type="button" className="btn primary" disabled={busy || !qtyValid} onClick={() => void act('deliver', { delivered_qty: qty, ...(note.trim() ? { note: note.trim() } : {}) }, 'Delivery recorded.')}>
                      Confirm delivery
                    </button>
                  </div>
                )}
                {['DELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED'].includes(task.status) && <p className="small muted">This task is closed.</p>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export function AdminOrderPage() {
  const { id = '' } = useParams();
  return (
    <div className="stack">
      <div className="no-print"><Link to="/admin/orders">← All orders</Link></div>
      <OrderDetailView orderId={id} canCancel={(order) => ['SUBMITTED', 'ALLOCATING', 'AWAITING_APPROVAL', 'NEEDS_REVIEW', 'NEEDS_REALLOCATION', 'APPROVED'].includes(order.status)} />
    </div>
  );
}

export function AdminTasks() {
  const tasks = useLiveData(() => api<Task[]>('/staff/tasks'));
  return (
    <div className="stack">
      <PageHead title="All tasks" subtitle="Read only. Each node's own staff act on its tasks." />
      <Card>{tasks.data?.length ? <TaskTable tasks={[...tasks.data].reverse()} showNode /> : <Empty>No tasks yet.</Empty>}</Card>
    </div>
  );
}

const FIELD_LABEL: Record<Review['field'], string> = { unit: 'Unit', category: 'Category', pack_size_kg: 'Pack size (kg)' };
const ALLOWED: Partial<Record<Review['field'], string[]>> = {
  unit: ['bag', 'piece', 'pallet', 'sheet', 'm', 'm2', 'm3', 'kg', 'roll'],
  category: ['cement', 'timber', 'gypsum_board', 'insulation', 'other'],
};

function ReviewRow({ review, onDone }: { review: Review; onDone: () => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(review.ai_suggestion ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noSuggestion = review.ai_suggestion === null;
  const pending = review.status === 'PENDING';
  const thinking = review.ai_status === 'QUEUED' || review.ai_status === 'IN_PROGRESS';

  const decide = async (path: 'approve' | 'reject', body: object) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/staff/normalization-reviews/${review.review_id}/${path}`, { method: 'POST', body });
      await onDone();
    } catch (failure) {
      setError(explainError(failure));
      setBusy(false);
    }
  };
  const allowed = ALLOWED[review.field];
  return (
    <Card>
      <div className="card-body stack">
        <div className="spread">
          <div className="row">
            <Badge tone="info">{FIELD_LABEL[review.field]}</Badge>
            <strong className="mono">“{review.raw_value}”</strong>
            <span className="small muted">from {review.source_system}</span>
          </div>
          <div className="row small">
            <Badge>{review.pending_record_count} records held</Badge>
            {pending ? <Badge tone="warn">Waiting for a human</Badge> : <Badge tone={review.status === 'APPROVED' ? 'ok' : 'danger'}>{statusText(review.status)}</Badge>}
          </div>
        </div>
        {review.source_description && <div className="small muted">Product: {review.source_description}</div>}
        <div className="spread">
          <div>
            <div className="small muted">AI suggestion</div>
            {thinking ? (
              <span className="muted">Asking the AI…</span>
            ) : noSuggestion ? (
              <span>No suggestion. {review.ai_reason}</span>
            ) : (
              <span>
                <strong>{review.ai_suggestion}</strong>{' '}
                {review.confidence !== null && (
                  <span className="small muted">
                    <span className="confidence"><span style={{ width: `${review.confidence * 100}%` }} /></span>
                    {formatPercent(review.confidence)} confidence
                  </span>
                )}
              </span>
            )}
            {review.ai_reason && !noSuggestion && <div className="small muted">{review.ai_reason}</div>}
            {review.ai_evidence && <div className="small muted">Quoted from the source: “{review.ai_evidence}”</div>}
          </div>
          {review.model_version && <span className="small muted mono">{review.model_version}</span>}
        </div>
        {!pending && (
          <div className="small muted">
            Decided by {review.reviewed_by} at {formatTime(review.reviewed_at)}
            {review.final_value ? `: ${review.final_value}` : ''}
            {review.outcome ? ` (${statusText(review.outcome)})` : ''}
            {review.reject_reason ? `. ${review.reject_reason}` : ''}
          </div>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        {pending && !editing && (
          <div className="row">
            <button type="button" className="btn primary" disabled={busy || noSuggestion} onClick={() => void decide('approve', {})}>
              Approve suggestion
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
              {noSuggestion ? 'Enter value' : 'Edit and approve'}
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void decide('reject', {})}>
              Reject
            </button>
          </div>
        )}
        {pending && editing && (
          <div className="row">
            {allowed ? (
              <select aria-label="Correct value" value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">Choose…</option>
                {allowed.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : (
              <input aria-label="Correct value" type="number" min={0} step="any" value={value} onChange={(e) => setValue(e.target.value)} />
            )}
            <button type="button" className="btn primary" disabled={busy || !value} onClick={() => void decide('approve', { value })}>
              Save and approve
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function ReviewsPage() {
  const [tab, setTab] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const reviews = useLiveData(() => api<Review[]>(`/staff/normalization-reviews?status=${tab}`), [tab]);
  const stats = useLiveData(() => api<AiStats>('/staff/normalization-reviews/stats'));
  const reload = async () => {
    await Promise.all([reviews.reload(), stats.reload()]);
  };
  return (
    <div className="stack">
      <PageHead title="AI data normalization" subtitle="New source values wait here before they can be used" />
      <div className="ai-rule">
        <strong>AI suggests, humans approve.</strong> Nothing is applied until someone here decides. Once approved, a value is reused automatically, with no further AI call. AI plays no part in routing, stock, reservations or ETA.
      </div>
      {stats.data && (
        <>
          {stats.data.is_live_provider ? (
            <Alert tone="ok">Suggestions come from a live model: {stats.data.provider} ({stats.data.model_version}).</Alert>
          ) : (
            <Alert tone="warn" title="Mock provider">Suggestions come from simple keyword rules, not an AI model. This is a demonstration of the workflow only.</Alert>
          )}
          <div className="kpis">
            <Kpi icon={Sparkles} label="AI calls" value={stats.data.ai_calls_total} />
            <Kpi icon={Repeat} label="Reused without AI" value={stats.data.normalization_cache_hits_total} hint="Approved mapping applied" />
            <Kpi label="Reuse rate" value={formatPercent(stats.data.normalization_cache_hit_rate)} />
            <Kpi label="Accepted / edited / rejected" value={<span style={{ fontSize: '1.1rem' }}>{stats.data.outcomes.accepted_as_is ?? 0} / {stats.data.outcomes.edited ?? 0} / {stats.data.outcomes.rejected ?? 0}</span>} />
          </div>
        </>
      )}
      <div className="row">
        {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((status) => (
          <button key={status} type="button" className={`btn small ${tab === status ? 'primary' : ''}`} onClick={() => setTab(status)}>
            {statusText(status)}
          </button>
        ))}
      </div>
      {reviews.loading && !reviews.data && <Loading what="Loading the queue" />}
      {Boolean(reviews.error) && <Alert tone="danger">{explainError(reviews.error)}</Alert>}
      {reviews.data && !reviews.data.length && <Card><Empty>Nothing here.</Empty></Card>}
      {reviews.data?.map((review) => <ReviewRow key={`${review.review_id}-${review.ai_status}`} review={review} onDone={reload} />)}
    </div>
  );
}
