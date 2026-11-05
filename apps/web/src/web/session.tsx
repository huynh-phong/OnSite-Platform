import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, configureApi, currentToken } from './api';
import { openStream, type StreamEvent } from './sse';

export type Role = 'customer' | 'staff' | 'admin';

export interface Session {
  token: string;
  user_id: string;
  role: Role;
  store_id: string | null;
  customer_id: string | null;
  expires_at: number;
}

interface LoginResponse {
  access_token: string;
  expires_in: number;
  user_id: string;
  role: Role;
  store_id: string | null;
  customer_id: string | null;
}

const STORAGE_KEY = 'onsite.session';

function readStored(): Session | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Session | null;
    return stored && stored.expires_at > Date.now() ? stored : null;
  } catch {
    return null;
  }
}

interface SessionContextValue {
  session: Session | null;
  notice: string | null;
  login: (username: string, password: string) => Promise<Session>;
  logout: (notice?: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    const stored = readStored();
    configureApi({ token: stored?.token ?? null });
    return stored;
  });
  const [notice, setNotice] = useState<string | null>(null);

  const logout = useCallback((message?: string) => {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem('onsite.cart');
    configureApi({ token: null });
    setSession(null);
    setNotice(message ?? null);
  }, []);

  useEffect(() => {
    configureApi({ token: currentToken(), onUnauthorized: () => logout('Your session has expired. Please log in again.') });
  }, [logout]);

  // Log out when the token runs out, even on a screen that makes no requests.
  useEffect(() => {
    if (!session) return undefined;
    const timer = setTimeout(
      () => logout('Your session has expired. Please log in again.'),
      Math.min(session.expires_at - Date.now(), 2 ** 31 - 1),
    );
    return () => clearTimeout(timer);
  }, [session, logout]);

  const login = useCallback(async (username: string, password: string) => {
    const response = await api<LoginResponse>('/auth/login', { method: 'POST', body: { username, password } });
    const next: Session = {
      token: response.access_token,
      user_id: response.user_id,
      role: response.role,
      store_id: response.store_id,
      customer_id: response.customer_id,
      expires_at: Date.now() + response.expires_in * 1000,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    configureApi({ token: next.token });
    setNotice(null);
    setSession(next);
    return next;
  }, []);

  const value = useMemo(() => ({ session, notice, login, logout }), [session, notice, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('SessionProvider is missing');
  return value;
}

export const homeFor = (role: Role) => `/${role}`;

// ---------------------------------------------------------------- live updates

type Listener = (event: StreamEvent | null) => void;

interface LiveContextValue {
  connected: boolean;
  subscribe: (listener: Listener) => () => void;
  toasts: { id: number; text: string }[];
}

const LiveContext = createContext<LiveContextValue>({ connected: false, subscribe: () => () => undefined, toasts: [] });

const TOAST_TEXT: Record<string, string> = {
  'task.assigned': 'New fulfilment task assigned',
  'order.at_risk': 'An order is now at risk of being late',
  'review.created': 'New AI suggestion waiting for review',
};

/** One stream per session. Events only say "something changed": screens then reload from REST. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { session, logout } = useSession();
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const listeners = useRef(new Set<Listener>());
  const nextToast = useRef(1);

  useEffect(() => {
    if (!session) return undefined;
    const notify = (event: StreamEvent | null) => {
      for (const listener of listeners.current) listener(event);
    };
    return openStream({
      getToken: () => session.token,
      onConnected: () => {
        setConnected(true);
        notify(null);
      },
      onDisconnected: () => setConnected(false),
      onUnauthorized: () => logout('Your session has expired. Please log in again.'),
      onEvent: (event) => {
        notify(event);
        const text = TOAST_TEXT[event.type];
        if (text) {
          const id = nextToast.current++;
          setToasts((current) => [...current.slice(-3), { id, text }]);
          setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
        }
      },
    });
  }, [session, logout]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const value = useMemo(() => ({ connected, subscribe, toasts }), [connected, subscribe, toasts]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

/**
 * Loads data from REST, and reloads on any live event, on reconnecting, and every so often as a fallback.
 * A reload keeps the old data on screen, and never clears it because of a passing failure.
 */
export function useLiveData<T>(load: () => Promise<T>, deps: unknown[] = [], intervalMs = 15000) {
  const { subscribe } = useLive();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const value = await loadRef.current();
      if (mine === sequence.current) {
        setData(value);
        setError(null);
      }
    } catch (failure) {
      if (mine === sequence.current) setError(failure);
    } finally {
      if (mine === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    const unsubscribe = subscribe(() => void reload());
    const timer = setInterval(() => void reload(), intervalMs);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, subscribe, intervalMs, ...deps]);

  return { data, error, loading, reload };
}
