import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../../src/auth.js';
import { callLlm, MockLlmProvider, validateLlmOutput, type SuggestInput } from '../../src/connectors/llm.js';
import { computeShipmentEta, haversineKm, nextDispatchSlot, summarizeOrderEta } from '../../src/modules/eta/eta.js';
import { assessFreshness } from '../../src/modules/inventory/freshness.js';
import { isUnitCompatible, safetyStock, usableStock } from '../../src/modules/inventory/usable.js';
import { isInScope, NotificationHub } from '../../src/modules/notifications/hub.js';
import {
  canTransitionOrder,
  canTransitionTask,
  assertOrderTransition,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type OrderStatus,
  type TaskStatus,
} from '../../src/modules/orders/state-machine.js';
import { backoffMs } from '../../src/modules/outbox/outbox.service.js';
import { statesPackWeight } from '../../src/modules/normalization/values.js';

describe('state machines', () => {
  const allowedOrder: [OrderStatus, OrderStatus][] = [
    ['SUBMITTED', 'ALLOCATING'],
    ['ALLOCATING', 'AWAITING_APPROVAL'],
    ['AWAITING_APPROVAL', 'APPROVED'],
    ['APPROVED', 'DISPATCHING'],
    ['DISPATCHING', 'DISPATCHED'],
    ['DISPATCHED', 'DELIVERED'],
    ['ALLOCATING', 'NEEDS_REVIEW'],
    ['AWAITING_APPROVAL', 'NEEDS_REALLOCATION'],
    ['NEEDS_REALLOCATION', 'ALLOCATING'],
    ['AWAITING_APPROVAL', 'EXPIRED'],
    ['SUBMITTED', 'CANCELLED'],
    ['ALLOCATING', 'CANCELLED'],
    ['AWAITING_APPROVAL', 'CANCELLED'],
    ['NEEDS_REVIEW', 'CANCELLED'],
    // The customer accepts what can be supplied now.
    ['NEEDS_REVIEW', 'ALLOCATING'],
    ['NEEDS_REALLOCATION', 'CANCELLED'],
    // Extension approved for Issue 1, limited to admins by the order service.
    ['APPROVED', 'CANCELLED'],
  ];
  const allowedTask: [TaskStatus, TaskStatus][] = [
    ['PENDING_APPROVAL', 'APPROVED'],
    ['APPROVED', 'DISPATCHED'],
    ['DISPATCHED', 'DELIVERED'],
    ['PENDING_APPROVAL', 'REJECTED'],
    ['PENDING_APPROVAL', 'EXPIRED'],
    // Closing a task together with its order.
    ['PENDING_APPROVAL', 'CANCELLED'],
    ['APPROVED', 'CANCELLED'],
    ['APPROVED', 'EXPIRED'],
  ];

  it('allows exactly the listed order transitions, and forbids every other pair', () => {
    const allowed = new Set(allowedOrder.map(([from, to]) => `${from}>${to}`));
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransitionOrder(from, to), `${from} > ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
    expect(Object.values(ORDER_TRANSITIONS).flat()).toHaveLength(allowedOrder.length);
  });

  it('allows exactly the listed task transitions, and forbids every other pair', () => {
    const allowed = new Set(allowedTask.map(([from, to]) => `${from}>${to}`));
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(canTransitionTask(from, to), `${from} > ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
    expect(Object.values(TASK_TRANSITIONS).flat()).toHaveLength(allowedTask.length);
  });

  it('refuses a forbidden transition with a 409', () => {
    expect(() => assertOrderTransition('DELIVERED', 'CANCELLED')).toThrowError(/cannot go/);
    try {
      assertOrderTransition('DISPATCHED', 'CANCELLED');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: 'INVALID_TRANSITION' });
    }
  });
});

