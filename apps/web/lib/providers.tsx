'use client';

import { ApolloProvider } from '@apollo/client';
import { useState, type ReactNode } from 'react';
import { createApolloClient } from './apollo-client';
import { AuthProvider } from './auth-context';

export function Providers({ children }: { children: ReactNode }) {
  // useState, not a module singleton: in dev, Fast Refresh would otherwise hand
  // every remount the same client with a stale cache.
  const [client] = useState(() => createApolloClient());

  return (
    <ApolloProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </ApolloProvider>
  );
}
