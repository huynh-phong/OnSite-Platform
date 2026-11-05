/** ETA rules. All parameters are simulated assumptions from config. No I/O and no AI. */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface EtaParams {
  timeZone: string;
  dispatchSlots: string[];
  avgSpeedKmh: number;
  unloadMinutes: number;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSeconds;
}

/** The instant a wall-clock time occurs in the zone. Correct across daylight-saving changes. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(first), timeZone));
}

/** The first dispatch slot at or after readyAt, on the same local day or a later one. */
export function nextDispatchSlot(readyAt: Date, params: Pick<EtaParams, 'timeZone' | 'dispatchSlots'>): Date {
  const { year, month, day } = zonedParts(readyAt, params.timeZone);
  const slots = params.dispatchSlots.map((slot) => slot.split(':').map(Number) as [number, number]);
  for (let offset = 0; offset < 3; offset += 1) {
    for (const [hour, minute] of slots) {
      const candidate = zonedTimeToUtc(year, month, day + offset, hour, minute, params.timeZone);
      if (candidate.getTime() >= readyAt.getTime()) return candidate;
    }
  }
  throw new Error('No dispatch slot found');
}

export interface ShipmentEtaInput {
  /** Approval time, or the current time for a provisional estimate before approval. */
  approvedAt: Date;
  /** When set, the shipment has left and the slot no longer applies. */
  dispatchedAt?: Date | null;
  provisional: boolean;
  prepMinutes: number;
  node: LatLng;
  site: LatLng;
}

export interface ShipmentEta {
  readyAt: Date;
  dispatchAt: Date;
  eta: Date;
  inputs: {
    provisional: boolean;
    dispatched: boolean;
    approved_at: string;
    prep_minutes: number;
    ready_at: string;
    dispatch_at: string;
    distance_km: number;
    avg_speed_kmh: number;
    unload_minutes: number;
    travel_minutes: number;
    time_zone: string;
    slots: string[];
  };
}

export function computeShipmentEta(input: ShipmentEtaInput, params: EtaParams): ShipmentEta {
  const readyAt = new Date(input.approvedAt.getTime() + input.prepMinutes * 60_000);
  const dispatchAt = input.dispatchedAt ?? nextDispatchSlot(readyAt, params);
  const distanceKm = haversineKm(input.node, input.site);
  const travelMinutes = (distanceKm / params.avgSpeedKmh) * 60 + params.unloadMinutes;
  const eta = new Date(dispatchAt.getTime() + travelMinutes * 60_000);
  return {
    readyAt,
    dispatchAt,
    eta,
    inputs: {
      provisional: input.provisional,
      dispatched: Boolean(input.dispatchedAt),
      approved_at: input.approvedAt.toISOString(),
      prep_minutes: input.prepMinutes,
      ready_at: readyAt.toISOString(),
      dispatch_at: dispatchAt.toISOString(),
      distance_km: Math.round(distanceKm * 10) / 10,
      avg_speed_kmh: params.avgSpeedKmh,
      unload_minutes: params.unloadMinutes,
      travel_minutes: Math.round(travelMinutes * 10) / 10,
      time_zone: params.timeZone,
      slots: params.dispatchSlots,
    },
  };
}

/** The order is as late as its latest shipment, and at risk when that is past the requested time. */
export function summarizeOrderEta(shipments: { eta: Date }[], requestedDeliveryAt: Date) {
  if (shipments.length === 0) return { eta: null, atRisk: false };
  const eta = new Date(Math.max(...shipments.map((shipment) => shipment.eta.getTime())));
  return { eta, atRisk: eta.getTime() > requestedDeliveryAt.getTime() };
}
