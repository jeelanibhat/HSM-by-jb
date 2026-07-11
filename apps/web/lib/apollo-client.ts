import { ApolloClient, HttpLink, InMemoryCache, from } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';

/**
 * Apollo is the source of truth for server state (TDD §7.3) — no Redux.
 *
 * The links, in order:
 *   error   → catches 401 and drives the silent-refresh retry
 *   auth    → injects the access token + X-Property-Id tenancy header
 *   http    → /graphql
 */

const GRAPHQL_URL = process.env['NEXT_PUBLIC_GRAPHQL_URL'] ?? 'http://localhost:4000/graphql';

/**
 * The access token lives in memory only. localStorage is readable by any XSS
 * payload; the refresh token is an httpOnly cookie the JS never sees (TDD §3).
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Set by the property-context provider on login / property switch. */
let activePropertyId: string | null = null;

export function setActiveProperty(propertyId: string | null): void {
  activePropertyId = propertyId;
}

const authLink = setContext((_, { headers }) => ({
  headers: {
    ...headers,
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(activePropertyId ? { 'X-Property-Id': activePropertyId } : {}),
  },
}));

const errorLink = onError(({ graphQLErrors, networkError, operation, forward }) => {
  // 401 → silent refresh → retry (TDD §7.3). Wired up when the auth module lands
  // in build step 3; the seam is here so no caller has to know about it.
  const unauthenticated = graphQLErrors?.some(
    (e) => e.extensions?.['code'] === 'UNAUTHENTICATED',
  );

  if (unauthenticated) {
    return forward(operation);
  }

  if (networkError) {
    console.error('[network]', networkError.message);
  }
});

export function createApolloClient(): ApolloClient<unknown> {
  return new ApolloClient({
    link: from([errorLink, authLink, new HttpLink({ uri: GRAPHQL_URL, credentials: 'include' })]),
    cache: new InMemoryCache({
      typePolicies: {
        Query: {
          fields: {
            // The tape chart is queried per date-window; each window is its own
            // cache entry rather than one list Apollo would try to merge.
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