describe('usable stock', () => {
  it('follows the formula from the architecture report', () => {
    expect(safetyStock(60, 0.1)).toBe(6);
    expect(usableStock(60, 0, 0.1)).toBe(54);
    expect(usableStock(40, 0, 0.1)).toBe(36);
    expect(usableStock(60, 54, 0.1)).toBe(0);
    expect(usableStock(60, 60, 0.1)).toBe(0);
    expect(usableStock(0, 0, 0.1)).toBe(0);
  });

  it('rounds up without floating-point surprises', () => {
    // 30 x 0.1 is 3.0000000000000004 in floating point, which a naive ceil would turn into 4.
    expect(safetyStock(30, 0.1)).toBe(3);
    expect(safetyStock(70, 0.1)).toBe(7);
    expect(safetyStock(61, 0.1)).toBe(7);
    expect(safetyStock(1, 0.1)).toBe(1);
    for (let onHand = 0; onHand <= 2000; onHand += 1) {
      expect(safetyStock(onHand, 0.1)).toBe(Math.ceil(onHand / 10));
    }
  });

  it('counts a piece as a sellable item, but never converts between measures', () => {
    expect(isUnitCompatible('bag', 'bag')).toBe(true);
    expect(isUnitCompatible('piece', 'bag')).toBe(true);
    expect(isUnitCompatible('piece', 'm')).toBe(false);
    expect(isUnitCompatible('bag', 'pallet')).toBe(false);
    expect(isUnitCompatible(null, 'bag')).toBe(false);
    expect(isUnitCompatible('bag', null)).toBe(false);
  });
});

describe('inventory trust', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const cursor = {
    lastSeq: 5,
    lastSuccessfulSyncAt: new Date('2026-11-05T11:59:50Z'),
    lastError: null,
    continuityOk: true,
  };
  const assess = (over: object = {}, connectorEnabled = true) =>
    assessFreshness({ now, connectorEnabled, cursor: { ...cursor, ...over }, staleAfterSeconds: 60 });

  it('trusts a recent verified sync', () => {
    expect(assess()).toMatchObject({ trusted: true, staleReason: null, verifiedAgeSeconds: 10 });
  });
  it.each([
    [{ lastError: 'SOURCE_UNAVAILABLE' }, 'LAST_SYNC_FAILED'],
    [{ lastSuccessfulSyncAt: null }, 'NEVER_SYNCED'],
    [{ continuityOk: false }, 'CURSOR_DISCONTINUITY'],
    [{ lastSuccessfulSyncAt: new Date('2026-11-05T11:58:00Z') }, 'SYNC_TOO_OLD'],
  ])('%j is not trusted: %s', (over, reason) => {
    expect(assess(over)).toMatchObject({ trusted: false, staleReason: reason });
  });
  it('does not trust a missing cursor or a disabled connector', () => {
    expect(
      assessFreshness({ now, connectorEnabled: true, cursor: null, staleAfterSeconds: 60 }).staleReason,
    ).toBe('NO_CURSOR');
    expect(assess({}, false).staleReason).toBe('CONNECTOR_DISABLED');
  });
  it('treats exactly the threshold as still fresh', () => {
    expect(assess({ lastSuccessfulSyncAt: new Date('2026-11-05T11:59:00Z') }).trusted).toBe(true);
  });
});

