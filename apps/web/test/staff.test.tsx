import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, loginAs, mockApi, order, picklist, renderAt, review, stats, task } from './helpers';

const STORE_B = { store_id: 'SE-STORE-B' };
const taskRoutes = (taskOverrides: object = {}, orderOverrides: object = {}) => ({
  ...baseRoutes,
  'GET /staff/tasks': [task(taskOverrides)],
  'GET /staff/tasks/t-b/picklist': picklist,
  'GET /orders/SE-ORD-000001': order(orderOverrides),
  'GET /staff/normalization-reviews': [],
});

describe('staff task list', () => {
  it('groups tasks by what needs doing, for this node', async () => {
    loginAs('staff', STORE_B);
    mockApi({
      ...baseRoutes,
      'GET /staff/normalization-reviews': [review],
      'GET /staff/tasks': [
        task({ task_id: 'a' }),
        task({ task_id: 'b', status: 'APPROVED', order_status: 'APPROVED', order_id: 'SE-ORD-000002' }),
        task({ task_id: 'c', status: 'DELIVERED', order_status: 'DELIVERED', order_id: 'SE-ORD-000003' }),
      ],
    });
    renderAt('/staff');
    expect(await screen.findByRole('heading', { name: 'Tasks at SE-STORE-B' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'To approve' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ready to dispatch' })).toBeInTheDocument();
    expect(await screen.findByText(/AI suggestions are waiting/)).toBeInTheDocument();
  });

  it('warns that stock cannot be trusted during a source outage', async () => {
    loginAs('staff', STORE_B);
    mockApi({
      ...taskRoutes(),
      'GET /system/status': { inventory_trusted: false, stale_reason: 'LAST_SYNC_FAILED', last_successful_sync_at: null, verified_age_s: 120, stale_after_s: 60, connector_enabled: true, source_reachable: false },
    });
    renderAt('/staff');
    expect(await screen.findByText(/no stock will be committed/)).toBeInTheDocument();
    expect(screen.getByText(/source system is not responding/)).toBeInTheDocument();
  });

  it('asks for manual action for a lost reservation on a partly dispatched order', async () => {
    loginAs('staff', STORE_B);
    mockApi({ ...baseRoutes, 'GET /staff/normalization-reviews': [], 'GET /staff/tasks': [task({ status: 'APPROVED', order_status: 'DISPATCHING', reservation_health: 'LOST' })] });
    renderAt('/staff');
    expect(await screen.findByText('Manual action needed: SE-ORD-000001')).toBeInTheDocument();
    expect(screen.getByText(/cannot recover this automatically/)).toBeInTheDocument();
  });
});

describe('working a task', () => {
  it('approves with the task version, and shows progress across nodes from the server', async () => {
    loginAs('staff', STORE_B);
    let approved = false;
    const calls = mockApi({
      ...baseRoutes,
      'GET /staff/tasks': () => ({ body: [task(approved ? { status: 'APPROVED', version: 2 } : {})] }),
      'GET /staff/tasks/t-b/picklist': picklist,
      'GET /orders/SE-ORD-000001': () => ({
        body: order({
          shipments: order().shipments.map((s) => (approved && s.task_id === 't-b' ? { ...s, status: 'APPROVED' } : s)),
        }),
      }),
      'POST /staff/tasks/t-b/approve': () => {
        approved = true;
        return { body: { order_status: 'AWAITING_APPROVAL' } };
      },
    });
    renderAt('/staff/tasks/t-b');
    expect(await screen.findByText('Approvals: 0 of 2 nodes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Approved\. The order is now: Awaiting approval/)).toBeInTheDocument();
    expect(await screen.findByText('Approvals: 1 of 2 nodes')).toBeInTheDocument();
    expect(calls.find((call) => call.url.endsWith('/approve'))?.body).toEqual({ version: 1 });
    expect(screen.getByText(/Waiting for the other nodes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dispatch' })).not.toBeInTheDocument();
  });

  it('on a version conflict says so, shows no success, and reloads', async () => {
    loginAs('staff', STORE_B);
    const calls = mockApi({
      ...taskRoutes(),
      'POST /staff/tasks/t-b/approve': () => ({ status: 409, body: { error: { code: 'VERSION_CONFLICT', message: 'x', request_id: 'r' } } }),
    });
    renderAt('/staff/tasks/t-b');
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Someone else changed this/)).toBeInTheDocument();
    expect(screen.queryByText(/The order is now/)).not.toBeInTheDocument();
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/v1/staff/tasks').length).toBeGreaterThan(1));
  });

  it.each([
    ['RESERVATION_LOST', /no longer holds this stock/],
    ['SOURCE_UNAVAILABLE', /cannot be reached, so nothing was changed/],
    ['INVALID_TRANSITION', /no longer possible/],
    ['FORBIDDEN', /server refused it/],
  ])('explains %s when dispatch is refused', async (code, message) => {
    loginAs('staff', STORE_B);
    mockApi({
      ...taskRoutes({ status: 'APPROVED', order_status: 'APPROVED' }),
      'POST /staff/tasks/t-b/dispatch': () => ({ status: code === 'SOURCE_UNAVAILABLE' ? 503 : code === 'FORBIDDEN' ? 403 : 409, body: { error: { code, message: 'x', request_id: 'r' } } }),
    });
    renderAt('/staff/tasks/t-b');
    await userEvent.click(await screen.findByRole('button', { name: 'Dispatch' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/The order is now/)).not.toBeInTheDocument();
  });

  it('blocks dispatch when the reservation is lost', async () => {
    loginAs('staff', STORE_B);
    mockApi(taskRoutes({ status: 'APPROVED', order_status: 'APPROVED', reservation_health: 'LOST' }));
    renderAt('/staff/tasks/t-b');
    expect(await screen.findByText(/Reservation lost: dispatch is blocked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dispatch' })).toBeDisabled();
  });

  it('warns about a failing renewal', async () => {
    loginAs('staff', STORE_B);
    mockApi(taskRoutes({ status: 'APPROVED', order_status: 'APPROVED', reservation_health: 'RENEWAL_FAILING' }));
    renderAt('/staff/tasks/t-b');
    expect(await screen.findByText('The reservation could not be renewed')).toBeInTheDocument();
  });

  it('requires a reason to reject', async () => {
    loginAs('staff', STORE_B);
    const calls = mockApi({ ...taskRoutes(), 'POST /staff/tasks/t-b/reject': { order_status: 'NEEDS_REVIEW' } });
    renderAt('/staff/tasks/t-b');
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Why can this node/), 'Forklift broken');
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/reject'))?.body).toEqual({ version: 1, reason: 'Forklift broken' }));
  });

  it('records delivery, defaulting to the allocated quantity, and warns when short', async () => {
    loginAs('staff', STORE_B);
    const calls = mockApi({ ...taskRoutes({ status: 'DISPATCHED', order_status: 'DISPATCHED' }), 'POST /staff/tasks/t-b/deliver': { order_status: 'DELIVERED' } });
    renderAt('/staff/tasks/t-b');
    const quantity = await screen.findByLabelText(/Quantity delivered/);
    expect(quantity).toHaveValue(54);
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '50');
    expect(screen.getByText(/mark the delivery as short/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/deliver'))?.body).toEqual({ version: 1, delivered_qty: 50 }));
  });

  it('shows the picking list, labelled as not a tax invoice', async () => {
    loginAs('staff', STORE_B);
    mockApi(taskRoutes());
    renderAt('/staff/tasks/t-b');
    expect(await screen.findByText(/Not a tax invoice/)).toBeInTheDocument();
    expect(screen.getByText('Demo Site 1, Askim')).toBeInTheDocument();
    expect(screen.getByText('54 bag')).toBeInTheDocument();
  });

  it('a task of another node shows the refusal and offers no actions', async () => {
    loginAs('staff', { store_id: 'SE-HUB-01' });
    mockApi({
      ...baseRoutes,
      'GET /staff/tasks': [],
      'GET /staff/tasks/t-b/picklist': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'x', request_id: 'r' } } }),
    });
    renderAt('/staff/tasks/t-b');
    expect(await screen.findByText('This task belongs to another node')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('an admin gets a read-only view', async () => {
    loginAs('admin');
    mockApi(taskRoutes());
    renderAt('/admin/tasks/t-b');
    await screen.findByText('Approvals: 0 of 2 nodes');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});

describe('AI review', () => {
  const routes = (overrides: object = {}) => ({
    ...baseRoutes,
    'GET /staff/normalization-reviews?status=PENDING': [{ ...review, ...overrides }],
    'GET /staff/normalization-reviews?status=APPROVED': [],
    'GET /staff/normalization-reviews/stats': stats,
  });

  it('shows the suggestion and everything needed to judge it, and that humans decide', async () => {
    loginAs('staff', STORE_B);
    mockApi(routes());
    renderAt('/staff/reviews');
    expect(await screen.findByText('AI suggests, humans approve.')).toBeInTheDocument();
    expect(await screen.findByText('“säck”')).toBeInTheDocument();
    expect(screen.getByText('bag')).toBeInTheDocument();
    expect(screen.getByText(/92% confidence/)).toBeInTheDocument();
    expect(screen.getByText('Swedish for bag')).toBeInTheDocument();
    expect(screen.getByText('12 records held')).toBeInTheDocument();
    expect(screen.getByText('from sweden-legacy')).toBeInTheDocument();
    expect(screen.getByText('Waiting for a human')).toBeInTheDocument();
    expect(await screen.findByText(/live model: gemini/)).toBeInTheDocument();
    expect(screen.getByText('AI calls')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('says plainly when the provider is the mock', async () => {
    loginAs('staff', STORE_B);
    mockApi({ ...routes(), 'GET /staff/normalization-reviews/stats': { ...stats, provider: 'mock', is_live_provider: false, model_version: 'mock-rules-v1' } });
    renderAt('/staff/reviews');
    expect(await screen.findByText('Mock provider')).toBeInTheDocument();
    expect(screen.getByText(/not an AI model/)).toBeInTheDocument();
  });

  it('approves as suggested, then reloads the queue', async () => {
    loginAs('staff', STORE_B);
    let done = false;
    const calls = mockApi({
      ...routes(),
      'GET /staff/normalization-reviews?status=PENDING': () => ({ body: done ? [] : [review] }),
      'POST /staff/normalization-reviews/r1/approve': () => {
        done = true;
        return { body: { ...review, status: 'APPROVED' } };
      },
    });
    renderAt('/staff/reviews');
    await userEvent.click(await screen.findByRole('button', { name: 'Approve suggestion' }));
    expect(await screen.findByText('Nothing here.')).toBeInTheDocument();
    expect(calls.find((call) => call.url.endsWith('/approve'))?.body).toEqual({});
  });

  it('edits and approves, limited to allowed values', async () => {
    loginAs('staff', STORE_B);
    const calls = mockApi({ ...routes(), 'POST /staff/normalization-reviews/r1/approve': { ...review, status: 'APPROVED' } });
    renderAt('/staff/reviews');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit and approve' }));
    await userEvent.selectOptions(screen.getByLabelText('Correct value'), 'piece');
    await userEvent.click(screen.getByRole('button', { name: 'Save and approve' }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/approve'))?.body).toEqual({ value: 'piece' }));
  });

  it('rejects', async () => {
    loginAs('staff', STORE_B);
    const calls = mockApi({ ...routes(), 'POST /staff/normalization-reviews/r1/reject': { ...review, status: 'REJECTED' } });
    renderAt('/staff/reviews');
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/reject'))).toBe(true));
  });

  it('with no suggestion, a person must enter the value', async () => {
    loginAs('staff', STORE_B);
    mockApi(routes({ ai_suggestion: null, confidence: null, ai_status: 'FAILED', ai_reason: 'AI unavailable – manual review' }));
    renderAt('/staff/reviews');
    expect(await screen.findByRole('button', { name: 'Approve suggestion' })).toBeDisabled();
    expect(screen.getByText(/AI unavailable – manual review/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter value' })).toBeEnabled();
  });

  it('shows an API error on a decision', async () => {
    loginAs('staff', STORE_B);
    mockApi({ ...routes(), 'POST /staff/normalization-reviews/r1/approve': () => ({ status: 409, body: { error: { code: 'REVIEW_NOT_PENDING', message: 'Review is already APPROVED', request_id: 'r' } } }) });
    renderAt('/staff/reviews');
    await userEvent.click(await screen.findByRole('button', { name: 'Approve suggestion' }));
    expect(await screen.findByText('Review is already APPROVED')).toBeInTheDocument();
  });
});
