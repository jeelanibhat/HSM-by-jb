'use client';

import { useApolloClient, useMutation } from '@apollo/client';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getActiveProperty,
  refreshOnce,
  resetClient,
  setAccessToken,
  setActiveProperty,
  setSessionExpiredHandler,
} from './apollo-client';
import { LOGIN, LOGOUT, type AuthUser } from './graphql/operations';

interface AuthState {
  user: AuthUser | null;
  propertyId: string | null;
  role: string | null;
  /** True until the boot-time silent refresh settles — render nothing decisive before then. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchProperty: (propertyId: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Survives a reload; it is a UI preference, not a credential. The server re-checks it. */
const PROPERTY_KEY = 'hotelos.activeProperty';

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useApolloClient();
  const router = useRouter();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [propertyId, setPropertyIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [loginMutation] = useMutation(LOGIN);
  const [logoutMutation] = useMutation(LOGOUT);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setActiveProperty(null);
    setUser(null);
    setPropertyIdState(null);
    if (typeof window !== 'undefined') localStorage.removeItem(PROPERTY_KEY);
  }, []);

  /**
   * Pick the active property: the last one used, but ONLY if the user still holds
   * a role there. Honouring a stale localStorage value from a revoked grant would
   * make every request 403 and the app look broken.
   */
  const restoreProperty = useCallback((u: AuthUser) => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(PROPERTY_KEY) : null;

    const valid = stored && u.roles.some((r) => r.propertyId === stored) ? stored : null;
    const chosen = valid ?? u.roles[0]?.propertyId ?? null;

    setActiveProperty(chosen);
    setPropertyIdState(chosen);

    if (chosen && typeof window !== 'undefined') {
      localStorage.setItem(PROPERTY_KEY, chosen);
    }
  }, []);

  /**
   * On boot the access token is gone — it only ever lived in memory. But the
   * httpOnly refresh cookie survives, so we silently mint a new one. This is what
   * makes a page reload not look like a logout.
   */
  useEffect(() => {
    setSessionExpiredHandler(() => {
      clearSession();
      router.replace('/login');
    });

    let cancelled = false;

    (async () => {
      const token = await refreshOnce();

      if (cancelled) return;

      if (!token) {
        setLoading(false);
        return;
      }

      // refreshOnce() only hands back the token; re-read the user from the same
      // response shape by asking the server who we are.
      try {
        const res = await fetch(
          process.env['NEXT_PUBLIC_GRAPHQL_URL'] ?? 'http://localhost:4000/graphql',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              authorization: `Bearer ${token}`,
            },
            credentials: 'include',
            body: JSON.stringify({
              query: `{ me { id email name roles { propertyId role } } }`,
            }),
          },
        );
        const json = await res.json();
        const me: AuthUser | undefined = json?.data?.me;

        if (!cancelled && me) {
          setUser(me);
          restoreProperty(me);
        }
      } catch {
        // Leave unauthenticated; the login page will handle it.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearSession, restoreProperty, router]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { data } = await loginMutation({ variables: { input: { email, password } } });

      const token: string = data.login.accessToken;
      const me: AuthUser = data.login.user;

      setAccessToken(token);
      setUser(me);
      restoreProperty(me);

      // A fresh identity must never see the previous one's cached data.
      await resetClient(client);
    },
    [loginMutation, restoreProperty, client],
  );

  const logout = useCallback(async () => {
    try {
      await logoutMutation();
    } finally {
      clearSession();
      await resetClient(client);
      router.replace('/login');
    }
  }, [logoutMutation, clearSession, client, router]);

  const switchProperty = useCallback(
    async (next: string) => {
      setActiveProperty(next);
      setPropertyIdState(next);
      localStorage.setItem(PROPERTY_KEY, next);

      // Every cached entity belongs to the OLD property. Serving it under the new
      // one would show Hotel Alpha's rooms on Hotel Beta's screen.
      await resetClient(client);
    },
    [client],
  );

  const role = useMemo(
    () => user?.roles.find((r) => r.propertyId === propertyId)?.role ?? null,
    [user, propertyId],
  );

  const value = useMemo(
    () => ({ user, propertyId, role, loading, login, logout, switchProperty }),
    [user, propertyId, role, loading, login, logout, switchProperty],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The current property id, guaranteed non-null inside the dashboard. */
export function useActiveProperty(): string {
  const { propertyId } = useAuth();
  return propertyId ?? getActiveProperty() ?? '';
}
