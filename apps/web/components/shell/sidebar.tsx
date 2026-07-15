'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/components/icons';

interface NavItem {
  href: string;
  label: string;
  icon: (p: { className?: string }) => React.ReactElement;
  /** Mirrors the server's @Roles(). UX only — the API refuses regardless. */
  roles?: string[];
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

/**
 * Sections mirror how a hotel actually divides its work, not how the code is
 * organised. A receptionist thinks "front desk", not "reservations module".
 */
const SECTIONS: NavSection[] = [
  {
    heading: 'General',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: Icon.Dashboard },
      { href: '/front-desk', label: 'Front desk', icon: Icon.Desk },
    ],
  },
  {
    heading: 'Operations',
    items: [
      {
        href: '/reservations/new',
        label: 'New booking',
        icon: Icon.Plus,
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
      },
      { href: '/tape-chart', label: 'Tape chart', icon: Icon.Calendar },
      { href: '/rooms', label: 'Rooms', icon: Icon.Bed },
      // No `roles`: housekeeping obviously needs it, and the front desk needs to
      // know which rooms are ready before they hand anyone a key.
      { href: '/housekeeping', label: 'Housekeeping', icon: Icon.Broom },
      {
        href: '/pos',
        label: 'Point of sale',
        icon: Icon.Receipt,
        // A waiter is not a receptionist. Housekeeping does not sell food, and the
        // auditor reads the books rather than working the till.
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'POS_OPERATOR'],
      },
    ],
  },
  {
    heading: 'Back office',
    items: [
      {
        href: '/night-audit',
        label: 'Night audit',
        icon: Icon.Moon,
        roles: ['ADMIN', 'MANAGER'],
      },
      {
        href: '/reports',
        label: 'Reports',
        icon: Icon.Chart,
        roles: ['ADMIN', 'MANAGER', 'AUDITOR'],
      },
    ],
  },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { role } = useAuth();

  const visible = SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((i) => !i.roles || (role && i.roles.includes(role))),
  })).filter((s) => s.items.length > 0);

  return (
    <>
      {/* Mobile scrim. The rail is a drawer below lg. */}
      {open && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          aria-hidden
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col bg-rail transition-transform duration-200',
          'lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand">
            <Icon.Key className="h-4 w-4 text-white" />
          </div>
          <span className="text-[17px] font-semibold tracking-tight text-white">HotelOS</span>

          <button
            onClick={onClose}
            className="ml-auto text-rail-text hover:text-white lg:hidden"
            aria-label="Close menu"
          >
            <Icon.Close />
          </button>
        </div>

        {/* The rail scrolls on its own — the page never does. */}
        <nav className="rail-scroll flex-1 overflow-y-auto px-3 pb-6">
          {visible.map((section) => (
            <div key={section.heading} className="mb-1 mt-4 first:mt-0">
              <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-rail-text/50">
                {section.heading}
              </p>

              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const active =
                    pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const ItemIcon = item.icon;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onClose}
                        className={cn(
                          'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors',
                          active
                            ? 'bg-brand text-white shadow-[0_4px_12px_rgba(115,102,255,0.35)]'
                            : 'text-rail-text hover:bg-rail-hover hover:text-white',
                        )}
                      >
                        <ItemIcon className="h-[18px] w-[18px] shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-white/5 px-5 py-4">
          <p className="text-[10px] text-rail-text/50">HotelOS · Phase 1</p>
        </div>
      </aside>
    </>
  );
}
