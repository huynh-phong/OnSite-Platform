export interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Splits an SSE text stream into events, keeping an incomplete block for the next chunk. */
export function parseSseChunk(buffer: string): { events: StreamEvent[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    const type = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!type || !data) continue; // Comments and keep-alives.
    try {
      events.push({ type, data: JSON.parse(data) as Record<string, unknown> });
    } catch {
      // A malformed hint is not worth failing over: the data comes from REST.
    }
  }
  return { events, rest };
}

export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

export interface StreamOptions {
  getToken: () => string | null;
  onEvent: (event: StreamEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onUnauthorized: () => void;
  delays?: number[];
}

/**
 * EventSource cannot send an Authorization header, so the stream is read with fetch instead. That way the
 * token stays out of URLs. Reconnects with backoff, and onConnected tells the caller to reload from REST,
 * since events may have been missed in between.
 */
export function openStream(options: StreamOptions): () => void {
  const delays = options.delays ?? RECONNECT_DELAYS_MS;
  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    const token = options.getToken();
    if (stopped || !token) return;
    controller = new AbortController();
    try {
      const response = await fetch('/api/v1/stream', {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (response.status === 401) {
        options.onUnauthorized();
        return;
      }
      if (!response.ok || !response.body) throw new Error(`Stream refused: ${response.status}`);
      attempt = 0;
      options.onConnected();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const event of events) options.onEvent(event);
      }
    } catch {
      // Falls through to reconnect.
    }
    if (stopped) return;
    options.onDisconnected();
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 10000;
    attempt += 1;
    timer = setTimeout(() => void run(), delay);
  };
  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}