describe('ETA', () => {
  const params = {
    timeZone: 'Europe/Stockholm',
    dispatchSlots: ['07:00', '09:00', '11:00', '13:00', '15:00'],
    avgSpeedKmh: 40,
    unloadMinutes: 15,
  };

  it('computes distance by haversine', () => {
    expect(haversineKm({ lat: 57.6554, lng: 12.0138 }, { lat: 57.629, lng: 11.929 })).toBeCloseTo(5.84, 1);
    expect(haversineKm({ lat: 1, lng: 1 }, { lat: 1, lng: 1 })).toBe(0);
  });

  it('picks the first slot at or after the ready time, in Stockholm time', () => {
    // 08:30 in Stockholm (UTC+1 in November).
    expect(nextDispatchSlot(new Date('2026-11-09T07:30:00Z'), params).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    // Exactly on a slot.
    expect(nextDispatchSlot(new Date('2026-11-09T08:00:00Z'), params).toISOString()).toBe('2026-11-09T08:00:00.000Z');
  });

  it('rolls over to the next day after the last slot', () => {
    expect(nextDispatchSlot(new Date('2026-11-09T14:30:00Z'), params).toISOString()).toBe('2026-11-10T06:00:00.000Z');
  });

  it('rolls over across a month and a year', () => {
    expect(nextDispatchSlot(new Date('2026-12-31T15:00:00Z'), params).toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });

  it('uses summer time when Stockholm is on it', () => {
    // 08:30 local on UTC+2.
    expect(nextDispatchSlot(new Date('2026-07-01T06:30:00Z'), params).toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('is right across both daylight-saving changes', () => {
    // Clocks go forward on 2026-03-29 and back on 2026-10-25. 07:00 local is 05:00Z and then 06:00Z.
    expect(nextDispatchSlot(new Date('2026-03-28T16:00:00Z'), params).toISOString()).toBe('2026-03-29T05:00:00.000Z');
    expect(nextDispatchSlot(new Date('2026-10-24T16:00:00Z'), params).toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });

  it('adds prep and travel, and records the inputs for explaining the result', () => {
    const result = computeShipmentEta(
      {
        approvedAt: new Date('2026-11-09T06:00:00Z'),
        provisional: false,
        prepMinutes: 60,
        node: { lat: 57.6554, lng: 12.0138 },
        site: { lat: 57.629, lng: 11.929 },
      },
      params,
    );
    // Ready 07:00Z (08:00 local), first slot 09:00 local = 08:00Z, 5.8 km at 40 km/h plus 15 min unloading.
    expect(result.dispatchAt.toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect((result.eta.getTime() - result.dispatchAt.getTime()) / 60000).toBeCloseTo(23.6, 0);
    expect(result.inputs).toMatchObject({ prep_minutes: 60, avg_speed_kmh: 40, unload_minutes: 15, provisional: false });
  });

  it('uses the actual departure once a shipment has left', () => {
    const dispatchedAt = new Date('2026-11-09T09:17:00Z');
    const result = computeShipmentEta(
      {
        approvedAt: new Date('2026-11-09T06:00:00Z'),
        dispatchedAt,
        provisional: false,
        prepMinutes: 60,
        node: { lat: 57.6554, lng: 12.0138 },
        site: { lat: 57.6554, lng: 12.0138 },
      },
      params,
    );
    expect(result.dispatchAt).toEqual(dispatchedAt);
    expect(result.eta.toISOString()).toBe('2026-11-09T09:32:00.000Z');
  });

  it('takes the latest shipment, and is at risk only when later than requested', () => {
    const early = new Date('2026-11-09T08:00:00Z');
    const late = new Date('2026-11-09T10:00:00Z');
    expect(summarizeOrderEta([{ eta: early }, { eta: late }], late)).toEqual({ eta: late, atRisk: false });
    expect(summarizeOrderEta([{ eta: early }, { eta: late }], early)).toEqual({ eta: late, atRisk: true });
    expect(summarizeOrderEta([], early)).toEqual({ eta: null, atRisk: false });
  });
});

describe('LLM output validation', () => {
  const unit: SuggestInput = { field: 'unit', rawValue: 'säck', description: null, allowedValues: ['bag', 'piece'] };
  const pack: SuggestInput = { field: 'pack_size_kg', rawValue: 'Byggcement 25kg säck', description: null, allowedValues: null };
  const good = { suggested_value: 'bag', confidence: 0.9, reason: 'Swedish for bag' };

  it('accepts a valid object or a valid JSON string', () => {
    expect(validateLlmOutput(unit, good)).toMatchObject({ suggestion: 'bag', confidence: 0.9 });
    expect(validateLlmOutput(unit, JSON.stringify(good))).toMatchObject({ suggestion: 'bag' });
  });

  it.each([
    ['not json'],
    [null],
    [42],
    [{ ...good, suggested_value: 'bucket' }],
    [{ ...good, suggested_value: null }],
    [{ ...good, confidence: 2 }],
    [{ ...good, confidence: '0.9' }],
    [{ ...good, reason: '' }],
    [{ suggested_value: 'bag' }],
  ])('rejects %j', (output) => {
    expect(validateLlmOutput(unit, output)).toBeUndefined();
  });

  it('requires a pack size to quote its evidence from the source text', () => {
    const answer = { suggested_value: '25', confidence: 0.9, reason: 'stated', evidence: '25kg' };
    expect(validateLlmOutput(pack, answer)).toMatchObject({ suggestion: '25', evidence: '25kg' });
    expect(validateLlmOutput(pack, { ...answer, evidence: undefined })).toBeUndefined();
    expect(validateLlmOutput(pack, { ...answer, evidence: '40kg' })).toBeUndefined();
    expect(validateLlmOutput(pack, { ...answer, suggested_value: '40' })).toBeUndefined();
    expect(validateLlmOutput(pack, { ...answer, suggested_value: '-1' })).toBeUndefined();
  });

  it('reports a timeout and a provider error without throwing', async () => {
    const slow = { modelVersion: 'x', suggest: () => new Promise(() => undefined) };
    await expect(callLlm(slow, unit, 10)).resolves.toEqual({ kind: 'unavailable' });
    const broken = { modelVersion: 'x', suggest: () => Promise.reject(new Error('down')) };
    await expect(callLlm(broken, unit, 10)).resolves.toEqual({ kind: 'unavailable' });
    const nonsense = { modelVersion: 'x', suggest: () => Promise.resolve('nonsense') };
    await expect(callLlm(nonsense, unit, 10)).resolves.toEqual({ kind: 'invalid' });
  });

  it('the mock suggests known values, and gives nothing valid for an unknown unit', async () => {
    const mock = new MockLlmProvider();
    const run = (input: SuggestInput) => callLlm(mock, input, 100);
    expect(await run(unit)).toMatchObject({ kind: 'ok', suggestion: 'bag' });
    expect(await run({ ...unit, rawValue: 'blorp', allowedValues: unit.allowedValues })).toEqual({ kind: 'invalid' });
    expect(await run(pack)).toMatchObject({ kind: 'ok', suggestion: '25' });
  });

  it('only asks for a pack size when the text states a weight', () => {
    expect(statesPackWeight('Byggcement Std 25kg säck')).toBe(true);
    expect(statesPackWeight('Portland cement 25 kg bag')).toBe(true);
    expect(statesPackWeight('Vapour barrier roll 25 m')).toBe(false);
  });
});

describe('JWT', () => {
  const secret = 'x'.repeat(40);
  const claims = { sub: 'staff.store-b', role: 'staff' as const, country: 'SE', store_id: 'SE-STORE-B' };

  it('round-trips the claims', () => {
    expect(verifyToken(signToken(claims, secret, 60), secret, 'SE')).toMatchObject(claims);
  });

  it('rejects a wrong secret, a tampered payload, an unsigned token and an expired token', () => {
    const token = signToken(claims, secret, 60);
    expect(() => verifyToken(token, 'y'.repeat(40), 'SE')).toThrow();
    const [header, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, role: 'admin', exp: 9999999999 })).toString('base64url');
    expect(() => verifyToken(`${header}.${forged}.${signature}`, secret, 'SE')).toThrow();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(() => verifyToken(`${none}.${payload}.`, secret, 'SE')).toThrow();
    expect(() => verifyToken(signToken(claims, secret, 60, Date.now() - 120_000), secret, 'SE')).toThrow();
  });

  it('rejects a token from another country', () => {
    expect(() => verifyToken(signToken(claims, secret, 60), secret, 'DK')).toThrow(/another country/);
  });
});

describe('notifications', () => {
  it('scopes staff to their node, customers to their orders, and shows admins everything', () => {
    const node = { nodeIds: ['SE-STORE-B'] };
    expect(isInScope({ role: 'staff', storeId: 'SE-STORE-B' }, node)).toBe(true);
    expect(isInScope({ role: 'staff', storeId: 'SE-HUB-01' }, node)).toBe(false);
    expect(isInScope({ role: 'admin' }, node)).toBe(true);
    expect(isInScope({ role: 'customer', customerId: 'A' }, { customerId: 'A' })).toBe(true);
    expect(isInScope({ role: 'customer', customerId: 'B' }, { customerId: 'A' })).toBe(false);
    expect(isInScope({ role: 'customer', customerId: 'A' }, { allStaff: true })).toBe(false);
    expect(isInScope({ role: 'staff', storeId: 'SE-HUB-01' }, { allStaff: true })).toBe(true);
  });

  it('delivers only to matching subscribers and stops after unsubscribing', () => {
    const hub = new NotificationHub();
    const received: string[] = [];
    const unsubscribe = hub.subscribe({
      role: 'staff',
      storeId: 'SE-STORE-B',
      send: (event) => received.push(event.type),
      close: () => undefined,
    });
    hub.publish({ type: 'task.assigned', scope: { nodeIds: ['SE-STORE-B'] }, data: {} });
    hub.publish({ type: 'task.assigned', scope: { nodeIds: ['SE-HUB-01'] }, data: {} });
    unsubscribe();
    hub.publish({ type: 'task.updated', scope: { nodeIds: ['SE-STORE-B'] }, data: {} });
    expect(received).toEqual(['task.assigned']);
  });
});

describe('outbox backoff', () => {
  it('grows exponentially, stays under the cap, and applies jitter', () => {
    expect(backoffMs(0, 2000, 300000, 1)).toBe(2000);
    expect(backoffMs(3, 2000, 300000, 1)).toBe(16000);
    expect(backoffMs(30, 2000, 300000, 1)).toBe(300000);
    expect(backoffMs(3, 2000, 300000, 0.5)).toBe(8000);
  });
});
