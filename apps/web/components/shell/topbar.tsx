'use client';

import { useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/components/icons';
import { MY_PROPERTIES, type Property } from '@/lib/graphql/operations';

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, role, propertyId, switchProperty, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<{ myProperties: Property[] }>(MY_PROPERTIES, { skip: !user });
  const properties = data?.myProperties ?? [];
  const active = properties.find((p) => p.id === propertyId);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const initials = (user?.name ?? '')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-card px-4 sm:px-6">
      <button
        onClick={onMenu}
        className="text-muted transition-colors hover:text-ink lg:hidden"
        aria-label="Open menu"
      >
        <Icon.Menu />
      </button>

      {/* Property switcher — only ever lists hotels this user holds a role at. */}
      {properties.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={propertyId ?? ''}
            onChange={(e) => void switchProperty(e.target.value)}
            aria-label="Active property"
            className="max-w-[180px] rounded-lg border border-line bg-transparent py-1.5 pl-2.5 pr-7 text-[13px] font-medium outline-none focus:border-brand"
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {active && (
            <span className="hidden items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[11px] font-medium text-brand md:inline-flex">
              <Icon.Calendar className="h-3.5 w-3.5" />
              {/* The BUSINESS date — not today's calendar date (TDD §6). It is on
                  every screen because every posting and report keys off it. */}
              {active.businessDate}
            </span>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button className="hidden rounded-lg p-2 text-muted transition-colors hover:bg-canvas hover:text-ink sm:block">
          <Icon.Search />
        </button>
        <button className="relative hidden rounded-lg p-2 text-muted transition-colors hover:bg-canvas hover:text-ink sm:block">
          <Icon.Bell />
        </button>

        <div ref={menuRef} className="relative ml-1">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-canvas"
          >
            <span className="grid h-9 w-9 place-items-center rounded-full bg-brand text-[13px] font-semibold text-white">
              {initials || '?'}
            </span>
            <span className="hidden text-left sm:block">
              <span className="block text-[13px] font-medium leading-tight">{user?.name}</span>
              <span className="block text-[11px] leading-tight text-muted">
                {role?.replace('_', ' ').toLowerCase()}
              </span>
            </span>
            <Icon.Chevron
              className={cn(
                'hidden h-3.5 w-3.5 text-muted transition-transform sm:block',
                menuOpen && 'rotate-90',
              )}
            />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-2 w-52 overflow-hidden rounded-xl border border-line bg-card shadow-pop">
              <div className="border-b border-line px-4 py-3">
                <p className="text-[13px] font-medium">{user?.name}</p>
                <p className="truncate text-[11px] text-muted">{user?.email}</p>
              </div>
              <button
                onClick={() => void logout()}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-[13px] text-danger transition-colors hover:bg-danger-soft"
              >
                <Icon.Logout className="h-4 w-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
