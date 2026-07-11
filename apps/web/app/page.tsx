'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';

/** Route on identity: signed in → front desk, otherwise → login. */
export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/front-desk' : '/login');
  }, [user, loading, router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-sm opacity-60">Loading…</p>
    </main>
  );
}
