'use client';

import { useQuery } from '@apollo/client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { MY_PROPERTIES, type Property } from '@/lib/graphql/operations';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, role, propertyId, switchProperty, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  const { data } = useQuery<{ myProperties: Property[] }>(MY_PROPERTIES, {
    skip: !user,
  });

  // Don't flash the dashboard before the boot-time silent refresh settles.
  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm opacity-60">Loading…</p>
      </main>
    );
  }

  const properties = data?.myProperties ?? [];
  const active = properties.find((p) => p.id === propertyId);

  return (
    <div className="min-h-screen">
      <header className="border-b border-black/10 dark:border-white/10">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <span className="text-sm font-semibold tracking-tight">HotelOS</span>

          {/* The property switcher. Only lists hotels this user holds a role at —
              the server enforces that, we merely render it. */}
          {properties.length > 0 && (
            <select
              value={propertyId ?? ''}
              onChange={(e) => void switchProperty(e.target.value)}
              aria-label="Active property"
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm outline-none dark:border-white/20"
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          {active && (
            <span className="hidden text-xs opacity-60 sm:inline">
              Business date{' '}
              <strong className="font-medium opacity-100">{active.businessDate}</strong>
            </span>
          )}

          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs opacity-70">
              {user.name}
              {role && (
                <span className="ml-1.5 rounded bg-status-occupied/15 px-1.5 py-0.5 text-status-occupied">
                  {role.replace('_', ' ')}
                </span>
              )}
            </span>
            <button
              onClick={() => void logout()}
              className="text-xs underline underline-offset-2 opacity-70 hover:opacity-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
