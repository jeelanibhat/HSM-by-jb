import {
  ApolloClient,
  HttpLink,
  InMemoryCache,
  Observable,
  from,
  split,
  type FetchResult,
  type NormalizedCacheObject,
} from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';

/**
 * Apollo is the source of truth for server state (TDD §7.3). No Redux.
 *
 * Link order: error → auth → http.
 *   error: catches UNAUTHENTICATED and drives silent refresh + retry
 *   auth:  injects the access token and the X-Property-Id tenancy header
 */

const GRAPHQL_URL = process.env['NEXT_PUBLIC_GRAPHQL_URL'] ?? 'http://localhost:4000/graphql';

/**
 * The access token lives in memory ONLY.
 *
 * localStorage is readable by any XSS payload, and a token there survives the tab.
 * Keeping it in a module variable means a refresh of the page drops it — which is
 * fine, because the refresh token (an httpOnly cookie JS cannot read) silently
 * mints a new one on boot.
 */
let accessToken: string | null = null;
let activePropertyId: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setActiveProperty(propertyId: string | null): void {
  activePropertyId = propertyId;
}

export function getActiveProperty(): string | null {
  return activePropertyId;
}

/** Called when refresh fails — the session is genuinely over. */
let onSessionExpired: () => void = () => {};

export function setSessionExpiredHandler(fn: () => void): void {
  onSessionExpired = fn;
}

const REFRESH_MUTATION = `
  mutation RefreshToken {
    refreshToken {
      accessToken
      user { id email name roles { propertyId role } }
    }
  }
`;

/**
 * Ask the server for a new access token using the httpOnly refresh cookie.
 *
 * Deliberately a bare fetch, not an Apollo mutation: routing it back through the
 * client would re-enter the error link on failure and recurse forever.
 */
async function refreshAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // sends the httpOnly cookie
      body: JSON.stringify({ query: REFRESH_MUTATION }),
    });

    const json = await res.json();
    const token: string | undefined = json?.data?.refreshToken?.accessToken;

    if (!token) return null;

    setAccessToken(token);
    return token;
  } catch {
    return null;
  }
}

/**
 * One refresh at a time. Without this, a page that fires six queries on mount and
 * gets six 401s would kick off six concurrent refreshes — and because refresh
 * tokens ROTATE, five of them would present an already-spent token, trip the
 * server's reuse detection, and revoke the whole family. The user would be
 * force-logged-out by their own app.
 */
let inFlightRefresh: Promise<string | null> | null = null;

function refreshOnce(): Promise<string | null> {
  inFlightRefresh ??= refreshAccessToken().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

const authLink = setContext((_, { headers }) => ({
  headers: {
    ...headers,
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(activePropertyId ? { 'X-Property-Id': activePropertyId } : {}),
  },
}));

const errorLink = onError(({ graphQLErrors, operation, forward }) => {
  const unauthenticated = graphQLErrors?.some(
    (e) => e.extensions?.['code'] === 'UNAUTHENTICATED',
  );

  if (!unauthenticated) return;

  // Don't try to refresh the refresh call itself.
  if (operation.operationName === 'RefreshToken' || operation.operationName === 'Login') {
    return;
  }

  return new Observable<FetchResult>((observer) => {
    refreshOnce()
      .then((token) => {
        if (!token) {
          onSessionExpired();
          observer.error(new Error('Session expired'));
          return;
        }

        operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
          headers: { ...headers, authorization: `Bearer ${token}` },
        }));

        forward(operation).subscribe({
          next: observer.next.bind(observer),
          error: observer.error.bind(observer),
          complete: observer.complete.bind(observer),
        });
      })
      .catch((err: unknown) => observer.error(err));
  });
});

/**
 * Subscriptions ride a WebSocket, not HTTP.
 *
 * The socket authenticates ONCE, at the handshake, via connectionParams — there
 * are no per-message headers to attach a bearer token to. `lazy` means we only
 * open it when something actually subscribes, so a page with no live data does
 * not hold a socket open.
 *
 * connectionParams is a FUNCTION, not an object: it is evaluated at connect time,
 * so a socket that reconnects after the access token was silently refreshed
 * presents the NEW token. Passing a snapshot object would pin the socket to a
 * token that expires 15 minutes later and then reconnect forever with a dead one.
 */
function createWsLink(): GraphQLWsLink | null {
  if (typeof window === 'undefined') return null; // no sockets during SSR

  return new GraphQLWsLink(
    createClient({
      url: GRAPHQL_URL.replace(/^http/, 'ws'),
      lazy: true,
      connectionParams: () => ({
        authorization: accessToken ? `Bearer ${accessToken}` : '',
      }),
      retryAttempts: 5,
    }),
  );
}

export function createApolloClient(): ApolloClient<NormalizedCacheObject> {
  const httpLink = new HttpLink({ uri: GRAPHQL_URL, credentials: 'include' });
  const wsLink = createWsLink();

  // Route subscriptions to the socket, everything else over HTTP.
  const transport = wsLink
    ? split(
        ({ query }) => {
          const def = getMainDefinition(query);
          return def.kind === 'OperationDefinition' && def.operation === 'subscription';
        },
        wsLink,
        httpLink,
      )
    : httpLink;

  return new ApolloClient({
    link: from([errorLink, authLink, transport]),
    cache: new InMemoryCache({
      typePolicies: {
        Query: {
          fields: {
            // The tape chart is fetched per date-window; each window is its own
            // cache entry rather than a list Apollo would try to merge.
            tapeChart: { keyArgs: ['from', 'to'] },
            reservations: { keyArgs: ['filter'] },
          },
        },
      },
    }),
    defaultOptions: {
      watchQuery: { fetchPolicy: 'cache-and-network' },
    },
  });
}

/**
 * Wipe the cache on logout and on property switch — never show one hotel's cached
 * data under another hotel's context.
 *
 * Typed loosely on purpose: useApolloClient() hands back ApolloClient<object>,
 * and we only need clearStore(), so the cache's shape is irrelevant here.
 */
export async function resetClient(client: Pick<ApolloClient<unknown>, 'clearStore'>): Promise<void> {
  await client.clearStore();
}

export { refreshOnce };
