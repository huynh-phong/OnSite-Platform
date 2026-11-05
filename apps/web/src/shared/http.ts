/** For the two dashboards, which use a same-origin HttpOnly session rather than a token. */
export class DashboardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function sessionFetch<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      ...(options.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new DashboardError(0, 'NETWORK_ERROR', 'This service cannot be reached.');
  }
  const payload = (await response.json().catch(() => undefined)) as { error?: { code: string; message: string } } | undefined;
  if (!response.ok) {
    throw new DashboardError(response.status, payload?.error?.code ?? 'ERROR', payload?.error?.message ?? `Failed (${response.status})`);
  }
  return payload as T;
}
